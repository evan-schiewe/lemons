import type {
  AnnotationHandlers,
  AnnotationPayload,
  DriverStint,
  LapRow,
  PanelAnnotationKind,
  RaceAnnotations,
  RangeEvent,
  TaggedIncident,
} from '../../types';
import { closestElement } from '../../utils/dom';
import { escapeHtml, formatNumber, formatSpeed } from '../../utils/format';
import { formatDurationMs, formatWallClock } from '../../utils/time';

interface KindConfig {
  formId: string;
  title: string;
  listKey: keyof Pick<
    RaceAnnotations,
    'taggedIncidents' | 'rangeEvents' | 'driverStints'
  >;
  timingLabel: string;
}

interface AnnotationPanelViewModel {
  selectedLapRow: LapRow | null;
  rows: LapRow[];
  raceStartTime: string | null;
  annotations: RaceAnnotations;
}

interface ActiveEdit {
  kind: PanelAnnotationKind;
  id: string;
}

type PanelItem = TaggedIncident | RangeEvent | DriverStint;

interface SelectedLapDetails {
  flags: string[];
  lapNotes: RaceAnnotations['lapNotes'];
  taggedIncidents: TaggedIncident[];
  rangeEvents: RangeEvent[];
  driverStints: DriverStint[];
}

interface AnnotationPanelState {
  viewModel: AnnotationPanelViewModel;
  activeEdit: ActiveEdit | null;
  activeKind: PanelAnnotationKind;
  isModalOpen: boolean;
  modalView: 'form' | 'lapDetails';
  modalRoot: HTMLDivElement;
  prefillValues: AnnotationPayload | null;
}

const EMPTY_ANNOTATIONS: RaceAnnotations = {
  lapNotes: [],
  taggedIncidents: [],
  rangeEvents: [],
  driverStints: [],
  journalEntries: [],
};

const EMPTY_VIEW_MODEL: AnnotationPanelViewModel = {
  selectedLapRow: null,
  rows: [],
  raceStartTime: null,
  annotations: EMPTY_ANNOTATIONS,
};

const KIND_CONFIG = {
  taggedIncident: {
    formId: 'tagged-incident-form',
    title: 'Tagged Incident',
    listKey: 'taggedIncidents',
    timingLabel: 'Single lap event',
  },
  rangeEvent: {
    formId: 'range-event-form',
    title: 'Range Event',
    listKey: 'rangeEvents',
    timingLabel: 'Lap range event',
  },
  driverStint: {
    formId: 'driver-stint-form',
    title: 'Driver Stint',
    listKey: 'driverStints',
    timingLabel: 'Driver span across laps',
  },
} satisfies Record<PanelAnnotationKind, KindConfig>;

const DEFAULT_KIND: PanelAnnotationKind = 'taggedIncident';

/**
 * Find the selected lap and its neighbors (lap before and lap after)
 */
function getContextLaps(rows: LapRow[], selectedLapRow: LapRow | null) {
  if (!selectedLapRow || !rows?.length) {
    return { before: null, current: selectedLapRow, after: null };
  }

  const currentIndex = rows.findIndex((row) => row.id === selectedLapRow.id);
  if (currentIndex === -1) {
    return { before: null, current: selectedLapRow, after: null };
  }

  return {
    before: currentIndex > 0 ? rows[currentIndex - 1] : null,
    current: selectedLapRow,
    after: currentIndex < rows.length - 1 ? rows[currentIndex + 1] : null,
  };
}

/**
 * Render a mini table row for lap context
 */
function renderContextLapRow(
  row: LapRow,
  label: string,
  raceStartTimeIso: string | null,
): string {
  const hasPitTag = Boolean(row.is_pit_lap);
  const hasIncidentTag = Number(row.incident_count) > 0;
  const flags = [
    hasPitTag ? 'Pit' : null,
    row.is_outlier && !hasPitTag && !hasIncidentTag ? 'Outlier' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `
    <tr class="annotation-context-lap ${label}">
      <td class="annotation-context-label">${escapeHtml(label)}</td>
      <td>${escapeHtml(row.lap_number)}</td>
      <td>${escapeHtml(formatWallClock(raceStartTimeIso, row.lap_start_offset_ms))}</td>
      <td>${escapeHtml(row.display_driver_name || row.driver_name || '-')}</td>
      <td>${escapeHtml(formatDurationMs(row.lap_time_ms))}</td>
      <td>${escapeHtml(formatNumber(row.position_value))}</td>
      <td>${escapeHtml(formatSpeed(row.speed_mph))}</td>
      <td>${escapeHtml(flags || '-')}</td>
    </tr>
  `;
}

/**
 * Render the mini lap context table
 */
function renderContextTable(
  rows: LapRow[],
  selectedLapRow: LapRow | null,
  raceStartTimeIso: string | null,
): string {
  const context = getContextLaps(rows, selectedLapRow);

  let html = `
    <section class="annotation-section annotation-context-table">
      <h4>Lap Context</h4>
  `;

  if (!context.current) {
    html += `<p class="annotation-meta">Enter a lap number above to see lap details</p>`;
  } else {
    html += `
      <table class="annotation-mini-table">
        <thead>
          <tr>
            <th class="annotation-context-label-header"></th>
            <th>Lap</th>
            <th>Time</th>
            <th>Driver</th>
            <th>Duration</th>
            <th>Pos</th>
            <th>Speed</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
    `;

    if (context.before) {
      html += renderContextLapRow(context.before, '← Before', raceStartTimeIso);
    }

    html += renderContextLapRow(context.current, 'Current', raceStartTimeIso);

    if (context.after) {
      html += renderContextLapRow(context.after, 'After →', raceStartTimeIso);
    }

    html += `
        </tbody>
      </table>
    `;
  }

  html += `
    </section>
  `;

  return html;
}

export function mountAnnotationPanel(
  container: HTMLElement,
  handlers: AnnotationHandlers,
) {
  const modalRoot = document.createElement('div');
  modalRoot.className = 'annotation-modal-root';
  document.body.appendChild(modalRoot);

  const state: AnnotationPanelState = {
    viewModel: EMPTY_VIEW_MODEL,
    activeEdit: null,
    activeKind: DEFAULT_KIND,
    isModalOpen: false,
    modalView: 'form',
    modalRoot,
    prefillValues: null,
  };

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    const form = closestElement<HTMLFormElement>(
      event.target,
      'form[data-kind]',
    );
    if (!form) {
      return;
    }

    const formData = new FormData(form);
    const kind = readPanelKind(form.dataset.kind);
    if (!kind) {
      return;
    }
    const didSave = await handlers.onSave(
      kind,
      normalizeFormData(kind, formData),
    );
    if (didSave) {
      state.isModalOpen = false;
      state.activeEdit = null;
      state.prefillValues = null;
      renderCurrentPanel(container, state);
    }
  }

  function handleChange(event: Event) {
    const selector = closestElement<HTMLSelectElement>(
      event.target,
      '[data-action="switch-kind"]',
    );
    if (!selector) {
      return;
    }

    state.activeKind = readPanelKind(selector.value) ?? DEFAULT_KIND;
    state.activeEdit = null;
    renderCurrentPanel(container, state);
    hydrateActiveForm(
      state.modalRoot,
      state.viewModel,
      state.activeKind,
      null,
      state.prefillValues,
    );
  }

  function handleLapNumberChange(event: Event) {
    if (state.modalView !== 'form') {
      return;
    }

    const input = closestElement<HTMLInputElement>(
      event.target,
      'input[name="lap_number"], input[name="start_lap"], input[name="end_lap"]',
    );
    if (!input || !state.viewModel?.rows) {
      return;
    }

    const lapNumber = Number.parseInt(input.value, 10);
    if (!Number.isInteger(lapNumber) || lapNumber < 1) {
      return;
    }

    const foundLap = state.viewModel.rows.find(
      (row) => row.lap_number === lapNumber,
    );
    if (!foundLap) {
      return;
    }

    // Update the mini table in the DOM
    const contextTableSection = state.modalRoot.querySelector(
      '.annotation-context-table',
    );
    if (contextTableSection) {
      const newTableHtml = renderContextTable(
        state.viewModel.rows,
        foundLap,
        state.viewModel.raceStartTime,
      );
      if (newTableHtml) {
        contextTableSection.outerHTML = newTableHtml;
      }
    }
  }

  async function handleClick(event: MouseEvent) {
    const button = closestElement<HTMLButtonElement>(
      event.target,
      'button[data-action]',
    );
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    const kind = readPanelKind(button.dataset.kind);

    if (action === 'delete' && kind) {
      const id = button.dataset.id;
      if (id) {
        await handlers.onDelete(kind, id);
      }
      return;
    }

    if (action === 'open-modal') {
      state.isModalOpen = true;
      state.modalView = 'form';
      state.activeEdit = null;
      state.prefillValues = null;
      state.activeKind = kind ?? state.activeKind;
      renderCurrentPanel(container, state);
      hydrateActiveForm(
        state.modalRoot,
        state.viewModel,
        state.activeKind,
        null,
        state.prefillValues,
      );
      return;
    }

    if (action === 'close-modal') {
      state.isModalOpen = false;
      state.modalView = 'form';
      state.activeEdit = null;
      state.prefillValues = null;
      renderCurrentPanel(container, state);
      return;
    }

    if (action === 'edit' && kind) {
      const id = button.dataset.id;
      const item = findItem(state.viewModel, kind, id);
      state.activeEdit = item && id ? { kind, id } : null;
      state.activeKind = kind;
      state.isModalOpen = true;
      state.modalView = 'form';
      state.prefillValues = null;
      renderCurrentPanel(container, state);
      hydrateActiveForm(state.modalRoot, state.viewModel, kind, item);
      return;
    }

    if (action === 'clear' && kind) {
      state.activeEdit = null;
      state.isModalOpen = false;
      state.modalView = 'form';
      state.prefillValues = null;
      state.activeKind = kind;
      renderCurrentPanel(container, state);
    }
  }

  container.addEventListener('click', handleClick);
  state.modalRoot.addEventListener('click', handleClick);
  state.modalRoot.addEventListener('change', handleChange);
  state.modalRoot.addEventListener('input', handleLapNumberChange);
  state.modalRoot.addEventListener('submit', handleSubmit);

  return {
    render(viewModel: AnnotationPanelViewModel | null) {
      state.viewModel = normalizePanelViewModel(viewModel);
      if (state.activeEdit?.kind) {
        const nextItem = findItem(
          state.viewModel,
          state.activeEdit.kind,
          state.activeEdit.id,
        );
        state.activeEdit = nextItem ? state.activeEdit : null;
      }

      renderCurrentPanel(container, state);

      if (state.isModalOpen && state.modalView === 'form') {
        hydrateActiveForm(
          state.modalRoot,
          state.viewModel,
          state.activeKind,
          state.activeEdit
            ? findItem(
                state.viewModel,
                state.activeEdit.kind,
                state.activeEdit.id,
              )
            : null,
          state.prefillValues,
          false,
        );
      }
    },
    openComposer(
      kind: string = DEFAULT_KIND,
      options: { prefill?: AnnotationPayload } = {},
    ) {
      state.activeKind = readPanelKind(kind) ?? DEFAULT_KIND;
      state.activeEdit = null;
      state.isModalOpen = true;
      state.modalView = 'form';
      state.prefillValues = options.prefill ?? null;
      renderCurrentPanel(container, state);
      hydrateActiveForm(
        state.modalRoot,
        state.viewModel,
        state.activeKind,
        null,
        state.prefillValues,
      );
    },
    openEditor(kind: string, id: string) {
      const panelKind = readPanelKind(kind);
      if (!panelKind) {
        return;
      }
      const item = findItem(state.viewModel, panelKind, id);
      if (!item) {
        return;
      }

      state.activeKind = panelKind;
      state.activeEdit = { kind: panelKind, id };
      state.isModalOpen = true;
      state.modalView = 'form';
      state.prefillValues = null;
      renderCurrentPanel(container, state);
      hydrateActiveForm(state.modalRoot, state.viewModel, panelKind, item);
    },
    openLapDetails(viewModel: Partial<AnnotationPanelViewModel> | null) {
      const safeViewModel: AnnotationPanelViewModel = {
        selectedLapRow: viewModel?.selectedLapRow ?? null,
        rows: viewModel?.rows ?? [],
        raceStartTime: viewModel?.raceStartTime ?? null,
        annotations: {
          lapNotes: viewModel?.annotations?.lapNotes ?? [],
          taggedIncidents: viewModel?.annotations?.taggedIncidents ?? [],
          rangeEvents: viewModel?.annotations?.rangeEvents ?? [],
          driverStints: viewModel?.annotations?.driverStints ?? [],
          journalEntries: viewModel?.annotations?.journalEntries ?? [],
        },
      };

      state.viewModel = safeViewModel;
      state.activeEdit = null;
      state.prefillValues = null;
      state.isModalOpen = true;
      state.modalView = 'lapDetails';
      renderCurrentPanel(container, state);
    },
  };
}

function renderCurrentPanel(
  container: HTMLElement,
  state: AnnotationPanelState,
): void {
  container.innerHTML = renderPanel(state.viewModel, state.activeEdit);
  state.modalRoot.innerHTML = state.isModalOpen
    ? renderModal(
        state.viewModel,
        state.activeEdit,
        state.activeKind,
        state.modalView,
      )
    : '';
  document.body.classList.toggle('annotation-modal-open', state.isModalOpen);
}

function renderPanel(
  viewModel: AnnotationPanelViewModel,
  activeEdit: ActiveEdit | null,
): string {
  const selected = viewModel.selectedLapRow;
  const annotationCount =
    viewModel.annotations.taggedIncidents.length +
    viewModel.annotations.rangeEvents.length +
    viewModel.annotations.driverStints.length;

  return `
    <section class="annotation-section annotation-editor-intro">
      <div>
        <strong>${selected ? `Lap ${escapeHtml(selected.lap_number)}` : 'No selected lap'}</strong>
        <p class="annotation-meta">${selected ? escapeHtml(selected.display_driver_name || selected.driver_name || 'Unknown driver') : 'Select a lap in the table or chart to prefill forms for incidents and spans.'}</p>
        ${activeEdit ? `<p class="annotation-meta annotation-edit-state">Editing ${escapeHtml(KIND_CONFIG[activeEdit.kind].title)}</p>` : '<p class="annotation-meta annotation-edit-state">Forms stay hidden until you open the editor modal.</p>'}
      </div>
      <div class="annotation-editor-actions">
        <span class="status-pill">Tracked items: ${annotationCount}</span>
        <button class="button secondary" data-action="open-modal" type="button">New Annotation</button>
      </div>
    </section>
    ${renderListSection('Tagged Incidents', 'taggedIncident', viewModel.annotations.taggedIncidents, renderTaggedIncidentItem)}
    ${renderListSection('Range Events', 'rangeEvent', viewModel.annotations.rangeEvents, renderRangeEventItem)}
    ${renderListSection('Driver Stints', 'driverStint', viewModel.annotations.driverStints, renderDriverStintItem)}
  `;
}

function buildSelectedLapDetails(
  selected: LapRow,
  annotations: RaceAnnotations,
): SelectedLapDetails {
  const hasPitTag = Boolean(selected.is_pit_lap);
  const hasIncidentTag = Number(selected.incident_count) > 0;

  const flags = [
    selected.is_green_flag ? 'Green Flag' : null,
    hasPitTag ? 'Pit' : null,
    selected.is_outlier && !hasPitTag && !hasIncidentTag ? 'Outlier' : null,
    selected.note_count
      ? `${selected.note_count} Note${selected.note_count === 1 ? '' : 's'}`
      : null,
    selected.incident_count
      ? `${selected.incident_count} Incident${selected.incident_count === 1 ? '' : 's'}`
      : null,
  ].filter((flag): flag is string => Boolean(flag));

  const lapNumber = selected.lap_number;
  return {
    flags,
    lapNotes: annotations.lapNotes.filter(
      (item) => item.lap_number === lapNumber,
    ),
    taggedIncidents: annotations.taggedIncidents.filter(
      (item) => item.lap_number === lapNumber,
    ),
    rangeEvents: annotations.rangeEvents.filter(
      (item) => item.start_lap <= lapNumber && lapNumber <= item.end_lap,
    ),
    driverStints: annotations.driverStints.filter(
      (item) => item.start_lap <= lapNumber && lapNumber <= item.end_lap,
    ),
  };
}

function renderSelectedLapList<T>(
  title: string,
  items: T[],
  renderItem: (item: T) => string,
  renderActions: ((item: T) => string) | null = null,
): string {
  return `
    <section class="selected-lap-list">
      <h4>${escapeHtml(title)}</h4>
      ${items.length ? `<ul>${items.map((item) => `<li>${renderItem(item)}${renderActions ? renderActions(item) : ''}</li>`).join('')}</ul>` : '<p class="annotation-meta">None</p>'}
    </section>
  `;
}

function renderSelectedLapTaggedIncidentActions(item: TaggedIncident): string {
  return `
    <div class="selected-lap-item-actions">
      <button class="button ghost" data-action="edit" data-kind="taggedIncident" data-id="${item.id}" type="button">Edit</button>
    </div>
  `;
}

function renderModal(
  viewModel: AnnotationPanelViewModel,
  activeEdit: ActiveEdit | null,
  activeKind: PanelAnnotationKind,
  modalView: AnnotationPanelState['modalView'] = 'form',
): string {
  if (modalView === 'lapDetails') {
    return renderLapDetailsModal(viewModel);
  }

  const selected = viewModel?.selectedLapRow;
  const rows = viewModel?.rows;
  const raceStartTime = viewModel?.raceStartTime;
  return `
    <div class="annotation-modal" role="dialog" aria-modal="true" aria-labelledby="annotation-modal-title">
      <button class="annotation-modal-backdrop" data-action="close-modal" type="button" aria-label="Close annotation editor"></button>
      <section class="annotation-modal-card">
        <div class="panel-header annotation-modal-header">
          <div>
            <h3 id="annotation-modal-title">${activeEdit ? `Edit ${escapeHtml(KIND_CONFIG[activeEdit.kind].title)}` : 'New Annotation'}</h3>
            <span class="panel-subtitle">${escapeHtml(KIND_CONFIG[activeKind].timingLabel)}</span>
          </div>
          <button class="button ghost" data-action="close-modal" type="button">Close</button>
        </div>
        ${renderFormSwitcher(activeKind)}
        ${renderContextTable(rows || [], selected, raceStartTime)}
        ${renderActiveForm(selected, activeEdit, activeKind)}
      </section>
    </div>
  `;
}

function renderLapDetailsModal(viewModel: AnnotationPanelViewModel): string {
  const selected = viewModel?.selectedLapRow;
  const details = selected
    ? buildSelectedLapDetails(selected, viewModel.annotations)
    : null;
  const detailsContent = details
    ? `
        <div class="selected-lap-grid">
          ${renderSelectedLapList('Lap Notes', details.lapNotes, (item) => `${escapeHtml(item.note_text || 'No details')}`)}
          ${renderSelectedLapList(
            'Tagged Incidents',
            details.taggedIncidents,
            (item) =>
              `<strong>${escapeHtml(item.tag)}</strong> · ${escapeHtml(item.title || 'Untitled')}<div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>`,
            (item) => renderSelectedLapTaggedIncidentActions(item),
          )}
          ${renderSelectedLapList('Range Events Covering Lap', details.rangeEvents, (item) => `<strong>${escapeHtml(item.tag)}</strong> · Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)}<div class="annotation-meta">${escapeHtml(item.title || 'Untitled')}</div>`)}
          ${renderSelectedLapList('Driver Stints Covering Lap', details.driverStints, (item) => `<strong>${escapeHtml(item.driver_name || 'Unknown driver')}</strong> · Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)}<div class="annotation-meta">${escapeHtml(item.notes || 'No stint notes')}</div>`)}
        </div>
      `
    : '<p class="annotation-meta">Click a lap table row to inspect flags and matching annotations.</p>';

  return `
    <div class="annotation-modal" role="dialog" aria-modal="true" aria-labelledby="annotation-modal-title">
      <button class="annotation-modal-backdrop" data-action="close-modal" type="button" aria-label="Close annotation details"></button>
      <section class="annotation-modal-card">
        <div class="panel-header annotation-modal-header">
          <div>
            <h3 id="annotation-modal-title">Lap ${selected ? escapeHtml(selected.lap_number) : ''} Details</h3>
            <div class="panel-subtitle selected-lap-subtitle">
              <span>${selected ? escapeHtml(selected.display_driver_name || selected.driver_name || 'Unknown driver') : 'No lap selected'}</span>
              ${details ? details.flags.map((flag) => `<span class="status-pill">${escapeHtml(flag)}</span>`).join('') : ''}
            </div>
          </div>
          <button class="button ghost" data-action="close-modal" type="button">Close</button>
        </div>
        ${detailsContent}
      </section>
    </div>
  `;
}

function renderFormSwitcher(activeKind: PanelAnnotationKind): string {
  return `
    <section class="annotation-section annotation-form-switcher">
      <label>
        <span>Annotation Type</span>
        <select data-action="switch-kind">
          ${Object.entries(KIND_CONFIG)
            .map(
              ([kind, config]) => `
            <option value="${kind}" ${kind === activeKind ? 'selected' : ''}>${escapeHtml(config.title)} · ${escapeHtml(config.timingLabel)}</option>
          `,
            )
            .join('')}
        </select>
      </label>
    </section>
  `;
}

function renderActiveForm(
  selected: LapRow | null,
  activeEdit: ActiveEdit | null,
  activeKind: PanelAnnotationKind,
): string {
  if (activeKind === 'rangeEvent') {
    return renderRangeEventForm(selected, activeEdit);
  }

  if (activeKind === 'driverStint') {
    return renderDriverStintForm(selected, activeEdit);
  }

  return renderIncidentForm(selected, activeEdit);
}

function renderIncidentForm(
  selected: LapRow | null,
  activeEdit: ActiveEdit | null,
): string {
  const isEditing = activeEdit?.kind === 'taggedIncident';
  return `
    <section class="annotation-section ${isEditing ? 'annotation-section-editing' : ''}">
      <h3>Tagged Incident</h3>
      <form id="tagged-incident-form" data-kind="taggedIncident">
        <input type="hidden" name="id" />
        <label><span>Lap</span><input name="lap_number" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Title</span><input name="title" required /></label>
        <label><span>Tag</span><input name="tag" placeholder="Spin, contact, FCY" required /></label>
        <label><span>Details</span><textarea name="details" rows="2"></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#d94f2b" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">${isEditing ? 'Update Incident' : 'Save Incident'}</button>
          <button class="button ghost" data-action="clear" data-kind="taggedIncident" type="button">${isEditing ? 'Cancel Edit' : 'Close'}</button>
        </div>
      </form>
    </section>
  `;
}

function renderRangeEventForm(
  selected: LapRow | null,
  activeEdit: ActiveEdit | null,
): string {
  const isEditing = activeEdit?.kind === 'rangeEvent';
  return `
    <section class="annotation-section ${isEditing ? 'annotation-section-editing' : ''}">
      <h3>Range Event</h3>
      <form id="range-event-form" data-kind="rangeEvent">
        <input type="hidden" name="id" />
        <label><span>Start Lap</span><input name="start_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>End Lap</span><input name="end_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Title</span><input name="title" required /></label>
        <label><span>Tag</span><input name="tag" placeholder="FCY, caution, weather" required /></label>
        <label><span>Details</span><textarea name="details" rows="2"></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#2563eb" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">${isEditing ? 'Update Range' : 'Save Range'}</button>
          <button class="button ghost" data-action="clear" data-kind="rangeEvent" type="button">${isEditing ? 'Cancel Edit' : 'Close'}</button>
        </div>
      </form>
    </section>
  `;
}

function renderDriverStintForm(
  selected: LapRow | null,
  activeEdit: ActiveEdit | null,
): string {
  const isEditing = activeEdit?.kind === 'driverStint';
  return `
    <section class="annotation-section ${isEditing ? 'annotation-section-editing' : ''}">
      <h3>Driver Stint</h3>
      <form id="driver-stint-form" data-kind="driverStint">
        <input type="hidden" name="id" />
        <label><span>Driver</span><input name="driver_name" value="${escapeHtml(selected?.driver_name ?? '')}" required /></label>
        <label><span>Start Lap</span><input name="start_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>End Lap</span><input name="end_lap" type="number" min="1" value="${selected?.lap_number ?? ''}" required /></label>
        <label><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
        <label><span>Color</span><input name="color" type="color" value="#059669" /></label>
        <div class="form-actions">
          <button class="button primary" type="submit">${isEditing ? 'Update Stint' : 'Save Stint'}</button>
          <button class="button ghost" data-action="clear" data-kind="driverStint" type="button">${isEditing ? 'Cancel Edit' : 'Close'}</button>
        </div>
      </form>
    </section>
  `;
}

function renderListSection<T extends PanelItem>(
  title: string,
  kind: PanelAnnotationKind,
  items: T[],
  renderItem: (item: T, kind: PanelAnnotationKind) => string,
): string {
  return `
    <section class="annotation-section">
      <div class="panel-header">
        <h3>${escapeHtml(title)}</h3>
        <span class="annotation-meta">${items.length}</span>
      </div>
      <div class="annotation-list">
        ${items.length ? items.map((item) => renderItem(item, kind)).join('') : '<div class="annotation-item">None</div>'}
      </div>
    </section>
  `;
}

function renderTaggedIncidentItem(
  item: TaggedIncident,
  kind: PanelAnnotationKind,
): string {
  return `
    <article class="annotation-item">
      <strong>Lap ${escapeHtml(item.lap_number)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderRangeEventItem(
  item: RangeEvent,
  kind: PanelAnnotationKind,
): string {
  return `
    <article class="annotation-item">
      <strong>Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderDriverStintItem(
  item: DriverStint,
  kind: PanelAnnotationKind,
): string {
  return `
    <article class="annotation-item">
      <strong>${escapeHtml(item.driver_name)} · Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)}</strong>
      <p>${escapeHtml(item.notes || 'No stint notes')}</p>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderItemActions(kind: PanelAnnotationKind, id: string): string {
  return `
    <div class="form-actions">
      <button class="button ghost" data-action="edit" data-kind="${kind}" data-id="${id}" type="button">Edit</button>
      <button class="button ghost" data-action="delete" data-kind="${kind}" data-id="${id}" type="button">Delete</button>
    </div>
  `;
}

function normalizeFormData(
  kind: PanelAnnotationKind,
  formData: FormData,
): AnnotationPayload {
  const common: AnnotationPayload = Object.fromEntries(formData.entries());
  const numericFields =
    {
      taggedIncident: ['lap_number'],
      rangeEvent: ['start_lap', 'end_lap'],
      driverStint: ['start_lap', 'end_lap'],
    }[kind] || [];

  numericFields.forEach((field) => {
    common[field] = Number.parseInt(`${common[field] ?? ''}`, 10);
  });

  Object.keys(common).forEach((field) => {
    if (typeof common[field] === 'string') {
      common[field] = common[field].trim();
    }
  });

  if (!common.id) {
    delete common.id;
  }

  return common;
}

function findItem(
  viewModel: AnnotationPanelViewModel,
  kind: PanelAnnotationKind | null | undefined,
  id: string | null | undefined,
): PanelItem | null {
  if (!viewModel || !kind || !id) {
    return null;
  }

  const listKey = KIND_CONFIG[kind].listKey;
  const items = viewModel.annotations[listKey] as PanelItem[];
  return items.find((item) => item.id === id) ?? null;
}

function hydrateForm(
  form: HTMLFormElement | null,
  item: PanelItem | null,
  selectedLapRow: LapRow | null,
  prefillValues: AnnotationPayload | null = null,
): void {
  if (!form) {
    return;
  }

  form.reset();

  const defaults = item ?? {
    ...buildDefaultValues(form.dataset.kind, selectedLapRow),
    ...(prefillValues ?? {}),
  };
  Object.entries(defaults).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement ||
      field instanceof HTMLSelectElement
    ) {
      field.value = `${value ?? ''}`;
    }
  });
}

function buildDefaultValues(
  kind: string | undefined,
  selectedLapRow: LapRow | null,
): AnnotationPayload {
  if (!selectedLapRow) {
    return {};
  }

  return {
    start_lap: selectedLapRow.lap_number,
    end_lap: selectedLapRow.lap_number,
    lap_number: selectedLapRow.lap_number,
    driver_name: selectedLapRow.driver_name,
    color: {
      taggedIncident: '#d94f2b',
      rangeEvent: '#2563eb',
      driverStint: '#059669',
    }[readPanelKind(kind) ?? DEFAULT_KIND],
  };
}

function focusAndRevealForm(form: HTMLFormElement | null): void {
  if (!form) {
    return;
  }

  form.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const firstEditableField = Array.from(form.elements).find(
    (
      field,
    ): field is
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | HTMLButtonElement => {
      return (
        (field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement ||
          field instanceof HTMLButtonElement) &&
        !field.disabled &&
        (!(field instanceof HTMLInputElement) || field.type !== 'hidden') &&
        typeof field.focus === 'function'
      );
    },
  );

  firstEditableField?.focus();
}

function hydrateActiveForm(
  container: ParentNode,
  viewModel: AnnotationPanelViewModel,
  kind: PanelAnnotationKind,
  item: PanelItem | null,
  prefillValues: AnnotationPayload | null = null,
  shouldFocus = true,
): void {
  const form = container.querySelector<HTMLFormElement>(
    `form[data-kind="${kind}"]`,
  );
  hydrateForm(form, item, viewModel?.selectedLapRow, prefillValues);

  if (shouldFocus) {
    focusAndRevealForm(form);
  }
}

function normalizePanelViewModel(
  viewModel: AnnotationPanelViewModel | null,
): AnnotationPanelViewModel {
  return {
    selectedLapRow: viewModel?.selectedLapRow ?? null,
    rows: viewModel?.rows ?? [],
    raceStartTime: viewModel?.raceStartTime ?? null,
    annotations: {
      lapNotes: viewModel?.annotations?.lapNotes ?? [],
      taggedIncidents: viewModel?.annotations?.taggedIncidents ?? [],
      rangeEvents: viewModel?.annotations?.rangeEvents ?? [],
      driverStints: viewModel?.annotations?.driverStints ?? [],
      journalEntries: viewModel?.annotations?.journalEntries ?? [],
    },
  };
}

function readPanelKind(value: string | undefined): PanelAnnotationKind | null {
  if (
    value === 'taggedIncident' ||
    value === 'rangeEvent' ||
    value === 'driverStint'
  ) {
    return value;
  }

  return null;
}

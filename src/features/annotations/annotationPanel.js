import { escapeHtml } from '../../utils/format.js';

const KIND_CONFIG = {
  taggedIncident: { formId: 'tagged-incident-form', title: 'Tagged Incident', listKey: 'taggedIncidents', timingLabel: 'Single lap event' },
  rangeEvent: { formId: 'range-event-form', title: 'Range Event', listKey: 'rangeEvents', timingLabel: 'Lap range event' },
  driverStint: { formId: 'driver-stint-form', title: 'Driver Stint', listKey: 'driverStints', timingLabel: 'Driver span across laps' },
};

const DEFAULT_KIND = 'taggedIncident';

export function mountAnnotationPanel(container, handlers) {
  const modalRoot = document.createElement('div');
  modalRoot.className = 'annotation-modal-root';
  document.body.appendChild(modalRoot);

  const state = { viewModel: null, activeEdit: null, activeKind: DEFAULT_KIND, isModalOpen: false, modalRoot, prefillValues: null };

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.target.closest('form[data-kind]');
    if (!form) {
      return;
    }

    const formData = new FormData(form);
    const kind = form.dataset.kind;
    const didSave = await handlers.onSave(kind, normalizeFormData(kind, formData));
    if (didSave) {
      state.isModalOpen = false;
      state.activeEdit = null;
      state.prefillValues = null;
      renderCurrentPanel(container, state);
    }
  }

  function handleChange(event) {
    const selector = event.target.closest('[data-action="switch-kind"]');
    if (!selector) {
      return;
    }

    state.activeKind = selector.value in KIND_CONFIG ? selector.value : DEFAULT_KIND;
    state.activeEdit = null;
    renderCurrentPanel(container, state);
    hydrateActiveForm(state.modalRoot, state.viewModel, state.activeKind, null, state.prefillValues);
  }

  async function handleClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    const kind = button.dataset.kind;

    if (action === 'delete') {
      await handlers.onDelete(kind, button.dataset.id);
      return;
    }

    if (action === 'open-modal') {
      state.isModalOpen = true;
      state.activeEdit = null;
      state.prefillValues = null;
      state.activeKind = button.dataset.kind in KIND_CONFIG ? button.dataset.kind : state.activeKind;
      renderCurrentPanel(container, state);
      hydrateActiveForm(state.modalRoot, state.viewModel, state.activeKind, null, state.prefillValues);
      return;
    }

    if (action === 'close-modal') {
      state.isModalOpen = false;
      state.activeEdit = null;
      state.prefillValues = null;
      renderCurrentPanel(container, state);
      return;
    }

    if (action === 'edit') {
      const item = findItem(state.viewModel, kind, button.dataset.id);
      state.activeEdit = item ? { kind, id: button.dataset.id } : null;
      state.activeKind = kind;
      state.isModalOpen = true;
      state.prefillValues = null;
      renderCurrentPanel(container, state);
      hydrateActiveForm(state.modalRoot, state.viewModel, kind, item);
      return;
    }

    if (action === 'clear') {
      state.activeEdit = null;
      state.isModalOpen = false;
      state.prefillValues = null;
      state.activeKind = kind;
      renderCurrentPanel(container, state);
    }
  }

  container.addEventListener('click', handleClick);
  state.modalRoot.addEventListener('click', handleClick);
  state.modalRoot.addEventListener('change', handleChange);
  state.modalRoot.addEventListener('submit', handleSubmit);

  return {
    render(viewModel) {
      state.viewModel = viewModel;
      if (state.activeEdit?.kind) {
        const nextItem = findItem(viewModel, state.activeEdit.kind, state.activeEdit.id);
        state.activeEdit = nextItem ? state.activeEdit : null;
      }

      renderCurrentPanel(container, state);

      if (state.isModalOpen) {
        hydrateActiveForm(
          state.modalRoot,
          viewModel,
          state.activeKind,
          state.activeEdit ? findItem(viewModel, state.activeEdit.kind, state.activeEdit.id) : null,
          state.prefillValues,
          false,
        );
      }
    },
    openComposer(kind = DEFAULT_KIND, options = {}) {
      state.activeKind = kind in KIND_CONFIG ? kind : DEFAULT_KIND;
      state.activeEdit = null;
      state.isModalOpen = true;
      state.prefillValues = options.prefill ?? null;
      renderCurrentPanel(container, state);
      hydrateActiveForm(state.modalRoot, state.viewModel, state.activeKind, null, state.prefillValues);
    },
    openEditor(kind, id) {
      const item = findItem(state.viewModel, kind, id);
      if (!item) {
        return;
      }

      state.activeKind = kind;
      state.activeEdit = { kind, id };
      state.isModalOpen = true;
      state.prefillValues = null;
      renderCurrentPanel(container, state);
      hydrateActiveForm(state.modalRoot, state.viewModel, kind, item);
    },
  };
}

function renderCurrentPanel(container, state) {
  container.innerHTML = renderPanel(state.viewModel, state.activeEdit, state.activeKind);
  state.modalRoot.innerHTML = state.isModalOpen ? renderModal(state.viewModel?.selectedLapRow, state.activeEdit, state.activeKind) : '';
  document.body.classList.toggle('annotation-modal-open', state.isModalOpen);
}

function renderPanel(viewModel, activeEdit, activeKind) {
  const selected = viewModel.selectedLapRow;
  const annotationCount = viewModel.annotations.taggedIncidents.length
    + viewModel.annotations.rangeEvents.length
    + viewModel.annotations.driverStints.length;
  const resolvedKind = KIND_CONFIG[activeKind] ? activeKind : DEFAULT_KIND;

  return `
    <section class="annotation-section annotation-editor-intro">
      <div>
        <strong>${selected ? `Lap ${escapeHtml(selected.lap_number)}` : 'No selected lap'}</strong>
        <p class="annotation-meta">${selected ? escapeHtml(selected.driver_name || 'Unknown driver') : 'Select a lap in the table or chart to prefill forms for incidents and spans.'}</p>
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

function renderModal(selected, activeEdit, activeKind) {
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
        ${renderActiveForm(selected, activeEdit, activeKind)}
      </section>
    </div>
  `;
}

function renderFormSwitcher(activeKind) {
  return `
    <section class="annotation-section annotation-form-switcher">
      <label>
        <span>Annotation Type</span>
        <select data-action="switch-kind">
          ${Object.entries(KIND_CONFIG).map(([kind, config]) => `
            <option value="${kind}" ${kind === activeKind ? 'selected' : ''}>${escapeHtml(config.title)} · ${escapeHtml(config.timingLabel)}</option>
          `).join('')}
        </select>
      </label>
    </section>
  `;
}

function renderActiveForm(selected, activeEdit, activeKind) {
  if (activeKind === 'rangeEvent') {
    return renderRangeEventForm(selected, activeEdit);
  }

  if (activeKind === 'driverStint') {
    return renderDriverStintForm(selected, activeEdit);
  }

  return renderIncidentForm(selected, activeEdit);
}

function renderIncidentForm(selected, activeEdit) {
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

function renderRangeEventForm(selected, activeEdit) {
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

function renderDriverStintForm(selected, activeEdit) {
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

function renderListSection(title, kind, items, renderItem) {
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

function renderTaggedIncidentItem(item, kind) {
  return `
    <article class="annotation-item">
      <strong>Lap ${escapeHtml(item.lap_number)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderRangeEventItem(item, kind) {
  return `
    <article class="annotation-item">
      <strong>Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="annotation-meta">${escapeHtml(item.details || 'No details')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderDriverStintItem(item, kind) {
  return `
    <article class="annotation-item">
      <strong>${escapeHtml(item.driver_name)} · Laps ${escapeHtml(item.start_lap)}-${escapeHtml(item.end_lap)}</strong>
      <p>${escapeHtml(item.notes || 'No stint notes')}</p>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderItemActions(kind, id) {
  return `
    <div class="form-actions">
      <button class="button ghost" data-action="edit" data-kind="${kind}" data-id="${id}" type="button">Edit</button>
      <button class="button ghost" data-action="delete" data-kind="${kind}" data-id="${id}" type="button">Delete</button>
    </div>
  `;
}

function normalizeFormData(kind, formData) {
  const common = Object.fromEntries(formData.entries());
  const numericFields = {
    taggedIncident: ['lap_number'],
    rangeEvent: ['start_lap', 'end_lap'],
    driverStint: ['start_lap', 'end_lap'],
  }[kind] || [];

  numericFields.forEach((field) => {
    common[field] = Number.parseInt(common[field], 10);
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

function findItem(viewModel, kind, id) {
  if (!viewModel) {
    return null;
  }

  const listKey = KIND_CONFIG[kind].listKey;
  return viewModel.annotations[listKey].find((item) => item.id === id) ?? null;
}

function hydrateForm(form, item, selectedLapRow, prefillValues = null) {
  if (!form) {
    return;
  }

  form.reset();

  const defaults = item ?? { ...buildDefaultValues(form.dataset.kind, selectedLapRow), ...(prefillValues ?? {}) };
  Object.entries(defaults).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field) {
      field.value = value ?? '';
    }
  });
}

function buildDefaultValues(kind, selectedLapRow) {
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
    }[kind],
  };
}

function focusAndRevealForm(form) {
  if (!form) {
    return;
  }

  form.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const firstEditableField = Array.from(form.elements).find((field) => {
    return field instanceof HTMLElement
      && !field.disabled
      && field.type !== 'hidden'
      && typeof field.focus === 'function';
  });

  firstEditableField?.focus();
}

function hydrateActiveForm(container, viewModel, kind, item, prefillValues = null, shouldFocus = true) {
  const form = container.querySelector(`form[data-kind="${kind}"]`);
  hydrateForm(form, item, viewModel?.selectedLapRow, prefillValues);

  if (shouldFocus) {
    focusAndRevealForm(form);
  }
}
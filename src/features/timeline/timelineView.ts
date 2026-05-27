import { ANNOTATION_COLOR_TOKENS } from '../../app/theme';
import type {
  AnnotationHandlers,
  JournalEntry,
  TimelineEvent,
  TimelineViewHandle,
  TimelineViewModel,
} from '../../types';
import { closestElement } from '../../utils/dom';
import { escapeHtml } from '../../utils/format';

interface TimelineHandlers extends Partial<AnnotationHandlers> {
  onSelectLap?: (lapNumber: number) => void | Promise<void>;
  isLocalEditingEnabled?: boolean;
}

interface TimelineState {
  viewModel: TimelineViewModel | null;
  editingJournalId: string | null;
  isComposerExpanded: boolean;
  isLocalEditingEnabled: boolean;
}

export function mountTimelineView(
  container: HTMLElement,
  handlers: TimelineHandlers,
): TimelineViewHandle {
  const state: TimelineState = {
    viewModel: null,
    editingJournalId: null,
    isComposerExpanded: false,
    isLocalEditingEnabled: Boolean(handlers?.isLocalEditingEnabled),
  };

  container.addEventListener('submit', async (event: SubmitEvent) => {
    const form = closestElement<HTMLFormElement>(
      event.target,
      'form[data-action="journal-form"]',
    );
    if (!form) {
      return;
    }

    event.preventDefault();

    const formData = new FormData(form);
    const lapNumberValue = `${formData.get('lap_number') ?? ''}`.trim();
    const manualDateTime = `${formData.get('event_time_local') ?? ''}`.trim();

    const payload = {
      id: state.editingJournalId || undefined,
      lap_number: lapNumberValue ? Number.parseInt(lapNumberValue, 10) : null,
      event_time_iso: datetimeLocalToIso(manualDateTime),
      event_time_source: manualDateTime ? 'manual' : 'lap',
      title: `${formData.get('title') ?? ''}`.trim(),
      entry_text: `${formData.get('entry_text') ?? ''}`.trim(),
      color:
        `${formData.get('color') ?? ''}`.trim() ||
        ANNOTATION_COLOR_TOKENS.journalEntry,
    };

    const didSave = await handlers.onSave?.('journalEntry', payload);
    if (didSave) {
      state.editingJournalId = null;
      state.isComposerExpanded = false;
      renderCurrent(container, state);
    }
  });

  container.addEventListener('click', async (event: MouseEvent) => {
    const button = closestElement<HTMLButtonElement>(
      event.target,
      'button[data-action]',
    );
    if (!button) {
      return;
    }

    const action = button.dataset.action ?? '';

    if (
      !state.isLocalEditingEnabled &&
      [
        'open-composer',
        'edit-journal',
        'delete-journal',
        'close-composer',
        'cancel-edit-journal',
      ].includes(action)
    ) {
      return;
    }

    if (action === 'edit-journal') {
      state.editingJournalId = button.dataset.id || null;
      state.isComposerExpanded = true;
      renderCurrent(container, state);
      return;
    }

    if (action === 'cancel-edit-journal') {
      state.editingJournalId = null;
      state.isComposerExpanded = false;
      renderCurrent(container, state);
      return;
    }

    if (action === 'open-composer') {
      state.isComposerExpanded = true;
      renderCurrent(container, state);
      return;
    }

    if (action === 'close-composer') {
      state.isComposerExpanded = false;
      state.editingJournalId = null;
      renderCurrent(container, state);
      return;
    }

    if (action === 'delete-journal') {
      const id = button.dataset.id;
      if (id) {
        await handlers.onDelete?.('journalEntry', id);
      }
      return;
    }

    if (action === 'jump-lap') {
      const lapNumber = Number.parseInt(button.dataset.lapNumber || '', 10);
      if (Number.isInteger(lapNumber) && lapNumber > 0) {
        await handlers.onSelectLap?.(lapNumber);
      }
    }
  });

  return {
    render(viewModel: TimelineViewModel | null) {
      state.viewModel = viewModel;

      const journalEntries = viewModel?.journalEntries || [];
      if (
        state.editingJournalId &&
        !journalEntries.some((item) => item.id === state.editingJournalId)
      ) {
        state.editingJournalId = null;
      }

      renderCurrent(container, state);
    },
  };
}

function renderCurrent(container: HTMLElement, state: TimelineState): void {
  const viewModel = state.viewModel;
  if (!viewModel) {
    container.innerHTML =
      '<div class="timeline-empty">Load a race to view the event timeline.</div>';
    return;
  }

  const editingJournal = state.editingJournalId
    ? (viewModel.journalEntries || []).find(
        (item) => item.id === state.editingJournalId,
      ) || null
    : null;

  container.innerHTML = `
        <div class="timeline-layout">
            <section class="timeline-entries">
                ${renderTimelineEvents(viewModel.timelineEvents || [], state.isLocalEditingEnabled)}
            </section>
            ${
              state.isLocalEditingEnabled
                ? `
            <aside class="timeline-composer-rail">
                ${state.isComposerExpanded ? renderComposerExpanded(viewModel, editingJournal) : renderComposerCollapsed()}
            </aside>
            `
                : ''
            }
        </div>
    `;
}

function renderComposerCollapsed(): string {
  return `
        <button
            type="button"
            class="timeline-composer-toggle"
            data-action="open-composer"
            aria-label="Add journal entry"
            title="Add journal entry"
        >
            <span class="timeline-composer-toggle-icon" aria-hidden="true">+</span>
        </button>
    `;
}

function renderComposerExpanded(
  viewModel: TimelineViewModel,
  editingJournal: JournalEntry | null,
): string {
  return `
        <section class="timeline-composer panel" aria-live="polite">
            <div class="panel-header timeline-composer-header">
                <h3>${editingJournal ? 'Edit Journal Entry' : 'New Journal Entry'}</h3>
                <button type="button" class="button ghost" data-action="close-composer" aria-label="Minimize journal composer">Minimize</button>
            </div>
            <p class="panel-subtitle timeline-composer-subtitle">Capture race notes with lap-linked or manual timestamps.</p>
            ${renderJournalForm(viewModel, editingJournal)}
        </section>
    `;
}

function renderJournalForm(
  viewModel: TimelineViewModel,
  editingJournal: JournalEntry | null,
): string {
  const selectedLap = viewModel.selectedLapRow || null;
  // Do not auto-assign a lap for new journal entries.
  const defaultLapNumber = editingJournal?.lap_number ?? '';

  const lapDerivedIso =
    selectedLap && Number.isFinite(selectedLap.lap_start_offset_ms)
      ? computeLapIso(viewModel.raceStartTime, selectedLap.lap_start_offset_ms)
      : null;

  const eventTimeIso = editingJournal?.event_time_iso || lapDerivedIso || null;
  const eventTimeLocal = isoToDatetimeLocal(eventTimeIso);

  return `
        <form data-action="journal-form" class="timeline-journal-form">
            <label>
                <span>Title</span>
                <input name="title" type="text" maxlength="120" placeholder="Optional headline" value="${escapeHtml(editingJournal?.title || '')}" />
            </label>
            <label>
                <span>Lap Number</span>
                <input name="lap_number" type="number" min="1" placeholder="Optional" value="${escapeHtml(defaultLapNumber)}" />
            </label>
            <label>
                <span>Timestamp (manual override)</span>
                <input name="event_time_local" type="datetime-local" value="${escapeHtml(eventTimeLocal)}" />
            </label>
            <label>
                <span>Color</span>
                <input name="color" type="color" value="${escapeHtml(editingJournal?.color || ANNOTATION_COLOR_TOKENS.journalEntry)}" />
            </label>
            <label>
                <span>Journal Entry</span>
                <textarea name="entry_text" rows="5" placeholder="What happened and why it matters...">${escapeHtml(editingJournal?.entry_text || '')}</textarea>
            </label>
            <div class="form-actions">
                <button type="submit" class="button primary">${editingJournal ? 'Update Journal' : 'Save Journal'}</button>
                ${editingJournal ? '<button type="button" class="button ghost" data-action="cancel-edit-journal">Cancel Edit</button>' : ''}
            </div>
        </form>
    `;
}

function renderTimelineEvents(
  events: TimelineEvent[],
  isLocalEditingEnabled: boolean,
): string {
  if (!events.length) {
    return '<div class="timeline-empty">No timeline events match the current filters.</div>';
  }

  return `
        <div class="timeline-list">
            ${events.map((eventItem) => renderEventCard(eventItem, isLocalEditingEnabled)).join('')}
        </div>
    `;
}

function renderEventCard(
  eventItem: TimelineEvent,
  isLocalEditingEnabled: boolean,
): string {
  const timeLabel = formatIsoTimestamp(eventItem.event_time_iso);
  const lapLabel = Number.isInteger(eventItem.lap_number)
    ? `Lap ${eventItem.lap_number}`
    : Number.isInteger(eventItem.lap_start) &&
        Number.isInteger(eventItem.lap_end)
      ? `Laps ${eventItem.lap_start}-${eventItem.lap_end}`
      : '';

  const isJournal = eventItem.event_type === 'journalEntry';
  const isDriverSwitch = eventItem.event_type === 'driverSwitch';

  if (isDriverSwitch) {
    return renderDriverSwitchCard(eventItem, timeLabel, lapLabel);
  }

  return `
        <article class="timeline-card" style="--event-color: ${escapeHtml(eventItem.color || ANNOTATION_COLOR_TOKENS.fallback)}">
            <header class="timeline-card-header">
                <div class="timeline-card-meta">
                    <span class="timeline-card-badge">${escapeHtml(eventItem.event_label || eventItem.event_type)}</span>
                    <span class="timeline-card-time">${escapeHtml(timeLabel)}</span>
                    <span class="timeline-card-lap">${escapeHtml(lapLabel)}</span>
                    ${eventItem.driver_name ? `<span class="timeline-card-driver">${escapeHtml(eventItem.driver_name)}</span>` : ''}
                </div>
                <div class="timeline-card-actions">
                    ${Number.isInteger(eventItem.lap_number) ? `<button type="button" class="button ghost" data-action="jump-lap" data-lap-number="${eventItem.lap_number}">Jump to Lap</button>` : ''}
                    ${isJournal && isLocalEditingEnabled ? `<button type="button" class="button ghost" data-action="edit-journal" data-id="${escapeHtml(eventItem.source_id)}">Edit</button>` : ''}
                    ${isJournal && isLocalEditingEnabled ? `<button type="button" class="button ghost" data-action="delete-journal" data-id="${escapeHtml(eventItem.source_id)}">Delete</button>` : ''}
                </div>
            </header>
            <h4 class="timeline-card-title">${escapeHtml(eventItem.title || 'Untitled Event')}</h4>
            ${eventItem.body ? `<p class="timeline-card-body">${escapeHtml(eventItem.body)}</p>` : ''}
        </article>
    `;
}

function renderDriverSwitchCard(
  eventItem: TimelineEvent,
  timeLabel: string,
  lapLabel: string,
): string {
  const oldDriverName = `${eventItem.old_driver_name ?? ''}`.trim();
  const newDriverName =
    `${eventItem.new_driver_name ?? eventItem.driver_name ?? ''}`.trim();
  const driverTransition =
    oldDriverName && newDriverName
      ? `${oldDriverName} -> ${newDriverName}`
      : newDriverName || oldDriverName || 'Driver updated';

  return `
        <article class="timeline-card timeline-card-driver-switch" style="--event-color: ${escapeHtml(eventItem.color || ANNOTATION_COLOR_TOKENS.driverStint)}">
            <header class="timeline-card-header">
                <div class="timeline-card-meta">
                    <span class="timeline-card-badge">${escapeHtml(eventItem.event_label || eventItem.event_type)}</span>
                    <span class="timeline-card-time">${escapeHtml(timeLabel)}</span>
                    <span class="timeline-card-lap">${escapeHtml(lapLabel)}</span>
                    <span class="timeline-card-driver-switch-inline">${escapeHtml(driverTransition)}</span>
                </div>
                <div class="timeline-card-actions">
                    ${Number.isInteger(eventItem.lap_number) ? `<button type="button" class="button ghost" data-action="jump-lap" data-lap-number="${eventItem.lap_number}">Jump to Lap</button>` : ''}
                </div>
            </header>
        </article>
    `;
}

function computeLapIso(
  raceStartTime: string | null | undefined,
  lapStartOffsetMs: number | null | undefined,
): string | null {
  if (
    !raceStartTime ||
    typeof lapStartOffsetMs !== 'number' ||
    !Number.isFinite(lapStartOffsetMs)
  ) {
    return null;
  }

  const startDate = new Date(raceStartTime);
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }

  return new Date(startDate.getTime() + lapStartOffsetMs).toISOString();
}

function formatIsoTimestamp(value: string | null | undefined): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return '-';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function datetimeLocalToIso(value: string | null | undefined): string | null {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function isoToDatetimeLocal(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

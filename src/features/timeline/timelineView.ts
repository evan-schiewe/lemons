import { ANNOTATION_COLOR_TOKENS } from '../../app/theme';
import type {
  AnnotationHandlers,
  JournalEntry,
  TimelineEvent,
  TimelineViewHandle,
  TimelineViewModel,
} from '../../types';
import { closestElement, errorMessage } from '../../utils/dom';
import { escapeHtml } from '../../utils/format';
import {
  getFormMediaAttachments,
  MAX_MEDIA_ATTACHMENTS,
  renderMediaAttachmentEditor,
  renderMediaAttachmentGallery,
  setFormMediaAttachments,
  updateFormMediaAttachmentText,
} from '../media/media';

interface TimelineHandlers extends Partial<AnnotationHandlers> {
  onSelectLap?: (lapNumber: number) => void | Promise<void>;
  isLocalEditingEnabled?: boolean;
}

interface TimelineState {
  viewModel: TimelineViewModel | null;
  editingJournalId: string | null;
  isComposerExpanded: boolean;
  isLocalEditingEnabled: boolean;
  bandResizeObserver: ResizeObserver | null;
}

type TimelineDayPhase = 'day' | 'twilight' | 'night' | 'unknown';

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const TIMELINE_DAY_BAND_FALLBACK = 'var(--timeline-day-blue)';
const TIMELINE_DAY_BLUE = [31, 126, 208] as const;
const TIMELINE_SUNSET_ORANGE = [239, 125, 33] as const;
const TIMELINE_NIGHT_BLACK = [8, 10, 13] as const;
const LIGHT_EVENT_BADGE_TEXT = 'var(--color-event-badge-text-light)';
const DARK_EVENT_BADGE_TEXT = 'var(--color-event-badge-text-dark)';
const LIGHT_EVENT_BADGE_TEXT_RGB = { r: 255, g: 254, b: 248 };
const DARK_EVENT_BADGE_TEXT_RGB = { r: 16, g: 17, b: 16 };
const FIRST_LIGHT_MINUTES = 5 * 60 + 16;
const SUNRISE_MINUTES = 5 * 60 + 47;
const SUNSET_MINUTES = 20 * 60 + 23;
const LAST_LIGHT_MINUTES = 20 * 60 + 54;
const MIN_TWILIGHT_STOP_SEPARATION_PERCENT = 1.2;

export function mountTimelineView(
  container: HTMLElement,
  handlers: TimelineHandlers,
): TimelineViewHandle {
  const state: TimelineState = {
    viewModel: null,
    editingJournalId: null,
    isComposerExpanded: false,
    isLocalEditingEnabled: Boolean(handlers?.isLocalEditingEnabled),
    bandResizeObserver: null,
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
    if (!state.isLocalEditingEnabled) {
      return;
    }

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
      media_json: `${formData.get('media_json') ?? '[]'}`,
      color:
        `${formData.get('color') ?? ''}`.trim() ||
        ANNOTATION_COLOR_TOKENS.journalEntry,
    };

    const didSave = await handlers.onSave?.('journalEntry', payload);
    if (didSave) {
      state.editingJournalId = null;
      state.isComposerExpanded = false;
      renderCurrent(container, state, handlers);
    }
  });

  container.addEventListener('change', async (event: Event) => {
    const mediaInput = closestElement<HTMLInputElement>(
      event.target,
      'input[data-action="media-upload"]',
    );
    if (mediaInput) {
      await handleMediaUploadInput(mediaInput);
    }
  });

  container.addEventListener('input', (event: Event) => {
    const mediaTextInput = closestElement<HTMLInputElement>(
      event.target,
      'input[data-action="media-caption"], input[data-action="media-alt"]',
    );
    if (!mediaTextInput) {
      return;
    }

    const form = closestElement<HTMLFormElement>(
      mediaTextInput,
      'form[data-action="journal-form"]',
    );
    const assetId = mediaTextInput.dataset.assetId;
    const field =
      mediaTextInput.dataset.action === 'media-alt' ? 'altText' : 'caption';
    if (form && assetId) {
      updateFormMediaAttachmentText(form, assetId, field, mediaTextInput.value);
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
        'detach-media',
      ].includes(action)
    ) {
      return;
    }

    if (action === 'edit-journal') {
      state.editingJournalId = button.dataset.id || null;
      state.isComposerExpanded = true;
      renderCurrent(container, state, handlers);
      return;
    }

    if (action === 'cancel-edit-journal') {
      state.editingJournalId = null;
      state.isComposerExpanded = false;
      renderCurrent(container, state, handlers);
      return;
    }

    if (action === 'open-composer') {
      state.isComposerExpanded = true;
      renderCurrent(container, state, handlers);
      return;
    }

    if (action === 'close-composer') {
      state.isComposerExpanded = false;
      state.editingJournalId = null;
      renderCurrent(container, state, handlers);
      return;
    }

    if (action === 'detach-media') {
      const form = closestElement<HTMLFormElement>(
        button,
        'form[data-action="journal-form"]',
      );
      const assetId = button.dataset.assetId;
      if (form && assetId) {
        setFormMediaAttachments(
          form,
          getFormMediaAttachments(form).filter(
            (attachment) => attachment.assetId !== assetId,
          ),
          Boolean(handlers.isMediaUploadEnabled?.()),
        );
      }
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

      renderCurrent(container, state, handlers);
    },
    setLocalEditingEnabled(isEnabled: boolean) {
      state.isLocalEditingEnabled = isEnabled;
      if (!isEnabled) {
        state.editingJournalId = null;
        state.isComposerExpanded = false;
      }
      renderCurrent(container, state, handlers);
    },
  };

  async function handleMediaUploadInput(input: HTMLInputElement) {
    const form = closestElement<HTMLFormElement>(
      input,
      'form[data-action="journal-form"]',
    );
    const status = form?.querySelector<HTMLElement>('[data-media-status]');
    const files = Array.from(input.files ?? []);
    if (!form || !files.length) {
      return;
    }

    if (!handlers.onUploadMedia || !handlers.isMediaUploadEnabled?.()) {
      if (status) {
        status.textContent = 'Cloud media upload is not available.';
      }
      input.value = '';
      return;
    }

    const existing = getFormMediaAttachments(form);
    const remaining = MAX_MEDIA_ATTACHMENTS - existing.length;
    if (remaining <= 0) {
      if (status) {
        status.textContent = 'Image limit reached.';
      }
      input.value = '';
      return;
    }

    const selectedFiles = files.slice(0, remaining);
    if (status) {
      status.textContent = `Uploading ${selectedFiles.length} image${selectedFiles.length === 1 ? '' : 's'}...`;
    }

    try {
      const uploaded = await handlers.onUploadMedia(selectedFiles);
      setFormMediaAttachments(
        form,
        [...existing, ...uploaded],
        Boolean(handlers.isMediaUploadEnabled?.()),
      );
      if (status) {
        status.textContent = `Uploaded ${uploaded.length} image${uploaded.length === 1 ? '' : 's'}.`;
      }
    } catch (error) {
      if (status) {
        status.textContent = `Upload failed: ${errorMessage(error)}`;
      }
    } finally {
      input.value = '';
    }
  }
}

function renderCurrent(
  container: HTMLElement,
  state: TimelineState,
  handlers: TimelineHandlers,
): void {
  const viewModel = state.viewModel;
  if (!viewModel) {
    resetTimelineBandObserver(state);
    container.innerHTML =
      '<div class="timeline-empty">Load a race to view the event timeline.</div>';
    return;
  }

  const editingJournal = state.editingJournalId
    ? (viewModel.journalEntries || []).find(
        (item) => item.id === state.editingJournalId,
      ) || null
    : null;
  const canUploadMedia = Boolean(
    state.isLocalEditingEnabled && handlers.isMediaUploadEnabled?.(),
  );

  container.innerHTML = `
        <div class="timeline-layout">
            <section class="timeline-entries">
                ${renderTimelineEvents(viewModel.timelineEvents || [], state.isLocalEditingEnabled)}
            </section>
            ${
              state.isLocalEditingEnabled
                ? `
            <aside class="timeline-composer-rail">
                ${state.isComposerExpanded ? renderComposerExpanded(viewModel, editingJournal, canUploadMedia) : renderComposerCollapsed()}
            </aside>
            `
                : ''
            }
        </div>
    `;

  observeTimelineBand(container, state);
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
  canUploadMedia: boolean,
): string {
  return `
        <section class="timeline-composer panel" aria-live="polite">
            <div class="panel-header timeline-composer-header">
                <h3>${editingJournal ? 'Edit Journal Entry' : 'New Journal Entry'}</h3>
                <button type="button" class="button ghost" data-action="close-composer" aria-label="Minimize journal composer">Minimize</button>
            </div>
            <p class="panel-subtitle timeline-composer-subtitle">Capture race notes with lap-linked or manual timestamps.</p>
            ${renderJournalForm(viewModel, editingJournal, canUploadMedia)}
        </section>
    `;
}

function renderJournalForm(
  viewModel: TimelineViewModel,
  editingJournal: JournalEntry | null,
  canUploadMedia: boolean,
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
            ${renderMediaAttachmentEditor(editingJournal?.media_json ?? '[]', canUploadMedia)}
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
  const bandStyle = `--timeline-day-night-band: ${TIMELINE_DAY_BAND_FALLBACK};`;

  if (!events.length) {
    return `
        <div class="timeline-list timeline-list-empty" style="${escapeHtml(bandStyle)}">
            <div class="timeline-empty">No timeline events match the current filters.</div>
        </div>
    `;
  }

  return `
        <div class="timeline-list" style="${escapeHtml(bandStyle)}">
            ${events.map((eventItem) => renderEventCard(eventItem, isLocalEditingEnabled)).join('')}
        </div>
    `;
}

function getTimelineBandColor(eventTimeIso: string | null | undefined): string {
  const eventDate = parseIsoDate(eventTimeIso);
  if (!eventDate) {
    return TIMELINE_DAY_BAND_FALLBACK;
  }

  const eventMinutes = getDateMinutes(eventDate);
  if (eventMinutes < FIRST_LIGHT_MINUTES) {
    return `rgb(${TIMELINE_NIGHT_BLACK.join(' ')})`;
  }

  if (eventMinutes < SUNRISE_MINUTES) {
    return mixTimelineBandColor(
      TIMELINE_SUNSET_ORANGE,
      TIMELINE_DAY_BLUE,
      normalizeRange(eventMinutes, FIRST_LIGHT_MINUTES, SUNRISE_MINUTES),
    );
  }

  if (eventMinutes < SUNSET_MINUTES) {
    return `rgb(${TIMELINE_DAY_BLUE.join(' ')})`;
  }

  if (eventMinutes < LAST_LIGHT_MINUTES) {
    return mixTimelineBandColor(
      TIMELINE_SUNSET_ORANGE,
      TIMELINE_NIGHT_BLACK,
      normalizeRange(eventMinutes, SUNSET_MINUTES, LAST_LIGHT_MINUTES),
    );
  }

  return `rgb(${TIMELINE_NIGHT_BLACK.join(' ')})`;
}

function getTimelineBandMinutes(
  eventTimeIso: string | null | undefined,
): string {
  const eventDate = parseIsoDate(eventTimeIso);
  return eventDate ? `${getDateMinutes(eventDate)}` : '';
}

function getTimelineDayPhase(
  eventTimeIso: string | null | undefined,
): TimelineDayPhase {
  const eventDate = parseIsoDate(eventTimeIso);
  if (!eventDate) {
    return 'unknown';
  }

  const eventMinutes = getDateMinutes(eventDate);
  if (
    eventMinutes < FIRST_LIGHT_MINUTES ||
    eventMinutes >= LAST_LIGHT_MINUTES
  ) {
    return 'night';
  }

  if (eventMinutes < SUNRISE_MINUTES || eventMinutes >= SUNSET_MINUTES) {
    return 'twilight';
  }

  return 'day';
}

function parseTimelineDayPhase(
  value: string | null | undefined,
): TimelineDayPhase {
  return value === 'day' || value === 'twilight' || value === 'night'
    ? value
    : 'unknown';
}

function getDateMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function parseIsoDate(value: string | null | undefined): Date | null {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function formatGradientPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return clamped.toFixed(3).replace(/\.?0+$/, '');
}

function observeTimelineBand(
  container: HTMLElement,
  state: TimelineState,
): void {
  resetTimelineBandObserver(state);

  const list = container.querySelector<HTMLElement>('.timeline-list');
  if (!list) {
    return;
  }

  syncTimelineBandToCardPositions(list);

  const observer = new ResizeObserver(() => {
    syncTimelineBandToCardPositions(list);
  });
  observer.observe(list);
  list.querySelectorAll<HTMLElement>('.timeline-card').forEach((card) => {
    observer.observe(card);
  });
  state.bandResizeObserver = observer;

  requestAnimationFrame(() => {
    syncTimelineBandToCardPositions(list);
  });
}

function resetTimelineBandObserver(state: TimelineState): void {
  state.bandResizeObserver?.disconnect();
  state.bandResizeObserver = null;
}

function syncTimelineBandToCardPositions(list: HTMLElement): void {
  const cards = Array.from(
    list.querySelectorAll<HTMLElement>('.timeline-card'),
  );
  if (!cards.length) {
    return;
  }

  const listRect = list.getBoundingClientRect();
  if (!Number.isFinite(listRect.height) || listRect.height <= 0) {
    return;
  }

  const cardStops = cards.map((card) => {
    const cardRect = card.getBoundingClientRect();
    const cardCenter = cardRect.top + cardRect.height / 2;
    const position = ((cardCenter - listRect.top) / listRect.height) * 100;

    return {
      color: card.dataset.timelineBandColor || TIMELINE_DAY_BAND_FALLBACK,
      minutes: Number.parseFloat(card.dataset.timelineBandMinutes || ''),
      phase: parseTimelineDayPhase(card.dataset.timelineDayPhase),
      position: formatGradientPercent(position),
      rawPosition: Math.max(0, Math.min(100, position)),
    };
  });

  const firstColor = cardStops[0].color;
  const lastColor = cardStops[cardStops.length - 1].color;
  if (cardStops.length === 1) {
    list.style.setProperty(
      '--timeline-day-night-band',
      `linear-gradient(180deg, ${firstColor} 0%, ${firstColor} 100%)`,
    );
    return;
  }

  const stops = [
    `${firstColor} 0%`,
    ...buildMeasuredTimelineBandStops(cardStops),
    `${lastColor} 100%`,
  ];

  list.style.setProperty(
    '--timeline-day-night-band',
    `linear-gradient(180deg, ${stops.join(', ')})`,
  );
}

function buildMeasuredTimelineBandStops(
  cardStops: Array<{
    color: string;
    minutes: number;
    phase: TimelineDayPhase;
    position: string;
    rawPosition: number;
  }>,
): string[] {
  const stops: string[] = [];
  for (let index = 0; index < cardStops.length; index += 1) {
    if (index > 0) {
      stops.push(
        ...buildSyntheticTwilightStops(cardStops[index - 1], cardStops[index]),
      );
    }

    stops.push(`${cardStops[index].color} ${cardStops[index].position}%`);
  }

  return stops;
}

function buildSyntheticTwilightStops(
  previous: {
    minutes: number;
    phase: TimelineDayPhase;
    rawPosition: number;
  },
  next: {
    minutes: number;
    phase: TimelineDayPhase;
    rawPosition: number;
  },
): string[] {
  if (!Number.isFinite(previous.minutes) || !Number.isFinite(next.minutes)) {
    return [];
  }

  if (next.rawPosition <= previous.rawPosition) {
    return [];
  }

  if (previous.phase === 'day' && next.phase === 'day') {
    return [];
  }

  return [
    ...buildTwilightBoundaryStops(previous, next, SUNSET_MINUTES),
    ...buildTwilightBoundaryStops(previous, next, FIRST_LIGHT_MINUTES),
  ].sort((left, right) => {
    const leftPosition = Number.parseFloat(left.split(' ').at(-1) ?? '0');
    const rightPosition = Number.parseFloat(right.split(' ').at(-1) ?? '0');
    return leftPosition - rightPosition;
  });
}

function buildTwilightBoundaryStops(
  previous: {
    minutes: number;
    rawPosition: number;
  },
  next: {
    minutes: number;
    rawPosition: number;
  },
  boundaryMinutes: number,
): string[] {
  if (
    !timeRangeCrossesBoundary(previous.minutes, next.minutes, boundaryMinutes)
  ) {
    return [];
  }

  const position = interpolateBoundaryPosition(previous, next, boundaryMinutes);
  if (!Number.isFinite(position)) {
    return [];
  }

  const constrainedPosition = clamp(
    position,
    previous.rawPosition + MIN_TWILIGHT_STOP_SEPARATION_PERCENT,
    next.rawPosition - MIN_TWILIGHT_STOP_SEPARATION_PERCENT,
  );
  if (
    constrainedPosition <= previous.rawPosition ||
    constrainedPosition >= next.rawPosition
  ) {
    return [];
  }

  return [
    `rgb(${TIMELINE_SUNSET_ORANGE.join(' ')}) ${formatGradientPercent(constrainedPosition)}%`,
  ];
}

function timeRangeCrossesBoundary(
  previousMinutes: number,
  nextMinutes: number,
  boundaryMinutes: number,
): boolean {
  if (nextMinutes >= previousMinutes) {
    return previousMinutes < boundaryMinutes && nextMinutes > boundaryMinutes;
  }

  return previousMinutes < boundaryMinutes || nextMinutes > boundaryMinutes;
}

function interpolateBoundaryPosition(
  previous: {
    minutes: number;
    rawPosition: number;
  },
  next: {
    minutes: number;
    rawPosition: number;
  },
  boundaryMinutes: number,
): number {
  const nextMinutes =
    next.minutes >= previous.minutes ? next.minutes : next.minutes + 24 * 60;
  const normalizedBoundary =
    boundaryMinutes > previous.minutes
      ? boundaryMinutes
      : boundaryMinutes + 24 * 60;
  const progress = normalizeRange(
    normalizedBoundary,
    previous.minutes,
    nextMinutes,
  );

  return (
    previous.rawPosition + (next.rawPosition - previous.rawPosition) * progress
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRange(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) {
    return 0;
  }

  return (value - min) / span;
}

function mixTimelineBandColor(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  amount: number,
): string {
  const clampedAmount = Math.max(0, Math.min(1, amount));
  const channels = from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * clampedAmount),
  );

  return `rgb(${channels.join(' ')})`;
}

function renderTimelineDayPhaseIcon(
  eventTimeIso: string | null | undefined,
): string {
  const phase = getTimelineDayPhase(eventTimeIso);
  if (phase === 'unknown') {
    return '';
  }

  const label =
    phase === 'day'
      ? 'Daytime'
      : phase === 'twilight'
        ? 'Twilight'
        : 'Nighttime';

  return `
            <span class="timeline-day-phase-icon timeline-day-phase-icon-${phase}" role="img" aria-label="${label}">
                ${renderTimelineDayPhaseSvg(phase)}
            </span>`;
}

function renderTimelineDayPhaseSvg(
  phase: Exclude<TimelineDayPhase, 'unknown'>,
): string {
  if (phase === 'day') {
    return `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
                </svg>`;
  }

  if (phase === 'twilight') {
    return `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M4 17h16" />
                    <path d="M7 17a5 5 0 0 1 10 0" />
                    <path d="M12 5v3M5.64 8.64l2.12 2.12M18.36 8.64l-2.12 2.12" />
                </svg>`;
  }

  return `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />
                </svg>`;
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
  const journalActions = [
    isJournal && isLocalEditingEnabled
      ? `<button type="button" class="button ghost" data-action="edit-journal" data-id="${escapeHtml(eventItem.source_id)}">Edit</button>`
      : '',
    isJournal && isLocalEditingEnabled
      ? `<button type="button" class="button ghost" data-action="delete-journal" data-id="${escapeHtml(eventItem.source_id)}">Delete</button>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  if (isDriverSwitch) {
    return renderDriverSwitchCard(eventItem, timeLabel, lapLabel);
  }

  const bandColor = getTimelineBandColor(eventItem.event_time_iso);
  const bandMinutes = getTimelineBandMinutes(eventItem.event_time_iso);
  const phase = getTimelineDayPhase(eventItem.event_time_iso);
  const phaseIcon = renderTimelineDayPhaseIcon(eventItem.event_time_iso);
  const eventStyle = renderTimelineEventStyle(
    eventItem.color || ANNOTATION_COLOR_TOKENS.fallback,
  );

  return `
        <article class="timeline-card" data-timeline-band-color="${escapeHtml(bandColor)}" data-timeline-band-minutes="${escapeHtml(bandMinutes)}" data-timeline-day-phase="${phase}" style="${escapeHtml(eventStyle)}">
            ${phaseIcon}
            <header class="timeline-card-header">
                <div class="timeline-card-meta">
                    <span class="timeline-card-badge">${escapeHtml(eventItem.event_label || eventItem.event_type)}</span>
                    <span class="timeline-card-time">${escapeHtml(timeLabel)}</span>
                    ${renderTimelineLapMeta(lapLabel, eventItem.lap_number)}
                    ${eventItem.driver_name ? `<span class="timeline-card-driver">${escapeHtml(eventItem.driver_name)}</span>` : ''}
                </div>
                ${journalActions ? `<div class="timeline-card-actions">${journalActions}</div>` : ''}
            </header>
            <h4 class="timeline-card-title">${escapeHtml(eventItem.title || 'Untitled Event')}</h4>
            ${eventItem.body ? `<p class="timeline-card-body">${escapeHtml(eventItem.body)}</p>` : ''}
            ${renderMediaAttachmentGallery(eventItem.media_json)}
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
  const bandColor = getTimelineBandColor(eventItem.event_time_iso);
  const bandMinutes = getTimelineBandMinutes(eventItem.event_time_iso);
  const phase = getTimelineDayPhase(eventItem.event_time_iso);
  const phaseIcon = renderTimelineDayPhaseIcon(eventItem.event_time_iso);
  const eventStyle = renderTimelineEventStyle(
    eventItem.color || ANNOTATION_COLOR_TOKENS.driverStint,
  );
  const driverTransition =
    oldDriverName && newDriverName
      ? `${oldDriverName} -> ${newDriverName}`
      : newDriverName || oldDriverName || 'Driver updated';

  return `
        <article class="timeline-card timeline-card-driver-switch" data-timeline-band-color="${escapeHtml(bandColor)}" data-timeline-band-minutes="${escapeHtml(bandMinutes)}" data-timeline-day-phase="${phase}" style="${escapeHtml(eventStyle)}">
            ${phaseIcon}
            <header class="timeline-card-header">
                <div class="timeline-card-meta">
                    <span class="timeline-card-badge">${escapeHtml(eventItem.event_label || eventItem.event_type)}</span>
                    <span class="timeline-card-time">${escapeHtml(timeLabel)}</span>
                    ${renderTimelineLapMeta(lapLabel, eventItem.lap_number)}
                    <span class="timeline-card-driver-switch-inline">${escapeHtml(driverTransition)}</span>
                </div>
            </header>
        </article>
    `;
}

function renderTimelineEventStyle(color: string): string {
  const eventColor = normalizeTimelineEventColor(color);
  return `--event-color: ${eventColor}; --event-text-color: ${getTimelineBadgeTextColor(eventColor)};`;
}

function normalizeTimelineEventColor(color: string): string {
  const trimmed = color.trim();
  if (parseCssColor(trimmed)) {
    return trimmed;
  }

  return ANNOTATION_COLOR_TOKENS.fallback;
}

function getTimelineBadgeTextColor(backgroundColor: string): string {
  const color = parseCssColor(backgroundColor);
  if (!color) {
    return DARK_EVENT_BADGE_TEXT;
  }

  const lightContrast = getContrastRatio(color, LIGHT_EVENT_BADGE_TEXT_RGB);
  const darkContrast = getContrastRatio(color, DARK_EVENT_BADGE_TEXT_RGB);
  return lightContrast > darkContrast
    ? LIGHT_EVENT_BADGE_TEXT
    : DARK_EVENT_BADGE_TEXT;
}

function getContrastRatio(left: RgbColor, right: RgbColor): number {
  const leftLuminance = getRelativeLuminance(left);
  const rightLuminance = getRelativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function getRelativeLuminance(color: RgbColor): number {
  const channels = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function parseCssColor(color: string): RgbColor | null {
  const trimmed = color.trim().toLowerCase();
  if (trimmed === 'black') {
    return { r: 0, g: 0, b: 0 };
  }
  if (trimmed === 'white') {
    return { r: 255, g: 255, b: 255 };
  }

  return parseHexColor(trimmed) ?? parseRgbColor(trimmed);
}

function parseHexColor(color: string): RgbColor | null {
  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (!hex) {
    return null;
  }

  const channels =
    hex.length === 3
      ? hex.split('').map((value) => Number.parseInt(`${value}${value}`, 16))
      : [
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
        ];

  return { r: channels[0], g: channels[1], b: channels[2] };
}

function parseRgbColor(color: string): RgbColor | null {
  const match = color.match(/^rgba?\((.+)\)$/i);
  if (!match) {
    return null;
  }

  const channelsValue = match[1].split('/')[0].trim();
  const parts = channelsValue.includes(',')
    ? channelsValue.split(',').slice(0, 3)
    : channelsValue.split(/\s+/).slice(0, 3);

  if (parts.length !== 3) {
    return null;
  }

  const channels = parts.map(parseRgbChannel);
  if (channels.some((channel) => !Number.isFinite(channel))) {
    return null;
  }

  return { r: channels[0], g: channels[1], b: channels[2] };
}

function parseRgbChannel(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) {
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent)
      ? clamp(Math.round((percent / 100) * 255), 0, 255)
      : Number.NaN;
  }

  const channel = Number.parseFloat(trimmed);
  return Number.isFinite(channel)
    ? clamp(Math.round(channel), 0, 255)
    : Number.NaN;
}

function renderTimelineLapMeta(
  lapLabel: string,
  lapNumber: number | null,
): string {
  if (!lapLabel) {
    return '';
  }

  const lapInfoButton = Number.isInteger(lapNumber)
    ? `<button
            type="button"
            class="timeline-card-lap-info"
            data-action="jump-lap"
            data-lap-number="${escapeHtml(lapNumber)}"
            aria-label="Inspect lap ${escapeHtml(lapNumber)}"
            title="Inspect lap ${escapeHtml(lapNumber)}"
        >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <path d="M12 8h.01" />
            </svg>
        </button>`
    : '';

  return `<span class="timeline-card-lap">${escapeHtml(lapLabel)}${lapInfoButton}</span>`;
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

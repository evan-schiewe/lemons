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
  bandResizeObserver: ResizeObserver | null;
}

type TimelineDayPhase = 'day' | 'twilight' | 'night' | 'unknown';

const TIMELINE_DAY_BAND_FALLBACK = 'var(--timeline-day-blue)';
const TIMELINE_DAY_BLUE = [31, 126, 208] as const;
const TIMELINE_SUNSET_ORANGE = [239, 125, 33] as const;
const TIMELINE_NIGHT_BLACK = [8, 10, 13] as const;
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
    setLocalEditingEnabled(isEnabled: boolean) {
      state.isLocalEditingEnabled = isEnabled;
      if (!isEnabled) {
        state.editingJournalId = null;
        state.isComposerExpanded = false;
      }
      renderCurrent(container, state);
    },
  };
}

function renderCurrent(container: HTMLElement, state: TimelineState): void {
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

  return `
        <article class="timeline-card" data-timeline-band-color="${escapeHtml(bandColor)}" data-timeline-band-minutes="${escapeHtml(bandMinutes)}" data-timeline-day-phase="${phase}" style="--event-color: ${escapeHtml(eventItem.color || ANNOTATION_COLOR_TOKENS.fallback)};">
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
  const driverTransition =
    oldDriverName && newDriverName
      ? `${oldDriverName} -> ${newDriverName}`
      : newDriverName || oldDriverName || 'Driver updated';

  return `
        <article class="timeline-card timeline-card-driver-switch" data-timeline-band-color="${escapeHtml(bandColor)}" data-timeline-band-minutes="${escapeHtml(bandMinutes)}" data-timeline-day-phase="${phase}" style="--event-color: ${escapeHtml(eventItem.color || ANNOTATION_COLOR_TOKENS.driverStint)};">
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

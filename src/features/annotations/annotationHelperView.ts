import { ANNOTATION_COLOR_TOKENS } from '../../app/theme';
import type {
  AnnotationHandlers,
  AnnotationHelperHandle,
  AnnotationHelperViewModel,
  AnnotationKind,
  AnnotationPayload,
  CandidateLap,
  LapNote,
  RaceAnnotations,
  RangeEvent,
  TaggedIncident,
} from '../../types';
import { closestElement } from '../../utils/dom';
import { escapeHtml } from '../../utils/format';
import { formatLapTimeHHMMSS, formatWallClock } from '../../utils/time';

/**
 * Annotation Helper View Controller
 *
 * Renders and manages the guided annotation helper workflow:
 * - Candidate queue with one-at-a-time navigation
 * - Quick actions (incident, event, stint, reviewed/no-action)
 * - Embedded advanced forms for full edits
 * - Auto-advance toggle and state persistence
 */

interface AnnotationHelperHandlers extends AnnotationHandlers {
  onOpenComposer?: (
    kind: AnnotationKind,
    options?: { prefill?: AnnotationPayload },
  ) => void;
  onOpenEditor?: (kind: AnnotationKind, id: string) => void;
  onNavigate: (direction: 'prev' | 'next' | 'jump-unresolved') => void;
  onToggleAutoAdvance: () => void;
}

interface AnnotationHelperState {
  viewModel: AnnotationHelperViewModel | null;
}

export function mountAnnotationHelper(
  container: HTMLElement,
  handlers: AnnotationHelperHandlers,
): AnnotationHelperHandle {
  const state: AnnotationHelperState = { viewModel: null };

  // Delegation for button actions (delete, edit, quick actions)
  container.addEventListener('click', async (event: MouseEvent) => {
    const button = closestElement<HTMLButtonElement>(
      event.target,
      'button[data-action]',
    );
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    const kind = readAnnotationKind(button.dataset.kind);

    if (action === 'delete' && kind) {
      const id = button.dataset.id;
      if (id) {
        await handlers.onDelete(kind, id);
      }
      return;
    }

    if (action === 'edit' && kind) {
      const id = button.dataset.id;
      if (id) {
        handlers.onOpenEditor?.(kind, id);
      }
      return;
    }

    // Quick actions for helper workflow
    if (action === 'prev-candidate') {
      handlers.onNavigate('prev');
      return;
    }

    if (action === 'next-candidate') {
      handlers.onNavigate('next');
      return;
    }

    if (action === 'jump-unresolved') {
      handlers.onNavigate('jump-unresolved');
      return;
    }

    if (action === 'toggle-auto-advance') {
      handlers.onToggleAutoAdvance();
      return;
    }

    if (action === 'quick-incident') {
      handlers.onOpenComposer?.('taggedIncident');
      return;
    }

    if (action === 'quick-range-event') {
      handlers.onOpenComposer?.('rangeEvent');
      return;
    }

    if (action === 'quick-stint-start') {
      const selected = state.viewModel?.selectedLapRow;
      if (selected) {
        handlers.onOpenComposer?.('driverStint', {
          prefill: {
            driver_name: selected.driver_name,
            start_lap: selected.lap_number,
            end_lap: selected.lap_number,
          },
        });
      }
      return;
    }

    if (action === 'quick-stint-end') {
      const selected = state.viewModel?.selectedLapRow;
      if (selected) {
        handlers.onOpenComposer?.('driverStint', {
          prefill: {
            driver_name: selected.driver_name,
            start_lap: selected.lap_number,
            end_lap: selected.lap_number,
          },
        });
      }
      return;
    }

    if (action === 'mark-reviewed') {
      // Quick action: create a REVIEWED_NO_ACTION lap note
      const selected = state.viewModel?.selectedLapRow;
      if (selected) {
        await handlers.onSave('lapNote', {
          lap_number: selected.lap_number,
          driver_name: selected.driver_name,
          note_text: 'REVIEWED_NO_ACTION',
          color: ANNOTATION_COLOR_TOKENS.reviewed,
        });
      }
      return;
    }
  });

  return {
    render(viewModel: AnnotationHelperViewModel | null) {
      state.viewModel = viewModel;
      if (!viewModel) {
        container.innerHTML = '<div class="helper-empty">No race loaded</div>';
        return;
      }

      container.innerHTML = renderHelper(viewModel);
    },
  };
}

function renderHelper(viewModel: AnnotationHelperViewModel): string {
  const { candidates, currentIndex, annotations, autoAdvance, raceStartTime } =
    viewModel;

  if (!candidates || candidates.length === 0) {
    return '<div class="helper-empty"><p>No candidates found. All laps reviewed!</p></div>';
  }

  const currentCandidate = candidates[currentIndex] || candidates[0];
  const unreviewed = candidates.filter((c) => !c.isReviewed).length;

  return `
    <div class="helper-wrapper">
      ${renderQueueHeader(currentCandidate, currentIndex, candidates.length, unreviewed, raceStartTime)}
      ${renderNavigationControls(currentIndex, candidates.length, autoAdvance, unreviewed)}
      ${renderQuickActions()}
      ${renderRelatedAnnotations(currentCandidate, annotations)}
    </div>
  `;
}

function renderQueueHeader(
  candidate: CandidateLap,
  index: number,
  total: number,
  unreviewed: number,
  raceStartTime: string | null,
): string {
  const statusClass = candidate.isReviewed
    ? 'helper-status-reviewed'
    : 'helper-status-unreviewed';
  const typeColor =
    {
      repair: ANNOTATION_COLOR_TOKENS.repair,
      pit: ANNOTATION_COLOR_TOKENS.pit,
      outlier: ANNOTATION_COLOR_TOKENS.outlier,
    }[candidate.candidate_type] || ANNOTATION_COLOR_TOKENS.fallback;

  const contextLabel = `Lap ${escapeHtml(candidate.lap_number)}`;
  const driverLabel = escapeHtml(candidate.driver_name || 'Unknown driver');
  const lapTimeMs = escapeHtml(formatLapTimeHHMMSS(candidate.lap_time_ms));
  const wallClockTime = escapeHtml(
    formatWallClock(raceStartTime, candidate.lap_start_offset_ms),
  );
  const positionLabel = escapeHtml(candidate.position_value ?? '—');
  const gapLabel = escapeHtml(candidate.gap_leader_display || '—');

  return `
    <div class="helper-header">
      <div class="helper-header-main">
        <div class="helper-queue-badge">
          <span class="helper-index">${index + 1}</span>
          <span class="helper-total">of ${total}</span>
          <span class="helper-unreviewed">${unreviewed} unreviewed</span>
        </div>
        <div class="helper-candidate-badge" style="border-color: ${typeColor}">
          ${escapeHtml(candidate.candidate_type.toUpperCase())}
        </div>
      </div>
      <div class="helper-context">
        <div class="helper-context-main">
          <strong>${contextLabel}</strong>
          <span class="helper-driver">${driverLabel}</span>
        </div>
        <div class="helper-metrics">
          <span class="helper-metric">Lap Time: ${lapTimeMs}</span>
          <span class="helper-metric">Time of Day: ${wallClockTime}</span>
          <span class="helper-metric">Position: ${positionLabel}</span>
          <span class="helper-metric">Gap: ${gapLabel}</span>
        </div>
      </div>
      <div class="helper-status ${statusClass}">
        ${candidate.isReviewed ? '✓ Reviewed' : '⊘ Unreviewed'}
      </div>
    </div>
  `;
}

function renderNavigationControls(
  currentIndex: number,
  total: number,
  autoAdvance: boolean,
  unreviewed: number,
): string {
  const canGoBack = currentIndex > 0;
  const canGoNext = currentIndex < total - 1;
  const hasUnreviewed = unreviewed > 0;

  return `
    <div class="helper-controls">
      <div class="helper-nav-buttons">
        <button
          class="button ghost helper-nav-btn"
          data-action="prev-candidate"
          ${!canGoBack ? 'disabled' : ''}
          type="button"
        >
          ← Previous
        </button>
        <button
          class="button ghost helper-nav-btn"
          data-action="next-candidate"
          ${!canGoNext ? 'disabled' : ''}
          type="button"
        >
          Next →
        </button>
        <button
          class="button ghost helper-nav-btn"
          data-action="jump-unresolved"
          ${!hasUnreviewed ? 'disabled' : ''}
          type="button"
        >
          Jump to First Unreviewed
        </button>
      </div>
      <div class="helper-auto-advance">
        <label class="helper-toggle">
          <input
            type="checkbox"
            data-action="toggle-auto-advance"
            ${autoAdvance ? 'checked' : ''}
          />
          <span>Auto-advance on save</span>
        </label>
      </div>
    </div>
  `;
}

function renderQuickActions(): string {
  return `
    <div class="helper-quick-actions">
      <button class="button secondary" data-action="quick-incident" type="button">
        + Incident
      </button>
      <button class="button secondary" data-action="quick-range-event" type="button">
        + Range Event
      </button>
      <button class="button secondary" data-action="quick-stint-start" type="button">
        ⊢ Start Stint
      </button>
      <button class="button secondary" data-action="quick-stint-end" type="button">
        ⊣ End Stint
      </button>
      <button class="button ghost helper-mark-reviewed" data-action="mark-reviewed" type="button">
        ✓ Mark Reviewed (No Action)
      </button>
    </div>
  `;
}

function renderRelatedAnnotations(
  candidate: CandidateLap,
  annotations: RaceAnnotations,
): string {
  const relatedNotes = annotations.lapNotes.filter(
    (n) => n.lap_number === candidate.lap_number,
  );
  const relatedIncidents = annotations.taggedIncidents.filter(
    (i) => i.lap_number === candidate.lap_number,
  );
  const relatedRanges = annotations.rangeEvents.filter(
    (e) =>
      e.start_lap <= candidate.lap_number && candidate.lap_number <= e.end_lap,
  );

  const total =
    relatedNotes.length + relatedIncidents.length + relatedRanges.length;
  if (total === 0) {
    return '';
  }

  return `
    <div class="helper-related-annotations">
      <h4>Related Annotations (${total})</h4>
      ${relatedNotes.length ? renderListSection('Notes', 'lapNote', relatedNotes, renderLapNoteItem) : ''}
      ${relatedIncidents.length ? renderListSection('Incidents', 'taggedIncident', relatedIncidents, renderTaggedIncidentItem) : ''}
      ${relatedRanges.length ? renderListSection('Range Events', 'rangeEvent', relatedRanges, renderRangeEventItem) : ''}
    </div>
  `;
}

function renderListSection<T extends { id: string }>(
  title: string,
  kind: AnnotationKind,
  items: T[],
  renderItem: (item: T, kind: AnnotationKind) => string,
): string {
  return `
    <section class="helper-annotation-list-section">
      <h5>${escapeHtml(title)}</h5>
      <div class="helper-annotation-list">
        ${items.map((item) => renderItem(item, kind)).join('')}
      </div>
    </section>
  `;
}

function renderLapNoteItem(item: LapNote, kind: AnnotationKind): string {
  return `
    <article class="helper-annotation-item">
      <strong>Lap ${escapeHtml(item.lap_number)}</strong>
      <p>${escapeHtml(item.note_text)}</p>
      <div class="helper-annotation-meta">${escapeHtml(item.driver_name || 'No driver')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderTaggedIncidentItem(
  item: TaggedIncident,
  kind: AnnotationKind,
): string {
  return `
    <article class="helper-annotation-item">
      <strong>Lap ${escapeHtml(item.lap_number)} · ${escapeHtml(item.tag)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="helper-annotation-meta">${escapeHtml(item.details || '')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderRangeEventItem(item: RangeEvent, kind: AnnotationKind): string {
  return `
    <article class="helper-annotation-item">
      <strong>Laps ${escapeHtml(item.start_lap)}–${escapeHtml(item.end_lap)}</strong>
      <p>${escapeHtml(item.title)}</p>
      <div class="helper-annotation-meta">${escapeHtml(item.details || '')}</div>
      ${renderItemActions(kind, item.id)}
    </article>
  `;
}

function renderItemActions(kind: AnnotationKind, id: string): string {
  return `
    <div class="form-actions">
      <button class="button ghost" data-action="edit" data-kind="${kind}" data-id="${escapeHtml(id)}" type="button">Edit</button>
      <button class="button ghost" data-action="delete" data-kind="${kind}" data-id="${escapeHtml(id)}" type="button">Delete</button>
    </div>
  `;
}

function readAnnotationKind(value: string | undefined): AnnotationKind | null {
  if (
    value === 'lapNote' ||
    value === 'taggedIncident' ||
    value === 'rangeEvent' ||
    value === 'driverStint' ||
    value === 'journalEntry'
  ) {
    return value;
  }

  return null;
}

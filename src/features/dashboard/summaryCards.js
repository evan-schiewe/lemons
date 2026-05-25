import { escapeHtml, formatNumber } from '../../utils/format.js';
import { formatDurationMs } from '../../utils/time.js';

export function renderSummaryCards(container, summary) {
    if (!summary || Number(summary.total_laps) === 0) {
        container.innerHTML = '<div class="summary-card"><span>No race selected</span><strong>Import a CSV</strong></div>';
        return;
    }

    const cards = [
        { label: 'Best Lap', value: formatDurationMs(summary.best_lap_ms) },
        { label: 'Green Flag Pace', value: formatDurationMs(summary.avg_green_ms) },
        { label: 'Long Lap Outliers', value: formatNumber(summary.long_lap_outliers) },
        { label: 'Pit / Repair Candidates', value: formatNumber(summary.pit_repair_candidates) },
        { label: 'Total Laps', value: formatNumber(summary.total_laps) },
        {
            label: 'Position Range',
            value: Number.isFinite(summary.best_position) && Number.isFinite(summary.worst_position)
                ? `${formatNumber(summary.best_position)}-${formatNumber(summary.worst_position)}`
                : '-',
        },
        {
            label: 'Annotations',
            value: `${formatNumber(summary.lap_note_count)} notes / ${formatNumber(summary.incident_count)} incidents`,
        },
        { label: 'Stints / Events', value: `${formatNumber(summary.stint_count)} / ${formatNumber(summary.range_event_count)}` },
    ];

    container.innerHTML = cards
        .map(
            (card) => `
        <article class="summary-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
        </article>
      `,
        )
        .join('');
}
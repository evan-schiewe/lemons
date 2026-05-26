import type { LapRow, SortState } from '../../types';
import { escapeHtml, formatNumber, formatSpeed } from '../../utils/format';
import { formatDurationMs, formatWallClock } from '../../utils/time';

export function renderLapTable(
  tbody: HTMLTableSectionElement,
  rows: LapRow[],
  selectedLapId: string,
  raceStartTimeIso: string | null = null,
): void {
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="9">No laps match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((row) => {
      const hasPitTag = Boolean(row.is_pit_lap);
      const hasIncidentTag = Number(row.incident_count) > 0;
      const flags = [
        hasPitTag ? 'Pit' : null,
        row.is_outlier && !hasPitTag && !hasIncidentTag ? 'Outlier' : null,
        row.note_count ? `${row.note_count} note` : null,
        row.incident_count ? `${row.incident_count} incident` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      return `
                <tr data-lap-id="${escapeHtml(row.id)}" class="${row.id === selectedLapId ? 'is-selected' : ''}">
          <td>${escapeHtml(row.lap_number)}</td>
                    <td>${escapeHtml(formatWallClock(raceStartTimeIso, row.lap_start_offset_ms))}</td>
                      <td>${escapeHtml(row.display_driver_name || row.driver_name || '-')}</td>
          <td>${escapeHtml(formatDurationMs(row.lap_time_ms))}</td>
          <td>${escapeHtml(formatNumber(row.position_value))}</td>
          <td>${escapeHtml(formatSpeed(row.speed_mph))}</td>
          <td>${escapeHtml(row.gap_ahead_display || '-')}</td>
          <td>${escapeHtml(row.gap_leader_display || '-')}</td>
          <td>${escapeHtml(flags || '-')}</td>
        </tr>
      `;
    })
    .join('');
}

export function updateSortIndicators(
  table: HTMLTableElement,
  sort: SortState,
): void {
  table
    .querySelectorAll<HTMLTableCellElement>('thead th[data-sort]')
    .forEach((header) => {
      const column = header.dataset.sort;
      header.textContent = (header.textContent ?? '').replace(/\s[↑↓]$/, '');
      if (column === sort.column) {
        header.textContent = `${header.textContent} ${sort.direction === 'desc' ? '↓' : '↑'}`;
      }
    });
}

export function scrollToLap(lapNumber: number): void {
  const tbody = document.querySelector('#lap-table-body');
  if (!tbody) return;

  const row = Array.from(tbody.querySelectorAll('tr')).find((tr) => {
    const lapCell = tr.querySelector('td:first-child');
    return (
      lapCell && Number.parseInt(lapCell.textContent ?? '', 10) === lapNumber
    );
  });

  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

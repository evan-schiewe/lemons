import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { CallbackDataParams } from 'echarts/types/dist/shared';
import { CHART_COLOR_TOKENS } from '../../app/theme';
import type { LapRow, SummaryRow } from '../../types';
import { escapeHtml, formatNumber } from '../../utils/format';
import { formatDurationMs, formatLapTimeHHMMSS } from '../../utils/time';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

let isHistogramExpanded = false;

interface SummaryCardOptions {
  greenFlagOnly?: boolean;
}

interface PositionChanges {
  gained: number;
  lost: number;
}

interface HistogramBin {
  value: number | null;
  rawCount?: number;
  startMs: number;
  endMs: number;
}

interface HistogramCard {
  label: string;
  value?: string;
  note?: string;
  visualHtml?: string;
  chartData?: {
    bins: HistogramBin[];
    useLogScale: boolean;
  };
}

export function renderSummaryCards(
  container: HTMLElement,
  summary: SummaryRow | null,
  lapRows: LapRow[] = [],
  options: SummaryCardOptions = {},
): void {
  const { greenFlagOnly = false } = options;

  disposeSummaryCardCharts(container);

  if (!summary || Number(summary.total_laps) === 0) {
    container.innerHTML =
      '<div class="summary-card"><span>No race selected</span><strong>Import a CSV</strong></div>';
    return;
  }

  const paceMs = getPaceMs(lapRows, { greenFlagOnly });
  const positionChanges = getLapPositionChanges(lapRows, { greenFlagOnly });
  const histogramCard = buildLapHistogramCard(lapRows, { greenFlagOnly });

  const cards = [
    { label: 'Best Lap', value: formatDurationMs(summary.best_lap_ms) },
    {
      label: 'Pace',
      value: formatDurationMs(paceMs),
      note: greenFlagOnly ? 'Green flag laps only' : 'All laps',
    },
    {
      label: 'Total Laps',
      value: formatNumber(summary.total_laps),
      note: 'All laps',
    },
    {
      label: 'Position Range',
      value:
        Number.isFinite(summary.best_position) &&
        Number.isFinite(summary.worst_position)
          ? `${formatNumber(summary.best_position)}-${formatNumber(summary.worst_position)}`
          : '-',
    },
    {
      label: 'Positions Gained/Lost',
      value: formatPositionChanges(positionChanges),
      note: greenFlagOnly ? 'Green flag laps only' : 'All laps',
    },
    { label: 'Driver Stints', value: formatNumber(summary.stint_count) },
    histogramCard,
  ];

  container.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <span>${escapeHtml(card.label)}</span>
          ${card.visualHtml ?? `<strong>${escapeHtml(card.value)}</strong>`}
          ${card.note ? `<small class="summary-card-note">${escapeHtml(card.note)}</small>` : ''}
        </article>
      `,
    )
    .join('');

  initializeSummaryCardCharts(container, histogramCard.chartData ?? null);
}

function getLapPositionChanges(
  lapRows: LapRow[],
  options: SummaryCardOptions = {},
): PositionChanges | null {
  const { greenFlagOnly = false } = options;

  if (!Array.isArray(lapRows) || !lapRows.length) {
    return null;
  }

  const validRows = lapRows
    .filter((row) => {
      const lapNumber = Number(row.lap_number);
      const position = Number(row.position_value);
      return (
        Number.isFinite(lapNumber) &&
        Number.isFinite(position) &&
        position > 0 &&
        (!greenFlagOnly || Number(row.is_green_flag) === 1)
      );
    })
    .sort((a, b) => Number(a.lap_number) - Number(b.lap_number));

  if (validRows.length < 2) {
    return null;
  }

  let gained = 0;
  let lost = 0;
  for (let index = 1; index < validRows.length; index += 1) {
    const previousRow = validRows[index - 1];
    const currentRow = validRows[index];

    const previousPosition = Number(previousRow.position_value);
    const currentPosition = Number(currentRow.position_value);

    const delta = previousPosition - currentPosition;
    if (delta > 0) {
      gained += delta;
    } else if (delta < 0) {
      lost += Math.abs(delta);
    }
  }

  return { gained, lost };
}

function formatPositionChanges(changes: PositionChanges | null): string {
  if (!changes) {
    return '-';
  }

  return `${formatNumber(changes.gained)}/${formatNumber(changes.lost)}`;
}

function buildLapHistogramCard(
  lapRows: LapRow[],
  options: SummaryCardOptions = {},
): HistogramCard {
  const { greenFlagOnly = false } = options;
  const useLogScale = !greenFlagOnly;
  const lapTimesMs = greenFlagOnly
    ? getGreenFlagLapTimes(lapRows)
    : getLapTimes(lapRows);

  if (!lapTimesMs.length) {
    return {
      label: 'Lap Time Histogram',
      value: '-',
      note: greenFlagOnly
        ? 'No green flag laps in current filter'
        : 'No laps in current filter',
    };
  }

  const bins = buildHistogramBins(lapTimesMs, 12, { useLogBins: useLogScale });

  return {
    label: 'Lap Time Histogram',
    visualHtml: `
          <div class="summary-card-visual">
                        <button
                            class="summary-card-expand-btn"
                            type="button"
                            data-action="expand-histogram"
                            aria-label="Expand lap time histogram"
                            aria-pressed="false"
                            title="Expand chart"
                        >
                            ⛶
                        </button>
            <div class="summary-card-histogram-chart" role="img" aria-label="Lap time histogram"></div>
          </div>
        `,
    note: greenFlagOnly
      ? 'Green flag laps only'
      : 'All laps (log count scale + log bins)',
    chartData: {
      bins,
      useLogScale,
    },
  };
}

function getPaceMs(
  lapRows: LapRow[],
  options: SummaryCardOptions = {},
): number {
  const { greenFlagOnly = false } = options;
  const lapTimesMs = greenFlagOnly
    ? getTrimmedGreenFlagLapTimes(lapRows)
    : getTrimmedLapTimes(lapRows);

  if (!lapTimesMs.length) {
    return Number.NaN;
  }

  const total = lapTimesMs.reduce((sum, value) => sum + value, 0);
  return total / lapTimesMs.length;
}

function getGreenFlagLapTimes(lapRows: LapRow[]): number[] {
  return lapRows
    .filter((row) => Number(row.is_green_flag) === 1)
    .map((row) => Number(row.lap_time_ms))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function getLapTimes(lapRows: LapRow[]): number[] {
  return lapRows
    .map((row) => Number(row.lap_time_ms))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function getTrimmedGreenFlagLapTimes(lapRows: LapRow[]): number[] {
  const greenFlagLapTimes = getGreenFlagLapTimes(lapRows);

  return trimLapTimesP95(greenFlagLapTimes);
}

function getTrimmedLapTimes(lapRows: LapRow[]): number[] {
  const lapTimes = getLapTimes(lapRows);

  return trimLapTimesP95(lapTimes);
}

function trimLapTimesP95(lapTimes: number[]): number[] {
  if (!lapTimes.length) {
    return [];
  }

  const sorted = [...lapTimes].sort((a, b) => a - b);
  const p95 = percentile(sorted, 0.95);

  if (!Number.isFinite(p95)) {
    return lapTimes;
  }

  return lapTimes.filter((value) => value <= p95);
}

function buildHistogramBins(
  values: number[],
  binCount: number,
  options: { useLogBins?: boolean } = {},
): HistogramBin[] {
  const { useLogBins = false } = options;
  const sortedValues = [...values].sort((a, b) => a - b);
  const minValue = sortedValues[0];
  const maxValue = sortedValues[sortedValues.length - 1];
  const lowerBound = minValue;
  const upperBound = maxValue;
  const useLogRange = useLogBins && lowerBound > 0 && upperBound > lowerBound;
  const lowerLog = useLogRange ? Math.log(lowerBound) : 0;
  const upperLog = useLogRange ? Math.log(upperBound) : 0;
  const counts = new Array(binCount).fill(0);
  const ranges = new Array(binCount).fill(null).map((_, index) => {
    if (upperBound === lowerBound) {
      return {
        startMs: lowerBound,
        endMs: upperBound,
      };
    }

    const bucketSize = useLogRange
      ? (upperLog - lowerLog) / binCount
      : (upperBound - lowerBound) / binCount;
    const startMs = useLogRange
      ? Math.exp(lowerLog + bucketSize * index)
      : lowerBound + bucketSize * index;
    const endMs =
      index === binCount - 1
        ? upperBound
        : useLogRange
          ? Math.exp(lowerLog + bucketSize * (index + 1))
          : lowerBound + bucketSize * (index + 1);

    return { startMs, endMs };
  });

  if (upperBound === lowerBound) {
    counts[0] = values.length;
  } else {
    const bucketSize = useLogRange
      ? (upperLog - lowerLog) / binCount
      : (upperBound - lowerBound) / binCount;
    values.forEach((value) => {
      const clampedValue = Math.max(lowerBound, Math.min(upperBound, value));
      const offset = useLogRange
        ? Math.log(clampedValue) - lowerLog
        : clampedValue - lowerBound;
      const binIndex = Math.min(binCount - 1, Math.floor(offset / bucketSize));
      counts[binIndex] += 1;
    });
  }

  return counts.map((count, index) => ({
    value: count,
    startMs: ranges[index].startMs,
    endMs: ranges[index].endMs,
  }));
}

function percentile(sortedValues: number[], p: number): number {
  if (!sortedValues.length) {
    return NaN;
  }

  const clampedP = Math.max(0, Math.min(1, p));
  const index = (sortedValues.length - 1) * clampedP;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }

  const weight = index - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight
  );
}

function disposeSummaryCardCharts(container: HTMLElement): void {
  const chartElements = container.querySelectorAll(
    '.summary-card-histogram-chart',
  );
  chartElements.forEach((element) => {
    const chart = echarts.getInstanceByDom(element as HTMLElement);
    if (chart) {
      chart.dispose();
    }
  });
}

function initializeSummaryCardCharts(
  container: HTMLElement,
  histogramBins: HistogramCard['chartData'] | null,
): void {
  const bins = Array.isArray(histogramBins)
    ? histogramBins
    : histogramBins?.bins;
  const useLogScale = Boolean(histogramBins?.useLogScale);

  if (!Array.isArray(bins) || !bins.length) {
    return;
  }

  const chartElement = container.querySelector<HTMLElement>(
    '.summary-card-histogram-chart',
  );
  if (!chartElement) {
    return;
  }

  const chart = echarts.init(chartElement);

  const histogramCard = chartElement.closest('.summary-card');
  applyHistogramExpandedState({
    chart,
    chartElement,
    histogramCard,
    histogramBins: bins,
    useLogScale,
    expanded: isHistogramExpanded,
  });

  const expandButton = container.querySelector(
    '[data-action="expand-histogram"]',
  );
  if (expandButton) {
    updateHistogramExpandButton(expandButton, isHistogramExpanded);
    expandButton.addEventListener('click', () => {
      isHistogramExpanded = !isHistogramExpanded;
      updateHistogramExpandButton(expandButton, isHistogramExpanded);
      applyHistogramExpandedState({
        chart,
        chartElement,
        histogramCard,
        histogramBins: bins,
        useLogScale,
        expanded: isHistogramExpanded,
      });
    });
  }
}

function applyHistogramExpandedState({
  chart,
  chartElement,
  histogramCard,
  histogramBins,
  useLogScale,
  expanded,
}: {
  chart: ReturnType<typeof echarts.init>;
  chartElement: HTMLElement;
  histogramCard: Element | null;
  histogramBins: HistogramBin[];
  useLogScale: boolean;
  expanded: boolean;
}): void {
  if (histogramCard) {
    histogramCard.classList.toggle('summary-card-expanded', expanded);
  }

  const expandedHeightPx = Math.max(
    300,
    Math.min(Math.floor(window.innerHeight * 0.62), 520),
  );
  chartElement.style.height = expanded ? `${expandedHeightPx}px` : '78px';

  chart.setOption(
    buildHistogramChartOption(histogramBins, {
      compact: !expanded,
      useLogScale,
    }),
  );
  chart.resize();
  requestAnimationFrame(() => chart.resize());
  setTimeout(() => chart.resize(), 220);
}

function updateHistogramExpandButton(button: Element, expanded: boolean): void {
  button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  button.setAttribute('title', expanded ? 'Collapse chart' : 'Expand chart');
  button.setAttribute(
    'aria-label',
    expanded ? 'Collapse lap time histogram' : 'Expand lap time histogram',
  );
  button.textContent = expanded ? '🗕' : '⛶';
}

function buildHistogramChartOption(
  histogramBins: HistogramBin[],
  options: { compact?: boolean; useLogScale?: boolean } = {},
) {
  const { compact = true, useLogScale = false } = options;
  const seriesData = histogramBins.map((bin) => {
    const count = Number(bin?.value) || 0;
    return {
      ...bin,
      rawCount: count,
      // Log axes do not support zero or negative values.
      value: useLogScale ? (count > 0 ? count : null) : count,
    };
  });

  return {
    animation: false,
    grid: compact
      ? { left: 0, right: 0, top: 24, bottom: 0 }
      : { left: 72, right: 24, top: 36, bottom: 82 },
    xAxis: {
      type: 'category',
      data: histogramBins.map((_, index) => `${index + 1}`),
      show: !compact,
      name: compact ? undefined : 'Lap Time (ms)',
      nameLocation: compact ? undefined : 'middle',
      nameGap: compact ? undefined : 52,
      nameTextStyle: compact
        ? undefined
        : {
            color: CHART_COLOR_TOKENS.axisText,
            fontWeight: 600,
          },
      axisLabel: compact
        ? undefined
        : {
            show: true,
            formatter: (_value: string, index: number) => {
              const bin = histogramBins[index];
              const startMs = Number(bin?.startMs);
              const endMs = Number(bin?.endMs);
              if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
                return `${index + 1}`;
              }

              return `${formatLapTimeHHMMSS(startMs)}\n${formatLapTimeHHMMSS(endMs)}`;
            },
            color: CHART_COLOR_TOKENS.axisText,
            fontSize: 10,
            interval: 0,
            hideOverlap: false,
            rotate: 0,
            margin: 10,
          },
      axisLine: compact
        ? undefined
        : { show: true, lineStyle: { color: CHART_COLOR_TOKENS.axisLine } },
      axisTick: compact ? undefined : { show: true },
    },
    yAxis: {
      type: useLogScale ? 'log' : 'value',
      min: useLogScale ? 1 : 0,
      show: !compact,
      name: compact
        ? undefined
        : useLogScale
          ? 'Count (laps, log)'
          : 'Count (laps)',
      nameLocation: compact ? undefined : 'middle',
      nameGap: compact ? undefined : 56,
      nameTextStyle: compact
        ? undefined
        : { color: CHART_COLOR_TOKENS.axisText },
      axisLabel: compact
        ? undefined
        : {
            show: true,
            color: CHART_COLOR_TOKENS.axisText,
            formatter: (value: number) => `${formatNumber(value)} laps`,
            hideOverlap: false,
          },
      axisLine: compact
        ? undefined
        : { show: true, lineStyle: { color: CHART_COLOR_TOKENS.axisLine } },
      axisTick: compact ? undefined : { show: true },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      ...(compact
        ? {
            position: (
              _point: unknown,
              _params: unknown,
              dom: HTMLElement,
              _rect: unknown,
              size: { viewSize?: number[] },
            ) => {
              const tooltipWidth = dom?.offsetWidth ?? 0;
              const chartWidth = size?.viewSize?.[0] ?? 0;
              const horizontalPadding = 6;
              const centeredLeft = (chartWidth - tooltipWidth) / 2;
              const maxLeft = Math.max(
                horizontalPadding,
                chartWidth - tooltipWidth - horizontalPadding,
              );

              return [
                Math.min(Math.max(horizontalPadding, centeredLeft), maxLeft),
                0,
              ];
            },
          }
        : {}),
      formatter: (params: CallbackDataParams | CallbackDataParams[]) => {
        const point = Array.isArray(params) ? params[0] : params;
        const data = point?.data as Partial<HistogramBin> | undefined;
        const count =
          Number(data?.rawCount ?? data?.value ?? point?.value) || 0;
        const startMs = data?.startMs;
        const endMs = data?.endMs;
        const rangeLabel =
          Number.isFinite(startMs) && Number.isFinite(endMs)
            ? `${formatDurationMs(startMs)} - ${formatDurationMs(endMs)}`
            : '-';

        return `Range: ${rangeLabel}<br/>${formatNumber(count)} lap${count === 1 ? '' : 's'}`;
      },
    },
    series: [
      {
        type: 'bar',
        data: seriesData,
        barCategoryGap: '24%',
        itemStyle: {
          color: CHART_COLOR_TOKENS.histogramBar,
          borderRadius: [2, 2, 0, 0],
        },
      },
    ],
  };
}

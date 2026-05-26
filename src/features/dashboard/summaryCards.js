import * as echarts from 'echarts';
import { escapeHtml, formatNumber } from '../../utils/format.js';
import { formatDurationMs } from '../../utils/time.js';

export function renderSummaryCards(container, summary, lapRows = [], options = {}) {
    const { greenFlagOnly = false } = options;

    disposeSummaryCardCharts(container);

    if (!summary || Number(summary.total_laps) === 0) {
        container.innerHTML = '<div class="summary-card"><span>No race selected</span><strong>Import a CSV</strong></div>';
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
            note: greenFlagOnly ? 'Green flag laps only' : 'All laps (0-95% range)',
        },
        { label: 'Total Laps', value: formatNumber(summary.total_laps), note: 'All laps' },
        {
            label: 'Position Range',
            value: Number.isFinite(summary.best_position) && Number.isFinite(summary.worst_position)
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

function getLapPositionChanges(lapRows, options = {}) {
    const { greenFlagOnly = false } = options;

    if (!Array.isArray(lapRows) || !lapRows.length) {
        return null;
    }

    const validRows = lapRows
        .filter((row) => {
            const lapNumber = Number(row.lap_number);
            const position = Number(row.position_value);
            return Number.isFinite(lapNumber)
                && Number.isFinite(position)
                && position > 0
                && (!greenFlagOnly || Number(row.is_green_flag) === 1);
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

function formatPositionChanges(changes) {
    if (!changes) {
        return '-';
    }

    return `${formatNumber(changes.gained)}/${formatNumber(changes.lost)}`;
}

function buildLapHistogramCard(lapRows, options = {}) {
    const { greenFlagOnly = false } = options;
    const lapTimesMs = greenFlagOnly
        ? getTrimmedGreenFlagLapTimes(lapRows)
        : getTrimmedLapTimes(lapRows);

    if (!lapTimesMs.length) {
        return {
            label: 'Lap Time Histogram',
            value: '-',
            note: greenFlagOnly ? 'No green flag laps in current filter' : 'No laps in current filter',
        };
    }

    const bins = buildHistogramBins(lapTimesMs, 12);

    return {
        label: 'Lap Time Histogram',
        visualHtml: `
          <div class="summary-card-visual">
            <div class="summary-card-histogram-chart" role="img" aria-label="Lap time histogram"></div>
          </div>
        `,
        note: greenFlagOnly ? 'Green flag laps only' : 'All laps (0-95% range)',
        chartData: bins,
    };
}

function getPaceMs(lapRows, options = {}) {
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

function getTrimmedGreenFlagLapTimes(lapRows) {
    const greenFlagLapTimes = lapRows
        .filter((row) => Number(row.is_green_flag) === 1)
        .map((row) => Number(row.lap_time_ms))
        .filter((value) => Number.isFinite(value) && value > 0);

    return trimLapTimesP95(greenFlagLapTimes);
}

function getTrimmedLapTimes(lapRows) {
    const lapTimes = lapRows
        .map((row) => Number(row.lap_time_ms))
        .filter((value) => Number.isFinite(value) && value > 0);

    return trimLapTimesP95(lapTimes);
}

function trimLapTimesP95(lapTimes) {
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

function buildHistogramBins(values, binCount) {
    const sortedValues = [...values].sort((a, b) => a - b);
    const minValue = sortedValues[0];
    const maxValue = sortedValues[sortedValues.length - 1];
    const robustMax = percentile(sortedValues, 0.95);
    const bucketMin = minValue;
    const bucketMax = Number.isFinite(robustMax) ? robustMax : maxValue;
    const useRobustRange = bucketMax > bucketMin;
    const lowerBound = useRobustRange ? bucketMin : minValue;
    const upperBound = useRobustRange ? bucketMax : maxValue;
    const counts = new Array(binCount).fill(0);
    const ranges = new Array(binCount).fill(null).map((_, index) => {
        if (upperBound === lowerBound) {
            return {
                startMs: lowerBound,
                endMs: upperBound,
            };
        }

        const bucketSize = (upperBound - lowerBound) / binCount;
        const startMs = lowerBound + (bucketSize * index);
        const endMs = index === binCount - 1
            ? upperBound
            : lowerBound + (bucketSize * (index + 1));

        return { startMs, endMs };
    });

    if (upperBound === lowerBound) {
        counts[0] = values.length;
    } else {
        const bucketSize = (upperBound - lowerBound) / binCount;
        values.forEach((value) => {
            const clampedValue = Math.max(lowerBound, Math.min(upperBound, value));
            const binIndex = Math.min(binCount - 1, Math.floor((clampedValue - lowerBound) / bucketSize));
            counts[binIndex] += 1;
        });
    }

    return counts.map((count, index) => ({
        value: count,
        startMs: ranges[index].startMs,
        endMs: ranges[index].endMs,
    }));
}

function percentile(sortedValues, p) {
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
    return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function disposeSummaryCardCharts(container) {
    const chartElements = container.querySelectorAll('.summary-card-histogram-chart');
    chartElements.forEach((element) => {
        const chart = echarts.getInstanceByDom(element);
        if (chart) {
            chart.dispose();
        }
    });
}

function initializeSummaryCardCharts(container, histogramBins) {
    if (!Array.isArray(histogramBins) || !histogramBins.length) {
        return;
    }

    const chartElement = container.querySelector('.summary-card-histogram-chart');
    if (!chartElement) {
        return;
    }

    const chart = echarts.init(chartElement);

    chart.setOption({
        animation: false,
        grid: { left: 0, right: 0, top: 24, bottom: 0 },
        xAxis: {
            type: 'category',
            data: histogramBins.map((_, index) => `${index + 1}`),
            show: false,
        },
        yAxis: {
            type: 'value',
            min: 0,
            show: false,
        },
        tooltip: {
            trigger: 'axis',
            confine: true,
            axisPointer: { type: 'shadow' },
            position: (_point, _params, dom) => {
                const tooltipWidth = dom?.offsetWidth ?? 0;
                const chartWidth = chartElement.clientWidth;
                const horizontalPadding = 6;
                const centeredLeft = (chartWidth - tooltipWidth) / 2;
                const maxLeft = Math.max(horizontalPadding, chartWidth - tooltipWidth - horizontalPadding);

                return [Math.min(Math.max(horizontalPadding, centeredLeft), maxLeft), 0];
            },
            formatter: (params) => {
                const point = Array.isArray(params) ? params[0] : params;
                const count = Number(point?.data?.value ?? point?.value) || 0;
                const startMs = point?.data?.startMs;
                const endMs = point?.data?.endMs;
                const rangeLabel = Number.isFinite(startMs) && Number.isFinite(endMs)
                    ? `${formatDurationMs(startMs)} - ${formatDurationMs(endMs)}`
                    : '-';

                return `Range: ${rangeLabel}<br/>${formatNumber(count)} lap${count === 1 ? '' : 's'}`;
            },
        },
        series: [{
            type: 'bar',
            data: histogramBins,
            barCategoryGap: '24%',
            itemStyle: {
                color: 'rgba(217, 79, 43, 0.82)',
                borderRadius: [2, 2, 0, 0],
            },
        }],
    });
}
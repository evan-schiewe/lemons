import * as echarts from 'echarts';
import { formatDurationMs } from '../../utils/time.js';
import { formatGapDisplay } from '../../utils/time.js';
import { formatNumber } from '../../utils/format.js';

const PALETTE = ['#d94f2b', '#2563eb', '#059669', '#9d174d', '#7c3aed', '#0f766e'];
const GAP_PALETTE = ['#7c3aed', '#0f766e', '#d97706', '#be123c', '#1d4ed8', '#059669'];

export function createLapTimeChart(element, { onSelectLap }) {
    const chart = echarts.init(element);

    chart.on('click', (params) => {
        const lapNumber = params?.data?.lapNumber;
        if (Number.isFinite(lapNumber)) {
            onSelectLap(lapNumber);
        }
    });

    return {
        render(rows, annotations, selectedLapNumber) {
            const rowsByCar = groupRowsByCar(rows);
            const isSingleSeries = rowsByCar.length <= 1;
            const fastestSeconds = rows.reduce((fastest, row) => {
                if (!Number.isFinite(row.lap_time_ms)) {
                    return fastest;
                }

                const lapSeconds = row.lap_time_ms / 1000;
                return Number.isFinite(fastest) ? Math.min(fastest, lapSeconds) : lapSeconds;
            }, Number.NaN);
            const lapTimeAxisMin = getMinuteFloorSeconds(fastestSeconds);
            const slowestSeconds = rows.reduce((slowest, row) => {
                if (!Number.isFinite(row.lap_time_ms)) {
                    return slowest;
                }

                const lapSeconds = row.lap_time_ms / 1000;
                return Number.isFinite(slowest) ? Math.max(slowest, lapSeconds) : lapSeconds;
            }, Number.NaN);
            const lapTimeAxisMax = getTenMinuteCeilingSeconds(slowestSeconds);
            const lapSeries = rowsByCar.map(([carNumber, carRows], index) => ({
                name: formatLapTimeSeriesName(carNumber, isSingleSeries),
                type: 'line',
                smooth: false,
                showSymbol: false,
                lineStyle: { width: 2 },
                itemStyle: { color: PALETTE[index % PALETTE.length] },
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: carRows
                    .filter((row) => Number.isFinite(row.lap_time_ms))
                    .map((row) => ({
                        value: [row.lap_number, row.lap_time_ms / 1000],
                        lapNumber: row.lap_number,
                        outlier: row.is_outlier === 1,
                        driverName: row.driver_name,
                    })),
                markLine: index === 0 ? buildLapMarks(selectedLapNumber, annotations.driverStints) : undefined,
                markArea: index === 0 ? buildRangeAreas(annotations.rangeEvents) : undefined,
            }));

            const positionSeries = rowsByCar.map(([carNumber, carRows], index) => ({
                name: formatPositionSeriesName(carNumber, isSingleSeries),
                type: 'line',
                smooth: false,
                showSymbol: false,
                itemStyle: { color: PALETTE[index % PALETTE.length] },
                lineStyle: { width: 2 },
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: carRows
                    .filter((row) => Number.isFinite(row.position_value))
                    .map((row) => ({ value: [row.lap_number, row.position_value], lapNumber: row.lap_number })),
                markLine: index === 0 && Number.isFinite(selectedLapNumber)
                    ? { symbol: 'none', data: [{ xAxis: selectedLapNumber, name: 'Selected Lap' }] }
                    : undefined,
                markArea: index === 0
                    ? {
                        itemStyle: { opacity: 0.08 },
                        data: annotations.rangeEvents.map((event) => [
                            { name: event.title, xAxis: event.start_lap, itemStyle: { color: event.color } },
                            { xAxis: event.end_lap },
                        ]),
                    }
                    : undefined,
            }));

            const gapSeries = rowsByCar.map(([carNumber, carRows], index) => ({
                name: formatGapSeriesName(carNumber, isSingleSeries),
                type: 'line',
                smooth: false,
                showSymbol: false,
                itemStyle: { color: GAP_PALETTE[index % GAP_PALETTE.length] },
                lineStyle: { width: 2, type: 'dashed' },
                xAxisIndex: 1,
                yAxisIndex: 2,
                data: carRows
                    .filter((row) => Number.isFinite(row.gap_leader_ms) || Number.isFinite(row.gap_leader_laps))
                    .map((row) => {
                        const gapDisplay = formatGapDisplay(row.gap_leader_ms, row.gap_leader_laps);
                        const gapValue = Number.isFinite(row.gap_leader_ms)
                            ? row.gap_leader_ms / 1000
                            : Number.isFinite(row.gap_leader_laps)
                                ? row.gap_leader_laps
                                : null;

                        return {
                            value: [row.lap_number, gapValue],
                            lapNumber: row.lap_number,
                            gapDisplay,
                        };
                    }),
            }));

            const maxSeconds = Math.max(
                ...rows.map((row) => (Number.isFinite(row.lap_time_ms) ? row.lap_time_ms / 1000 : 0)),
                1,
            );

            const lapIncidentSeries = buildIncidentScatter('Incidents', annotations.taggedIncidents, maxSeconds * 0.98, '#d94f2b', 0);
            const lapNoteSeries = buildIncidentScatter('Lap Notes', annotations.lapNotes, maxSeconds * 0.93, '#f59e0b', 0);
            const topLegendNames = [...lapSeries.map((series) => series.name), lapIncidentSeries.name, lapNoteSeries.name];
            const bottomLegendNames = [
                ...positionSeries.map((series) => series.name),
                ...gapSeries.map((series) => series.name),
            ];

            chart.setOption({
                animationDuration: 250,
                color: PALETTE,
                tooltip: {
                    trigger: 'axis',
                    formatter: (items) => items
                        .map((item) => {
                            if (item.seriesName.startsWith('Lap Times')) {
                                return `${item.seriesName}: ${formatDurationMs(item.value[1] * 1000)}`;
                            }
                            if (item.seriesName.startsWith('Position')) {
                                return `${item.seriesName}: ${formatNumber(item.value?.[1])}`;
                            }
                            if (item.seriesName.startsWith('Gap to Leader')) {
                                return `${item.seriesName}: ${item.data?.gapDisplay ?? formatNumber(item.value?.[1])}`;
                            }
                            return `${item.seriesName}: ${item.data?.label ?? ''}`;
                        })
                        .join('<br/>'),
                },
                legend: [
                    {
                        top: 4,
                        data: topLegendNames,
                    },
                    {
                        left: 'center',
                        bottom: 68,
                        data: bottomLegendNames,
                    },
                ],
                grid: [
                    { left: 0, right: 100, top: 40, height: '42%', containLabel: true },
                    { left: 48, right: 72, top: '58%', height: '18%' },
                ],
                xAxis: [
                    {
                        type: 'value',
                        name: '',
                        gridIndex: 0,
                    },
                    {
                        type: 'value',
                        name: 'Lap',
                        nameLocation: 'middle',
                        nameGap: 18,
                        gridIndex: 1,
                    },
                ],
                yAxis: [
                    {
                        type: 'log',
                        name: 'Lap Time',
                        gridIndex: 0,
                        min: lapTimeAxisMin,
                        max: lapTimeAxisMax,
                        axisLabel: {
                            formatter: (value) => formatDurationWholeSeconds(value),
                        },
                    },
                    {
                        type: 'value',
                        name: 'Position',
                        inverse: true,
                        minInterval: 1,
                        gridIndex: 1,
                        nameTextStyle: {
                            padding: [6, 0, 0, 0],
                        },
                    },
                    {
                        type: 'value',
                        name: 'Gap to Leader',
                        position: 'right',
                        min: 0,
                        gridIndex: 1,
                        axisLabel: {
                            formatter: (value) => formatNumber(value),
                        },
                    },
                ],
                dataZoom: [
                    { type: 'inside', xAxisIndex: [0, 1], zoomOnMouseWheel: false, moveOnMouseWheel: false },
                    { type: 'slider', bottom: 32, height: 32, xAxisIndex: [0, 1] },
                ],
                series: [...lapSeries, lapIncidentSeries, lapNoteSeries, ...positionSeries, ...gapSeries],
            });
        },
        resize() {
            chart.resize();
        },
    };
}

function groupRowsByCar(rows) {
    const groups = new Map();
    rows.forEach((row) => {
        const key = `${row.car_number ?? ''}`.trim();
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(row);
    });
    return [...groups.entries()];
}

function formatLapTimeSeriesName(carNumber, isSingleSeries) {
    if (isSingleSeries || !carNumber) {
        return 'Lap Times';
    }
    return `Lap Times ${carNumber}`;
}

function buildLapMarks(selectedLapNumber, driverStints) {
    const stintLines = driverStints.flatMap((stint) => [
        {
            xAxis: stint.start_lap,
            name: `${stint.driver_name} in`,
            lineStyle: { color: stint.color, type: 'dashed' },
        },
        {
            xAxis: stint.end_lap,
            name: `${stint.driver_name} out`,
            lineStyle: { color: stint.color, type: 'dotted' },
        },
    ]);

    const selectedLine = Number.isFinite(selectedLapNumber)
        ? [{ xAxis: selectedLapNumber, name: 'Selected Lap', lineStyle: { color: '#1f1b16', width: 2 } }]
        : [];

    return { symbol: 'none', label: { formatter: '{b}' }, data: [...selectedLine, ...stintLines] };
}

function buildRangeAreas(rangeEvents) {
    return {
        itemStyle: { opacity: 0.08 },
        data: rangeEvents.map((event) => [
            { name: event.title, xAxis: event.start_lap, itemStyle: { color: event.color } },
            { xAxis: event.end_lap },
        ]),
    };
}

function buildIncidentScatter(name, items, yValue, color) {
    return {
        name,
        type: 'scatter',
        symbolSize: 12,
        itemStyle: { color },
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: items.map((item) => ({
            value: [item.lap_number, yValue],
            lapNumber: item.lap_number,
            label: item.title || item.note_text,
        })),
    };
}

function formatPositionSeriesName(carNumber, isSingleSeries) {
    if (isSingleSeries || !carNumber) {
        return 'Position';
    }
    return `Position ${carNumber}`;
}

function formatGapSeriesName(carNumber, isSingleSeries) {
    if (isSingleSeries || !carNumber) {
        return 'Gap to Leader';
    }
    return `Gap to Leader ${carNumber}`;
}

function getMinuteFloorSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return 60;
    }

    const minuteFloorSeconds = Math.floor(seconds / 60) * 60;
    return Math.max(60, minuteFloorSeconds);
}

function getTenMinuteCeilingSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return 600;
    }

    const tenMinuteCeilingSeconds = Math.ceil(seconds / 600) * 600;
    return Math.max(600, tenMinuteCeilingSeconds);
}

function formatDurationWholeSeconds(seconds) {
    if (!Number.isFinite(seconds)) {
        return '-';
    }

    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${remainingSeconds}`;
    }

    return `${minutes}:${remainingSeconds}`;
}
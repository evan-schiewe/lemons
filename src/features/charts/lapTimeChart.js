import { CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { formatNumber } from '../../utils/format.js';
import { formatDurationMs, formatGapDisplay } from '../../utils/time.js';

echarts.use([
  LineChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
]);

const PALETTE = [
  '#d94f2b',
  '#2563eb',
  '#059669',
  '#9d174d',
  '#7c3aed',
  '#0f766e',
];
const GAP_PALETTE = [
  '#7c3aed',
  '#0f766e',
  '#d97706',
  '#be123c',
  '#1d4ed8',
  '#059669',
];

export function createLapTimeChart(element, { onSelectLap, onLapRangeChange }) {
  const chart = echarts.init(element);
  let lapAxisBounds = { min: 0, max: 1 };
  let suppressZoomEvent = false;
  let zoomSyncTimer = null;

  chart.on('click', (params) => {
    const lapNumber = params?.data?.lapNumber;
    if (Number.isFinite(lapNumber)) {
      onSelectLap(lapNumber);
    }
  });

  chart.on('datazoom', () => {
    if (suppressZoomEvent || typeof onLapRangeChange !== 'function') {
      return;
    }

    if (zoomSyncTimer) {
      clearTimeout(zoomSyncTimer);
    }

    zoomSyncTimer = setTimeout(() => {
      const range = getCurrentZoomLapRange(chart, lapAxisBounds);
      if (!range) {
        return;
      }

      onLapRangeChange(range);
    }, 80);
  });

  return {
    render(rows, annotations) {
      const fastestSeconds = rows.reduce((fastest, row) => {
        if (!Number.isFinite(row.lap_time_ms)) {
          return fastest;
        }

        const lapSeconds = row.lap_time_ms / 1000;
        return Number.isFinite(fastest)
          ? Math.min(fastest, lapSeconds)
          : lapSeconds;
      }, Number.NaN);
      const lapTimeAxisMin = getMinuteFloorSeconds(fastestSeconds);
      const slowestSeconds = rows.reduce((slowest, row) => {
        if (!Number.isFinite(row.lap_time_ms)) {
          return slowest;
        }

        const lapSeconds = row.lap_time_ms / 1000;
        return Number.isFinite(slowest)
          ? Math.max(slowest, lapSeconds)
          : lapSeconds;
      }, Number.NaN);
      const lapTimeAxisMax = getTenMinuteCeilingSeconds(slowestSeconds);
      const lapNumbers = rows
        .map((row) => row.lap_number)
        .filter((lapNumber) => Number.isFinite(lapNumber));
      const lapAxisMin = lapNumbers.length ? Math.min(...lapNumbers) : 0;
      const lapAxisMax = lapNumbers.length ? Math.max(...lapNumbers) : 1;
      lapAxisBounds = { min: lapAxisMin, max: lapAxisMax };
      const lapSeries = [
        {
          name: 'Lap Times',
          type: 'line',
          smooth: false,
          showSymbol: false,
          lineStyle: { width: 2 },
          itemStyle: { color: PALETTE[0] },
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: withGaps(
            rows
              .filter((row) => Number.isFinite(row.lap_time_ms))
              .map((row) => ({
                value: [row.lap_number, row.lap_time_ms / 1000],
                lapNumber: row.lap_number,
                outlier: row.is_outlier === 1,
                driverName: row.driver_name,
              })),
          ),
        },
      ];

      const stintLaneModel = buildStintLaneModel(annotations.driverStints);
      const stintSeries = {
        name: 'Driver Stints',
        type: 'custom',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: stintLaneModel.stints,
        renderItem: (params, api) => {
          const startLap = api.value(0);
          const endLap = api.value(1);
          const laneIndex = api.value(2);
          const start = api.coord([startLap, laneIndex]);
          const end = api.coord([endLap, laneIndex]);
          const laneHeight = Math.max(api.size([0, 1])[1] * 0.58, 8);
          const rawRect = {
            x: Math.min(start[0], end[0]),
            y: start[1] - laneHeight / 2,
            width: Math.max(1, Math.abs(end[0] - start[0])),
            height: laneHeight,
          };

          const clippedRect = echarts.graphic.clipRectByRect(rawRect, {
            x: params.coordSys.x,
            y: params.coordSys.y,
            width: params.coordSys.width,
            height: params.coordSys.height,
          });

          if (!clippedRect) {
            return null;
          }

          return {
            type: 'rect',
            shape: clippedRect,
            style: {
              fill: api.visual('color') || params.data?.itemStyle?.color,
              opacity: 0.88,
            },
          };
        },
        encode: { x: [0, 1], y: 2 },
        tooltip: {
          formatter: (params) => params.data?.label || 'Driver stint',
        },
        z: 3,
      };

      const rangeEventSeries = {
        name: 'Range Events',
        type: 'line',
        showSymbol: false,
        lineStyle: { opacity: 0 },
        itemStyle: { opacity: 0 },
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: [],
        markArea: buildRangeAreas(annotations.rangeEvents),
        tooltip: { show: false },
        z: 1,
      };

      const stintIncidentSeries = buildIncidentScatter(
        'Incidents',
        annotations.taggedIncidents,
        0,
        '#d94f2b',
        1,
        1,
        'diamond',
      );
      const stintNoteSeries = buildIncidentScatter(
        'Lap Notes',
        annotations.lapNotes,
        1,
        '#f59e0b',
        1,
        1,
        'circle',
      );

      const positionSeries = [
        {
          name: 'Position',
          type: 'line',
          smooth: false,
          showSymbol: false,
          itemStyle: { color: PALETTE[0] },
          lineStyle: { width: 2 },
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: withGaps(
            rows
              .filter((row) => Number.isFinite(row.position_value))
              .map((row) => ({
                value: [row.lap_number, row.position_value],
                lapNumber: row.lap_number,
              })),
          ),
        },
      ];

      const gapSeries = [
        {
          name: 'Gap to Leader',
          type: 'line',
          smooth: false,
          showSymbol: false,
          itemStyle: { color: GAP_PALETTE[0] },
          lineStyle: { width: 2, type: 'dashed' },
          xAxisIndex: 2,
          yAxisIndex: 3,
          data: withGaps(
            rows
              .filter(
                (row) =>
                  Number.isFinite(row.gap_leader_ms) ||
                  Number.isFinite(row.gap_leader_laps),
              )
              .map((row) => {
                const gapDisplay = formatGapDisplay(
                  row.gap_leader_ms,
                  row.gap_leader_laps,
                );
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
          ),
        },
      ];

      const topLegendNames = [...lapSeries.map((series) => series.name)];
      const middleLegendNames = [
        rangeEventSeries.name,
        stintSeries.name,
        stintIncidentSeries.name,
        stintNoteSeries.name,
      ];
      const bottomLegendNames = [
        ...positionSeries.map((series) => series.name),
        ...gapSeries.map((series) => series.name),
      ];

      chart.setOption({
        animationDuration: 250,
        color: PALETTE,
        tooltip: {
          trigger: 'axis',
          formatter: (items) =>
            items
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
                if (item.seriesName.startsWith('Driver Stints')) {
                  return `${item.seriesName}: ${item.data?.label ?? ''}`;
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
            top: '43%',
            data: middleLegendNames,
          },
          {
            left: 'center',
            bottom: 72,
            data: bottomLegendNames,
          },
        ],
        grid: [
          { left: 56, right: 72, top: 40, height: '33%', containLabel: false },
          {
            left: 56,
            right: 72,
            top: '47%',
            height: '14%',
            containLabel: false,
          },
          {
            left: 56,
            right: 72,
            top: '69%',
            height: '13%',
            containLabel: false,
          },
        ],
        xAxis: [
          {
            type: 'value',
            name: '',
            gridIndex: 0,
            min: lapAxisMin,
            max: lapAxisMax,
            minInterval: 1,
          },
          {
            type: 'value',
            name: '',
            gridIndex: 1,
            min: lapAxisMin,
            max: lapAxisMax,
            minInterval: 1,
          },
          {
            type: 'value',
            name: 'Lap',
            nameLocation: 'middle',
            nameGap: 18,
            gridIndex: 2,
            min: lapAxisMin,
            max: lapAxisMax,
            minInterval: 1,
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
            gridIndex: 1,
            min: -0.5,
            max: Math.max(stintLaneModel.labels.length - 0.5, 1.5),
            interval: 1,
            axisLabel: { show: false },
            axisTick: { show: false },
          },
          {
            type: 'value',
            name: 'Position',
            inverse: true,
            minInterval: 1,
            gridIndex: 2,
            nameTextStyle: {
              padding: [6, 0, 0, 0],
            },
          },
          {
            type: 'value',
            name: 'Gap to Leader',
            position: 'right',
            min: 0,
            gridIndex: 2,
            axisLabel: {
              formatter: (value) => formatNumber(value),
            },
          },
        ],
        dataZoom: [
          {
            type: 'inside',
            xAxisIndex: [0, 1, 2],
            zoomOnMouseWheel: false,
            moveOnMouseWheel: false,
          },
          {
            type: 'slider',
            bottom: 28,
            height: 32,
            xAxisIndex: [0, 1, 2],
            labelFormatter: (value) => `${Math.round(value)}`,
          },
        ],
        series: [
          ...lapSeries,
          rangeEventSeries,
          stintSeries,
          stintIncidentSeries,
          stintNoteSeries,
          ...positionSeries,
          ...gapSeries,
        ],
      });
    },
    resize() {
      chart.resize();
    },
    setLapRange(lapMin, lapMax) {
      const normalized = normalizeZoomLapRange(lapMin, lapMax, lapAxisBounds);
      if (!normalized) {
        return;
      }
      applyZoomRange(
        chart,
        normalized,
        () => {
          suppressZoomEvent = true;
        },
        () => {
          suppressZoomEvent = false;
        },
      );
    },
  };
}

function applyZoomRange(chart, range, onBefore, onAfter) {
  onBefore?.();
  try {
    chart.dispatchAction({
      type: 'dataZoom',
      dataZoomIndex: 0,
      startValue: range.lapMin,
      endValue: range.lapMax,
    });
    chart.dispatchAction({
      type: 'dataZoom',
      dataZoomIndex: 1,
      startValue: range.lapMin,
      endValue: range.lapMax,
    });
  } finally {
    onAfter?.();
  }
}

function getCurrentRawZoomLapRange(chart, lapAxisBounds) {
  const option = chart.getOption();
  const dataZooms = Array.isArray(option?.dataZoom) ? option.dataZoom : [];
  if (!dataZooms.length) {
    return null;
  }

  const zoom =
    dataZooms.find(
      (item) =>
        Number.isFinite(Number(item.startValue)) ||
        Number.isFinite(Number(item.endValue)),
    ) ?? dataZooms[0];

  const axisMin = Number(lapAxisBounds?.min);
  const axisMax = Number(lapAxisBounds?.max);
  const span = axisMax - axisMin;

  let startValue = Number(zoom.startValue);
  let endValue = Number(zoom.endValue);

  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) {
    if (!Number.isFinite(axisMin) || !Number.isFinite(axisMax) || span <= 0) {
      return null;
    }

    const startPct = Number.isFinite(Number(zoom.start))
      ? Number(zoom.start)
      : 0;
    const endPct = Number.isFinite(Number(zoom.end)) ? Number(zoom.end) : 100;
    startValue = axisMin + (span * startPct) / 100;
    endValue = axisMin + (span * endPct) / 100;
  }

  return {
    lapMin: Math.min(startValue, endValue),
    lapMax: Math.max(startValue, endValue),
  };
}

function getCurrentZoomLapRange(chart, lapAxisBounds) {
  const rawRange = getCurrentRawZoomLapRange(chart, lapAxisBounds);
  if (!rawRange) {
    return null;
  }

  const axisMin = Number(lapAxisBounds?.min);
  const axisMax = Number(lapAxisBounds?.max);

  const clampedMin = clamp(Math.floor(rawRange.lapMin), axisMin, axisMax);
  const clampedMax = clamp(Math.ceil(rawRange.lapMax), axisMin, axisMax);
  if (!Number.isFinite(clampedMin) || !Number.isFinite(clampedMax)) {
    return null;
  }

  return { lapMin: clampedMin, lapMax: clampedMax };
}

function normalizeZoomLapRange(lapMin, lapMax, lapAxisBounds) {
  const axisMin = Number(lapAxisBounds?.min);
  const axisMax = Number(lapAxisBounds?.max);

  if (!Number.isFinite(axisMin) || !Number.isFinite(axisMax)) {
    return null;
  }

  let normalizedMin = Number.isFinite(Number(lapMin))
    ? Number(lapMin)
    : axisMin;
  let normalizedMax = Number.isFinite(Number(lapMax))
    ? Number(lapMax)
    : axisMax;

  if (normalizedMin > normalizedMax) {
    const temp = normalizedMin;
    normalizedMin = normalizedMax;
    normalizedMax = temp;
  }

  return {
    lapMin: clamp(Math.floor(normalizedMin), axisMin, axisMax),
    lapMax: clamp(Math.ceil(normalizedMax), axisMin, axisMax),
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  return Math.max(min, Math.min(max, value));
}

function withGaps(points) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].lapNumber - points[i - 1].lapNumber > 1) {
      result.push({
        value: [points[i].lapNumber - 1, null],
        lapNumber: points[i].lapNumber - 1,
      });
    }
    result.push(points[i]);
  }
  return result;
}

function buildRangeAreas(rangeEvents) {
  return {
    silent: true,
    itemStyle: { opacity: 0.08 },
    label: {
      show: true,
      position: 'insideBottom',
      formatter: (params) => params?.data?.[0]?.name ?? params?.name ?? '',
      color: '#1f2937',
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderWidth: 0,
      borderRadius: 0,
      padding: 0,
      textBorderWidth: 0,
    },
    data: rangeEvents.map((event) => [
      {
        name: event.title,
        xAxis: event.start_lap,
        itemStyle: { color: event.color },
      },
      { xAxis: event.end_lap },
    ]),
  };
}

function buildIncidentScatter(
  name,
  items,
  yValue,
  color,
  xAxisIndex,
  yAxisIndex,
  symbol = 'circle',
) {
  return {
    name,
    type: 'scatter',
    symbol,
    symbolSize: 12,
    itemStyle: { color },
    xAxisIndex,
    yAxisIndex,
    data: items.map((item) => ({
      value: [item.lap_number, yValue],
      lapNumber: item.lap_number,
      label: item.title || item.note_text,
    })),
  };
}

function buildStintLaneModel(driverStints) {
  const sortedStints = driverStints
    .filter(
      (stint) =>
        Number.isFinite(stint.start_lap) && Number.isFinite(stint.end_lap),
    )
    .sort((a, b) => {
      if (a.start_lap !== b.start_lap) {
        return a.start_lap - b.start_lap;
      }
      return a.end_lap - b.end_lap;
    });

  const laneByDriver = new Map();
  const orderedDrivers = [];
  sortedStints.forEach((stint) => {
    const driverName =
      (stint.driver_name || 'Unknown driver').trim() || 'Unknown driver';
    if (!laneByDriver.has(driverName)) {
      orderedDrivers.push(driverName);
      laneByDriver.set(driverName, 0);
    }
  });

  const driverCount = orderedDrivers.length;
  orderedDrivers.forEach((driverName, index) => {
    // Reserve lanes 0 and 1 for incidents/notes; place first driver at top.
    laneByDriver.set(driverName, driverCount - index + 1);
  });

  const labels = ['Incidents', 'Lap Notes'];
  laneByDriver.forEach((laneIndex, driverName) => {
    labels[laneIndex] = driverName;
  });

  const driverColorByName = new Map();
  laneByDriver.forEach((laneIndex, driverName) => {
    driverColorByName.set(driverName, buildDriverLaneColor(laneIndex - 2));
  });

  const stints = sortedStints.map((stint) => {
    const driverName =
      (stint.driver_name || 'Unknown driver').trim() || 'Unknown driver';
    const laneIndex = laneByDriver.get(driverName) ?? 2;
    const color = driverColorByName.get(driverName) ?? buildDriverLaneColor(0);

    return {
      value: [stint.start_lap, stint.end_lap, laneIndex],
      lapNumber: Math.round((stint.start_lap + stint.end_lap) / 2),
      label: `${driverName}: L${stint.start_lap} - L${stint.end_lap}`,
      itemStyle: { color },
    };
  });

  return { labels, stints };
}

function buildDriverLaneColor(driverIndex) {
  const hue = (driverIndex * 137.508) % 360;
  return `hsl(${hue}, 72%, 46%)`;
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

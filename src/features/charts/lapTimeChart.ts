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
import type { ChartColorTokens } from '../../app/theme';
import { getChartColorTokens, getChartSeriesPalette } from '../../app/theme';
import type {
  DriverStint,
  LapNote,
  LapRangeBounds,
  LapRow,
  LapTimeChartHandle,
  RaceAnnotations,
  RangeEvent,
  TaggedIncident,
} from '../../types';
import { escapeHtml, formatNumber } from '../../utils/format';
import { formatDurationMs, formatGapDisplay } from '../../utils/time';

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

interface LapTimeChartHandlers {
  onSelectLap: (lapNumber: number) => void | Promise<void>;
  onLapRangeChange?: (range: {
    lapMin: number;
    lapMax: number;
  }) => void | Promise<void>;
}

interface LapAxisBounds {
  min: number;
  max: number;
}

interface ChartClickParams {
  data?: {
    lapNumber?: unknown;
  };
}

interface CustomRenderParams {
  coordSys: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  data?: {
    itemStyle?: {
      color?: string;
    };
  };
}

interface CustomRenderApi {
  value: (index: number) => number;
  coord: (value: number[]) => [number, number];
  size: (value: number[]) => [number, number];
  visual: (key: string) => unknown;
}

interface ChartTooltipParam {
  seriesName: string;
  value?: [number, number | null];
  data?: {
    gapDisplay?: string;
    label?: string;
  };
}

interface MarkAreaLabelParam {
  data?: Array<{ name?: string }>;
  name?: string;
}

export function createLapTimeChart(
  element: HTMLElement,
  { onSelectLap, onLapRangeChange }: LapTimeChartHandlers,
): LapTimeChartHandle {
  const chart = echarts.init(element);
  allowPageWheelScroll(element);
  let lapAxisBounds = { min: 0, max: 1 };
  let suppressZoomEvent = false;
  let zoomSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeAnimationFrame: number | null = null;

  const scheduleResize = (): void => {
    if (resizeAnimationFrame !== null) {
      cancelAnimationFrame(resizeAnimationFrame);
    }

    resizeAnimationFrame = requestAnimationFrame(() => {
      resizeAnimationFrame = null;
      chart.resize();
    });
  };

  const resizeObserver = new ResizeObserver(() => {
    scheduleResize();
  });
  resizeObserver.observe(element);

  chart.on('click', (params: unknown) => {
    const lapNumber = (params as ChartClickParams)?.data?.lapNumber;
    if (typeof lapNumber === 'number' && Number.isFinite(lapNumber)) {
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
    render(
      rows: LapRow[],
      annotations: RaceAnnotations,
      options: { lapAxisBounds?: LapRangeBounds | null } = {},
    ) {
      const chartColors = getChartColorTokens();
      const palette = getChartSeriesPalette();
      const fastestSeconds = rows.reduce((fastest, row) => {
        if (
          typeof row.lap_time_ms !== 'number' ||
          !Number.isFinite(row.lap_time_ms)
        ) {
          return fastest;
        }

        const lapSeconds = row.lap_time_ms / 1000;
        return Number.isFinite(fastest)
          ? Math.min(fastest, lapSeconds)
          : lapSeconds;
      }, Number.NaN);
      const lapTimeAxisMin = getMinuteFloorSeconds(fastestSeconds);
      const slowestSeconds = rows.reduce((slowest, row) => {
        if (
          typeof row.lap_time_ms !== 'number' ||
          !Number.isFinite(row.lap_time_ms)
        ) {
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
      const providedLapBounds = options.lapAxisBounds;
      const lapAxisMin =
        providedLapBounds && Number.isFinite(providedLapBounds.min)
          ? providedLapBounds.min
          : lapNumbers.length
            ? Math.min(...lapNumbers)
            : 0;
      const lapAxisMax =
        providedLapBounds && Number.isFinite(providedLapBounds.max)
          ? providedLapBounds.max
          : lapNumbers.length
            ? Math.max(...lapNumbers)
            : 1;
      lapAxisBounds = { min: lapAxisMin, max: lapAxisMax };
      const gridGutters = getChartGridGutters(element);
      const lapTimePoints = rows
        .filter((row) => Number.isFinite(row.lap_time_ms))
        .map((row) => ({
          value: [row.lap_number, Number(row.lap_time_ms) / 1000],
          lapNumber: row.lap_number,
          outlier: row.is_outlier === 1,
          driverName: row.driver_name,
        }));
      const lapSeries = [
        {
          name: 'Lap Times',
          type: 'line',
          smooth: false,
          showSymbol: false,
          lineStyle: { width: 2 },
          itemStyle: { color: chartColors.lapLine },
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: withGaps(lapTimePoints),
        },
        {
          name: 'Lap Times Single Points',
          type: 'scatter',
          symbol: 'circle',
          symbolSize: 9,
          itemStyle: { color: chartColors.lapLine },
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: getSinglePointSegments(lapTimePoints),
          tooltip: { show: false },
          z: 4,
        },
      ];

      const stintLaneModel = buildStintLaneModel(annotations.driverStints);
      const stintSeries = {
        name: 'Driver Stints',
        type: 'custom',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: stintLaneModel.stints,
        renderItem: (params: CustomRenderParams, api: CustomRenderApi) => {
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

          const visualColor = api.visual('color');
          return {
            type: 'rect',
            shape: clippedRect,
            style: {
              fill:
                typeof visualColor === 'string'
                  ? visualColor
                  : params.data?.itemStyle?.color,
              opacity: 0.88,
            },
          };
        },
        encode: { x: [0, 1], y: 2 },
        tooltip: {
          formatter: (params: ChartTooltipParam) =>
            escapeHtml(params.data?.label || 'Driver stint'),
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
        markArea: buildRangeAreas(annotations.rangeEvents, chartColors),
        tooltip: { show: false },
        z: 1,
      };

      const stintIncidentSeries = buildIncidentScatter(
        'Incidents',
        annotations.taggedIncidents,
        0,
        chartColors.incidentMarker,
        1,
        1,
        'diamond',
      );

      const positionSeries = [
        {
          name: 'Position',
          type: 'line',
          smooth: false,
          showSymbol: false,
          itemStyle: { color: chartColors.positionLine },
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
          itemStyle: { color: chartColors.gapLine },
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
                const gapValue =
                  typeof row.gap_leader_ms === 'number' &&
                  Number.isFinite(row.gap_leader_ms)
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

      const topLegendNames = ['Lap Times'];
      const middleLegendNames = [
        rangeEventSeries.name,
        stintSeries.name,
        stintIncidentSeries.name,
      ];
      const bottomLegendNames = [
        ...positionSeries.map((series) => series.name),
        ...gapSeries.map((series) => series.name),
      ];

      chart.setOption({
        animationDuration: 250,
        color: palette,
        textStyle: { color: chartColors.labelText },
        tooltip: {
          trigger: 'axis',
          backgroundColor: chartColors.tooltipBackground,
          borderColor: chartColors.tooltipBorder,
          textStyle: { color: chartColors.tooltipText },
          formatter: (items: ChartTooltipParam[]) =>
            items
              .map((item) => {
                const value = item.value?.[1];
                const seriesName = escapeHtml(item.seriesName);
                if (item.seriesName.startsWith('Lap Times')) {
                  return `${seriesName}: ${escapeHtml(formatDurationMs(typeof value === 'number' ? value * 1000 : null))}`;
                }
                if (item.seriesName.startsWith('Position')) {
                  return `${seriesName}: ${escapeHtml(formatNumber(value))}`;
                }
                if (item.seriesName.startsWith('Gap to Leader')) {
                  return `${seriesName}: ${escapeHtml(item.data?.gapDisplay ?? formatNumber(value))}`;
                }
                if (item.seriesName.startsWith('Driver Stints')) {
                  return `${seriesName}: ${escapeHtml(item.data?.label ?? '')}`;
                }
                return `${seriesName}: ${escapeHtml(item.data?.label ?? '')}`;
              })
              .join('<br/>'),
        },
        legend: [
          {
            top: 4,
            data: topLegendNames,
            textStyle: { color: chartColors.axisText },
          },
          {
            left: 'center',
            top: '43%',
            data: middleLegendNames,
            textStyle: { color: chartColors.axisText },
          },
          {
            left: 'center',
            bottom: 72,
            data: bottomLegendNames,
            textStyle: { color: chartColors.axisText },
          },
        ],
        grid: [
          {
            left: gridGutters.left,
            right: gridGutters.right,
            top: 40,
            height: '33%',
            containLabel: false,
          },
          {
            left: gridGutters.left,
            right: gridGutters.right,
            top: '47%',
            height: '14%',
            containLabel: false,
          },
          {
            left: gridGutters.left,
            right: gridGutters.right,
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
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            axisTick: { lineStyle: { color: chartColors.axisLine } },
            axisLabel: { color: chartColors.axisText },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
          },
          {
            type: 'value',
            name: '',
            gridIndex: 1,
            min: lapAxisMin,
            max: lapAxisMax,
            minInterval: 1,
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            axisTick: { lineStyle: { color: chartColors.axisLine } },
            axisLabel: { color: chartColors.axisText },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
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
            nameTextStyle: { color: chartColors.axisText },
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            axisTick: { lineStyle: { color: chartColors.axisLine } },
            axisLabel: { color: chartColors.axisText },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
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
              color: chartColors.axisText,
              formatter: (value: number) => formatDurationWholeSeconds(value),
            },
            nameTextStyle: { color: chartColors.axisText },
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            axisTick: { lineStyle: { color: chartColors.axisLine } },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
          },
          {
            type: 'value',
            gridIndex: 1,
            min: -0.5,
            max: Math.max(stintLaneModel.labels.length - 0.5, 1.5),
            interval: 1,
            axisLabel: { show: false },
            axisTick: { show: false },
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
          },
          {
            type: 'value',
            name: 'Position',
            inverse: true,
            minInterval: 1,
            gridIndex: 2,
            nameTextStyle: {
              color: chartColors.axisText,
              padding: [6, 0, 0, 0],
            },
            axisLabel: { color: chartColors.axisText },
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            axisTick: { lineStyle: { color: chartColors.axisLine } },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
          },
          {
            type: 'value',
            name: 'Gap to Leader',
            position: 'right',
            min: 0,
            gridIndex: 2,
            nameTextStyle: { color: chartColors.axisText },
            axisLabel: {
              color: chartColors.axisText,
              formatter: (value: number) => formatNumber(value),
            },
            axisLine: { lineStyle: { color: chartColors.axisLine } },
            axisTick: { lineStyle: { color: chartColors.axisLine } },
            splitLine: { lineStyle: { color: chartColors.splitLine } },
          },
        ],
        dataZoom: [
          {
            type: 'slider',
            bottom: 28,
            height: 32,
            xAxisIndex: [0, 1, 2],
            labelFormatter: (value: number) => `${Math.round(value)}`,
            textStyle: { color: chartColors.axisText },
            borderColor: chartColors.axisLine,
            fillerColor: chartColors.dataZoomFill,
            handleStyle: { color: chartColors.dataZoomHandle },
          },
        ],
        series: [
          ...lapSeries,
          rangeEventSeries,
          stintSeries,
          stintIncidentSeries,
          ...positionSeries,
          ...gapSeries,
        ],
      });
    },
    resize() {
      scheduleResize();
    },
    setLapRange(
      lapMin: number | null | undefined,
      lapMax: number | null | undefined,
    ) {
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

function applyZoomRange(
  chart: ReturnType<typeof echarts.init>,
  range: { lapMin: number; lapMax: number },
  onBefore?: () => void,
  onAfter?: () => void,
): void {
  onBefore?.();
  try {
    chart.dispatchAction({
      type: 'dataZoom',
      dataZoomIndex: 0,
      startValue: range.lapMin,
      endValue: range.lapMax,
    });
  } finally {
    onAfter?.();
  }
}

function getCurrentRawZoomLapRange(
  chart: ReturnType<typeof echarts.init>,
  lapAxisBounds: LapAxisBounds,
): { lapMin: number; lapMax: number } | null {
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

function getCurrentZoomLapRange(
  chart: ReturnType<typeof echarts.init>,
  lapAxisBounds: LapAxisBounds,
): { lapMin: number; lapMax: number } | null {
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

function normalizeZoomLapRange(
  lapMin: number | null | undefined,
  lapMax: number | null | undefined,
  lapAxisBounds: LapAxisBounds,
): { lapMin: number; lapMax: number } | null {
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  return Math.max(min, Math.min(max, value));
}

function withGaps<T extends { lapNumber: number }>(
  points: T[],
): Array<
  | T
  | {
      value: [number, null];
      lapNumber: number;
    }
> {
  const result: Array<T | { value: [number, null]; lapNumber: number }> = [];
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

function getSinglePointSegments<T extends { lapNumber: number }>(
  points: T[],
): T[] {
  return points.filter((point, index) => {
    const previous = points[index - 1] ?? null;
    const next = points[index + 1] ?? null;
    const hasPreviousNeighbor =
      previous !== null && point.lapNumber - previous.lapNumber <= 1;
    const hasNextNeighbor =
      next !== null && next.lapNumber - point.lapNumber <= 1;

    return !hasPreviousNeighbor && !hasNextNeighbor;
  });
}

function getChartGridGutters(element: HTMLElement): {
  left: number;
  right: number;
} {
  const width = element.clientWidth;
  if (width <= 520) {
    return { left: 40, right: 28 };
  }

  if (width <= 760) {
    return { left: 48, right: 44 };
  }

  return { left: 56, right: 72 };
}

function allowPageWheelScroll(element: HTMLElement): void {
  element.addEventListener(
    'wheel',
    (event) => {
      event.stopPropagation();
    },
    { capture: true, passive: true },
  );
}

function buildRangeAreas(
  rangeEvents: RangeEvent[],
  chartColors: ChartColorTokens,
) {
  return {
    silent: true,
    itemStyle: { opacity: 0.08 },
    label: {
      show: true,
      position: 'insideBottom',
      formatter: (params: MarkAreaLabelParam) =>
        params?.data?.[0]?.name ?? params?.name ?? '',
      color: chartColors.labelText,
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
  name: string,
  items: Array<LapNote | TaggedIncident>,
  yValue: number,
  color: string,
  xAxisIndex: number,
  yAxisIndex: number,
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

function buildStintLaneModel(driverStints: DriverStint[]) {
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

  const laneByDriver = new Map<string, number>();
  const orderedDrivers: string[] = [];
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
    // Reserve lane 0 for incidents; place first driver at top.
    laneByDriver.set(driverName, driverCount - index);
  });

  const labels: string[] = ['Incidents'];
  laneByDriver.forEach((laneIndex, driverName) => {
    labels[laneIndex] = driverName;
  });

  const driverColorByName = new Map<string, string>();
  laneByDriver.forEach((laneIndex, driverName) => {
    driverColorByName.set(driverName, buildDriverLaneColor(laneIndex - 1));
  });

  const stints = sortedStints.map((stint) => {
    const driverName =
      (stint.driver_name || 'Unknown driver').trim() || 'Unknown driver';
    const laneIndex = laneByDriver.get(driverName) ?? 1;
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

function buildDriverLaneColor(driverIndex: number): string {
  const hue = (driverIndex * 137.508) % 360;
  return `hsl(${hue}, 72%, 46%)`;
}

function getMinuteFloorSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 60;
  }

  const minuteFloorSeconds = Math.floor(seconds / 60) * 60;
  return Math.max(60, minuteFloorSeconds);
}

function getTenMinuteCeilingSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 600;
  }

  const tenMinuteCeilingSeconds = Math.ceil(seconds / 600) * 600;
  return Math.max(600, tenMinuteCeilingSeconds);
}

function formatDurationWholeSeconds(seconds: number): string {
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

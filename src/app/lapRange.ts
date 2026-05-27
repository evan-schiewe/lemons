import type { LapRangeBounds, LapRow } from '../types';

interface LapRangeInputRefs {
  lapMin: HTMLInputElement;
  lapMax: HTMLInputElement;
}

export function getLapBounds(rows: LapRow[]): LapRangeBounds | null {
  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  const lapNumbers = rows
    .map((row) => Number(row.lap_number))
    .filter((lapNumber) => Number.isFinite(lapNumber));

  if (!lapNumbers.length) {
    return null;
  }

  return {
    min: Math.min(...lapNumbers),
    max: Math.max(...lapNumbers),
  };
}

export function syncLapRangeInputs(
  refs: LapRangeInputRefs,
  bounds: LapRangeBounds | null,
  options: {
    prefill?: boolean;
    changedField?: 'lapMin' | 'lapMax' | null;
    forceToBounds?: boolean;
  } = {},
): { lapMin: number | null; lapMax: number | null } {
  const {
    prefill = false,
    changedField = null,
    forceToBounds = false,
  } = options;

  if (!bounds || !Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) {
    refs.lapMin.removeAttribute('min');
    refs.lapMin.removeAttribute('max');
    refs.lapMax.removeAttribute('min');
    refs.lapMax.removeAttribute('max');
    return { lapMin: null, lapMax: null };
  }

  refs.lapMin.min = `${bounds.min}`;
  refs.lapMin.max = `${bounds.max}`;
  refs.lapMax.min = `${bounds.min}`;
  refs.lapMax.max = `${bounds.max}`;

  let lapMin = parseIntegerOrNull(refs.lapMin.value);
  let lapMax = parseIntegerOrNull(refs.lapMax.value);

  if (forceToBounds) {
    lapMin = bounds.min;
    lapMax = bounds.max;
  }

  if (prefill && lapMin == null) {
    lapMin = bounds.min;
  }

  if (prefill && lapMax == null) {
    lapMax = bounds.max;
  }

  if (lapMin != null) {
    lapMin = clamp(lapMin, bounds.min, bounds.max);
  }

  if (lapMax != null) {
    lapMax = clamp(lapMax, bounds.min, bounds.max);
  }

  if (lapMin != null && lapMax != null && lapMin > lapMax) {
    if (changedField === 'lapMin') {
      lapMax = lapMin;
    } else if (changedField === 'lapMax') {
      lapMin = lapMax;
    } else {
      lapMin = bounds.min;
      lapMax = bounds.max;
    }
  }

  refs.lapMin.value = lapMin == null ? '' : `${lapMin}`;
  refs.lapMax.value = lapMax == null ? '' : `${lapMax}`;

  return { lapMin, lapMax };
}

export function parseIntegerOrNull(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const COLOR_TOKENS = {
  brandYellow: '#f7de03',
  brandGreen: '#007a40',
  brandBlack: '#000000',
  neutralInk: '#101110',
  neutralSecondary: '#333733',
  neutralMuted: '#686d66',
  neutralSubtle: '#8a8f87',
  warning: '#8a5a00',
  danger: '#b42318',
} as const;

export const ANNOTATION_COLOR_TOKENS = {
  lapNote: COLOR_TOKENS.brandYellow,
  taggedIncident: COLOR_TOKENS.brandGreen,
  rangeEvent: COLOR_TOKENS.brandYellow,
  driverStint: COLOR_TOKENS.brandGreen,
  journalEntry: COLOR_TOKENS.neutralSecondary,
  reviewed: COLOR_TOKENS.brandGreen,
  repair: COLOR_TOKENS.neutralSecondary,
  pit: COLOR_TOKENS.brandYellow,
  outlier: COLOR_TOKENS.neutralMuted,
  fallback: COLOR_TOKENS.neutralMuted,
} as const;

export const CHART_COLOR_TOKENS = {
  axisText: COLOR_TOKENS.neutralMuted,
  axisLine: COLOR_TOKENS.neutralSubtle,
  labelText: COLOR_TOKENS.neutralInk,
  histogramBar: 'rgb(0 122 64 / 0.82)',
  lapLine: COLOR_TOKENS.brandGreen,
  positionLine: COLOR_TOKENS.brandGreen,
  gapLine: COLOR_TOKENS.neutralSecondary,
  incidentMarker: ANNOTATION_COLOR_TOKENS.taggedIncident,
  lapNoteMarker: ANNOTATION_COLOR_TOKENS.lapNote,
} as const;

export const CHART_SERIES_PALETTE = [
  COLOR_TOKENS.brandGreen,
  COLOR_TOKENS.brandYellow,
  COLOR_TOKENS.neutralSecondary,
  COLOR_TOKENS.neutralMuted,
  COLOR_TOKENS.neutralSubtle,
] as const;

export const GAP_SERIES_PALETTE = [
  COLOR_TOKENS.neutralSecondary,
  COLOR_TOKENS.brandGreen,
  COLOR_TOKENS.brandYellow,
  COLOR_TOKENS.neutralMuted,
] as const;

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'lemons-theme-preference';
const SYSTEM_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

const FALLBACK_COLOR_TOKENS = {
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

export const COLOR_TOKENS = {
  get brandYellow() {
    return readCssValue('--brand-yellow', FALLBACK_COLOR_TOKENS.brandYellow);
  },
  get brandGreen() {
    return readCssValue('--brand-green', FALLBACK_COLOR_TOKENS.brandGreen);
  },
  get brandBlack() {
    return readCssValue('--brand-black', FALLBACK_COLOR_TOKENS.brandBlack);
  },
  get neutralInk() {
    return readCssValue('--neutral-900', FALLBACK_COLOR_TOKENS.neutralInk);
  },
  get neutralSecondary() {
    return readCssValue(
      '--neutral-700',
      FALLBACK_COLOR_TOKENS.neutralSecondary,
    );
  },
  get neutralMuted() {
    return readCssValue('--neutral-500', FALLBACK_COLOR_TOKENS.neutralMuted);
  },
  get neutralSubtle() {
    return readCssValue('--neutral-400', FALLBACK_COLOR_TOKENS.neutralSubtle);
  },
  get warning() {
    return readCssValue('--color-warning', FALLBACK_COLOR_TOKENS.warning);
  },
  get danger() {
    return readCssValue('--color-danger', FALLBACK_COLOR_TOKENS.danger);
  },
} as const;

export const ANNOTATION_COLOR_TOKENS = {
  get lapNote() {
    return COLOR_TOKENS.brandYellow;
  },
  get taggedIncident() {
    return COLOR_TOKENS.brandGreen;
  },
  get rangeEvent() {
    return COLOR_TOKENS.brandYellow;
  },
  get driverStint() {
    return COLOR_TOKENS.brandGreen;
  },
  get journalEntry() {
    return COLOR_TOKENS.neutralSecondary;
  },
  get reviewed() {
    return COLOR_TOKENS.brandGreen;
  },
  get repair() {
    return COLOR_TOKENS.neutralSecondary;
  },
  get pit() {
    return COLOR_TOKENS.brandYellow;
  },
  get outlier() {
    return COLOR_TOKENS.neutralMuted;
  },
  get fallback() {
    return COLOR_TOKENS.neutralMuted;
  },
} as const;

export interface ChartColorTokens {
  axisText: string;
  axisLine: string;
  splitLine: string;
  labelText: string;
  histogramBar: string;
  lapLine: string;
  positionLine: string;
  gapLine: string;
  incidentMarker: string;
  lapNoteMarker: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
  dataZoomFill: string;
  dataZoomHandle: string;
}

export function getChartColorTokens(): ChartColorTokens {
  const accentRgb = readCssValue('--color-accent-rgb', '0 122 64');

  return {
    axisText: readResolvedCssColor(
      '--chart-axis-text',
      FALLBACK_COLOR_TOKENS.neutralMuted,
    ),
    axisLine: readResolvedCssColor(
      '--chart-axis-line',
      FALLBACK_COLOR_TOKENS.neutralSubtle,
    ),
    splitLine: readResolvedCssColor('--chart-split-line', '#d9dbd4'),
    labelText: readResolvedCssColor(
      '--chart-label-text',
      FALLBACK_COLOR_TOKENS.neutralInk,
    ),
    histogramBar: `rgb(${accentRgb} / 0.82)`,
    lapLine: readResolvedCssColor(
      '--chart-lap-line',
      FALLBACK_COLOR_TOKENS.brandGreen,
    ),
    positionLine: readResolvedCssColor(
      '--chart-position-line',
      FALLBACK_COLOR_TOKENS.brandGreen,
    ),
    gapLine: readResolvedCssColor(
      '--chart-gap-line',
      FALLBACK_COLOR_TOKENS.neutralSecondary,
    ),
    incidentMarker: ANNOTATION_COLOR_TOKENS.taggedIncident,
    lapNoteMarker: ANNOTATION_COLOR_TOKENS.lapNote,
    tooltipBackground: readResolvedCssColor(
      '--chart-tooltip-background',
      '#fffef8',
    ),
    tooltipBorder: readResolvedCssColor('--chart-tooltip-border', '#d9dbd4'),
    tooltipText: readResolvedCssColor(
      '--chart-tooltip-text',
      FALLBACK_COLOR_TOKENS.neutralInk,
    ),
    dataZoomFill: `rgb(${accentRgb} / 0.18)`,
    dataZoomHandle: readResolvedCssColor(
      '--chart-data-zoom-handle',
      FALLBACK_COLOR_TOKENS.brandGreen,
    ),
  };
}

export const CHART_COLOR_TOKENS = {
  get axisText() {
    return getChartColorTokens().axisText;
  },
  get axisLine() {
    return getChartColorTokens().axisLine;
  },
  get splitLine() {
    return getChartColorTokens().splitLine;
  },
  get labelText() {
    return getChartColorTokens().labelText;
  },
  get histogramBar() {
    return getChartColorTokens().histogramBar;
  },
  get lapLine() {
    return getChartColorTokens().lapLine;
  },
  get positionLine() {
    return getChartColorTokens().positionLine;
  },
  get gapLine() {
    return getChartColorTokens().gapLine;
  },
  get incidentMarker() {
    return getChartColorTokens().incidentMarker;
  },
  get lapNoteMarker() {
    return getChartColorTokens().lapNoteMarker;
  },
} as const;

export const CHART_SERIES_PALETTE = [
  FALLBACK_COLOR_TOKENS.brandGreen,
  FALLBACK_COLOR_TOKENS.brandYellow,
  FALLBACK_COLOR_TOKENS.neutralSecondary,
  FALLBACK_COLOR_TOKENS.neutralMuted,
  FALLBACK_COLOR_TOKENS.neutralSubtle,
] as const;

export const GAP_SERIES_PALETTE = [
  FALLBACK_COLOR_TOKENS.neutralSecondary,
  FALLBACK_COLOR_TOKENS.brandGreen,
  FALLBACK_COLOR_TOKENS.brandYellow,
  FALLBACK_COLOR_TOKENS.neutralMuted,
] as const;

export function getChartSeriesPalette(): string[] {
  return [
    COLOR_TOKENS.brandGreen,
    COLOR_TOKENS.brandYellow,
    COLOR_TOKENS.neutralSecondary,
    COLOR_TOKENS.neutralMuted,
    COLOR_TOKENS.neutralSubtle,
  ];
}

export function getGapSeriesPalette(): string[] {
  return [
    COLOR_TOKENS.neutralSecondary,
    COLOR_TOKENS.brandGreen,
    COLOR_TOKENS.brandYellow,
    COLOR_TOKENS.neutralMuted,
  ];
}

export function readStoredThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function resolveEffectiveTheme(
  preference: ThemePreference = readStoredThemePreference(),
): EffectiveTheme {
  if (preference === 'light' || preference === 'dark') {
    return preference;
  }

  return getSystemColorSchemeQuery()?.matches ? 'dark' : 'light';
}

export function applyThemePreference(
  preference: ThemePreference = readStoredThemePreference(),
): EffectiveTheme {
  const normalizedPreference = normalizeThemePreference(preference);
  const effectiveTheme = resolveEffectiveTheme(normalizedPreference);

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.themePreference = normalizedPreference;
    document.documentElement.style.colorScheme = effectiveTheme;
  }

  return effectiveTheme;
}

export function initializeThemeControls(
  inputs: Iterable<HTMLInputElement>,
  options: {
    controlPanel?: HTMLElement;
    onThemeChange?: (
      effectiveTheme: EffectiveTheme,
      preference: ThemePreference,
    ) => void | Promise<void>;
    toggleButton?: HTMLButtonElement;
  } = {},
): () => void {
  const themeInputs = Array.from(inputs);
  const { controlPanel, toggleButton } = options;
  const mediaQuery = getSystemColorSchemeQuery();
  let currentPreference = readStoredThemePreference();
  let currentEffectiveTheme = applyThemePreference(currentPreference);

  syncThemeControls(themeInputs, currentPreference);
  updateThemeToggleLabel(
    toggleButton,
    currentPreference,
    currentEffectiveTheme,
  );

  const setPickerOpen = (isOpen: boolean, focusChecked = false): void => {
    if (!toggleButton || !controlPanel) {
      return;
    }

    controlPanel.hidden = !isOpen;
    toggleButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

    if (isOpen && focusChecked) {
      requestAnimationFrame(() => {
        const checkedInput = themeInputs.find((input) => input.checked);
        checkedInput?.focus();
      });
    }
  };

  const updatePreference = (preference: ThemePreference): void => {
    currentPreference = preference;
    persistThemePreference(preference);
    syncThemeControls(themeInputs, preference);
    const nextEffectiveTheme = applyThemePreference(preference);
    updateThemeToggleLabel(toggleButton, preference, nextEffectiveTheme);

    if (nextEffectiveTheme !== currentEffectiveTheme) {
      currentEffectiveTheme = nextEffectiveTheme;
      void options.onThemeChange?.(nextEffectiveTheme, preference);
      return;
    }

    currentEffectiveTheme = nextEffectiveTheme;
  };

  const handleInputChange = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    if (!input.checked) {
      return;
    }

    updatePreference(normalizeThemePreference(input.value));
    setPickerOpen(false);
    toggleButton?.focus();
  };

  const handleSystemThemeChange = (): void => {
    if (currentPreference !== 'system') {
      return;
    }

    const nextEffectiveTheme = applyThemePreference(currentPreference);
    updateThemeToggleLabel(toggleButton, currentPreference, nextEffectiveTheme);
    if (nextEffectiveTheme !== currentEffectiveTheme) {
      currentEffectiveTheme = nextEffectiveTheme;
      void options.onThemeChange?.(nextEffectiveTheme, currentPreference);
    }
  };

  const handleToggleClick = (): void => {
    if (!controlPanel) {
      return;
    }

    setPickerOpen(isThemeControlHidden(controlPanel), true);
  };

  const handleDocumentClick = (event: MouseEvent): void => {
    if (!toggleButton || !controlPanel || controlPanel.hidden) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (toggleButton.contains(target) || controlPanel.contains(target)) {
      return;
    }

    setPickerOpen(false);
  };

  const handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !controlPanel || controlPanel.hidden) {
      return;
    }

    setPickerOpen(false);
    toggleButton?.focus();
  };

  themeInputs.forEach((input) => {
    input.addEventListener('change', handleInputChange);
  });
  toggleButton?.addEventListener('click', handleToggleClick);
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleDocumentKeydown);
  mediaQuery?.addEventListener('change', handleSystemThemeChange);

  return () => {
    themeInputs.forEach((input) => {
      input.removeEventListener('change', handleInputChange);
    });
    toggleButton?.removeEventListener('click', handleToggleClick);
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleDocumentKeydown);
    mediaQuery?.removeEventListener('change', handleSystemThemeChange);
  };
}

function isThemeControlHidden(controlPanel: HTMLElement): boolean {
  return controlPanel.hidden === true || controlPanel.hidden === 'until-found';
}

function updateThemeToggleLabel(
  toggleButton: HTMLButtonElement | undefined,
  preference: ThemePreference,
  effectiveTheme: EffectiveTheme,
): void {
  if (!toggleButton) {
    return;
  }

  const preferenceLabel =
    preference === 'system'
      ? `System, currently ${effectiveTheme}`
      : preference;
  const label = `Theme: ${preferenceLabel}. Choose theme`;
  toggleButton.setAttribute('aria-label', label);
  toggleButton.title = label;
}

function persistThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
      return;
    }

    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignore storage failures and keep the in-memory preference active.
  }
}

function syncThemeControls(
  inputs: HTMLInputElement[],
  preference: ThemePreference,
): void {
  inputs.forEach((input) => {
    input.checked = input.value === preference;
  });
}

function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system';
}

function getSystemColorSchemeQuery(): MediaQueryList | null {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return null;
  }

  return window.matchMedia(SYSTEM_COLOR_SCHEME_QUERY);
}

function readCssValue(tokenName: string, fallback: string): string {
  if (typeof document === 'undefined') {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(tokenName)
    .trim();
  return value || fallback;
}

function readResolvedCssColor(tokenName: string, fallback: string): string {
  if (typeof document === 'undefined') {
    return fallback;
  }

  const host = document.body ?? document.documentElement;
  const probe = document.createElement('span');
  probe.style.color = `var(${tokenName}, ${fallback})`;
  probe.style.display = 'none';
  host.append(probe);

  const resolvedColor = getComputedStyle(probe).color;
  probe.remove();

  return resolvedColor || fallback;
}

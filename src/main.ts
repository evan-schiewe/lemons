import './styles.css';
import { SQLiteClient } from './db/sqliteClient';
import { mountAnnotationHelper } from './features/annotations/annotationHelperView';
import { mountAnnotationPanel } from './features/annotations/annotationPanel';
import { createAnnotationStore } from './features/annotations/annotationStore';
import { exportAnnotationsFile } from './features/export/exportAnnotations';
import { exportDatabaseFile } from './features/export/exportDb';
import { importRace } from './features/import/importRace';
import {
  augmentCandidateWithReviewStatus,
  getCandidates,
  getDriverOptions,
  getLapSeries,
  getLapTableRows,
  getRaceAnnotations,
  getRaceList,
  getRaceSnapshot,
  getRaceTimelineEvents,
  getSummary,
} from './features/query/raceQueries';
import {
  renderLapTable,
  scrollToLap,
  updateSortIndicators,
} from './features/table/lapTable';
import { mountTimelineView } from './features/timeline/timelineView';
import type {
  AnnotationHandlers,
  AnnotationKind,
  AnnotationPayload,
  AnnotationStore,
  LapFilters,
  LapRangeBounds,
  LapRow,
  LapTimeChartHandle,
  RaceAnnotations,
  RaceRecord,
  SortColumn,
  SortState,
  SummaryRow,
  TimelineEvent,
} from './types';
import { closestElement, errorMessage, queryRequired } from './utils/dom';

const isLocalEditingEnabled = import.meta.env.DEV;

interface AppRefs {
  appInitStatus: HTMLElement | null;
  heroActionsHost: HTMLElement;
  dataActions: HTMLElement;
  dataActionsSlot: HTMLElement;
  csvInput: HTMLInputElement;
  sqliteInput: HTMLInputElement;
  exportJson: HTMLButtonElement;
  exportSqlite: HTMLButtonElement;
  raceSelect: HTMLSelectElement;
  driverFilter: HTMLSelectElement;
  searchFilter: HTMLInputElement;
  lapMin: HTMLInputElement;
  lapMax: HTMLInputElement;
  summaryGreenOnly: HTMLInputElement;
  importStatus: HTMLElement;
  summaryCards: HTMLElement;
  tableBody: HTMLTableSectionElement;
  table: HTMLTableElement;
  helperContainer: HTMLElement;
  annotationPanelContainer: HTMLElement;
  timelineContainer: HTMLElement;
  dataTabButton: HTMLButtonElement;
  tabButtons: NodeListOf<HTMLButtonElement>;
  tabContents: NodeListOf<HTMLElement>;
  annotationSubtabButtons: NodeListOf<HTMLButtonElement>;
  annotationSubtabContents: NodeListOf<HTMLElement>;
}

interface AppState {
  db: SQLiteClient | null;
  annotationStore: AnnotationStore | null;
  races: RaceRecord[];
  activeRaceId: string;
  selectedLapId: string;
  sort: SortState;
  currentRows: LapRow[];
  currentAnnotations: RaceAnnotations;
  currentTimelineEvents: TimelineEvent[];
  helperMode: boolean;
  helperCurrentIndex: number;
  helperAutoAdvance: boolean;
  helperViewMode: 'queue' | 'form';
  lapRangeBounds: LapRangeBounds | null;
  lapRangeRaceId: string;
  summaryGreenOnly: boolean;
}

const refs: AppRefs = {
  appInitStatus: document.querySelector('#app-init-status'),
  heroActionsHost: queryRequired<HTMLElement>('#hero-actions-host'),
  dataActions: queryRequired<HTMLElement>('#data-actions'),
  dataActionsSlot: queryRequired<HTMLElement>('#data-actions-slot'),
  csvInput: queryRequired<HTMLInputElement>('#csv-input'),
  sqliteInput: queryRequired<HTMLInputElement>('#sqlite-input'),
  exportJson: queryRequired<HTMLButtonElement>('#export-json'),
  exportSqlite: queryRequired<HTMLButtonElement>('#export-sqlite'),
  raceSelect: queryRequired<HTMLSelectElement>('#race-select'),
  driverFilter: queryRequired<HTMLSelectElement>('#driver-filter'),
  searchFilter: queryRequired<HTMLInputElement>('#search-filter'),
  lapMin: queryRequired<HTMLInputElement>('#lap-min'),
  lapMax: queryRequired<HTMLInputElement>('#lap-max'),
  summaryGreenOnly: queryRequired<HTMLInputElement>('#summary-green-only'),
  importStatus: queryRequired<HTMLElement>('#import-status'),
  summaryCards: queryRequired<HTMLElement>('#summary-cards'),
  tableBody: queryRequired<HTMLTableSectionElement>('#lap-table-body'),
  table: queryRequired<HTMLTableElement>('table'),
  helperContainer: queryRequired<HTMLElement>('#annotation-helper-container'),
  annotationPanelContainer: queryRequired<HTMLElement>(
    '#annotation-panel-container',
  ),
  timelineContainer: queryRequired<HTMLElement>('#timeline-container'),
  dataTabButton: queryRequired<HTMLButtonElement>('#data-tab-button'),
  tabButtons: document.querySelectorAll('.tab-button'),
  tabContents: document.querySelectorAll('.tab-content'),
  annotationSubtabButtons: document.querySelectorAll(
    '.annotation-subtab-button',
  ),
  annotationSubtabContents: document.querySelectorAll(
    '.annotation-subtab-content',
  ),
};

const state: AppState = {
  db: null,
  annotationStore: null,
  races: [],
  activeRaceId: '',
  selectedLapId: '',
  sort: {
    column: 'lap_number',
    direction: 'asc',
  },
  currentRows: [],
  currentAnnotations: {
    lapNotes: [],
    taggedIncidents: [],
    rangeEvents: [],
    driverStints: [],
    journalEntries: [],
  },
  currentTimelineEvents: [],
  helperMode: false,
  helperCurrentIndex: 0,
  helperAutoAdvance: false,
  helperViewMode: 'queue', // 'queue' or 'form'
  lapRangeBounds: null,
  lapRangeRaceId: '',
  summaryGreenOnly: true,
};

const charts = {
  lapTime: null as LapTimeChartHandle | null,
};

let chartModulesPromise: Promise<void> | null = null;
let createLapTimeChart:
  | typeof import('./features/charts/lapTimeChart').createLapTimeChart
  | null = null;
let renderSummaryCards:
  | typeof import('./features/dashboard/summaryCards').renderSummaryCards
  | null = null;

// Placeholder for annotation helper - will be initialized when module is created
let annotationHelper: ReturnType<typeof mountAnnotationHelper> | null = null;
let annotationPanel: ReturnType<typeof mountAnnotationPanel> | null = null;
let timelineView: ReturnType<typeof mountTimelineView> | null = null;

function getDb(): SQLiteClient {
  if (!state.db) {
    throw new Error('Database is not initialized.');
  }

  return state.db;
}

function getAnnotationStore(): AnnotationStore {
  if (!state.annotationStore) {
    throw new Error('Annotation store is not initialized.');
  }

  return state.annotationStore;
}

async function ensureChartModules(): Promise<void> {
  if (!chartModulesPromise) {
    chartModulesPromise = Promise.all([
      import('./features/charts/lapTimeChart'),
      import('./features/dashboard/summaryCards'),
    ]).then(([lapTimeChartModule, summaryCardsModule]) => {
      createLapTimeChart = lapTimeChartModule.createLapTimeChart;
      renderSummaryCards = summaryCardsModule.renderSummaryCards;
    });
  }

  await chartModulesPromise;
}

async function ensureLapTimeChart(): Promise<LapTimeChartHandle> {
  if (charts.lapTime) {
    return charts.lapTime;
  }

  await ensureChartModules();
  if (!createLapTimeChart) {
    throw new Error('Chart module did not load.');
  }

  charts.lapTime = createLapTimeChart(queryRequired('#lap-time-chart'), {
    onSelectLap: handleLapSelectionByNumber,
    onLapRangeChange: handleLapRangeZoom,
  });

  return charts.lapTime;
}

async function renderSummaryCardsLazy(
  summary: SummaryRow,
  lapRows: LapRow[],
  options: { greenFlagOnly?: boolean },
): Promise<void> {
  await ensureChartModules();
  if (!renderSummaryCards) {
    throw new Error('Summary module did not load.');
  }
  renderSummaryCards(refs.summaryCards, summary, lapRows, options);
}

function createAnnotationHandlers({
  autoAdvanceOnSave = false,
}: {
  autoAdvanceOnSave?: boolean;
} = {}): AnnotationHandlers {
  return {
    onSave: async (kind: AnnotationKind, payload: AnnotationPayload) => {
      if (!state.activeRaceId) {
        setStatus('Import a race before saving annotations.');
        return false;
      }

      try {
        await getAnnotationStore().save(kind, {
          ...payload,
          race_id: state.activeRaceId,
        });
        setStatus('Annotation saved.');

        if (autoAdvanceOnSave && state.helperAutoAdvance) {
          const db = getDb();
          const candidates = getCandidates(db, state.activeRaceId);
          const annotations = getRaceAnnotations(db, state.activeRaceId);
          const augmented = candidates.map((candidate) =>
            augmentCandidateWithReviewStatus(
              candidate,
              annotations,
              db,
              state.activeRaceId,
            ),
          );

          for (
            let i = state.helperCurrentIndex + 1;
            i < augmented.length;
            i++
          ) {
            if (!augmented[i].isReviewed) {
              state.helperCurrentIndex = i;
              break;
            }
          }
        }

        await refreshView();
        return true;
      } catch (error) {
        console.error(error);
        setStatus(`Unable to save annotation: ${errorMessage(error)}`);
        return false;
      }
    },
    onDelete: async (kind: AnnotationKind, id: string) => {
      try {
        await getAnnotationStore().remove(kind, id);
        setStatus('Annotation removed.');
        await refreshView();
      } catch (error) {
        console.error(error);
        setStatus(`Unable to remove annotation: ${errorMessage(error)}`);
      }
    },
  };
}

initialize().catch((error) => {
  console.error(error);
  setStatus(`Initialization failed: ${errorMessage(error)}`);
  setAppLoadingState(false);
});

async function initialize(): Promise<void> {
  setAppLoadingState(true);
  setStatus('Initializing browser SQLite cache...');
  state.db = await new SQLiteClient().init();
  state.annotationStore = createAnnotationStore(state.db);

  // Restore helper state from localStorage
  state.helperAutoAdvance = localStorage.getItem('helperAutoAdvance') === '1';
  const persistedSummaryGreenOnly = localStorage.getItem('summaryGreenOnly');
  state.summaryGreenOnly =
    persistedSummaryGreenOnly == null
      ? true
      : persistedSummaryGreenOnly === '1';
  refs.summaryGreenOnly.checked = state.summaryGreenOnly;

  // Initialize annotation helper
  const helperContainer = refs.helperContainer;
  annotationHelper = mountAnnotationHelper(helperContainer, {
    ...createAnnotationHandlers({ autoAdvanceOnSave: true }),
    onOpenComposer: (kind, options) => {
      annotationPanel?.openComposer(kind, options);
    },
    onOpenEditor: (kind, id) => {
      annotationPanel?.openEditor(kind, id);
    },
    onNavigate: (direction) => {
      const db = getDb();
      const candidates = getCandidates(db, state.activeRaceId);
      if (!candidates.length) {
        return;
      }

      const annotations = getRaceAnnotations(db, state.activeRaceId);
      const augmented = candidates.map((c) =>
        augmentCandidateWithReviewStatus(
          c,
          annotations,
          db,
          state.activeRaceId,
        ),
      );

      if (direction === 'prev') {
        if (state.helperCurrentIndex > 0) {
          state.helperCurrentIndex--;
        }
      } else if (direction === 'next') {
        if (state.helperCurrentIndex < augmented.length - 1) {
          state.helperCurrentIndex++;
        }
      } else if (direction === 'jump-unresolved') {
        // Jump to first unreviewed candidate
        const nextUnreviewed = augmented.findIndex(
          (c, i) => i > state.helperCurrentIndex && !c.isReviewed,
        );
        if (nextUnreviewed >= 0) {
          state.helperCurrentIndex = nextUnreviewed;
        } else {
          // Wrap around to find first unreviewed from beginning
          const firstUnreviewed = augmented.findIndex((c) => !c.isReviewed);
          if (firstUnreviewed >= 0) {
            state.helperCurrentIndex = firstUnreviewed;
          }
        }
      }

      refreshView();
    },
    onToggleAutoAdvance: () => {
      state.helperAutoAdvance = !state.helperAutoAdvance;
      localStorage.setItem(
        'helperAutoAdvance',
        state.helperAutoAdvance ? '1' : '0',
      );
      refreshView();
    },
  });

  annotationPanel = mountAnnotationPanel(
    refs.annotationPanelContainer,
    createAnnotationHandlers(),
  );

  timelineView = mountTimelineView(refs.timelineContainer, {
    ...createAnnotationHandlers(),
    onSelectLap: handleLapSelectionByNumber,
    isLocalEditingEnabled,
  });

  wireEvents();
  await refreshRaceOptions();
  await refreshView();
  if (getDb().didRefreshBundledDatabase) {
    setAppLoadingState(false);
    setStatus(
      'Ready. Detected a newer deployment and refreshed the local bundled database cache.',
    );
    return;
  }

  setAppLoadingState(false);
  setStatus('Ready. Import lap CSV files or restore a SQLite export to begin.');
}

function wireEvents(): void {
  refs.csvInput.addEventListener('change', handleImport);
  refs.sqliteInput.addEventListener('change', handleRestoreSqlite);
  refs.raceSelect.addEventListener('change', async (event) => {
    state.activeRaceId = (event.currentTarget as HTMLSelectElement).value;
    state.selectedLapId = '';
    await refreshDriverOptions();
    await refreshView();
  });
  refs.driverFilter.addEventListener('change', () => {
    refreshView();
  });
  refs.searchFilter.addEventListener('input', () => {
    refreshView();
  });
  refs.lapMin.addEventListener('input', () => handleLapRangeInput('lapMin'));
  refs.lapMax.addEventListener('input', () => handleLapRangeInput('lapMax'));
  refs.summaryGreenOnly.addEventListener('change', async (event) => {
    state.summaryGreenOnly = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem(
      'summaryGreenOnly',
      state.summaryGreenOnly ? '1' : '0',
    );
    await refreshView();
  });
  refs.exportJson.addEventListener('click', () => {
    if (state.activeRaceId) {
      exportAnnotationsFile(getDb(), state.activeRaceId);
    }
  });
  refs.exportSqlite.addEventListener('click', () => {
    const activeRace = state.races.find(
      (race) => race.id === state.activeRaceId,
    );
    exportDatabaseFile(getDb(), activeRace?.name || 'lemons-race-viewer');
  });
  queryRequired<HTMLTableSectionElement>('thead', refs.table).addEventListener(
    'click',
    async (event) => {
      const header = closestElement<HTMLTableCellElement>(
        event.target,
        'th[data-sort]',
      );
      if (!header) {
        return;
      }

      const column = header.dataset.sort as SortColumn | undefined;
      if (!column) {
        return;
      }
      if (state.sort.column === column) {
        state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.column = column;
        state.sort.direction = 'asc';
      }

      await refreshView();
    },
  );
  refs.tableBody.addEventListener('click', async (event) => {
    const row = closestElement<HTMLTableRowElement>(
      event.target,
      'tr[data-lap-id]',
    );
    if (!row) {
      return;
    }

    const selectedRow = state.currentRows.find(
      (item) => item.id === row.dataset.lapId,
    );
    if (!selectedRow) {
      return;
    }

    await selectLapAndOpenDetails(selectedRow);
  });
  window.addEventListener('resize', () => {
    charts.lapTime?.resize();
  });
  setupTabSwitching();
  setupAnnotationSubtabs();
}

function setupTabSwitching(): void {
  const annotationsTabButton = Array.from(refs.tabButtons).find(
    (btn) => btn.dataset.tab === 'annotations',
  );
  if (annotationsTabButton) {
    annotationsTabButton.hidden = !isLocalEditingEnabled;
  }

  refs.tabButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const clickedButton = event.currentTarget as HTMLButtonElement;
      const tabName = clickedButton.dataset.tab;
      if (!tabName) return;

      // Update active button
      refs.tabButtons.forEach((btn) => {
        btn.classList.remove('active');
      });
      clickedButton.classList.add('active');

      // Update active tab content
      refs.tabContents.forEach((content) => {
        content.classList.remove('active');
      });
      const activeTab = document.querySelector<HTMLElement>(`#${tabName}-tab`);
      if (activeTab) {
        activeTab.classList.add('active');
        // Trigger chart resize if showing chart tab
        if (tabName === 'chart') {
          setTimeout(() => {
            charts.lapTime?.resize();
          }, 50);
        }
      }

      // Save preference to localStorage
      localStorage.setItem('activeTab', tabName);
    });
  });

  // Restore saved tab preference
  const savedTab = localStorage.getItem('activeTab') || 'chart';
  const savedTabButton = Array.from(refs.tabButtons).find(
    (btn) => btn.dataset.tab === savedTab && !btn.hidden,
  );
  if (savedTabButton) {
    savedTabButton.click();
  } else {
    const chartTabButton = Array.from(refs.tabButtons).find(
      (btn) => btn.dataset.tab === 'chart',
    );
    chartTabButton?.click();
  }
}

function syncDataTabAndActions(): void {
  const hasData = state.races.length > 0;

  refs.dataTabButton.hidden = !hasData;

  const activeDataButton = Array.from(refs.tabButtons).find(
    (btn) => btn.dataset.tab === 'data' && btn.classList.contains('active'),
  );
  if (!hasData && activeDataButton) {
    const chartButton = Array.from(refs.tabButtons).find(
      (btn) => btn.dataset.tab === 'chart',
    );
    chartButton?.click();
  }

  const targetHost = hasData ? refs.dataActionsSlot : refs.heroActionsHost;
  if (refs.dataActions.parentElement !== targetHost) {
    targetHost.append(refs.dataActions);
  }

  refs.heroActionsHost.hidden = hasData;
}

function setupAnnotationSubtabs(): void {
  refs.annotationSubtabButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const clickedButton = event.currentTarget as HTMLButtonElement;
      const subtabName = clickedButton.dataset.annotationTab;
      if (!subtabName) return;

      refs.annotationSubtabButtons.forEach((btn) => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      });
      clickedButton.classList.add('active');
      clickedButton.setAttribute('aria-selected', 'true');

      refs.annotationSubtabContents.forEach((content) => {
        content.classList.remove('active');
        content.hidden = true;
      });

      const activeSubtab = document.querySelector<HTMLElement>(
        `#annotation-${subtabName}-tab`,
      );
      if (activeSubtab) {
        activeSubtab.classList.add('active');
        activeSubtab.hidden = false;
      }

      localStorage.setItem('activeAnnotationSubtab', subtabName);
    });
  });

  const savedSubtab =
    localStorage.getItem('activeAnnotationSubtab') || 'editor';
  const savedSubtabButton = Array.from(refs.annotationSubtabButtons).find(
    (btn) => btn.dataset.annotationTab === savedSubtab,
  );
  if (savedSubtabButton) {
    savedSubtabButton.click();
  }
}

async function handleImport(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) {
    return;
  }

  const messages: string[] = [];
  const db = getDb();
  for (const file of files) {
    const importOptions = promptForRaceImportOptions(file.name);
    if (importOptions.cancelled) {
      refs.csvInput.value = '';
      setStatus(`Import cancelled before ${file.name}.`);
      return;
    }

    setStatus(`Importing ${file.name}...`);
    const result = await importRace(db, file, {
      raceStartTime: importOptions.raceStartTime,
    });
    messages.push(
      `${result.raceName}: ${result.rowCount} laps${result.warnings.length ? ` (${result.warnings.length} repairs/warnings)` : ''}`,
    );
    state.activeRaceId = result.raceId;
  }

  refs.csvInput.value = '';
  await refreshRaceOptions();
  await refreshView();
  setStatus(`Import complete. ${messages.join(' | ')}`);
}

async function handleRestoreSqlite(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const [file] = Array.from(input.files ?? []);
  if (!file) {
    return;
  }

  try {
    setStatus(`Restoring SQLite from ${file.name}...`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await getDb().restoreDatabase(bytes);

    state.activeRaceId = '';
    state.selectedLapId = '';
    state.helperCurrentIndex = 0;

    refs.sqliteInput.value = '';
    await refreshRaceOptions();
    await refreshView();

    const raceCount = state.races.length;
    setStatus(
      `SQLite restore complete. Loaded ${raceCount} race${raceCount === 1 ? '' : 's'}.`,
    );
  } catch (error) {
    console.error(error);
    refs.sqliteInput.value = '';
    setStatus(`SQLite restore failed: ${errorMessage(error)}`);
  }
}

async function refreshRaceOptions(): Promise<void> {
  state.races = getRaceList(getDb());
  syncDataTabAndActions();

  refs.raceSelect.innerHTML = state.races.length
    ? state.races
        .map((race) => `<option value="${race.id}">${race.name}</option>`)
        .join('')
    : '<option value="">No imported races</option>';

  if (!state.activeRaceId && state.races.length) {
    state.activeRaceId = state.races[0].id;
  }

  refs.raceSelect.value = state.activeRaceId;
  await refreshDriverOptions();
}

async function refreshDriverOptions(): Promise<void> {
  const selectedDriver = refs.driverFilter.value;
  const drivers = state.activeRaceId
    ? getDriverOptions(getDb(), state.activeRaceId)
    : [];
  refs.driverFilter.innerHTML = [
    '<option value="">All drivers</option>',
    ...drivers.map((driver) => `<option value="${driver}">${driver}</option>`),
  ].join('');
  refs.driverFilter.value = drivers.includes(selectedDriver)
    ? selectedDriver
    : '';
}

async function refreshView(
  options: { skipChartRender?: boolean } = {},
): Promise<void> {
  const { skipChartRender = false } = options;
  updateSortIndicators(refs.table, state.sort);

  if (!state.activeRaceId) {
    state.lapRangeBounds = null;
    state.lapRangeRaceId = '';
    syncLapRangeInputs(null, { prefill: false });
    refs.summaryCards.innerHTML =
      '<div class="summary-card"><span>No race selected</span><strong>Import a CSV</strong></div>';
    renderLapTable(refs.tableBody, [], state.selectedLapId, null);
    state.currentAnnotations = {
      lapNotes: [],
      taggedIncidents: [],
      rangeEvents: [],
      driverStints: [],
      journalEntries: [],
    };
    state.currentTimelineEvents = [];
    if (annotationHelper) {
      annotationHelper.render(null);
    }
    if (annotationPanel) {
      annotationPanel.render({
        selectedLapRow: null,
        rows: [],
        raceStartTime: null,
        annotations: {
          lapNotes: [],
          taggedIncidents: [],
          rangeEvents: [],
          driverStints: [],
          journalEntries: [],
        },
      });
    }
    if (timelineView) {
      timelineView.render(null);
    }
    return;
  }

  const db = getDb();
  const baseFilters = getBaseFilters();
  const raceLapSeries = getLapSeries(db, state.activeRaceId, {
    driver: '',
    search: '',
    lapMin: null,
    lapMax: null,
  });
  const lapRangeBounds = getLapBounds(raceLapSeries);
  state.lapRangeBounds = lapRangeBounds;
  const chartFilters = {
    ...baseFilters,
    lapMin: null,
    lapMax: null,
  };
  const lapSeries = getLapSeries(db, state.activeRaceId, chartFilters);
  const forceToBounds = state.lapRangeRaceId !== state.activeRaceId;
  const { lapMin, lapMax } = syncLapRangeInputs(lapRangeBounds, {
    prefill: true,
    forceToBounds,
  });
  state.lapRangeRaceId = state.activeRaceId;
  const filters = {
    ...baseFilters,
    lapMin,
    lapMax,
  };

  const rows = getLapTableRows(db, state.activeRaceId, filters, state.sort);
  const summary = getSummary(db, state.activeRaceId, filters);
  const annotations = getRaceAnnotations(db, state.activeRaceId);
  const timelineEvents = getRaceTimelineEvents(db, state.activeRaceId);

  state.currentRows = rows;
  state.currentAnnotations = annotations;
  state.currentTimelineEvents = timelineEvents;
  if (
    state.selectedLapId &&
    !rows.some((row) => row.id === state.selectedLapId)
  ) {
    state.selectedLapId = '';
  }

  await renderSummaryCardsLazy(summary, rows, {
    greenFlagOnly: state.summaryGreenOnly,
  });
  const activeRace = state.races.find((race) => race.id === state.activeRaceId);
  renderLapTable(
    refs.tableBody,
    rows,
    state.selectedLapId,
    activeRace?.race_start_time ?? null,
  );

  if (!skipChartRender) {
    const lapTimeChart = await ensureLapTimeChart();
    lapTimeChart.render(lapSeries, annotations, {
      lapAxisBounds: lapRangeBounds,
    });
    lapTimeChart.setLapRange(filters.lapMin, filters.lapMax);
  }
  // BUG FIX: charts.position was initialized but render() was never defined. Skip for now.
  // charts.position.render(lapSeries, annotations, null);

  const selectedLapRow =
    rows.find((row) => row.id === state.selectedLapId) ?? null;

  // Helper view: compute candidate queue and augmented review status
  if (annotationHelper) {
    const candidates = getCandidates(db, state.activeRaceId);
    const raceSnapshot = getRaceSnapshot(db, state.activeRaceId);
    const lapStartOffsets = new Map(
      raceSnapshot.laps.map((lap) => [
        lap.lap_number,
        lap.lap_start_offset_ms ?? 0,
      ]),
    );

    // Augment candidates with review status and lap_start_offset_ms
    const augmentedCandidates = candidates.map((candidate) => {
      const reviewed = augmentCandidateWithReviewStatus(
        candidate,
        annotations,
        db,
        state.activeRaceId,
      );

      return {
        ...reviewed,
        lap_start_offset_ms: lapStartOffsets.get(candidate.lap_number) ?? 0,
      };
    });

    annotationHelper.render({
      candidates: augmentedCandidates,
      currentIndex: state.helperCurrentIndex,
      selectedLapId: state.selectedLapId,
      selectedLapRow,
      annotations,
      autoAdvance: state.helperAutoAdvance,
      filterContext: filters,
      raceStartTime: activeRace?.race_start_time ?? null,
    });
  }

  if (annotationPanel) {
    annotationPanel.render({
      selectedLapRow,
      rows,
      raceStartTime: activeRace?.race_start_time ?? null,
      annotations,
    });
  }

  if (timelineView) {
    timelineView.render({
      timelineEvents,
      journalEntries: annotations.journalEntries || [],
      selectedLapRow,
      raceStartTime: activeRace?.race_start_time ?? null,
    });
  }
}

async function handleLapRangeZoom({
  lapMin,
  lapMax,
}: {
  lapMin: number | null;
  lapMax: number | null;
}): Promise<void> {
  const currentMin = parseIntegerOrNull(refs.lapMin.value);
  const currentMax = parseIntegerOrNull(refs.lapMax.value);
  const nextMin =
    typeof lapMin === 'number' && Number.isFinite(lapMin)
      ? Math.round(lapMin)
      : null;
  const nextMax =
    typeof lapMax === 'number' && Number.isFinite(lapMax)
      ? Math.round(lapMax)
      : null;

  const isSameMin =
    (Number.isFinite(currentMin) ? currentMin : null) === nextMin;
  const isSameMax =
    (Number.isFinite(currentMax) ? currentMax : null) === nextMax;
  if (isSameMin && isSameMax) {
    return;
  }

  refs.lapMin.value = nextMin == null ? '' : `${nextMin}`;
  refs.lapMax.value = nextMax == null ? '' : `${nextMax}`;
  syncLapRangeInputs(state.lapRangeBounds, { prefill: true });
  await refreshView({ skipChartRender: true });
}

async function handleLapRangeInput(
  changedField: 'lapMin' | 'lapMax',
): Promise<void> {
  syncLapRangeInputs(state.lapRangeBounds, { prefill: true, changedField });
  await refreshView();
}

function getBaseFilters(): LapFilters {
  return {
    driver: refs.driverFilter.value,
    search: refs.searchFilter.value.trim(),
  };
}

function getLapBounds(rows: LapRow[]): LapRangeBounds | null {
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

function syncLapRangeInputs(
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

function parseIntegerOrNull(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function handleLapSelectionByNumber(lapNumber: number): Promise<void> {
  const selectedRow = state.currentRows.find(
    (row) => row.lap_number === lapNumber,
  );
  if (selectedRow) {
    await selectLapAndOpenDetails(selectedRow);
  }

  // Scroll table to the clicked lap
  scrollToLap(lapNumber);
}

async function selectLapAndOpenDetails(selectedRow: LapRow): Promise<void> {
  if (!selectedRow) {
    return;
  }

  state.selectedLapId = selectedRow.id;
  await refreshView();

  if (!hasAnnotationsForLap(selectedRow, state.currentAnnotations)) {
    return;
  }

  const activeRace = state.races.find((race) => race.id === state.activeRaceId);
  annotationPanel?.openLapDetails({
    selectedLapRow: selectedRow,
    rows: state.currentRows,
    raceStartTime: activeRace?.race_start_time ?? null,
    annotations: state.currentAnnotations,
  });
}

function hasAnnotationsForLap(
  lapRow: LapRow,
  annotations: RaceAnnotations,
): boolean {
  if (!lapRow || !annotations) {
    return false;
  }

  const lapNumber = lapRow.lap_number;

  return (
    annotations.lapNotes.some((item) => item.lap_number === lapNumber) ||
    annotations.taggedIncidents.some((item) => item.lap_number === lapNumber) ||
    annotations.rangeEvents.some(
      (item) => item.start_lap <= lapNumber && lapNumber <= item.end_lap,
    ) ||
    annotations.driverStints.some(
      (item) => item.start_lap <= lapNumber && lapNumber <= item.end_lap,
    )
  );
}

function setStatus(message: string): void {
  refs.importStatus.textContent = message;
  if (refs.appInitStatus && document.body.classList.contains('app-loading')) {
    refs.appInitStatus.textContent = message;
  }
}

function setAppLoadingState(isLoading: boolean): void {
  document.body.classList.toggle('app-loading', isLoading);
  document.body.classList.toggle('app-ready', !isLoading);
}

function datetimeLocalToIso(value: unknown): string | null {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function promptForRaceImportOptions(fileName: string): {
  cancelled: boolean;
  raceStartTime: string | null;
} {
  while (true) {
    const response = window.prompt(
      `Race start time for ${fileName}\nEnter local time as YYYY-MM-DDTHH:mm.\nLeave blank to skip.`,
      '',
    );

    if (response == null) {
      return { cancelled: true, raceStartTime: null };
    }

    const trimmed = response.trim();
    if (!trimmed) {
      return { cancelled: false, raceStartTime: null };
    }

    const raceStartTime = datetimeLocalToIso(trimmed);
    if (raceStartTime) {
      return { cancelled: false, raceStartTime };
    }

    window.alert(
      'Invalid race start time. Use YYYY-MM-DDTHH:mm, for example 2026-05-25T09:30.',
    );
  }
}

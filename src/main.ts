import './styles.css';
import { promptForRaceImportOptions } from './app/importPrompt';
import {
  getLapBounds,
  parseIntegerOrNull,
  syncLapRangeInputs,
} from './app/lapRange';
import { createAppRefs } from './app/refs';
import { createEmptyRaceAnnotations, createInitialAppState } from './app/state';
import {
  setupAnnotationSubtabs,
  setupTabSwitching,
  syncDataTabAndActions,
} from './app/tabs';
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
import { SyncController } from './features/sync/syncController';
import { createSyncAnnotationStore } from './features/sync/syncLocalStore';
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
  LapRow,
  LapTimeChartHandle,
  RaceAnnotations,
  SortColumn,
  SummaryRow,
  SyncMode,
} from './types';
import { closestElement, errorMessage, queryRequired } from './utils/dom';

const refs = createAppRefs();
const state = createInitialAppState();

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
let syncController: SyncController | null = null;

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

function getSyncMode(): SyncMode {
  return syncController?.getSnapshot().mode ?? 'standalone';
}

function isEditingEnabled(): boolean {
  return getSyncMode() !== 'read-only';
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
        void syncController?.syncNow();
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
        void syncController?.syncNow();
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
  syncController = new SyncController(state.db, {
    onChange: renderSyncControls,
    onStatus: setStatus,
  });
  await syncController.initFromLocation();
  state.annotationStore = createSyncAnnotationStore(
    state.db,
    createAnnotationStore(state.db),
    () => syncController?.getActiveConfig() ?? null,
  );

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
    isLocalEditingEnabled: isEditingEnabled(),
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
  refs.exportJson.addEventListener('click', async () => {
    await syncController?.syncNow();
    if (state.activeRaceId) {
      exportAnnotationsFile(getDb(), state.activeRaceId);
    }
  });
  refs.exportSqlite.addEventListener('click', async () => {
    await syncController?.syncNow();
    const activeRace = state.races.find(
      (race) => race.id === state.activeRaceId,
    );
    exportDatabaseFile(getDb(), activeRace?.name || 'lemons-race-viewer');
  });
  refs.syncConnect.addEventListener('click', handleSyncConnect);
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
  setupTabSwitching(refs, {
    isLocalEditingEnabled: isEditingEnabled(),
    onChartTabShown: () => charts.lapTime?.resize(),
  });
  setupAnnotationSubtabs(refs);
}

async function handleSyncConnect(): Promise<void> {
  if (!syncController) {
    return;
  }

  const snapshot = syncController.getSnapshot();
  if (snapshot.mode === 'cloud-connected') {
    await syncController.syncNow();
    await refreshRaceOptions();
    await refreshView();
    return;
  }

  if (!syncController.canConnect()) {
    setStatus(
      'Open a valid collaborative edit link before connecting cloud sync.',
    );
    return;
  }

  const didConfirm = window.confirm(
    'Connect this local SQLite database to the Cloudflare sync workspace? Existing local annotations will be queued for upload.',
  );
  if (!didConfirm) {
    return;
  }

  try {
    await syncController.connectCurrentDatabase();
    await refreshRaceOptions();
    await refreshView();
  } catch (error) {
    console.error(error);
    setStatus(`Cloud sync failed: ${errorMessage(error)}`);
  }
}

function renderSyncControls(): void {
  const snapshot = syncController?.getSnapshot();
  if (!snapshot?.apiBase) {
    refs.syncControls.hidden = true;
    return;
  }

  refs.syncControls.hidden = false;
  refs.syncConnect.hidden = snapshot.mode === 'read-only';
  refs.syncConnect.disabled =
    snapshot.mode !== 'cloud-connected' && !snapshot.session;
  refs.syncConnect.textContent =
    snapshot.mode === 'cloud-connected' ? 'Sync Now' : 'Connect Cloud Sync';

  const pendingSuffix = snapshot.pendingCount
    ? `, ${snapshot.pendingCount} pending`
    : '';
  const failedSuffix = snapshot.failedCount
    ? `, ${snapshot.failedCount} failed`
    : '';

  if (snapshot.mode === 'read-only') {
    refs.syncStatus.textContent = 'Read-only';
  } else if (snapshot.mode === 'cloud-connected') {
    refs.syncStatus.textContent =
      snapshot.status === 'syncing'
        ? `Cloud syncing${pendingSuffix}`
        : `Cloud connected${pendingSuffix}${failedSuffix}`;
  } else if (snapshot.status === 'reconnect-required') {
    refs.syncStatus.textContent = `Reconnect required${pendingSuffix}${failedSuffix}`;
  } else if (snapshot.session) {
    refs.syncStatus.textContent = 'Edit token ready';
  } else {
    refs.syncStatus.textContent = 'Open edit link to connect';
  }
}

async function handleImport(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) {
    return;
  }

  const messages: string[] = [];
  let activeFileName = '';

  try {
    const db = getDb();
    for (const file of files) {
      activeFileName = file.name;
      const importOptions = promptForRaceImportOptions(file.name);
      if (importOptions.cancelled) {
        input.value = '';
        if (messages.length) {
          await refreshRaceOptions();
          await refreshView();
          setStatus(
            `Import stopped before ${file.name}. Completed: ${messages.join(' | ')}`,
          );
          return;
        }

        setStatus(`Import cancelled before ${file.name}.`);
        return;
      }

      setStatus(`Importing ${file.name}...`);
      const result = await importRace(db, file, {
        raceStartTime: importOptions.raceStartTime,
      });
      await syncController?.queueRaceForSync(result.raceKey);
      messages.push(
        `${result.raceName}: ${result.rowCount} laps${result.warnings.length ? ` (${result.warnings.length} repairs/warnings)` : ''}`,
      );
      state.activeRaceId = result.raceId;
    }

    input.value = '';
    await refreshRaceOptions();
    await refreshView();
    void syncController?.syncNow();
    setStatus(`Import complete. ${messages.join(' | ')}`);
  } catch (error) {
    console.error(error);
    input.value = '';
    await refreshRaceOptions();
    await refreshView();
    setStatus(
      `Import failed${activeFileName ? ` for ${activeFileName}` : ''}: ${errorMessage(error)}`,
    );
  }
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
    syncController?.reloadFromDatabase();

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
  syncDataTabAndActions(refs, state.races.length > 0);

  replaceSelectOptions(
    refs.raceSelect,
    state.races.length
      ? state.races.map((race) => ({ value: race.id, label: race.name }))
      : [{ value: '', label: 'No imported races' }],
  );

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
  replaceSelectOptions(refs.driverFilter, [
    { value: '', label: 'All drivers' },
    ...drivers.map((driver) => ({ value: driver, label: driver })),
  ]);
  refs.driverFilter.value = drivers.includes(selectedDriver)
    ? selectedDriver
    : '';
}

function replaceSelectOptions(
  select: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
): void {
  select.replaceChildren(
    ...options.map((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      return option;
    }),
  );
}

async function refreshView(
  options: { skipChartRender?: boolean } = {},
): Promise<void> {
  const { skipChartRender = false } = options;
  updateSortIndicators(refs.table, state.sort);

  if (!state.activeRaceId) {
    state.lapRangeBounds = null;
    state.lapRangeRaceId = '';
    syncLapRangeInputs(refs, null, { prefill: false });
    refs.summaryCards.innerHTML =
      '<div class="summary-card"><span>No race selected</span><strong>Import a CSV</strong></div>';
    renderLapTable(refs.tableBody, [], state.selectedLapId, null);
    state.currentAnnotations = createEmptyRaceAnnotations();
    state.currentTimelineEvents = [];
    if (annotationHelper) {
      annotationHelper.render(null);
    }
    if (annotationPanel) {
      annotationPanel.render({
        selectedLapRow: null,
        rows: [],
        raceStartTime: null,
        annotations: createEmptyRaceAnnotations(),
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
  const { lapMin, lapMax } = syncLapRangeInputs(refs, lapRangeBounds, {
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
  const timelineEvents = getRaceTimelineEvents(db, state.activeRaceId, filters);

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
  syncLapRangeInputs(refs, state.lapRangeBounds, { prefill: true });
  await refreshView({ skipChartRender: true });
}

async function handleLapRangeInput(
  changedField: 'lapMin' | 'lapMax',
): Promise<void> {
  syncLapRangeInputs(refs, state.lapRangeBounds, {
    prefill: true,
    changedField,
  });
  await refreshView();
}

function getBaseFilters(): LapFilters {
  return {
    driver: refs.driverFilter.value,
    search: refs.searchFilter.value.trim(),
  };
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

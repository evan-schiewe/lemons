import './styles.css';
import { SQLiteClient } from './db/sqliteClient.js';
import { mountAnnotationHelper } from './features/annotations/annotationHelperView.js';
import { mountAnnotationPanel } from './features/annotations/annotationPanel.js';
import { createAnnotationStore } from './features/annotations/annotationStore.js';
import { createLapTimeChart } from './features/charts/lapTimeChart.js';
import { renderSummaryCards } from './features/dashboard/summaryCards.js';
import { exportAnnotationsFile } from './features/export/exportAnnotations.js';
import { exportDatabaseFile } from './features/export/exportDb.js';
import { importRace } from './features/import/importRace.js';
import { mountTimelineView } from './features/timeline/timelineView.js';
import {
    getDriverOptions,
    getLapSeries,
    getLapTableRows,
    getRaceSnapshot,
    getRaceAnnotations,
    getRaceTimelineEvents,
    getRaceList,
    getSummary,
    updateRaceStartTime,
    getCandidates,
    augmentCandidateWithReviewStatus,
} from './features/query/raceQueries.js';
import { renderLapTable, updateSortIndicators, scrollToLap } from './features/table/lapTable.js';

const refs = {
    heroActionsHost: document.querySelector('#hero-actions-host'),
    dataActions: document.querySelector('#data-actions'),
    dataActionsSlot: document.querySelector('#data-actions-slot'),
    csvInput: document.querySelector('#csv-input'),
    sqliteInput: document.querySelector('#sqlite-input'),
    exportJson: document.querySelector('#export-json'),
    exportSqlite: document.querySelector('#export-sqlite'),
    raceSelect: document.querySelector('#race-select'),
    driverFilter: document.querySelector('#driver-filter'),
    searchFilter: document.querySelector('#search-filter'),
    lapMin: document.querySelector('#lap-min'),
    lapMax: document.querySelector('#lap-max'),
    raceStartTime: document.querySelector('#race-start-time'),
    importStatus: document.querySelector('#import-status'),
    summaryCards: document.querySelector('#summary-cards'),
    tableBody: document.querySelector('#lap-table-body'),
    table: document.querySelector('table'),
    helperContainer: document.querySelector('#annotation-helper-container'),
    annotationPanelContainer: document.querySelector('#annotation-panel-container'),
    timelineContainer: document.querySelector('#timeline-container'),
    dataTabButton: document.querySelector('#data-tab-button'),
    tabButtons: document.querySelectorAll('.tab-button'),
    tabContents: document.querySelectorAll('.tab-content'),
    annotationSubtabButtons: document.querySelectorAll('.annotation-subtab-button'),
    annotationSubtabContents: document.querySelectorAll('.annotation-subtab-content'),
};

const state = {
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
};

const charts = {
    lapTime: createLapTimeChart(document.querySelector('#lap-time-chart'), { onSelectLap: handleLapSelectionByNumber }),
};

// Placeholder for annotation helper - will be initialized when module is created
let annotationHelper = null;
let annotationPanel = null;
let timelineView = null;

function createAnnotationHandlers({ autoAdvanceOnSave = false } = {}) {
    return {
        onSave: async (kind, payload) => {
            if (!state.activeRaceId) {
                setStatus('Import a race before saving annotations.');
                return false;
            }

            try {
                await state.annotationStore.save(kind, { ...payload, race_id: state.activeRaceId });
                setStatus('Annotation saved.');

                if (autoAdvanceOnSave && state.helperAutoAdvance) {
                    const candidates = getCandidates(state.db, state.activeRaceId);
                    const annotations = getRaceAnnotations(state.db, state.activeRaceId);
                    const augmented = candidates.map((candidate) => augmentCandidateWithReviewStatus(candidate, annotations, state.db, state.activeRaceId));

                    for (let i = state.helperCurrentIndex + 1; i < augmented.length; i++) {
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
                setStatus(`Unable to save annotation: ${error.message}`);
                return false;
            }
        },
        onDelete: async (kind, id) => {
            try {
                await state.annotationStore.remove(kind, id);
                setStatus('Annotation removed.');
                await refreshView();
            } catch (error) {
                console.error(error);
                setStatus(`Unable to remove annotation: ${error.message}`);
            }
        },
    };
}

initialize().catch((error) => {
    console.error(error);
    setStatus(`Initialization failed: ${error.message}`);
});

async function initialize() {
    setStatus('Initializing browser SQLite cache...');
    state.db = await new SQLiteClient().init();
    state.annotationStore = createAnnotationStore(state.db);

    // Restore helper state from localStorage
    state.helperAutoAdvance = localStorage.getItem('helperAutoAdvance') === '1';

    // Initialize annotation helper
    const helperContainer = refs.helperContainer;
    if (helperContainer) {
        annotationHelper = mountAnnotationHelper(helperContainer, {
            ...createAnnotationHandlers({ autoAdvanceOnSave: true }),
            onOpenComposer: (kind, options) => {
                annotationPanel?.openComposer(kind, options);
            },
            onOpenEditor: (kind, id) => {
                annotationPanel?.openEditor(kind, id);
            },
            onNavigate: (direction) => {
                const candidates = getCandidates(state.db, state.activeRaceId);
                if (!candidates.length) {
                    return;
                }

                const annotations = getRaceAnnotations(state.db, state.activeRaceId);
                const augmented = candidates.map((c) => augmentCandidateWithReviewStatus(c, annotations, state.db, state.activeRaceId));

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
                    const nextUnreviewed = augmented.findIndex((c, i) => i > state.helperCurrentIndex && !c.isReviewed);
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
                localStorage.setItem('helperAutoAdvance', state.helperAutoAdvance ? '1' : '0');
                refreshView();
            },
        });
    }

    if (refs.annotationPanelContainer) {
        annotationPanel = mountAnnotationPanel(refs.annotationPanelContainer, createAnnotationHandlers());
    }

    if (refs.timelineContainer) {
        timelineView = mountTimelineView(refs.timelineContainer, {
            ...createAnnotationHandlers(),
            onSelectLap: handleLapSelectionByNumber,
        });
    }

    wireEvents();
    await refreshRaceOptions();
    await refreshView();
    setStatus('Ready. Import lap CSV files or restore a SQLite export to begin.');
}


function wireEvents() {
    refs.csvInput.addEventListener('change', handleImport);
    refs.sqliteInput.addEventListener('change', handleRestoreSqlite);
    refs.raceSelect.addEventListener('change', async (event) => {
        state.activeRaceId = event.target.value;
        state.selectedLapId = '';
        await refreshDriverOptions();
        await refreshView();
    });
    refs.driverFilter.addEventListener('change', refreshView);
    refs.searchFilter.addEventListener('input', refreshView);
    refs.lapMin.addEventListener('input', refreshView);
    refs.lapMax.addEventListener('input', refreshView);
    refs.raceStartTime.addEventListener('change', async (event) => {
        if (!state.activeRaceId) {
            return;
        }

        const raceStartIso = datetimeLocalToIso(event.target.value);
        updateRaceStartTime(state.db, state.activeRaceId, raceStartIso);
        await state.db.persist();
        await refreshRaceOptions();
        await refreshView();

        if (raceStartIso) {
            setStatus('Race start time saved.');
        } else {
            setStatus('Race start time cleared.');
        }
    });
    refs.exportJson.addEventListener('click', () => {
        if (state.activeRaceId) {
            exportAnnotationsFile(state.db, state.activeRaceId);
        }
    });
    refs.exportSqlite.addEventListener('click', () => {
        const activeRace = state.races.find((race) => race.id === state.activeRaceId);
        exportDatabaseFile(state.db, activeRace?.name || 'lemons-race-viewer');
    });
    refs.table.querySelector('thead').addEventListener('click', async (event) => {
        const header = event.target.closest('th[data-sort]');
        if (!header) {
            return;
        }

        const column = header.dataset.sort;
        if (state.sort.column === column) {
            state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            state.sort.column = column;
            state.sort.direction = 'asc';
        }

        await refreshView();
    });
    refs.tableBody.addEventListener('click', async (event) => {
        const row = event.target.closest('tr[data-lap-id]');
        if (!row) {
            return;
        }

        const selectedRow = state.currentRows.find((item) => item.id === row.dataset.lapId);
        if (!selectedRow) {
            return;
        }

        await selectLapAndOpenDetails(selectedRow);
    });
    window.addEventListener('resize', () => {
        charts.lapTime.resize();
    });
    setupTabSwitching();
    setupAnnotationSubtabs();
}

function setupTabSwitching() {
    refs.tabButtons.forEach((button) => {
        button.addEventListener('click', (event) => {
            const tabName = event.target.dataset.tab;
            if (!tabName) return;

            // Update active button
            refs.tabButtons.forEach((btn) => btn.classList.remove('active'));
            event.target.classList.add('active');

            // Update active tab content
            refs.tabContents.forEach((content) => content.classList.remove('active'));
            const activeTab = document.querySelector(`#${tabName}-tab`);
            if (activeTab) {
                activeTab.classList.add('active');
                // Trigger chart resize if showing chart tab
                if (tabName === 'chart') {
                    setTimeout(() => {
                        charts.lapTime.resize();
                    }, 50);
                }
            }

            // Save preference to localStorage
            localStorage.setItem('activeTab', tabName);
        });
    });

    // Restore saved tab preference
    const savedTab = localStorage.getItem('activeTab') || 'chart';
    const savedTabButton = Array.from(refs.tabButtons).find((btn) => btn.dataset.tab === savedTab && !btn.hidden);
    if (savedTabButton) {
        savedTabButton.click();
    } else {
        const chartTabButton = Array.from(refs.tabButtons).find((btn) => btn.dataset.tab === 'chart');
        chartTabButton?.click();
    }
}

function syncDataTabAndActions() {
    const hasData = state.races.length > 0;

    if (refs.dataTabButton) {
        refs.dataTabButton.hidden = !hasData;
    }

    const activeDataButton = Array.from(refs.tabButtons).find((btn) => btn.dataset.tab === 'data' && btn.classList.contains('active'));
    if (!hasData && activeDataButton) {
        const chartButton = Array.from(refs.tabButtons).find((btn) => btn.dataset.tab === 'chart');
        chartButton?.click();
    }

    const targetHost = hasData ? refs.dataActionsSlot : refs.heroActionsHost;
    if (targetHost && refs.dataActions && refs.dataActions.parentElement !== targetHost) {
        targetHost.append(refs.dataActions);
    }
}

function setupAnnotationSubtabs() {
    refs.annotationSubtabButtons.forEach((button) => {
        button.addEventListener('click', (event) => {
            const subtabName = event.target.dataset.annotationTab;
            if (!subtabName) return;

            refs.annotationSubtabButtons.forEach((btn) => {
                btn.classList.remove('active');
                btn.setAttribute('aria-selected', 'false');
            });
            event.target.classList.add('active');
            event.target.setAttribute('aria-selected', 'true');

            refs.annotationSubtabContents.forEach((content) => {
                content.classList.remove('active');
                content.hidden = true;
            });

            const activeSubtab = document.querySelector(`#annotation-${subtabName}-tab`);
            if (activeSubtab) {
                activeSubtab.classList.add('active');
                activeSubtab.hidden = false;
            }

            localStorage.setItem('activeAnnotationSubtab', subtabName);
        });
    });

    const savedSubtab = localStorage.getItem('activeAnnotationSubtab') || 'editor';
    const savedSubtabButton = Array.from(refs.annotationSubtabButtons).find((btn) => btn.dataset.annotationTab === savedSubtab);
    if (savedSubtabButton) {
        savedSubtabButton.click();
    }
}

async function handleImport(event) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) {
        return;
    }

    const messages = [];
    for (const file of files) {
        setStatus(`Importing ${file.name}...`);
        const result = await importRace(state.db, file);
        messages.push(`${result.raceName}: ${result.rowCount} laps${result.warnings.length ? ` (${result.warnings.length} repairs/warnings)` : ''}`);
        state.activeRaceId = result.raceId;
    }

    refs.csvInput.value = '';
    await refreshRaceOptions();
    await refreshView();
    setStatus(`Import complete. ${messages.join(' | ')}`);
}

async function handleRestoreSqlite(event) {
    const [file] = Array.from(event.target.files ?? []);
    if (!file) {
        return;
    }

    try {
        setStatus(`Restoring SQLite from ${file.name}...`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await state.db.restoreDatabase(bytes);

        state.activeRaceId = '';
        state.selectedLapId = '';
        state.helperCurrentIndex = 0;

        refs.sqliteInput.value = '';
        await refreshRaceOptions();
        await refreshView();

        const raceCount = state.races.length;
        setStatus(`SQLite restore complete. Loaded ${raceCount} race${raceCount === 1 ? '' : 's'}.`);
    } catch (error) {
        console.error(error);
        refs.sqliteInput.value = '';
        setStatus(`SQLite restore failed: ${error.message}`);
    }
}

async function refreshRaceOptions() {
    state.races = getRaceList(state.db);
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
    syncRaceStartTimeInput();
    await refreshDriverOptions();
}

function syncRaceStartTimeInput() {
    const activeRace = state.races.find((race) => race.id === state.activeRaceId);
    refs.raceStartTime.value = isoToDatetimeLocal(activeRace?.race_start_time ?? null);
}

async function refreshDriverOptions() {
    const selectedDriver = refs.driverFilter.value;
    const drivers = state.activeRaceId ? getDriverOptions(state.db, state.activeRaceId) : [];
    refs.driverFilter.innerHTML = ['<option value="">All drivers</option>', ...drivers.map((driver) => `<option value="${driver}">${driver}</option>`)].join('');
    refs.driverFilter.value = drivers.includes(selectedDriver) ? selectedDriver : '';
}

async function refreshView() {
    updateSortIndicators(refs.table, state.sort);

    if (!state.activeRaceId) {
        renderSummaryCards(refs.summaryCards, null, []);
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

    const filters = getFilters();
    const rows = getLapTableRows(state.db, state.activeRaceId, filters, state.sort);
    const lapSeries = getLapSeries(state.db, state.activeRaceId, filters);
    const summary = getSummary(state.db, state.activeRaceId, filters);
    const annotations = getRaceAnnotations(state.db, state.activeRaceId);
    const timelineEvents = getRaceTimelineEvents(state.db, state.activeRaceId, filters);

    state.currentRows = rows;
    state.currentAnnotations = annotations;
    state.currentTimelineEvents = timelineEvents;
    if (state.selectedLapId && !rows.some((row) => row.id === state.selectedLapId)) {
        state.selectedLapId = '';
    }

    renderSummaryCards(refs.summaryCards, summary, rows);
    const activeRace = state.races.find((race) => race.id === state.activeRaceId);
    renderLapTable(refs.tableBody, rows, state.selectedLapId, activeRace?.race_start_time ?? null);

    charts.lapTime.render(lapSeries, annotations);
    // BUG FIX: charts.position was initialized but render() was never defined. Skip for now.
    // charts.position.render(lapSeries, annotations, null);

    const selectedLapRow = rows.find((row) => row.id === state.selectedLapId) ?? null;

    // Helper view: compute candidate queue and augmented review status
    if (annotationHelper) {
        const candidates = getCandidates(state.db, state.activeRaceId);
        const raceSnapshot = getRaceSnapshot(state.db, state.activeRaceId);
        const lapStartOffsets = new Map(
            raceSnapshot.laps.map((lap) => [lap.lap_number, lap.lap_start_offset_ms ?? 0]),
        );

        // Augment candidates with review status and lap_start_offset_ms
        const augmentedCandidates = candidates.map((candidate) => {
            const reviewed = augmentCandidateWithReviewStatus(candidate, annotations, state.db, state.activeRaceId);

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

function getFilters() {
    const lapMin = Number.parseInt(refs.lapMin.value, 10);
    const lapMax = Number.parseInt(refs.lapMax.value, 10);

    return {
        driver: refs.driverFilter.value,
        search: refs.searchFilter.value.trim(),
        lapMin: Number.isFinite(lapMin) ? lapMin : null,
        lapMax: Number.isFinite(lapMax) ? lapMax : null,
    };
}

function handleLapSelection(lapId) {
    state.selectedLapId = lapId || '';
    refreshView();
}

async function handleLapSelectionByNumber(lapNumber) {
    const selectedRow = state.currentRows.find((row) => row.lap_number === lapNumber);
    if (selectedRow) {
        await selectLapAndOpenDetails(selectedRow);
    }

    // Scroll table to the clicked lap
    scrollToLap(lapNumber);
}

async function selectLapAndOpenDetails(selectedRow) {
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

function hasAnnotationsForLap(lapRow, annotations) {
    if (!lapRow || !annotations) {
        return false;
    }

    const lapNumber = lapRow.lap_number;

    return annotations.lapNotes.some((item) => item.lap_number === lapNumber)
        || annotations.taggedIncidents.some((item) => item.lap_number === lapNumber)
        || annotations.rangeEvents.some((item) => item.start_lap <= lapNumber && lapNumber <= item.end_lap)
        || annotations.driverStints.some((item) => item.start_lap <= lapNumber && lapNumber <= item.end_lap);
}

function setStatus(message) {
    refs.importStatus.textContent = message;
}

function isoToDatetimeLocal(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function datetimeLocalToIso(value) {
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
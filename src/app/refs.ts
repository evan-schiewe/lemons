import { queryRequired } from '../utils/dom';

export interface AppRefs {
  appInitStatus: HTMLElement | null;
  themeToggle: HTMLButtonElement;
  themeControl: HTMLElement;
  themePreferenceInputs: NodeListOf<HTMLInputElement>;
  heroActionsHost: HTMLElement;
  dataActions: HTMLElement;
  dataActionsSlot: HTMLElement;
  csvInput: HTMLInputElement;
  sqliteInput: HTMLInputElement;
  exportJson: HTMLButtonElement;
  exportSqlite: HTMLButtonElement;
  resetStarterData: HTMLButtonElement;
  syncControls: HTMLElement;
  syncStatus: HTMLElement;
  syncConnect: HTMLButtonElement;
  raceSelect: HTMLSelectElement;
  filtersPanel: HTMLElement;
  filtersToggle: HTMLButtonElement;
  filtersClose: HTMLButtonElement;
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

export function createAppRefs(): AppRefs {
  return {
    appInitStatus: document.querySelector('#app-init-status'),
    themeToggle: queryRequired<HTMLButtonElement>('#theme-toggle'),
    themeControl: queryRequired<HTMLElement>('#theme-control'),
    themePreferenceInputs: document.querySelectorAll(
      'input[name="theme-preference"]',
    ),
    heroActionsHost: queryRequired<HTMLElement>('#hero-actions-host'),
    dataActions: queryRequired<HTMLElement>('#data-actions'),
    dataActionsSlot: queryRequired<HTMLElement>('#data-actions-slot'),
    csvInput: queryRequired<HTMLInputElement>('#csv-input'),
    sqliteInput: queryRequired<HTMLInputElement>('#sqlite-input'),
    exportJson: queryRequired<HTMLButtonElement>('#export-json'),
    exportSqlite: queryRequired<HTMLButtonElement>('#export-sqlite'),
    resetStarterData: queryRequired<HTMLButtonElement>('#reset-starter-data'),
    syncControls: queryRequired<HTMLElement>('#sync-controls'),
    syncStatus: queryRequired<HTMLElement>('#sync-status'),
    syncConnect: queryRequired<HTMLButtonElement>('#sync-connect'),
    raceSelect: queryRequired<HTMLSelectElement>('#race-select'),
    filtersPanel: queryRequired<HTMLElement>('#filters-sidebar'),
    filtersToggle: queryRequired<HTMLButtonElement>('#filters-toggle'),
    filtersClose: queryRequired<HTMLButtonElement>('#filters-close'),
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
}

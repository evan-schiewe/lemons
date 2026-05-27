import type { SQLiteClient } from '../db/sqliteClient';
import type {
  AnnotationStore,
  LapRangeBounds,
  LapRow,
  RaceAnnotations,
  RaceRecord,
  SortState,
  TimelineEvent,
} from '../types';

export interface AppState {
  db: SQLiteClient | null;
  annotationStore: AnnotationStore | null;
  races: RaceRecord[];
  activeRaceId: string;
  selectedLapId: string;
  sort: SortState;
  currentRows: LapRow[];
  currentAnnotations: RaceAnnotations;
  currentTimelineEvents: TimelineEvent[];
  helperCurrentIndex: number;
  helperAutoAdvance: boolean;
  lapRangeBounds: LapRangeBounds | null;
  lapRangeRaceId: string;
  summaryGreenOnly: boolean;
}

export function createEmptyRaceAnnotations(): RaceAnnotations {
  return {
    lapNotes: [],
    taggedIncidents: [],
    rangeEvents: [],
    driverStints: [],
    journalEntries: [],
  };
}

export function createInitialAppState(): AppState {
  return {
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
    currentAnnotations: createEmptyRaceAnnotations(),
    currentTimelineEvents: [],
    helperCurrentIndex: 0,
    helperAutoAdvance: false,
    lapRangeBounds: null,
    lapRangeRaceId: '',
    summaryGreenOnly: true,
  };
}

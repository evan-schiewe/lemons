export type SqlValue = string | number | Uint8Array | null;
export type SqlParams = SqlValue[];
export type DbRow = Record<string, unknown>;

export type SortDirection = 'asc' | 'desc';
export type SortColumn =
  | 'lap_number'
  | 'lap_start_offset_ms'
  | 'driver_name'
  | 'lap_time_ms'
  | 'position_value'
  | 'speed_mph'
  | 'gap_ahead_display'
  | 'gap_leader_display'
  | 'flags';

export interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

export interface LapFilters {
  driver?: string;
  search?: string;
  lapMin?: number | null;
  lapMax?: number | null;
}

export interface LapRangeBounds {
  min: number;
  max: number;
}

export interface LapRange {
  lapMin: number | null;
  lapMax: number | null;
}

export interface CsvRowValues {
  lap: string;
  team_slot: string;
  driver: string;
  lap_time: string;
  position: string;
  speed: string;
  gap_ahead: string;
  gap_leader: string;
}

export interface ParsedRaceRow {
  rowIndex: number;
  csvRowNumber: number;
  rawLine: string;
  rawCells: string[];
  values: CsvRowValues;
}

export interface ParsedRaceCsv {
  headers: string[];
  detectedHeaders: string[];
  hasHeader: boolean;
  warnings: string[];
  rows: ParsedRaceRow[];
}

export type DurationKind =
  | 'empty'
  | 'leader'
  | 'laps-plus-time'
  | 'laps'
  | 'time'
  | 'text';

export interface ParsedDuration {
  raw: string;
  ms: number | null;
  laps: number | null;
  kind: DurationKind;
}

export interface NormalizedLap {
  rowIndex: number;
  csvRowNumber: number;
  rawLine: string;
  rawCells: string[];
  lapNumber: number;
  driverName: string;
  lapTime: ParsedDuration;
  lapTimeText: string;
  positionValue: number | null;
  speedMph: number | null;
  gapAhead: ParsedDuration & { display: string };
  gapLeader: ParsedDuration & { display: string };
  rollingMedianMs: number | null;
  isOutlier: boolean;
  isGreenFlag: boolean;
  searchText: string;
}

export interface NormalizedRaceData {
  laps: NormalizedLap[];
  stats: {
    drivers: string[];
    totalLaps: number;
    minLap: number;
    maxLap: number;
  };
}

export interface LoadedCsvFile {
  file: File;
  fileName: string;
  raceName: string;
  text: string;
  contentHash: string;
}

export interface RaceRecord extends DbRow, SyncMetadata {
  id: string;
  race_key: string;
  name: string;
  source_file_name: string;
  content_hash: string;
  race_start_time: string | null;
  row_count?: number;
  imported_at?: string;
  updated_at?: string;
  artifact_sha256?: string | null;
  artifact_size_bytes?: number | null;
}

export interface SyncMetadata {
  created_by?: string | null;
  updated_by?: string | null;
  sync_workspace_id?: string | null;
  sync_server_sequence?: number | null;
  sync_origin_client_id?: string | null;
}

export interface LapRow extends DbRow {
  id: string;
  race_id?: string;
  lap_number: number;
  driver_name: string | null;
  display_driver_name?: string | null;
  next_display_driver_name?: string | null;
  lap_time_ms: number | null;
  lap_time_text?: string | null;
  position_value: number | null;
  speed_mph: number | null;
  gap_ahead_ms: number | null;
  gap_ahead_laps: number | null;
  gap_ahead_display: string | null;
  gap_leader_ms: number | null;
  gap_leader_laps: number | null;
  gap_leader_display: string | null;
  rolling_median_ms?: number | null;
  is_outlier: number | boolean;
  is_green_flag: number | boolean;
  lap_start_offset_ms?: number | null;
  lap_start_wall_clock?: string | null;
  lap_start_iso?: string | null;
  note_count?: number | null;
  incident_count?: number | null;
  is_pit_lap?: number | boolean;
  search_text?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SummaryRow extends DbRow {
  total_laps: number;
  best_lap_ms: number | null;
  avg_green_ms: number | null;
  long_lap_outliers: number;
  best_position: number | null;
  worst_position: number | null;
  lap_note_count: number;
  incident_count: number;
  range_event_count: number;
  stint_count: number;
  journal_count: number;
}

export type AnnotationKind =
  | 'lapNote'
  | 'taggedIncident'
  | 'rangeEvent'
  | 'driverStint'
  | 'journalEntry';

export type PanelAnnotationKind =
  | 'taggedIncident'
  | 'rangeEvent'
  | 'driverStint';

export interface LapNote extends DbRow, SyncMetadata {
  id: string;
  race_id: string;
  lap_number: number;
  driver_name: string | null;
  note_text: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface TaggedIncident extends DbRow, SyncMetadata {
  id: string;
  race_id: string;
  lap_number: number;
  title: string;
  tag: string;
  color: string;
  details: string | null;
  created_at: string;
  updated_at: string;
}

export interface RangeEvent extends DbRow, SyncMetadata {
  id: string;
  race_id: string;
  start_lap: number;
  end_lap: number;
  title: string;
  tag: string;
  color: string;
  details: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriverStint extends DbRow, SyncMetadata {
  id: string;
  race_id: string;
  driver_name: string;
  start_lap: number;
  end_lap: number;
  color: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface JournalEntry extends DbRow, SyncMetadata {
  id: string;
  race_id: string;
  lap_number: number | null;
  event_time_iso: string | null;
  event_time_source: string;
  title: string | null;
  entry_text: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface RaceAnnotations {
  lapNotes: LapNote[];
  taggedIncidents: TaggedIncident[];
  rangeEvents: RangeEvent[];
  driverStints: DriverStint[];
  journalEntries: JournalEntry[];
}

export type SyncMode = 'standalone' | 'cloud-connected' | 'read-only';

export type SyncConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'reconnect-required'
  | 'error';

export interface SyncSession {
  subject: string;
  workspaceId: string;
  scopes: string[];
  raceScopes: string[];
  expiresAt: string;
  currentSequence: number;
}

export interface SyncConfig extends DbRow {
  id: number;
  workspace_id: string;
  api_base: string;
  client_id: string;
  connected_subject: string;
  status: 'connected' | 'reconnect_required';
  last_global_sequence_seen: number;
  connected_at: string;
  updated_at: string;
}

export interface SyncRaceCursor extends DbRow {
  workspace_id: string;
  race_key: string;
  last_server_sequence: number;
  updated_at: string;
}

export interface SyncOutboxRow extends DbRow {
  id: string;
  workspace_id: string;
  client_id: string;
  client_request_id: string;
  race_key: string;
  kind: AnnotationKind;
  action: 'upsert' | 'delete';
  annotation_id: string;
  payload_json: string;
  created_at: string;
  status: 'pending' | 'accepted' | 'failed';
  attempts: number;
  last_error: string | null;
  accepted_server_sequence: number | null;
}

export interface SyncRaceOutboxRow extends DbRow {
  id: string;
  workspace_id: string;
  client_id: string;
  client_request_id: string;
  race_key: string;
  action: 'upsert';
  created_at: string;
  status: 'pending' | 'accepted' | 'failed';
  attempts: number;
  last_error: string | null;
  accepted_server_sequence: number | null;
}

export interface CloudRaceMetadata {
  workspaceId?: string;
  raceKey: string;
  name: string;
  sourceFileName: string;
  contentHash: string;
  raceStartTime: string | null;
  rowCount: number;
  artifactSha256: string;
  artifactSizeBytes: number;
  serverSequence: number;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export interface CandidateLap extends LapRow {
  candidate_type: 'outlier' | 'pit' | 'repair';
  isReviewed?: boolean;
  source?: string | null;
}

export interface TimelineEvent extends DbRow {
  id: string;
  event_type: string;
  event_label: string;
  source_id: string;
  lap_number: number | null;
  lap_start: number | null;
  lap_end: number | null;
  driver_name: string | null;
  old_driver_name: string | null;
  new_driver_name: string | null;
  title: string;
  body: string;
  color: string;
  event_time_iso: string | null;
  event_time_source: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface RaceSnapshot {
  race: RaceRecord | null;
  laps: LapRow[];
  annotations: RaceAnnotations;
}

export type AnnotationPayload = Record<string, unknown>;

export interface AnnotationHandlers {
  onSave: (
    kind: AnnotationKind,
    payload: AnnotationPayload,
  ) => Promise<boolean>;
  onDelete: (kind: AnnotationKind, id: string) => Promise<void>;
}

export interface AnnotationStore {
  save: (kind: AnnotationKind, payload: AnnotationPayload) => Promise<string>;
  remove: (kind: AnnotationKind, id: string) => Promise<void>;
}

export interface LapTimeChartHandle {
  render: (
    rows: LapRow[],
    annotations: RaceAnnotations,
    options?: { lapAxisBounds?: LapRangeBounds | null },
  ) => void;
  resize: () => void;
  setLapRange: (
    lapMin: number | null | undefined,
    lapMax: number | null | undefined,
  ) => void;
}

export interface TimelineViewModel {
  timelineEvents: TimelineEvent[];
  journalEntries: JournalEntry[];
  selectedLapRow: LapRow | null;
  raceStartTime: string | null;
}

export interface TimelineViewHandle {
  render: (viewModel: TimelineViewModel | null) => void;
  setLocalEditingEnabled: (isEnabled: boolean) => void;
}

export interface AnnotationHelperViewModel {
  candidates: CandidateLap[];
  currentIndex: number;
  selectedLapId: string;
  selectedLapRow: LapRow | null;
  annotations: RaceAnnotations;
  autoAdvance: boolean;
  filterContext: LapFilters;
  raceStartTime: string | null;
}

export interface AnnotationHelperHandle {
  render: (viewModel: AnnotationHelperViewModel | null) => void;
}

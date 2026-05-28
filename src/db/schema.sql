PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  race_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  race_start_time TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  sync_workspace_id TEXT,
  sync_server_sequence INTEGER,
  sync_origin_client_id TEXT,
  artifact_sha256 TEXT,
  artifact_size_bytes INTEGER
);

CREATE TABLE IF NOT EXISTS raw_lap_rows (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  csv_row_number INTEGER NOT NULL,
  raw_line TEXT NOT NULL,
  raw_lap TEXT,
  raw_entry TEXT,
  raw_driver TEXT,
  raw_lap_time TEXT,
  raw_position TEXT,
  raw_speed TEXT,
  raw_gap_ahead TEXT,
  raw_gap_leader TEXT,
  UNIQUE (race_id, row_index)
);

CREATE TABLE IF NOT EXISTS normalized_laps (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  raw_row_id TEXT REFERENCES raw_lap_rows(id) ON DELETE SET NULL,
  lap_identity TEXT NOT NULL UNIQUE,
  lap_number INTEGER NOT NULL,
  driver_name TEXT,
  lap_time_ms INTEGER,
  lap_time_text TEXT,
  position_value REAL,
  speed_mph REAL,
  gap_ahead_ms INTEGER,
  gap_ahead_laps REAL,
  gap_ahead_display TEXT,
  gap_leader_ms INTEGER,
  gap_leader_laps REAL,
  gap_leader_display TEXT,
  rolling_median_ms INTEGER,
  is_outlier INTEGER NOT NULL DEFAULT 0,
  is_green_flag INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_normalized_laps_race_lap ON normalized_laps (race_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_normalized_laps_driver ON normalized_laps (race_id, driver_name);

CREATE VIEW IF NOT EXISTS normalized_laps_export AS
SELECT
  nl.*,
  r.race_start_time,
  COALESCE(
    SUM(COALESCE(nl.lap_time_ms, 0)) OVER (
      PARTITION BY nl.race_id
      ORDER BY nl.lap_number ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),
    0
  ) AS lap_start_offset_ms
FROM normalized_laps nl
JOIN races r ON r.id = nl.race_id;

CREATE TABLE IF NOT EXISTS lap_notes (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  lap_number INTEGER NOT NULL,
  driver_name TEXT,
  note_text TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f7de03',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  sync_workspace_id TEXT,
  sync_server_sequence INTEGER,
  sync_origin_client_id TEXT
);

CREATE TABLE IF NOT EXISTS tagged_incidents (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  lap_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#007a40',
  details TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  sync_workspace_id TEXT,
  sync_server_sequence INTEGER,
  sync_origin_client_id TEXT
);

CREATE TABLE IF NOT EXISTS range_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  start_lap INTEGER NOT NULL,
  end_lap INTEGER NOT NULL,
  title TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f7de03',
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  sync_workspace_id TEXT,
  sync_server_sequence INTEGER,
  sync_origin_client_id TEXT
);

CREATE TABLE IF NOT EXISTS driver_stints (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  driver_name TEXT NOT NULL,
  start_lap INTEGER NOT NULL,
  end_lap INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#007a40',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  sync_workspace_id TEXT,
  sync_server_sequence INTEGER,
  sync_origin_client_id TEXT
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  lap_number INTEGER,
  event_time_iso TEXT,
  event_time_source TEXT NOT NULL DEFAULT 'lap',
  title TEXT,
  entry_text TEXT NOT NULL,
  media_json TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT '#333733',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  sync_workspace_id TEXT,
  sync_server_sequence INTEGER,
  sync_origin_client_id TEXT
);

CREATE TABLE IF NOT EXISTS sync_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id TEXT NOT NULL,
  api_base TEXT NOT NULL,
  client_id TEXT NOT NULL,
  connected_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
  last_global_sequence_seen INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_race_cursors (
  workspace_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  last_server_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, race_key)
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  annotation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  accepted_server_sequence INTEGER,
  UNIQUE (workspace_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS sync_race_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert')),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  accepted_server_sequence INTEGER,
  UNIQUE (workspace_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS annotation_tombstones (
  workspace_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  deleted_by TEXT,
  sync_server_sequence INTEGER,
  PRIMARY KEY (workspace_id, race_key, kind, annotation_id)
);

CREATE INDEX IF NOT EXISTS idx_lap_notes_race_lap ON lap_notes (race_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_tagged_incidents_race_lap ON tagged_incidents (race_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_range_events_race_lap ON range_events (race_id, start_lap, end_lap);
CREATE INDEX IF NOT EXISTS idx_driver_stints_race_lap ON driver_stints (race_id, start_lap, end_lap);
CREATE INDEX IF NOT EXISTS idx_journal_entries_race_lap ON journal_entries (race_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_journal_entries_race_time ON journal_entries (race_id, event_time_iso);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_race_outbox_pending ON sync_race_outbox (workspace_id, status, created_at);

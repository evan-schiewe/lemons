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
  updated_at TEXT NOT NULL
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
  color TEXT NOT NULL DEFAULT '#f59e0b',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tagged_incidents (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  lap_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#d94f2b',
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS range_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  start_lap INTEGER NOT NULL,
  end_lap INTEGER NOT NULL,
  title TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb',
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_stints (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  driver_name TEXT NOT NULL,
  start_lap INTEGER NOT NULL,
  end_lap INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#059669',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lap_notes_race_lap ON lap_notes (race_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_tagged_incidents_race_lap ON tagged_incidents (race_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_range_events_race_lap ON range_events (race_id, start_lap, end_lap);
CREATE INDEX IF NOT EXISTS idx_driver_stints_race_lap ON driver_stints (race_id, start_lap, end_lap);
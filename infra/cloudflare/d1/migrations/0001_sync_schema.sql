PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO workspaces (id, name, created_at)
VALUES ('main', 'Lemons Main', datetime('now'));

CREATE TABLE IF NOT EXISTS sync_sequences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_sequences (workspace_id, value)
VALUES ('main', 0);

CREATE TABLE IF NOT EXISTS sync_requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  annotation_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, client_request_id),
  UNIQUE (workspace_id, server_sequence)
);

CREATE TABLE IF NOT EXISTS capability_revocations (
  jti TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revoked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lap_notes (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  lap_number INTEGER,
  driver_name TEXT,
  note_text TEXT,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, annotation_id)
);

CREATE TABLE IF NOT EXISTS tagged_incidents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  lap_number INTEGER,
  title TEXT,
  tag TEXT,
  color TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, annotation_id)
);

CREATE TABLE IF NOT EXISTS range_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  start_lap INTEGER,
  end_lap INTEGER,
  title TEXT,
  tag TEXT,
  color TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, annotation_id)
);

CREATE TABLE IF NOT EXISTS driver_stints (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  driver_name TEXT,
  start_lap INTEGER,
  end_lap INTEGER,
  color TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, annotation_id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  lap_number INTEGER,
  event_time_iso TEXT,
  event_time_source TEXT,
  title TEXT,
  entry_text TEXT,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, annotation_id)
);

CREATE INDEX IF NOT EXISTS idx_lap_notes_pull ON lap_notes (workspace_id, race_key, server_sequence);
CREATE INDEX IF NOT EXISTS idx_tagged_incidents_pull ON tagged_incidents (workspace_id, race_key, server_sequence);
CREATE INDEX IF NOT EXISTS idx_range_events_pull ON range_events (workspace_id, race_key, server_sequence);
CREATE INDEX IF NOT EXISTS idx_driver_stints_pull ON driver_stints (workspace_id, race_key, server_sequence);
CREATE INDEX IF NOT EXISTS idx_journal_entries_pull ON journal_entries (workspace_id, race_key, server_sequence);

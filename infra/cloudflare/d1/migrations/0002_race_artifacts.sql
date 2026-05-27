CREATE TABLE IF NOT EXISTS workspace_races (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  name TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  race_start_time TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  artifact_key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_size_bytes INTEGER NOT NULL,
  server_sequence INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, race_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_races_sequence
ON workspace_races (workspace_id, server_sequence);

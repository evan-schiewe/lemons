CREATE TABLE IF NOT EXISTS race_artifact_versions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  artifact_key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_size_bytes INTEGER NOT NULL CHECK (artifact_size_bytes >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, race_key, server_sequence),
  UNIQUE (workspace_id, artifact_key)
);

CREATE INDEX IF NOT EXISTS idx_race_artifact_versions_active
ON race_artifact_versions (workspace_id, race_key, deleted_at, server_sequence);

CREATE TABLE IF NOT EXISTS race_upload_counters (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('token', 'workspace')),
  bucket_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, bucket_type, bucket_key, window_start)
);

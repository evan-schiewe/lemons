CREATE TABLE IF NOT EXISTS media_assets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  variants_json TEXT NOT NULL,
  total_size_bytes INTEGER NOT NULL CHECK (total_size_bytes >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, asset_id),
  UNIQUE (workspace_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_race
ON media_assets (workspace_id, race_key, created_at);

CREATE TABLE IF NOT EXISTS media_upload_counters (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('token', 'workspace')),
  bucket_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, bucket_type, bucket_key, window_start)
);

CREATE TABLE IF NOT EXISTS annotation_media (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  race_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('taggedIncident', 'journalEntry')),
  annotation_id TEXT NOT NULL,
  media_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, annotation_id)
);

CREATE INDEX IF NOT EXISTS idx_annotation_media_race
ON annotation_media (workspace_id, race_key, kind);

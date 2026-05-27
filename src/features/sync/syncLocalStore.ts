import type { SQLiteClient } from '../../db/sqliteClient';
import type {
  AnnotationKind,
  AnnotationPayload,
  AnnotationStore,
  CloudRaceMetadata,
  DbRow,
  RaceRecord,
  SqlValue,
  SyncConfig,
  SyncOutboxRow,
  SyncRaceCursor,
  SyncRaceOutboxRow,
  SyncSession,
} from '../../types';
import { ANNOTATION_TABLE_CONFIG } from '../annotations/annotationStore';
import type {
  CloudRacePushResponse,
  SyncAcceptedMutation,
  SyncPulledMutation,
  SyncPushMutation,
  SyncRaceCursorRequest,
} from './syncApi';

interface LocalRaceKeyRow extends DbRow {
  id: string;
  race_key: string;
  name: string;
}

const SYNC_COLUMN_NAMES = new Set([
  'created_by',
  'updated_by',
  'sync_workspace_id',
  'sync_server_sequence',
  'sync_origin_client_id',
]);

export function getSyncConfig(db: SQLiteClient): SyncConfig | null {
  return db.queryOne<SyncConfig>('SELECT * FROM sync_config WHERE id = 1');
}

export async function upsertSyncConfig(
  db: SQLiteClient,
  apiBase: string,
  session: SyncSession,
  existingClientId?: string | null,
): Promise<SyncConfig> {
  const now = new Date().toISOString();
  const clientId = existingClientId || crypto.randomUUID();

  db.execute(
    `
      INSERT INTO sync_config (
        id, workspace_id, api_base, client_id, connected_subject, status,
        last_global_sequence_seen, connected_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, 'connected', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        api_base = excluded.api_base,
        client_id = excluded.client_id,
        connected_subject = excluded.connected_subject,
        status = 'connected',
        last_global_sequence_seen = MAX(sync_config.last_global_sequence_seen, excluded.last_global_sequence_seen),
        updated_at = excluded.updated_at
    `,
    [
      session.workspaceId,
      apiBase,
      clientId,
      session.subject,
      session.currentSequence,
      now,
      now,
    ],
  );
  await db.persist();
  return getSyncConfig(db) as SyncConfig;
}

export async function markSyncReconnectRequired(
  db: SQLiteClient,
): Promise<void> {
  db.execute(
    `
      UPDATE sync_config
      SET status = 'reconnect_required', updated_at = ?
      WHERE id = 1
    `,
    [new Date().toISOString()],
  );
  await db.persist();
}

export function getLocalRaceKeys(db: SQLiteClient): LocalRaceKeyRow[] {
  return db.query<LocalRaceKeyRow>(
    'SELECT id, race_key, name FROM races ORDER BY updated_at DESC',
  );
}

export function getRaceKeyForRaceId(
  db: SQLiteClient,
  raceId: string,
): string | null {
  return (
    db.queryOne<{ race_key: string }>(
      'SELECT race_key FROM races WHERE id = ?',
      [raceId],
    )?.race_key ?? null
  );
}

export function getRaceIdByRaceKey(
  db: SQLiteClient,
  raceKey: string,
): string | null {
  return (
    db.queryOne<{ id: string }>('SELECT id FROM races WHERE race_key = ?', [
      raceKey,
    ])?.id ?? null
  );
}

export function getRaceCursorRequests(
  db: SQLiteClient,
  workspaceId: string,
): SyncRaceCursorRequest[] {
  return db
    .query<DbRow & SyncRaceCursorRequest>(
      `
      SELECT
        r.race_key AS raceKey,
        COALESCE(c.last_server_sequence, 0) AS since
      FROM races r
      LEFT JOIN sync_race_cursors c
        ON c.workspace_id = ? AND c.race_key = r.race_key
      ORDER BY r.updated_at DESC
    `,
      [workspaceId],
    )
    .map((row) => ({
      raceKey: row.raceKey,
      since: Number(row.since ?? 0),
    }));
}

export function getRaceCursor(
  db: SQLiteClient,
  workspaceId: string,
  raceKey: string,
): SyncRaceCursor | null {
  return db.queryOne<SyncRaceCursor>(
    'SELECT * FROM sync_race_cursors WHERE workspace_id = ? AND race_key = ?',
    [workspaceId, raceKey],
  );
}

export function countPendingOutbox(
  db: SQLiteClient,
  workspaceId: string,
): number {
  return Number(
    db.queryOne<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM sync_outbox
        WHERE workspace_id = ? AND status = 'pending' AND attempts < 3
      `,
      [workspaceId],
    )?.count ?? 0,
  );
}

export function countFailedOutbox(
  db: SQLiteClient,
  workspaceId: string,
): number {
  return Number(
    db.queryOne<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM sync_outbox
        WHERE workspace_id = ? AND status = 'failed'
      `,
      [workspaceId],
    )?.count ?? 0,
  );
}

export function countPendingRaceOutbox(
  db: SQLiteClient,
  workspaceId: string,
): number {
  return Number(
    db.queryOne<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM sync_race_outbox
        WHERE workspace_id = ? AND status = 'pending' AND attempts < 3
      `,
      [workspaceId],
    )?.count ?? 0,
  );
}

export function countFailedRaceOutbox(
  db: SQLiteClient,
  workspaceId: string,
): number {
  return Number(
    db.queryOne<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM sync_race_outbox
        WHERE workspace_id = ? AND status = 'failed'
      `,
      [workspaceId],
    )?.count ?? 0,
  );
}

export function getPendingOutbox(
  db: SQLiteClient,
  workspaceId: string,
  limit: number,
): SyncOutboxRow[] {
  return db.query<SyncOutboxRow>(
    `
      SELECT *
      FROM sync_outbox
      WHERE workspace_id = ? AND status = 'pending' AND attempts < 3
      ORDER BY created_at ASC
      LIMIT ?
    `,
    [workspaceId, limit],
  );
}

export function getPendingRaceOutbox(
  db: SQLiteClient,
  workspaceId: string,
  limit: number,
): SyncRaceOutboxRow[] {
  return db.query<SyncRaceOutboxRow>(
    `
      SELECT *
      FROM sync_race_outbox
      WHERE workspace_id = ? AND status = 'pending' AND attempts < 3
      ORDER BY created_at ASC
      LIMIT ?
    `,
    [workspaceId, limit],
  );
}

export async function appendRaceOutboxMutation(
  db: SQLiteClient,
  config: SyncConfig,
  raceKey: string,
  clientRequestId: string = crypto.randomUUID(),
): Promise<void> {
  const existingPending = db.queryOne<{ id: string }>(
    `
      SELECT id
      FROM sync_race_outbox
      WHERE workspace_id = ? AND race_key = ? AND status = 'pending'
      LIMIT 1
    `,
    [config.workspace_id, raceKey],
  );
  if (existingPending) {
    return;
  }

  const now = new Date().toISOString();
  db.execute(
    `
      INSERT OR IGNORE INTO sync_race_outbox (
        id, workspace_id, client_id, client_request_id, race_key, action,
        created_at, status
      ) VALUES (?, ?, ?, ?, ?, 'upsert', ?, 'pending')
    `,
    [
      crypto.randomUUID(),
      config.workspace_id,
      config.client_id,
      clientRequestId,
      raceKey,
      now,
    ],
  );
  await db.persist();
}

export async function seedRaceOutboxForUnsyncedRaces(
  db: SQLiteClient,
  config: SyncConfig,
): Promise<number> {
  const rows = db.query<{ race_key: string }>(
    `
      SELECT r.race_key
      FROM races r
      WHERE r.sync_server_sequence IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sync_race_outbox o
          WHERE o.workspace_id = ?
            AND o.race_key = r.race_key
            AND o.status IN ('pending', 'accepted')
        )
      ORDER BY r.updated_at ASC
    `,
    [config.workspace_id],
  );

  for (const row of rows) {
    await appendRaceOutboxMutation(
      db,
      config,
      row.race_key,
      `seed:race:${row.race_key}`,
    );
  }

  return rows.length;
}

export function getRaceMetadataForSync(
  db: SQLiteClient,
  raceKey: string,
  workspaceId?: string,
): CloudRaceMetadata | null {
  const race = db.queryOne<RaceRecord>(
    'SELECT * FROM races WHERE race_key = ?',
    [raceKey],
  );
  if (!race) {
    return null;
  }

  return {
    workspaceId,
    raceKey: race.race_key,
    name: race.name,
    sourceFileName: race.source_file_name,
    contentHash: race.content_hash,
    raceStartTime: race.race_start_time ?? null,
    rowCount: Number(race.row_count ?? 0),
    artifactSha256: race.artifact_sha256 ?? '',
    artifactSizeBytes: Number(race.artifact_size_bytes ?? 0),
    serverSequence: Number(race.sync_server_sequence ?? 0),
    updatedAt: race.updated_at || new Date().toISOString(),
    createdBy: race.created_by ?? null,
    updatedBy: race.updated_by ?? null,
  };
}

export async function appendOutboxMutation(
  db: SQLiteClient,
  config: SyncConfig,
  kind: AnnotationKind,
  action: 'upsert' | 'delete',
  annotationId: string,
  raceKey: string,
  payload: AnnotationPayload,
  clientRequestId: string = crypto.randomUUID(),
): Promise<void> {
  const now = new Date().toISOString();
  db.execute(
    `
      INSERT OR IGNORE INTO sync_outbox (
        id, workspace_id, client_id, client_request_id, race_key, kind, action,
        annotation_id, payload_json, created_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `,
    [
      crypto.randomUUID(),
      config.workspace_id,
      config.client_id,
      clientRequestId,
      raceKey,
      kind,
      action,
      annotationId,
      JSON.stringify(payload),
      now,
    ],
  );
  await db.persist();
}

export async function seedOutboxForUnsyncedAnnotations(
  db: SQLiteClient,
  config: SyncConfig,
): Promise<number> {
  let seeded = 0;

  for (const kind of Object.keys(ANNOTATION_TABLE_CONFIG) as AnnotationKind[]) {
    const tableConfig = ANNOTATION_TABLE_CONFIG[kind];
    const rows = db.query<DbRow>(
      `
        SELECT a.*, r.race_key
        FROM ${tableConfig.table} a
        JOIN races r ON r.id = a.race_id
        WHERE a.sync_server_sequence IS NULL
        ORDER BY a.updated_at ASC
      `,
    );

    for (const row of rows) {
      const annotationId = `${row.id ?? ''}`;
      const raceKey = `${row.race_key ?? ''}`;
      if (!annotationId || !raceKey) {
        continue;
      }

      await appendOutboxMutation(
        db,
        config,
        kind,
        'upsert',
        annotationId,
        raceKey,
        rowToPayload(kind, row),
        `seed:${kind}:${annotationId}`,
      );
      seeded += 1;
    }
  }

  return seeded;
}

export function outboxRowsToPushMutations(
  rows: SyncOutboxRow[],
): SyncPushMutation[] {
  return rows.map((row) => ({
    clientRequestId: row.client_request_id,
    raceKey: row.race_key,
    kind: row.kind,
    action: row.action,
    annotationId: row.annotation_id,
    payload: parsePayload(row.payload_json),
  }));
}

export async function markOutboxAccepted(
  db: SQLiteClient,
  row: SyncOutboxRow,
  accepted: SyncAcceptedMutation,
  submittedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  const tableConfig = ANNOTATION_TABLE_CONFIG[row.kind];

  db.transaction(() => {
    db.execute(
      `
        UPDATE sync_outbox
        SET status = 'accepted', accepted_server_sequence = ?, last_error = NULL
        WHERE id = ?
      `,
      [accepted.serverSequence, row.id],
    );

    if (row.action === 'upsert') {
      db.execute(
        `
          UPDATE ${tableConfig.table}
          SET
            created_by = COALESCE(created_by, ?),
            updated_by = ?,
            sync_workspace_id = ?,
            sync_server_sequence = ?,
            sync_origin_client_id = ?,
            updated_at = updated_at
          WHERE id = ?
        `,
        [
          submittedBy,
          submittedBy,
          row.workspace_id,
          accepted.serverSequence,
          row.client_id,
          row.annotation_id,
        ],
      );
    }

    upsertRaceCursorSql(
      db,
      row.workspace_id,
      row.race_key,
      accepted.serverSequence,
      now,
    );
  });

  await db.persist();
}

export async function markRaceOutboxAccepted(
  db: SQLiteClient,
  row: SyncRaceOutboxRow,
  response: CloudRacePushResponse,
  submittedBy: string,
): Promise<void> {
  const accepted = response.accepted;

  db.transaction(() => {
    db.execute(
      `
        UPDATE sync_race_outbox
        SET status = 'accepted', accepted_server_sequence = ?, last_error = NULL
        WHERE id = ?
      `,
      [accepted.serverSequence, row.id],
    );
    db.execute(
      `
        UPDATE races
        SET
          created_by = COALESCE(created_by, ?),
          updated_by = ?,
          sync_workspace_id = ?,
          sync_server_sequence = ?,
          sync_origin_client_id = ?,
          artifact_sha256 = ?,
          artifact_size_bytes = ?
        WHERE race_key = ?
      `,
      [
        submittedBy,
        submittedBy,
        row.workspace_id,
        accepted.serverSequence,
        row.client_id,
        accepted.artifactSha256,
        accepted.artifactSizeBytes,
        row.race_key,
      ],
    );
  });

  await db.persist();
}

export async function markOutboxFailed(
  db: SQLiteClient,
  rows: SyncOutboxRow[],
  message: string,
): Promise<void> {
  if (!rows.length) {
    return;
  }

  db.transaction(() => {
    rows.forEach((row) => {
      db.execute(
        `
          UPDATE sync_outbox
          SET
            attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
            last_error = ?
          WHERE id = ?
        `,
        [message, row.id],
      );
    });
  });
  await db.persist();
}

export async function markRaceOutboxFailed(
  db: SQLiteClient,
  rows: SyncRaceOutboxRow[],
  message: string,
): Promise<void> {
  if (!rows.length) {
    return;
  }

  db.transaction(() => {
    rows.forEach((row) => {
      db.execute(
        `
          UPDATE sync_race_outbox
          SET
            attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
            last_error = ?
          WHERE id = ?
        `,
        [message, row.id],
      );
    });
  });
  await db.persist();
}

export async function applyPulledMutations(
  db: SQLiteClient,
  workspaceId: string,
  mutations: SyncPulledMutation[],
): Promise<number> {
  if (!mutations.length) {
    return 0;
  }

  let applied = 0;
  const knownRaceIds = new Map(
    getLocalRaceKeys(db).map((race) => [race.race_key, race.id]),
  );

  db.transaction(() => {
    mutations
      .slice()
      .sort((left, right) => left.serverSequence - right.serverSequence)
      .forEach((mutation) => {
        const localRaceId = knownRaceIds.get(mutation.raceKey);
        if (!localRaceId) {
          return;
        }

        if (mutation.action === 'delete') {
          applyPulledDelete(db, workspaceId, mutation);
        } else {
          applyPulledUpsert(db, workspaceId, localRaceId, mutation);
        }

        upsertRaceCursorSql(
          db,
          workspaceId,
          mutation.raceKey,
          mutation.serverSequence,
          new Date().toISOString(),
        );
        applied += 1;
      });
  });

  if (applied) {
    await db.persist();
  }

  return applied;
}

export async function recordGlobalSequenceSeen(
  db: SQLiteClient,
  currentSequence: number,
): Promise<void> {
  db.execute(
    `
      UPDATE sync_config
      SET last_global_sequence_seen = MAX(last_global_sequence_seen, ?),
        updated_at = ?
      WHERE id = 1
    `,
    [currentSequence, new Date().toISOString()],
  );
  await db.persist();
}

export function createSyncAnnotationStore(
  db: SQLiteClient,
  baseStore: AnnotationStore,
  getActiveConfig: () => SyncConfig | null,
): AnnotationStore {
  return {
    async save(kind, payload) {
      const id = await baseStore.save(kind, payload);
      const config = getActiveConfig();
      if (!config || config.status !== 'connected') {
        return id;
      }

      const raceId = `${payload.race_id ?? ''}`;
      const raceKey = getRaceKeyForRaceId(db, raceId);
      if (!raceKey) {
        return id;
      }

      const tableConfig = ANNOTATION_TABLE_CONFIG[kind];
      const row = db.queryOne<DbRow>(
        `SELECT * FROM ${tableConfig.table} WHERE id = ?`,
        [id],
      );
      if (!row) {
        return id;
      }

      await appendOutboxMutation(
        db,
        config,
        kind,
        'upsert',
        id,
        raceKey,
        rowToPayload(kind, row),
      );
      return id;
    },

    async remove(kind, id) {
      const config = getActiveConfig();
      const tableConfig = ANNOTATION_TABLE_CONFIG[kind];
      const existing = db.queryOne<DbRow & { race_key?: string }>(
        `
          SELECT a.*, r.race_key
          FROM ${tableConfig.table} a
          JOIN races r ON r.id = a.race_id
          WHERE a.id = ?
        `,
        [id],
      );

      await baseStore.remove(kind, id);

      if (!config || config.status !== 'connected' || !existing?.race_key) {
        return;
      }

      await appendOutboxMutation(
        db,
        config,
        kind,
        'delete',
        id,
        existing.race_key,
        rowToPayload(kind, existing),
      );
    },
  };
}

function applyPulledUpsert(
  db: SQLiteClient,
  workspaceId: string,
  localRaceId: string,
  mutation: SyncPulledMutation,
): void {
  const tableConfig = ANNOTATION_TABLE_CONFIG[mutation.kind];
  const payload: AnnotationPayload = {
    ...mutation.payload,
    id: mutation.annotationId,
    race_id: localRaceId,
    created_at: mutation.payload.created_at || mutation.submittedAt,
    updated_at: mutation.payload.updated_at || mutation.submittedAt,
    ...(mutation.kind === 'journalEntry'
      ? {
          event_time_source:
            mutation.payload.event_time_source ||
            (mutation.payload.event_time_iso ? 'manual' : 'lap'),
        }
      : {}),
  };
  const insertColumns = [
    'id',
    ...tableConfig.fields,
    'created_by',
    'updated_by',
    'sync_workspace_id',
    'sync_server_sequence',
    'sync_origin_client_id',
  ];
  const updateColumns = [
    ...tableConfig.fields,
    'updated_by',
    'sync_workspace_id',
    'sync_server_sequence',
    'sync_origin_client_id',
  ];
  const values = [
    mutation.annotationId,
    ...tableConfig.fields.map((field) => toSqlValue(payload[field])),
    mutation.submittedBy,
    mutation.submittedBy,
    workspaceId,
    mutation.serverSequence,
    null,
  ];

  db.execute(
    `
      INSERT INTO ${tableConfig.table} (${insertColumns.join(', ')})
      VALUES (${insertColumns.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET
        ${updateColumns.map((field) => `${field} = excluded.${field}`).join(', ')},
        created_by = COALESCE(${tableConfig.table}.created_by, excluded.created_by)
    `,
    values,
  );
}

function applyPulledDelete(
  db: SQLiteClient,
  workspaceId: string,
  mutation: SyncPulledMutation,
): void {
  const tableConfig = ANNOTATION_TABLE_CONFIG[mutation.kind];

  db.execute(`DELETE FROM ${tableConfig.table} WHERE id = ?`, [
    mutation.annotationId,
  ]);
  db.execute(
    `
      INSERT INTO annotation_tombstones (
        workspace_id, race_key, kind, annotation_id, deleted_at, deleted_by,
        sync_server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, race_key, kind, annotation_id) DO UPDATE SET
        deleted_at = excluded.deleted_at,
        deleted_by = excluded.deleted_by,
        sync_server_sequence = excluded.sync_server_sequence
    `,
    [
      workspaceId,
      mutation.raceKey,
      mutation.kind,
      mutation.annotationId,
      mutation.submittedAt,
      mutation.submittedBy,
      mutation.serverSequence,
    ],
  );
}

function upsertRaceCursorSql(
  db: SQLiteClient,
  workspaceId: string,
  raceKey: string,
  serverSequence: number,
  updatedAt: string,
): void {
  db.execute(
    `
      INSERT INTO sync_race_cursors (
        workspace_id, race_key, last_server_sequence, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, race_key) DO UPDATE SET
        last_server_sequence = MAX(sync_race_cursors.last_server_sequence, excluded.last_server_sequence),
        updated_at = excluded.updated_at
    `,
    [workspaceId, raceKey, serverSequence, updatedAt],
  );
}

function rowToPayload(
  kind: AnnotationKind,
  row: Record<string, unknown>,
): AnnotationPayload {
  const tableConfig = ANNOTATION_TABLE_CONFIG[kind];
  const payload: AnnotationPayload = {
    id: row.id,
  };

  tableConfig.fields.forEach((field) => {
    if (field === 'race_id' || SYNC_COLUMN_NAMES.has(field)) {
      return;
    }
    payload[field] = row[field];
  });

  return payload;
}

function parsePayload(json: string): AnnotationPayload {
  try {
    return JSON.parse(json) as AnnotationPayload;
  } catch {
    return {};
  }
}

function toSqlValue(value: unknown): SqlValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  return value == null ? null : `${value}`;
}

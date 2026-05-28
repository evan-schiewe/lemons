import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import defaultDatabaseUrl from '../assets/default-data.sqlite?url';
import { normalizeRaceData } from '../model/normalizeRaceData';
import type {
  CloudRaceMetadata,
  DbRow,
  ParsedRaceRow,
  SqlParams,
  SqlValue,
} from '../types';
import schemaSql from './schema.sql?raw';

const DATABASE_FILE_NAME = 'lemons-race-viewer.sqlite';
const DEFAULT_DATABASE_URL = defaultDatabaseUrl;
const DEFAULT_DATABASE_VERSION = `asset:${defaultDatabaseUrl}`;
const STORAGE_SOURCE_KEY = 'lemons-race-viewer-db-source';
const STORAGE_BUNDLE_VERSION_KEY = 'lemons-race-viewer-bundle-version';
const STORAGE_SOURCE_BUNDLE = 'bundle';
const STORAGE_SOURCE_CUSTOM = 'custom';
const BUNDLED_OPERATIONAL_TABLES = [
  'sync_config',
  'sync_race_cursors',
  'sync_outbox',
  'sync_race_outbox',
  'annotation_tombstones',
];

const RACE_ARTIFACT_RACE_COLUMNS = [
  'id',
  'race_key',
  'name',
  'source_file_name',
  'content_hash',
  'race_start_time',
  'row_count',
  'imported_at',
  'updated_at',
];

const RACE_LOCAL_SYNC_COLUMNS = [
  'created_by',
  'updated_by',
  'sync_workspace_id',
  'sync_server_sequence',
  'sync_origin_client_id',
  'artifact_sha256',
  'artifact_size_bytes',
];

const RACE_IMPORT_COLUMNS = [
  ...RACE_ARTIFACT_RACE_COLUMNS,
  ...RACE_LOCAL_SYNC_COLUMNS,
];

const RACE_ARTIFACT_RAW_ROW_COLUMNS = [
  'id',
  'race_id',
  'row_index',
  'csv_row_number',
  'raw_line',
  'raw_lap',
  'raw_entry',
  'raw_driver',
  'raw_lap_time',
  'raw_position',
  'raw_speed',
  'raw_gap_ahead',
  'raw_gap_leader',
];

const NORMALIZED_LAP_COLUMNS = [
  'id',
  'race_id',
  'raw_row_id',
  'lap_identity',
  'lap_number',
  'driver_name',
  'lap_time_ms',
  'lap_time_text',
  'position_value',
  'speed_mph',
  'gap_ahead_ms',
  'gap_ahead_laps',
  'gap_ahead_display',
  'gap_leader_ms',
  'gap_leader_laps',
  'gap_leader_display',
  'rolling_median_ms',
  'is_outlier',
  'is_green_flag',
  'search_text',
];

const RACE_ARTIFACT_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE races (
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

CREATE TABLE raw_lap_rows (
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
`;

const NORMALIZED_LAPS_SCHEMA_SQL = `
CREATE TABLE normalized_laps (
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
`;

const NORMALIZED_LAPS_EXPORT_VIEW_SQL = `
CREATE VIEW normalized_laps_export AS
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
`;

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlJsDatabase = InstanceType<SqlJsStatic['Database']>;
type StorageMode = 'memory' | 'opfs-cache';

export class SQLiteClient {
  SQL: SqlJsStatic | null;
  db: SqlJsDatabase | null;
  storageMode: StorageMode;
  didRefreshBundledDatabase: boolean;

  constructor() {
    this.SQL = null;
    this.db = null;
    this.storageMode = 'memory';
    this.didRefreshBundledDatabase = false;
  }

  async init(): Promise<this> {
    const SQL = await initSqlJs({
      locateFile: () => sqlWasmUrl,
    });
    this.SQL = SQL;

    const persistedBytes = await this.loadPersistedBytes();
    this.db = persistedBytes?.length
      ? new SQL.Database(persistedBytes)
      : new SQL.Database();
    this.db.run(schemaSql);
    this.applyMigrations(this.db);
    await this.persist();
    return this;
  }

  applyMigrations(database: SqlJsDatabase): void {
    // Existing persisted databases need explicit ALTERs for new columns.
    const raceColumns = this.queryDatabase<{ name: string }>(
      database,
      'PRAGMA table_info(races)',
    );
    const hasRaceStartTime = raceColumns.some(
      (column) => column.name === 'race_start_time',
    );
    if (!hasRaceStartTime) {
      database.run('ALTER TABLE races ADD COLUMN race_start_time TEXT');
    }

    [
      'created_by TEXT',
      'updated_by TEXT',
      'sync_workspace_id TEXT',
      'sync_server_sequence INTEGER',
      'sync_origin_client_id TEXT',
      'artifact_sha256 TEXT',
      'artifact_size_bytes INTEGER',
    ].forEach((columnDefinition) => {
      this.ensureColumn(database, 'races', columnDefinition);
    });

    this.migrateRawLapRows(database);
    this.migrateNormalizedLaps(database);
    this.recreateNormalizedLapsExportView(database);

    const hasJournalEntriesTable = this.tableExists(
      database,
      'journal_entries',
    );
    if (!hasJournalEntriesTable) {
      database.run(`
                CREATE TABLE IF NOT EXISTS journal_entries (
                    id TEXT PRIMARY KEY,
                    race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
                    lap_number INTEGER,
                    event_time_iso TEXT,
                    event_time_source TEXT NOT NULL DEFAULT 'lap',
                    title TEXT,
                    entry_text TEXT NOT NULL,
                    color TEXT NOT NULL DEFAULT '#333733',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            `);
      database.run(
        'CREATE INDEX IF NOT EXISTS idx_journal_entries_race_lap ON journal_entries (race_id, lap_number)',
      );
      database.run(
        'CREATE INDEX IF NOT EXISTS idx_journal_entries_race_time ON journal_entries (race_id, event_time_iso)',
      );
    }

    [
      'lap_notes',
      'tagged_incidents',
      'range_events',
      'driver_stints',
      'journal_entries',
    ].forEach((tableName) => {
      this.ensureColumn(database, tableName, 'created_by TEXT');
      this.ensureColumn(database, tableName, 'updated_by TEXT');
      this.ensureColumn(database, tableName, 'sync_workspace_id TEXT');
      this.ensureColumn(database, tableName, 'sync_server_sequence INTEGER');
      this.ensureColumn(database, tableName, 'sync_origin_client_id TEXT');
    });

    this.ensureColumn(
      database,
      'tagged_incidents',
      "media_json TEXT NOT NULL DEFAULT '[]'",
    );
    this.ensureColumn(
      database,
      'journal_entries',
      "media_json TEXT NOT NULL DEFAULT '[]'",
    );
  }

  migrateRawLapRows(database: SqlJsDatabase): void {
    const columns = this.queryDatabase<{ name: string }>(
      database,
      'PRAGMA table_info(raw_lap_rows)',
    );
    const columnNames = new Set(columns.map((column) => column.name));
    const hadRawEntry = columnNames.has('raw_entry');

    if (!hadRawEntry) {
      database.run('ALTER TABLE raw_lap_rows ADD COLUMN raw_entry TEXT');
    }

    if (columnNames.has('raw_car')) {
      database.run(`
        UPDATE raw_lap_rows
        SET raw_entry = raw_car
        WHERE raw_entry IS NULL AND raw_car IS NOT NULL
      `);
    }
  }

  migrateNormalizedLaps(database: SqlJsDatabase): void {
    const columns = this.queryDatabase<{ name: string; notnull: number }>(
      database,
      'PRAGMA table_info(normalized_laps)',
    );
    const hasLegacyRequiredCarNumber = columns.some(
      (column) => column.name === 'car_number' && Number(column.notnull) === 1,
    );

    if (!hasLegacyRequiredCarNumber) {
      return;
    }

    const legacyColumnNames = new Set(columns.map((column) => column.name));
    const copyColumns = NORMALIZED_LAP_COLUMNS.filter((column) =>
      legacyColumnNames.has(column),
    );

    database.run('BEGIN');
    try {
      database.run('DROP VIEW IF EXISTS normalized_laps_export');
      database.run('DROP TABLE IF EXISTS normalized_laps_legacy');
      database.run(
        'ALTER TABLE normalized_laps RENAME TO normalized_laps_legacy',
      );
      database.run(NORMALIZED_LAPS_SCHEMA_SQL);
      database.run(`
        INSERT INTO normalized_laps (${copyColumns.join(', ')})
        SELECT ${copyColumns.join(', ')}
        FROM normalized_laps_legacy
      `);
      database.run('DROP TABLE normalized_laps_legacy');
      database.run(
        'CREATE INDEX IF NOT EXISTS idx_normalized_laps_race_lap ON normalized_laps (race_id, lap_number)',
      );
      database.run(
        'CREATE INDEX IF NOT EXISTS idx_normalized_laps_driver ON normalized_laps (race_id, driver_name)',
      );
      database.run('COMMIT');
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  }

  recreateNormalizedLapsExportView(database: SqlJsDatabase): void {
    database.run('DROP VIEW IF EXISTS normalized_laps_export');
    database.run(NORMALIZED_LAPS_EXPORT_VIEW_SQL);
  }

  queryDatabase<T extends DbRow = DbRow>(
    database: SqlJsDatabase,
    sql: string,
    params: SqlParams = [],
  ): T[] {
    const statement = database.prepare(sql);

    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  query<T extends DbRow = DbRow>(sql: string, params: SqlParams = []): T[] {
    return this.queryDatabase<T>(this.requireDb(), sql, params);
  }

  queryOne<T extends DbRow = DbRow>(
    sql: string,
    params: SqlParams = [],
  ): T | null {
    return this.query<T>(sql, params)[0] ?? null;
  }

  tableExists(database: SqlJsDatabase, tableName: string): boolean {
    return (
      this.queryDatabase(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName],
      ).length > 0
    );
  }

  ensureColumn(
    database: SqlJsDatabase,
    tableName: string,
    columnDefinition: string,
  ): void {
    const columnName = columnDefinition.split(/\s+/)[0];
    const columns = this.queryDatabase<{ name: string }>(
      database,
      `PRAGMA table_info(${tableName})`,
    );
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    database.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }

  countRows(database: SqlJsDatabase, tableName: string): number {
    const rows = this.queryDatabase<{ count: number }>(
      database,
      `SELECT COUNT(*) AS count FROM ${tableName}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  execute(sql: string, params: SqlParams = []): void {
    this.requireDb().run(sql, params);
    this.markDatabaseAsCustom();
  }

  executeMany(sql: string, rows: SqlParams[]): void {
    const statement = this.requireDb().prepare(sql);

    try {
      rows.forEach((params: SqlParams) => {
        statement.run(params);
        statement.reset();
      });
    } finally {
      statement.free();
    }

    if (rows?.length) {
      this.markDatabaseAsCustom();
    }
  }

  executeManyOnDatabase(
    database: SqlJsDatabase,
    sql: string,
    rows: SqlParams[],
  ): void {
    const statement = database.prepare(sql);

    try {
      rows.forEach((params: SqlParams) => {
        statement.run(params);
        statement.reset();
      });
    } finally {
      statement.free();
    }
  }

  rebuildNormalizedLaps(database: SqlJsDatabase): void {
    const races = this.queryDatabase<{ id: string }>(
      database,
      'SELECT id FROM races ORDER BY rowid',
    );
    if (!races.length) {
      return;
    }

    const insertSql = `
        INSERT INTO normalized_laps (
                    id, race_id, raw_row_id, lap_identity, lap_number, driver_name,
          lap_time_ms, lap_time_text, position_value, speed_mph, gap_ahead_ms, gap_ahead_laps,
          gap_ahead_display, gap_leader_ms, gap_leader_laps, gap_leader_display,
            rolling_median_ms, is_outlier, is_green_flag,
          search_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

    const rebuiltRows: SqlParams[] = [];

    database.run('BEGIN');

    try {
      database.run('DELETE FROM normalized_laps');

      races.forEach((race) => {
        const rawRows = this.queryDatabase<DbRow>(
          database,
          `
                SELECT id, race_id, row_index, csv_row_number, raw_line, raw_lap, raw_entry, raw_driver,
                  raw_lap_time, raw_position, raw_speed, raw_gap_ahead, raw_gap_leader
                FROM raw_lap_rows
                WHERE race_id = ?
                ORDER BY row_index ASC
              `,
          [race.id],
        );

        if (!rawRows.length) {
          return;
        }

        const parsedRows: ParsedRaceRow[] = rawRows.map((row, index) => ({
          rowIndex: index,
          csvRowNumber: Number(row.csv_row_number ?? 0),
          rawLine: `${row.raw_line ?? ''}`,
          rawCells: [
            `${row.raw_lap ?? ''}`,
            `${row.raw_entry ?? ''}`,
            `${row.raw_driver ?? ''}`,
            `${row.raw_lap_time ?? ''}`,
            `${row.raw_position ?? ''}`,
            `${row.raw_speed ?? ''}`,
            `${row.raw_gap_ahead ?? ''}`,
            `${row.raw_gap_leader ?? ''}`,
          ],
          values: {
            lap: `${row.raw_lap ?? ''}`,
            team_slot: `${row.raw_entry ?? ''}`,
            driver: `${row.raw_driver ?? ''}`,
            lap_time: `${row.raw_lap_time ?? ''}`,
            position: `${row.raw_position ?? ''}`,
            speed: `${row.raw_speed ?? ''}`,
            gap_ahead: `${row.raw_gap_ahead ?? ''}`,
            gap_leader: `${row.raw_gap_leader ?? ''}`,
          },
        }));

        const normalized = normalizeRaceData(parsedRows);

        normalized.laps.forEach((lap) => {
          const sourceRow = rawRows[lap.rowIndex];
          rebuiltRows.push([
            crypto.randomUUID(),
            race.id,
            typeof sourceRow?.id === 'string' ? sourceRow.id : null,
            `${race.id}:${lap.lapNumber}:${lap.driverName}:${lap.lapTimeText}`,
            lap.lapNumber,
            lap.driverName,
            lap.lapTime.ms,
            lap.lapTimeText,
            lap.positionValue,
            lap.speedMph,
            lap.gapAhead.ms,
            lap.gapAhead.laps,
            lap.gapAhead.display,
            lap.gapLeader.ms,
            lap.gapLeader.laps,
            lap.gapLeader.display,
            lap.rollingMedianMs,
            lap.isOutlier ? 1 : 0,
            lap.isGreenFlag ? 1 : 0,
            lap.searchText,
          ]);
        });
      });

      if (rebuiltRows.length) {
        this.executeManyOnDatabase(database, insertSql, rebuiltRows);
      }

      database.run('COMMIT');
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  }

  transaction<T>(work: () => T): T {
    const database = this.requireDb();
    database.run('BEGIN');
    try {
      const result = work();
      database.run('COMMIT');
      this.markDatabaseAsCustom();
      return result;
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  }

  exportDatabase(): Uint8Array {
    return this.requireDb().export();
  }

  exportRaceArtifact(raceId: string): Uint8Array {
    const SQL = this.requireSql();
    const artifactDatabase = new SQL.Database();

    try {
      artifactDatabase.run(RACE_ARTIFACT_SCHEMA_SQL);

      const race = this.queryOne(
        `SELECT ${RACE_ARTIFACT_RACE_COLUMNS.join(', ')} FROM races WHERE id = ?`,
        [raceId],
      );
      if (!race) {
        throw new Error('Race not found for cloud artifact export.');
      }

      artifactDatabase.run(
        `
          INSERT INTO races (${RACE_ARTIFACT_RACE_COLUMNS.join(', ')})
          VALUES (${RACE_ARTIFACT_RACE_COLUMNS.map(() => '?').join(', ')})
        `,
        RACE_ARTIFACT_RACE_COLUMNS.map((column) => toSqlValue(race[column])),
      );

      const rawRows = this.query(
        `
          SELECT ${RACE_ARTIFACT_RAW_ROW_COLUMNS.join(', ')}
          FROM raw_lap_rows
          WHERE race_id = ?
          ORDER BY row_index ASC
        `,
        [raceId],
      );
      this.executeManyOnDatabase(
        artifactDatabase,
        `
          INSERT INTO raw_lap_rows (${RACE_ARTIFACT_RAW_ROW_COLUMNS.join(', ')})
          VALUES (${RACE_ARTIFACT_RAW_ROW_COLUMNS.map(() => '?').join(', ')})
        `,
        rawRows.map((row) =>
          RACE_ARTIFACT_RAW_ROW_COLUMNS.map((column) =>
            toSqlValue(row[column]),
          ),
        ),
      );

      return artifactDatabase.export();
    } finally {
      artifactDatabase.close();
    }
  }

  async importRaceArtifact(
    bytes: ArrayLike<number>,
    metadata: CloudRaceMetadata,
  ): Promise<string> {
    const incoming = new Uint8Array(bytes);
    const SQL = this.requireSql();
    let artifactDatabase: SqlJsDatabase | null = null;

    try {
      artifactDatabase = new SQL.Database(incoming);
      if (metadata.artifactSha256) {
        const actualSha256 = await sha256Hex(incoming);
        if (actualSha256 !== metadata.artifactSha256) {
          throw new Error('Cloud race artifact checksum does not match.');
        }
      }

      if (
        !this.tableExists(artifactDatabase, 'races') ||
        !this.tableExists(artifactDatabase, 'raw_lap_rows')
      ) {
        throw new Error('Cloud race artifact is not a valid race SQLite file.');
      }

      artifactDatabase.run(schemaSql);
      this.applyMigrations(artifactDatabase);

      const races = this.queryDatabase<DbRow>(
        artifactDatabase,
        `SELECT ${RACE_ARTIFACT_RACE_COLUMNS.join(', ')} FROM races`,
      );
      if (races.length !== 1) {
        throw new Error('Cloud race artifact must contain exactly one race.');
      }

      const artifactRace = races[0];
      if (artifactRace.race_key !== metadata.raceKey) {
        throw new Error(
          'Cloud race artifact metadata does not match race_key.',
        );
      }

      const rawRows = this.queryDatabase<DbRow>(
        artifactDatabase,
        `
          SELECT ${RACE_ARTIFACT_RAW_ROW_COLUMNS.join(', ')}
          FROM raw_lap_rows
          WHERE race_id = ?
          ORDER BY row_index ASC
        `,
        [`${artifactRace.id ?? ''}`],
      );
      if (!rawRows.length) {
        throw new Error('Cloud race artifact does not contain raw lap rows.');
      }

      const existingRace = this.queryOne<{ id: string }>(
        'SELECT id FROM races WHERE race_key = ?',
        [metadata.raceKey],
      );
      const localRaceId = existingRace?.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const raceRecord: DbRow = {
        ...artifactRace,
        id: localRaceId,
        race_key: metadata.raceKey,
        name: metadata.name,
        source_file_name: metadata.sourceFileName,
        content_hash: metadata.contentHash,
        race_start_time: metadata.raceStartTime,
        row_count: metadata.rowCount,
        imported_at: artifactRace.imported_at || now,
        updated_at: metadata.updatedAt,
        created_by: artifactRace.created_by || metadata.createdBy || null,
        updated_by: metadata.updatedBy || null,
        sync_workspace_id: metadata.workspaceId || null,
        sync_server_sequence: metadata.serverSequence,
        sync_origin_client_id: null,
        artifact_sha256: metadata.artifactSha256,
        artifact_size_bytes: metadata.artifactSizeBytes,
      };

      this.transaction(() => {
        if (existingRace) {
          this.execute(
            `
              UPDATE races
              SET ${RACE_IMPORT_COLUMNS.filter(
                (column) => column !== 'id' && column !== 'race_key',
              )
                .map((column) => `${column} = ?`)
                .join(', ')}
              WHERE id = ?
            `,
            [
              ...RACE_IMPORT_COLUMNS.filter(
                (column) => column !== 'id' && column !== 'race_key',
              ).map((column) => toSqlValue(raceRecord[column])),
              localRaceId,
            ],
          );
          this.execute('DELETE FROM raw_lap_rows WHERE race_id = ?', [
            localRaceId,
          ]);
          this.execute('DELETE FROM normalized_laps WHERE race_id = ?', [
            localRaceId,
          ]);
        } else {
          this.execute(
            `
              INSERT INTO races (${RACE_IMPORT_COLUMNS.join(', ')})
              VALUES (${RACE_IMPORT_COLUMNS.map(() => '?').join(', ')})
            `,
            RACE_IMPORT_COLUMNS.map((column) => toSqlValue(raceRecord[column])),
          );
        }

        const localRawRows = rawRows.map((row, index) =>
          RACE_ARTIFACT_RAW_ROW_COLUMNS.map((column) => {
            if (column === 'id') {
              return crypto.randomUUID();
            }
            if (column === 'race_id') {
              return localRaceId;
            }
            if (column === 'row_index') {
              return Number(row.row_index ?? index);
            }
            return toSqlValue(row[column]);
          }),
        );
        this.executeMany(
          `
            INSERT INTO raw_lap_rows (${RACE_ARTIFACT_RAW_ROW_COLUMNS.join(', ')})
            VALUES (${RACE_ARTIFACT_RAW_ROW_COLUMNS.map(() => '?').join(', ')})
          `,
          localRawRows,
        );
      });

      this.rebuildNormalizedLaps(this.requireDb());
      await this.persist();
      return localRaceId;
    } finally {
      artifactDatabase?.close();
    }
  }

  async restoreDatabase(bytes: ArrayLike<number>): Promise<void> {
    const incoming = new Uint8Array(bytes);
    let restoredDatabase: SqlJsDatabase | null = null;
    const SQL = this.requireSql();

    try {
      restoredDatabase = new SQL.Database(incoming);

      const hasRacesTable = this.tableExists(restoredDatabase, 'races');
      const hasRawLapRowsTable = this.tableExists(
        restoredDatabase,
        'raw_lap_rows',
      );
      if (!hasRacesTable || !hasRawLapRowsTable) {
        throw new Error(
          'Selected file is not a Lemons Race Viewer SQLite export.',
        );
      }

      const hadNormalizedLapsTable = this.tableExists(
        restoredDatabase,
        'normalized_laps',
      );

      restoredDatabase.run(schemaSql);
      this.applyMigrations(restoredDatabase);

      if (
        !hadNormalizedLapsTable ||
        this.countRows(restoredDatabase, 'normalized_laps') === 0
      ) {
        this.rebuildNormalizedLaps(restoredDatabase);
      }

      this.markRestoredSyncAsReconnectRequired(restoredDatabase);

      const previousDb = this.db;
      this.db = restoredDatabase;
      await this.persist();
      this.storageMode = this.storageMode || 'memory';
      this.markDatabaseAsCustom();

      if (previousDb) {
        previousDb.close();
      }
    } catch (error) {
      if (restoredDatabase) {
        restoredDatabase.close();
      }
      throw error;
    }
  }

  async persist(): Promise<void> {
    const bytes = this.requireDb().export();

    if (await this.writeToOpfs(bytes)) {
      this.storageMode = 'opfs-cache';
      return;
    }

    this.storageMode = 'memory';
  }

  async loadPersistedBytes(): Promise<Uint8Array | null> {
    this.didRefreshBundledDatabase = false;

    const opfsBytes = await this.readFromOpfs();
    if (opfsBytes?.length) {
      const source = this.getStorageSource();
      const storedBundleVersion = this.getStoredBundleVersion();
      const shouldRefreshBundledCopy =
        source === STORAGE_SOURCE_BUNDLE &&
        storedBundleVersion !== DEFAULT_DATABASE_VERSION;

      if (shouldRefreshBundledCopy) {
        await this.deleteFromOpfs();
        this.didRefreshBundledDatabase = true;
      } else {
        this.storageMode = 'opfs-cache';
        return opfsBytes;
      }
    }

    // First-run: fetch bundled default data
    const bundledBytes = await this.fetchBundledDatabaseBytes();
    if (bundledBytes?.length) {
      this.recordBundleSeed(DEFAULT_DATABASE_VERSION);
      this.storageMode = 'memory'; // Will persist to OPFS on next persist()
      return bundledBytes;
    }

    // Empty database (no OPFS, no default file)
    return null;
  }

  async clearPersistedData(): Promise<void> {
    await this.deleteFromOpfs();

    try {
      localStorage.removeItem('lemons-race-viewer-db');
      localStorage.removeItem(STORAGE_SOURCE_KEY);
      localStorage.removeItem(STORAGE_BUNDLE_VERSION_KEY);
    } catch {
      // Ignore storage access failures while clearing data.
    }

    const SQL = this.requireSql();
    this.db = new SQL.Database();
    this.db.run(schemaSql);
    this.applyMigrations(this.db);
    this.storageMode = 'memory';
  }

  async resetToBundledDatabase(): Promise<void> {
    const bundledBytes = await this.fetchBundledDatabaseBytes();
    if (!bundledBytes?.length) {
      throw new Error('Bundled starter data is not available.');
    }

    const SQL = this.requireSql();
    const resetDatabase = new SQL.Database(bundledBytes);
    const previousDb = this.db;

    try {
      resetDatabase.run(schemaSql);
      this.applyMigrations(resetDatabase);
      this.clearBundledOperationalState(resetDatabase);

      this.db = resetDatabase;
      await this.deleteFromOpfs();
      await this.persist();
      this.recordBundleSeed(DEFAULT_DATABASE_VERSION);

      if (previousDb) {
        previousDb.close();
      }
    } catch (error) {
      this.db = previousDb;
      resetDatabase.close();
      throw error;
    }
  }

  markRestoredSyncAsReconnectRequired(database: SqlJsDatabase): void {
    if (!this.tableExists(database, 'sync_config')) {
      return;
    }

    database.run(`
      UPDATE sync_config
      SET status = 'reconnect_required', updated_at = datetime('now')
      WHERE id = 1
    `);
  }

  async readFromOpfs(): Promise<Uint8Array | null> {
    if (
      !('storage' in navigator) ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return null;
    }

    try {
      await navigator.storage.persist?.();
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(DATABASE_FILE_NAME);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async writeToOpfs(bytes: Uint8Array): Promise<boolean> {
    if (
      !('storage' in navigator) ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return false;
    }

    try {
      await navigator.storage.persist?.();
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(DATABASE_FILE_NAME, {
        create: true,
      });
      const writable = await handle.createWritable();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      await writable.write(buffer);
      await writable.close();
      return true;
    } catch {
      return false;
    }
  }

  async deleteFromOpfs(): Promise<void> {
    if (
      !('storage' in navigator) ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return;
    }

    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(DATABASE_FILE_NAME);
    } catch {
      // Ignore if the file does not exist or cannot be deleted.
    }
  }

  markDatabaseAsCustom(): void {
    try {
      localStorage.setItem(STORAGE_SOURCE_KEY, STORAGE_SOURCE_CUSTOM);
    } catch {
      // Ignore localStorage access issues.
    }
  }

  recordBundleSeed(version: string | null): void {
    try {
      localStorage.setItem(STORAGE_SOURCE_KEY, STORAGE_SOURCE_BUNDLE);
      if (version) {
        localStorage.setItem(STORAGE_BUNDLE_VERSION_KEY, version);
      } else {
        localStorage.removeItem(STORAGE_BUNDLE_VERSION_KEY);
      }
    } catch {
      // Ignore localStorage access issues.
    }
  }

  getStorageSource(): string {
    try {
      return localStorage.getItem(STORAGE_SOURCE_KEY) || STORAGE_SOURCE_BUNDLE;
    } catch {
      return STORAGE_SOURCE_BUNDLE;
    }
  }

  getStoredBundleVersion(): string | null {
    try {
      return localStorage.getItem(STORAGE_BUNDLE_VERSION_KEY);
    } catch {
      return null;
    }
  }

  async fetchBundledDatabaseBytes(): Promise<Uint8Array | null> {
    try {
      const response = await fetch(DEFAULT_DATABASE_URL, {
        cache: 'no-store',
      });
      if (!response.ok) {
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      if (!bytes.length) {
        return null;
      }

      return this.sanitizeBundledDatabaseBytes(bytes);
    } catch (error) {
      console.warn('Failed to fetch default-data.sqlite:', error);
      return null;
    }
  }

  sanitizeBundledDatabaseBytes(bytes: Uint8Array): Uint8Array {
    const SQL = this.requireSql();
    const bundledDatabase = new SQL.Database(bytes);

    try {
      bundledDatabase.run(schemaSql);
      this.applyMigrations(bundledDatabase);
      this.clearBundledOperationalState(bundledDatabase);
      return bundledDatabase.export();
    } finally {
      bundledDatabase.close();
    }
  }

  clearBundledOperationalState(database: SqlJsDatabase): void {
    BUNDLED_OPERATIONAL_TABLES.forEach((tableName) => {
      if (this.tableExists(database, tableName)) {
        database.run(`DELETE FROM ${tableName}`);
      }
    });
  }

  private requireDb(): SqlJsDatabase {
    if (!this.db) {
      throw new Error('SQLite database has not been initialized.');
    }

    return this.db;
  }

  private requireSql(): SqlJsStatic {
    if (!this.SQL) {
      throw new Error('SQLite runtime has not been initialized.');
    }

    return this.SQL;
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', body.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

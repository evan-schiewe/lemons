import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import schemaSql from './schema.sql?raw';
import { normalizeRaceData } from '../model/normalizeRaceData.js';

const DATABASE_FILE_NAME = 'lemons-race-viewer.sqlite';

export class SQLiteClient {
    constructor() {
        this.SQL = null;
        this.db = null;
        this.storageMode = 'memory';
    }

    async init() {
        this.SQL = await initSqlJs({
            locateFile: () => sqlWasmUrl,
        });

        const persistedBytes = await this.loadPersistedBytes();
        this.db = persistedBytes?.length ? new this.SQL.Database(persistedBytes) : new this.SQL.Database();
        this.db.run(schemaSql);
        this.applyMigrations(this.db);
        await this.persist();
        return this;
    }

    applyMigrations(database) {
        // Existing persisted databases need explicit ALTERs for new columns.
        const raceColumns = this.queryDatabase(database, 'PRAGMA table_info(races)');
        const hasRaceStartTime = raceColumns.some((column) => column.name === 'race_start_time');
        if (!hasRaceStartTime) {
            database.run('ALTER TABLE races ADD COLUMN race_start_time TEXT');
        }
    }

    queryDatabase(database, sql, params = []) {
        const statement = database.prepare(sql);

        try {
            statement.bind(params);
            const rows = [];
            while (statement.step()) {
                rows.push(statement.getAsObject());
            }
            return rows;
        } finally {
            statement.free();
        }
    }

    query(sql, params = []) {
        return this.queryDatabase(this.db, sql, params);
    }

    queryOne(sql, params = []) {
        return this.query(sql, params)[0] ?? null;
    }

    tableExists(database, tableName) {
        return this.queryDatabase(
            database,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            [tableName],
        ).length > 0;
    }

    countRows(database, tableName) {
        const rows = this.queryDatabase(database, `SELECT COUNT(*) AS count FROM ${tableName}`);
        return Number(rows[0]?.count ?? 0);
    }

    execute(sql, params = []) {
        this.db.run(sql, params);
    }

    executeMany(sql, rows) {
        const statement = this.db.prepare(sql);

        try {
            rows.forEach((params) => {
                statement.run(params);
                statement.reset();
            });
        } finally {
            statement.free();
        }
    }

    executeManyOnDatabase(database, sql, rows) {
        const statement = database.prepare(sql);

        try {
            rows.forEach((params) => {
                statement.run(params);
                statement.reset();
            });
        } finally {
            statement.free();
        }
    }

    rebuildNormalizedLaps(database) {
        const races = this.queryDatabase(database, 'SELECT id FROM races ORDER BY rowid');
        if (!races.length) {
            return;
        }

        const insertSql = `
        INSERT INTO normalized_laps (
                    id, race_id, raw_row_id, lap_identity, lap_number, driver_name,
          lap_time_ms, lap_time_text, position_value, speed_mph, gap_ahead_ms, gap_ahead_laps,
          gap_ahead_display, gap_leader_ms, gap_leader_laps, gap_leader_display,
          rolling_median_ms, is_pit_candidate, is_repair_candidate, is_outlier, is_green_flag,
          search_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

        const rebuiltRows = [];

        database.run('BEGIN');

        try {
            database.run('DELETE FROM normalized_laps');

            races.forEach((race) => {
                const rawRows = this.queryDatabase(
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

                const parsedRows = rawRows.map((row, index) => ({
                    rowIndex: index,
                    csvRowNumber: row.csv_row_number,
                    rawLine: row.raw_line,
                    rawCells: [
                        row.raw_lap,
                        row.raw_entry,
                        row.raw_driver,
                        row.raw_lap_time,
                        row.raw_position,
                        row.raw_speed,
                        row.raw_gap_ahead,
                        row.raw_gap_leader,
                    ],
                    values: {
                        lap: row.raw_lap ?? '',
                        team_slot: row.raw_entry ?? '',
                        driver: row.raw_driver ?? '',
                        lap_time: row.raw_lap_time ?? '',
                        position: row.raw_position ?? '',
                        speed: row.raw_speed ?? '',
                        gap_ahead: row.raw_gap_ahead ?? '',
                        gap_leader: row.raw_gap_leader ?? '',
                    },
                }));

                const normalized = normalizeRaceData(parsedRows);

                normalized.laps.forEach((lap) => {
                    const sourceRow = rawRows[lap.rowIndex];
                    rebuiltRows.push([
                        crypto.randomUUID(),
                        race.id,
                        sourceRow?.id ?? null,
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
                        lap.isPitCandidate ? 1 : 0,
                        lap.isRepairCandidate ? 1 : 0,
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

    transaction(work) {
        this.db.run('BEGIN');
        try {
            const result = work();
            this.db.run('COMMIT');
            return result;
        } catch (error) {
            this.db.run('ROLLBACK');
            throw error;
        }
    }

    exportDatabase() {
        return this.db.export();
    }

    async restoreDatabase(bytes) {
        const incoming = new Uint8Array(bytes);
        let restoredDatabase = null;

        try {
            restoredDatabase = new this.SQL.Database(incoming);

            const hasRacesTable = this.tableExists(restoredDatabase, 'races');
            const hasRawLapRowsTable = this.tableExists(restoredDatabase, 'raw_lap_rows');
            if (!hasRacesTable || !hasRawLapRowsTable) {
                throw new Error('Selected file is not a Lemons Race Viewer SQLite export.');
            }

            const hadNormalizedLapsTable = this.tableExists(restoredDatabase, 'normalized_laps');

            restoredDatabase.run(schemaSql);
            this.applyMigrations(restoredDatabase);

            if (!hadNormalizedLapsTable || this.countRows(restoredDatabase, 'normalized_laps') === 0) {
                this.rebuildNormalizedLaps(restoredDatabase);
            }

            const previousDb = this.db;
            this.db = restoredDatabase;
            await this.persist();
            this.storageMode = this.storageMode || 'memory';

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

    async persist() {
        const bytes = this.db.export();

        if (await this.writeToOpfs(bytes)) {
            this.storageMode = 'opfs-cache';
            return;
        }

        this.storageMode = 'memory';
    }

    async loadPersistedBytes() {
        const opfsBytes = await this.readFromOpfs();
        if (opfsBytes?.length) {
            this.storageMode = 'opfs-cache';
            return opfsBytes;
        }

        return null;
    }

    async clearPersistedData() {
        await this.deleteFromOpfs();

        try {
            localStorage.removeItem('lemons-race-viewer-db');
        } catch {
            // Ignore storage access failures while clearing data.
        }

        this.db = new this.SQL.Database();
        this.db.run(schemaSql);
        this.applyMigrations(this.db);
        this.storageMode = 'memory';
    }

    async readFromOpfs() {
        if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
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

    async writeToOpfs(bytes) {
        if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
            return false;
        }

        try {
            await navigator.storage.persist?.();
            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(DATABASE_FILE_NAME, { create: true });
            const writable = await handle.createWritable();
            await writable.write(bytes);
            await writable.close();
            return true;
        } catch {
            return false;
        }
    }

    async deleteFromOpfs() {
        if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
            return;
        }

        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(DATABASE_FILE_NAME);
        } catch {
            // Ignore if the file does not exist or cannot be deleted.
        }
    }
}
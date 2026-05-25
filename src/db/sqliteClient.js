import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import schemaSql from './schema.sql?raw';

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

            const tables = this.queryDatabase(
                restoredDatabase,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('races', 'raw_lap_rows', 'normalized_laps')",
            );
            if (tables.length < 3) {
                throw new Error('Selected file is not a Lemons Race Viewer SQLite export.');
            }

            restoredDatabase.run(schemaSql);
            this.applyMigrations(restoredDatabase);

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
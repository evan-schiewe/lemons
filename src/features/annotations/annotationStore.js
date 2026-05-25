const TABLE_CONFIG = {
    lapNote: {
        table: 'lap_notes',
        fields: ['race_id', 'lap_number', 'car_number', 'driver_name', 'note_text', 'color', 'created_at', 'updated_at'],
    },
    taggedIncident: {
        table: 'tagged_incidents',
        fields: ['race_id', 'lap_number', 'title', 'tag', 'color', 'details', 'created_at', 'updated_at'],
    },
    rangeEvent: {
        table: 'range_events',
        fields: ['race_id', 'start_lap', 'end_lap', 'title', 'tag', 'color', 'details', 'created_at', 'updated_at'],
    },
    driverStint: {
        table: 'driver_stints',
        fields: ['race_id', 'driver_name', 'car_number', 'start_lap', 'end_lap', 'color', 'notes', 'created_at', 'updated_at'],
    },
};

export function createAnnotationStore(db) {
    return {
        async save(kind, payload) {
            const config = TABLE_CONFIG[kind];
            if (!config) {
                throw new Error(`Unknown annotation kind: ${kind}`);
            }

            const now = new Date().toISOString();
            const id = payload.id || crypto.randomUUID();
            const existing = payload.id
                ? db.queryOne(`SELECT id, created_at FROM ${config.table} WHERE id = ?`, [payload.id])
                : null;

            const record = {
                ...payload,
                id,
                created_at: existing?.created_at || now,
                updated_at: now,
            };

            if (existing) {
                const updateFields = config.fields.filter((field) => field !== 'created_at');
                db.execute(
                    `UPDATE ${config.table} SET ${updateFields.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`,
                    [...updateFields.map((field) => record[field] ?? null), id],
                );
            } else {
                db.execute(
                    `
            INSERT INTO ${config.table} (id, ${config.fields.join(', ')})
            VALUES (?, ${config.fields.map(() => '?').join(', ')})
          `,
                    [id, ...config.fields.map((field) => record[field] ?? null)],
                );
            }

            await db.persist();
            return id;
        },
        async remove(kind, id) {
            const config = TABLE_CONFIG[kind];
            if (!config) {
                throw new Error(`Unknown annotation kind: ${kind}`);
            }

            db.execute(`DELETE FROM ${config.table} WHERE id = ?`, [id]);
            await db.persist();
        },
    };
}
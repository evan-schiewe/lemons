const TABLE_CONFIG = {
  lapNote: {
    table: 'lap_notes',
    fields: [
      'race_id',
      'lap_number',
      'driver_name',
      'note_text',
      'color',
      'created_at',
      'updated_at',
    ],
  },
  taggedIncident: {
    table: 'tagged_incidents',
    fields: [
      'race_id',
      'lap_number',
      'title',
      'tag',
      'color',
      'details',
      'created_at',
      'updated_at',
    ],
  },
  rangeEvent: {
    table: 'range_events',
    fields: [
      'race_id',
      'start_lap',
      'end_lap',
      'title',
      'tag',
      'color',
      'details',
      'created_at',
      'updated_at',
    ],
  },
  driverStint: {
    table: 'driver_stints',
    fields: [
      'race_id',
      'driver_name',
      'start_lap',
      'end_lap',
      'color',
      'notes',
      'created_at',
      'updated_at',
    ],
  },
  journalEntry: {
    table: 'journal_entries',
    fields: [
      'race_id',
      'lap_number',
      'event_time_iso',
      'event_time_source',
      'title',
      'entry_text',
      'color',
      'created_at',
      'updated_at',
    ],
  },
};

function ensurePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a whole lap number greater than 0.`);
  }
}

function validateAnnotationPayload(kind, payload) {
  if (kind === 'taggedIncident' || kind === 'lapNote') {
    ensurePositiveInteger(payload.lap_number, 'Lap');
  }

  if (kind === 'rangeEvent' || kind === 'driverStint') {
    ensurePositiveInteger(payload.start_lap, 'Start lap');
    ensurePositiveInteger(payload.end_lap, 'End lap');

    if (payload.end_lap < payload.start_lap) {
      throw new Error('End lap must be greater than or equal to start lap.');
    }
  }

  if (kind === 'journalEntry') {
    const hasLap =
      Number.isInteger(payload.lap_number) && payload.lap_number > 0;
    const hasEventTimeIso =
      typeof payload.event_time_iso === 'string' &&
      payload.event_time_iso.trim().length > 0;

    if (payload.lap_number != null && payload.lap_number !== '') {
      ensurePositiveInteger(payload.lap_number, 'Lap');
    }

    if (!hasLap && !hasEventTimeIso) {
      throw new Error(
        'Journal entries require a lap number, a timestamp, or both.',
      );
    }

    if (
      hasEventTimeIso &&
      Number.isNaN(new Date(payload.event_time_iso).getTime())
    ) {
      throw new Error('Journal timestamp must be a valid date/time.');
    }

    const text = `${payload.entry_text ?? ''}`.trim();
    if (!text) {
      throw new Error('Journal entry text is required.');
    }
  }
}

export function createAnnotationStore(db) {
  return {
    async save(kind, payload) {
      const config = TABLE_CONFIG[kind];
      if (!config) {
        throw new Error(`Unknown annotation kind: ${kind}`);
      }

      validateAnnotationPayload(kind, payload);

      const now = new Date().toISOString();
      const id = payload.id || crypto.randomUUID();
      const existing = payload.id
        ? db.queryOne(
            `SELECT id, created_at FROM ${config.table} WHERE id = ?`,
            [payload.id],
          )
        : null;

      const record = {
        ...payload,
        id,
        ...(kind === 'journalEntry'
          ? {
              event_time_source:
                payload.event_time_source ||
                (payload.event_time_iso ? 'manual' : 'lap'),
            }
          : {}),
        created_at: existing?.created_at || now,
        updated_at: now,
      };

      if (existing) {
        const updateFields = config.fields.filter(
          (field) => field !== 'created_at',
        );
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

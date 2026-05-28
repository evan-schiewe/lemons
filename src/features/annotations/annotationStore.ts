import type { SQLiteClient } from '../../db/sqliteClient';
import type {
  AnnotationKind,
  AnnotationPayload,
  AnnotationStore,
  SqlValue,
} from '../../types';

export interface AnnotationTableConfig {
  table: string;
  fields: string[];
}

export const ANNOTATION_TABLE_CONFIG = {
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
} satisfies Record<AnnotationKind, AnnotationTableConfig>;

function ensurePositiveInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a whole lap number greater than 0.`);
  }
}

function validateAnnotationPayload(
  kind: AnnotationKind,
  payload: AnnotationPayload,
): void {
  if (kind === 'taggedIncident' || kind === 'lapNote') {
    ensurePositiveInteger(payload.lap_number, 'Lap');
  }

  if (kind === 'rangeEvent' || kind === 'driverStint') {
    ensurePositiveInteger(payload.start_lap, 'Start lap');
    ensurePositiveInteger(payload.end_lap, 'End lap');

    if (Number(payload.end_lap) < Number(payload.start_lap)) {
      throw new Error('End lap must be greater than or equal to start lap.');
    }
  }

  if (kind === 'journalEntry') {
    const hasLap =
      typeof payload.lap_number === 'number' &&
      Number.isInteger(payload.lap_number) &&
      payload.lap_number > 0;
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
      typeof payload.event_time_iso === 'string' &&
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

export function createAnnotationStore(db: SQLiteClient): AnnotationStore {
  return {
    async save(kind: AnnotationKind, payload: AnnotationPayload) {
      const config = ANNOTATION_TABLE_CONFIG[kind];

      validateAnnotationPayload(kind, payload);

      const now = new Date().toISOString();
      const id =
        typeof payload.id === 'string' && payload.id
          ? payload.id
          : crypto.randomUUID();
      const existing = payload.id
        ? db.queryOne<{ id: string; created_at: string }>(
            `SELECT id, created_at FROM ${config.table} WHERE id = ?`,
            [id],
          )
        : null;

      const record: AnnotationPayload = {
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
          `
            UPDATE ${config.table}
            SET
              ${updateFields.map((field) => `${field} = ?`).join(', ')},
              updated_by = NULL,
              sync_server_sequence = NULL,
              sync_origin_client_id = NULL
            WHERE id = ?
          `,
          [...updateFields.map((field) => toSqlValue(record[field])), id],
        );
      } else {
        db.execute(
          `
            INSERT INTO ${config.table} (id, ${config.fields.join(', ')})
            VALUES (?, ${config.fields.map(() => '?').join(', ')})
          `,
          [id, ...config.fields.map((field) => toSqlValue(record[field]))],
        );
      }

      await db.persist();
      return id;
    },
    async remove(kind: AnnotationKind, id: string) {
      const config = ANNOTATION_TABLE_CONFIG[kind];

      db.execute(`DELETE FROM ${config.table} WHERE id = ?`, [id]);
      await db.persist();
    },
  };
}

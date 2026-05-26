import type { SQLiteClient } from '../../db/sqliteClient';
import { downloadBlob, slugify } from '../../utils/format';
import { getRaceSnapshot } from '../query/raceQueries';

export function exportAnnotationsFile(db: SQLiteClient, raceId: string): void {
  const snapshot = getRaceSnapshot(db, raceId);
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, `${slugify(snapshot.race?.name || 'lemons-race')}.json`);
}

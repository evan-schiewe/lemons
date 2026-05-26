import type { SQLiteClient } from '../../db/sqliteClient';
import { downloadBlob, slugify } from '../../utils/format';

export function exportDatabaseFile(db: SQLiteClient, raceName: string): void {
  const bytes = db.exportDatabase();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: 'application/x-sqlite3' });
  downloadBlob(blob, `${slugify(raceName)}.sqlite`);
}

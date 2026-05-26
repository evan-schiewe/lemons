import { downloadBlob, slugify } from '../../utils/format.js';

export function exportDatabaseFile(db, raceName) {
  const bytes = db.exportDatabase();
  const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
  downloadBlob(blob, `${slugify(raceName)}.sqlite`);
}

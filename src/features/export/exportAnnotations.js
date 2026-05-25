import { downloadBlob, slugify } from '../../utils/format.js';
import { getRaceSnapshot } from '../query/raceQueries.js';

export function exportAnnotationsFile(db, raceId) {
    const snapshot = getRaceSnapshot(db, raceId);
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: 'application/json',
    });
    downloadBlob(blob, `${slugify(snapshot.race?.name || 'lemons-race')}.json`);
}
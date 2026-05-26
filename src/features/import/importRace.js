import { loadCsvFile } from '../../import/csvLoader.js';
import { parseRaceCsv } from '../../import/parseRaceCsv.js';
import { normalizeRaceData } from '../../model/normalizeRaceData.js';

export async function importRace(db, file, options = {}) {
    const loadedFile = await loadCsvFile(file);
    const parsedCsv = parseRaceCsv(loadedFile.text);
    const normalized = normalizeRaceData(parsedCsv.rows);
    const timestamp = new Date().toISOString();
    const raceKey = `race-${loadedFile.contentHash}`;
    const existingRace = db.queryOne('SELECT id, race_start_time FROM races WHERE race_key = ?', [raceKey]);
    const raceId = existingRace?.id ?? crypto.randomUUID();
    const raceStartTime = options.raceStartTime === undefined ? (existingRace?.race_start_time ?? null) : options.raceStartTime;

    db.transaction(() => {
        if (existingRace) {
            db.execute(
                `
          UPDATE races
          SET name = ?, source_file_name = ?, content_hash = ?, race_start_time = ?, row_count = ?, updated_at = ?
          WHERE id = ?
        `,
                [loadedFile.raceName, loadedFile.fileName, loadedFile.contentHash, raceStartTime, normalized.laps.length, timestamp, raceId],
            );
            db.execute('DELETE FROM raw_lap_rows WHERE race_id = ?', [raceId]);
            db.execute('DELETE FROM normalized_laps WHERE race_id = ?', [raceId]);
        } else {
            db.execute(
                `
          INSERT INTO races (id, race_key, name, source_file_name, content_hash, race_start_time, row_count, imported_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
                [
                    raceId,
                    raceKey,
                    loadedFile.raceName,
                    loadedFile.fileName,
                    loadedFile.contentHash,
                    raceStartTime,
                    normalized.laps.length,
                    timestamp,
                    timestamp,
                ],
            );
        }

        const rawRows = parsedCsv.rows.map((row) => {
            const rawRowId = crypto.randomUUID();
            return {
                rawRowId,
                values: [
                    rawRowId,
                    raceId,
                    row.rowIndex,
                    row.csvRowNumber,
                    row.rawLine,
                    row.values.lap,
                    row.values.team_slot,
                    row.values.driver,
                    row.values.lap_time,
                    row.values.position,
                    row.values.speed,
                    row.values.gap_ahead,
                    row.values.gap_leader,
                ],
            };
        });

        db.executeMany(
            `
        INSERT INTO raw_lap_rows (
                    id, race_id, row_index, csv_row_number, raw_line, raw_lap, raw_entry, raw_driver,
          raw_lap_time, raw_position, raw_speed, raw_gap_ahead, raw_gap_leader
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            rawRows.map((row) => row.values),
        );

        db.executeMany(
            `
        INSERT INTO normalized_laps (
                    id, race_id, raw_row_id, lap_identity, lap_number, driver_name,
          lap_time_ms, lap_time_text, position_value, speed_mph, gap_ahead_ms, gap_ahead_laps,
          gap_ahead_display, gap_leader_ms, gap_leader_laps, gap_leader_display,
          rolling_median_ms, is_outlier, is_green_flag,
          search_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            normalized.laps.map((lap) => {
                const rawRow = rawRows[lap.rowIndex];
                return [
                    crypto.randomUUID(),
                    raceId,
                    rawRow?.rawRowId ?? null,
                    `${raceId}:${lap.lapNumber}:${lap.driverName}:${lap.lapTimeText}`,
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
                ];
            }),
        );
    });

    await db.persist();

    return {
        raceId,
        raceName: loadedFile.raceName,
        rowCount: normalized.laps.length,
        warnings: parsedCsv.warnings,
        stats: normalized.stats,
    };
}
import { formatWallClock } from '../../utils/time.js';

const SORTABLE_COLUMNS = {
    lap_number: 'lap_number',
    lap_start_offset_ms: 'lap_start_offset_ms',
    driver_name: 'display_driver_name',
    lap_time_ms: 'lap_time_ms',
    position_value: 'position_value',
    speed_mph: 'speed_mph',
    gap_ahead_display: 'gap_ahead_display',
    gap_leader_display: 'gap_leader_display',
};

export function getRaceList(db) {
    return db.query(
        `
      SELECT id, name, source_file_name, race_start_time, row_count, imported_at, updated_at
      FROM races
      ORDER BY updated_at DESC
    `,
    );
}

export function updateRaceStartTime(db, raceId, raceStartTime) {
    const timestamp = new Date().toISOString();
    db.execute(
        `
      UPDATE races
      SET race_start_time = ?, updated_at = ?
      WHERE id = ?
    `,
        [raceStartTime, timestamp, raceId],
    );
}

export function getDriverOptions(db, raceId) {
    return db.query(
        `
      SELECT DISTINCT ${resolvedDriverNameSql('nl')} AS driver_name
            FROM normalized_laps nl
      WHERE nl.race_id = ? AND COALESCE(${resolvedDriverNameSql('nl')}, '') <> ''
      ORDER BY driver_name
    `,
        [raceId],
    ).map((row) => row.driver_name);
}

export function getLapTableRows(db, raceId, filters, sort) {
    const { whereSql, params } = buildLapFilterSql(raceId, filters, 'race_laps', false);
    const orderBy = SORTABLE_COLUMNS[sort.column] ?? 'lap_number';
    const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';

    return db.query(
        `
            WITH race_laps AS (
                SELECT
                    nl.*,
                    ${resolvedDriverNameSql('nl')} AS display_driver_name,
                    COALESCE(
                        SUM(COALESCE(nl.lap_time_ms, 0)) OVER (
                            PARTITION BY nl.race_id
                            ORDER BY nl.lap_number ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                        ),
                        0
                    ) AS lap_start_offset_ms,
                    COALESCE(ln.note_count, 0) AS note_count,
                    COALESCE(ti.incident_count, 0) AS incident_count
                FROM normalized_laps nl
                LEFT JOIN (
                    SELECT race_id, lap_number, COUNT(*) AS note_count
                    FROM lap_notes
                    GROUP BY race_id, lap_number
                ) ln ON ln.race_id = nl.race_id AND ln.lap_number = nl.lap_number
                LEFT JOIN (
                    SELECT race_id, lap_number, COUNT(*) AS incident_count
                    FROM tagged_incidents
                    GROUP BY race_id, lap_number
                ) ti ON ti.race_id = nl.race_id AND ti.lap_number = nl.lap_number
                WHERE nl.race_id = ?
            )
            SELECT *
            FROM race_laps
            ${whereSql}
            ORDER BY ${orderBy} ${direction}, lap_number ASC
    `,
        [raceId, ...params],
    );
}

export function getLapSeries(db, raceId, filters) {
    const { whereSql, params } = buildLapFilterSql(raceId, filters);
    return db.query(
        `
      SELECT
        id,
        lap_number,
        driver_name,
        lap_time_ms,
        position_value,
        speed_mph,
        gap_ahead_ms,
        gap_ahead_laps,
        gap_ahead_display,
        gap_leader_ms,
        gap_leader_laps,
        gap_leader_display,
        is_outlier,
        is_green_flag,
        is_pit_candidate,
        is_repair_candidate
      FROM normalized_laps
      ${whereSql}
            ORDER BY lap_number ASC
    `,
        params,
    );
}

export function getSummary(db, raceId, filters) {
    const { whereSql, params } = buildLapFilterSql(raceId, filters);
    const aggregate = db.queryOne(
        `
      SELECT
        COUNT(*) AS total_laps,
        MIN(lap_time_ms) AS best_lap_ms,
        AVG(CASE WHEN is_green_flag = 1 THEN lap_time_ms END) AS avg_green_ms,
        SUM(CASE WHEN is_outlier = 1 THEN 1 ELSE 0 END) AS long_lap_outliers,
        SUM(CASE WHEN is_pit_candidate = 1 OR is_repair_candidate = 1 THEN 1 ELSE 0 END) AS pit_repair_candidates,
        MIN(position_value) AS best_position,
        MAX(position_value) AS worst_position
      FROM normalized_laps
      ${whereSql}
    `,
        params,
    );

    const raceCounts = db.queryOne(
        `
      SELECT
        (SELECT COUNT(*) FROM lap_notes WHERE race_id = ?) AS lap_note_count,
        (SELECT COUNT(*) FROM tagged_incidents WHERE race_id = ?) AS incident_count,
        (SELECT COUNT(*) FROM range_events WHERE race_id = ?) AS range_event_count,
        (SELECT COUNT(*) FROM driver_stints WHERE race_id = ?) AS stint_count
    `,
        [raceId, raceId, raceId, raceId],
    );

    return { ...aggregate, ...raceCounts };
}

export function getRaceAnnotations(db, raceId) {
    return {
        lapNotes: db.query(
            'SELECT * FROM lap_notes WHERE race_id = ? ORDER BY lap_number ASC, updated_at DESC',
            [raceId],
        ),
        taggedIncidents: db.query(
            'SELECT * FROM tagged_incidents WHERE race_id = ? ORDER BY lap_number ASC, updated_at DESC',
            [raceId],
        ),
        rangeEvents: db.query(
            'SELECT * FROM range_events WHERE race_id = ? ORDER BY start_lap ASC, updated_at DESC',
            [raceId],
        ),
        driverStints: db.query(
            'SELECT * FROM driver_stints WHERE race_id = ? ORDER BY start_lap ASC, updated_at DESC',
            [raceId],
        ),
    };
}

/**
 * Get combined candidates (pit + repair + outlier) for the active race.
 * Sorted by lap_number, id for deterministic traversal.
 * Returns basic lap data plus candidate type flags.
 */
export function getCandidates(db, raceId) {
    return db.query(
        `
      SELECT
        id,
        lap_number,
        driver_name,
        lap_time_ms,
        position_value,
        speed_mph,
        gap_ahead_ms,
        gap_ahead_laps,
        gap_ahead_display,
        gap_leader_ms,
        gap_leader_laps,
        gap_leader_display,
        is_outlier,
        is_green_flag,
        is_pit_candidate,
        is_repair_candidate,
        CASE
          WHEN is_repair_candidate = 1 THEN 'repair'
          WHEN is_pit_candidate = 1 THEN 'pit'
          WHEN is_outlier = 1 THEN 'outlier'
          ELSE 'unknown'
        END AS candidate_type
      FROM normalized_laps
      WHERE race_id = ? AND (is_pit_candidate = 1 OR is_repair_candidate = 1 OR is_outlier = 1)
      ORDER BY lap_number ASC, id ASC
    `,
        [raceId],
    );
}

/**
 * Infer reviewed status for a candidate based on existing annotations and driver changes.
 * A candidate is considered reviewed if it has:
 * - A driver change at the candidate lap (stint boundary), OR
 * - A lap note with REVIEWED_NO_ACTION prefix, OR
 * - A tagged incident on the same lap, OR
 * - A range event covering the lap, OR
 * - A driver stint covering the lap
 */
export function inferCandidateReviewedStatus(candidate, annotations, db, raceId) {
    const { lap_number, driver_name } = candidate;

    // Check for driver change at this lap (stint boundary)
    if (db && raceId && lap_number > 1) {
        const previousLap = db.queryOne(
            `SELECT driver_name FROM normalized_laps WHERE race_id = ? AND lap_number = ? ORDER BY lap_number DESC LIMIT 1`,
            [raceId, lap_number - 1],
        );
        if (previousLap && previousLap.driver_name !== driver_name) {
            return { isReviewed: true, source: 'driverChange' };
        }
    }

    // Check for REVIEWED_NO_ACTION lap note
    const hasReviewedNote = annotations.lapNotes.some(
        (note) => note.lap_number === lap_number && note.note_text.startsWith('REVIEWED_NO_ACTION'),
    );
    if (hasReviewedNote) {
        return { isReviewed: true, source: 'lapNote' };
    }

    // Check for tagged incident on same lap
    const hasIncident = annotations.taggedIncidents.some((incident) => incident.lap_number === lap_number);
    if (hasIncident) {
        return { isReviewed: true, source: 'taggedIncident' };
    }

    // Check for range event covering lap
    const hasRangeEvent = annotations.rangeEvents.some(
        (event) => event.start_lap <= lap_number && lap_number <= event.end_lap,
    );
    if (hasRangeEvent) {
        return { isReviewed: true, source: 'rangeEvent' };
    }

    // Check for driver stint covering lap
    const hasStint = annotations.driverStints.some(
        (stint) =>
            stint.start_lap <= lap_number &&
            lap_number <= stint.end_lap,
    );
    if (hasStint) {
        return { isReviewed: true, source: 'driverStint' };
    }

    return { isReviewed: false, source: null };
}

/**
 * Augment candidate with reviewed inference status.
 * Merges candidate data with reviewed status and source.
 */
export function augmentCandidateWithReviewStatus(candidate, annotations, db, raceId) {
    const reviewStatus = inferCandidateReviewedStatus(candidate, annotations, db, raceId);
    return {
        ...candidate,
        ...reviewStatus,
    };
}

export function getRaceSnapshot(db, raceId) {
    const race = db.queryOne('SELECT * FROM races WHERE id = ?', [raceId]);
    const laps = db.query(
        `
      SELECT
        nl.*,
                COALESCE(
                    SUM(COALESCE(nl.lap_time_ms, 0)) OVER (
                        PARTITION BY nl.race_id
                        ORDER BY nl.lap_number ASC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                    ),
                    0
                ) AS lap_start_offset_ms
      FROM normalized_laps nl
      WHERE nl.race_id = ?
            ORDER BY nl.lap_number ASC
    `,
        [raceId],
    ).map((lap) => {
        const raceStartIso = race?.race_start_time ?? null;
        const lapStartOffsetMs = Number.isFinite(lap.lap_start_offset_ms) ? lap.lap_start_offset_ms : null;
        const lapStartIso = buildLapStartIso(raceStartIso, lapStartOffsetMs);

        return {
            ...lap,
            lap_start_wall_clock: formatWallClock(raceStartIso, lapStartOffsetMs),
            lap_start_iso: lapStartIso,
        };
    });

    return {
        race,
        laps,
        annotations: getRaceAnnotations(db, raceId),
    };
}

function buildLapStartIso(raceStartIso, lapStartOffsetMs) {
    if (!raceStartIso || !Number.isFinite(lapStartOffsetMs)) {
        return null;
    }

    const raceStart = new Date(raceStartIso);
    if (Number.isNaN(raceStart.getTime())) {
        return null;
    }

    return new Date(raceStart.getTime() + lapStartOffsetMs).toISOString();
}

function buildLapFilterSql(raceId, filters, alias = '', includeRaceId = true) {
    const prefix = alias ? `${alias}.` : '';
    const conditions = [];
    const params = [];

    if (includeRaceId) {
        conditions.push(`${prefix}race_id = ?`);
        params.push(raceId);
    }

    if (filters.driver) {
        conditions.push(`${resolvedDriverNameSql(alias)} = ?`);
        params.push(filters.driver);
    }

    if (filters.search) {
        conditions.push(`${prefix}search_text LIKE ?`);
        params.push(`%${filters.search.toLowerCase()}%`);
    }

    if (Number.isFinite(filters.lapMin)) {
        conditions.push(`${prefix}lap_number >= ?`);
        params.push(filters.lapMin);
    }

    if (Number.isFinite(filters.lapMax)) {
        conditions.push(`${prefix}lap_number <= ?`);
        params.push(filters.lapMax);
    }

    if (!conditions.length) {
        return {
            whereSql: '',
            params,
        };
    }

    return {
        whereSql: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
}

function resolvedDriverNameSql(alias = '') {
    const prefix = alias ? `${alias}.` : '';
    return `COALESCE((SELECT ds.driver_name FROM driver_stints ds WHERE ds.race_id = ${prefix}race_id AND ${prefix}lap_number BETWEEN ds.start_lap AND ds.end_lap ORDER BY ds.updated_at DESC, ds.start_lap DESC LIMIT 1), ${prefix}driver_name)`;
}
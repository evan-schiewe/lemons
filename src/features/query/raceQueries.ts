import { ANNOTATION_COLOR_TOKENS } from '../../app/theme';
import type { SQLiteClient } from '../../db/sqliteClient';
import type {
  CandidateLap,
  DriverStint,
  JournalEntry,
  LapFilters,
  LapNote,
  LapRow,
  RaceAnnotations,
  RaceRecord,
  RaceSnapshot,
  RangeEvent,
  SortColumn,
  SortState,
  SqlParams,
  SummaryRow,
  TaggedIncident,
  TimelineEvent,
} from '../../types';
import { formatWallClock } from '../../utils/time';

const SORTABLE_COLUMNS: Partial<Record<SortColumn, string>> = {
  lap_number: 'lap_number',
  lap_start_offset_ms: 'lap_start_offset_ms',
  driver_name: 'display_driver_name',
  lap_time_ms: 'lap_time_ms',
  position_value: 'position_value',
  speed_mph: 'speed_mph',
  gap_ahead_display: 'gap_ahead_display',
  gap_leader_display: 'gap_leader_display',
};

export function getRaceList(db: SQLiteClient): RaceRecord[] {
  return db.query<RaceRecord>(
    `
      SELECT id, race_key, name, source_file_name, race_start_time, row_count, imported_at, updated_at
      FROM races
      ORDER BY updated_at DESC
    `,
  );
}

export function getDriverOptions(db: SQLiteClient, raceId: string): string[] {
  return db
    .query<{ driver_name: string }>(
      `
      SELECT DISTINCT ${resolvedDriverNameSql('nl')} AS driver_name
            FROM normalized_laps nl
      WHERE nl.race_id = ? AND COALESCE(${resolvedDriverNameSql('nl')}, '') <> ''
      ORDER BY driver_name
    `,
      [raceId],
    )
    .map((row) => row.driver_name);
}

export function getLapTableRows(
  db: SQLiteClient,
  raceId: string,
  filters: LapFilters,
  sort: SortState,
): LapRow[] {
  const { whereSql, params } = buildLapFilterSql(
    raceId,
    filters,
    'race_laps',
    false,
  );
  const orderBy = SORTABLE_COLUMNS[sort.column] ?? 'lap_number';
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';

  return db.query<LapRow>(
    `
            WITH race_laps AS (
                SELECT
                    nl.*,
                    ${resolvedDriverNameSql('nl')} AS display_driver_name,
                    LEAD(${resolvedDriverNameSql('nl')}) OVER (
                        PARTITION BY nl.race_id
                        ORDER BY nl.lap_number ASC
                    ) AS next_display_driver_name,
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
            SELECT
                race_laps.*,
                CASE
                    WHEN race_laps.next_display_driver_name IS NOT NULL
                        AND COALESCE(race_laps.display_driver_name, '') <> ''
                        AND race_laps.display_driver_name <> race_laps.next_display_driver_name
                    THEN 1
                    ELSE 0
                END AS is_pit_lap
            FROM race_laps
            ${whereSql}
            ORDER BY ${orderBy} ${direction}, lap_number ASC
    `,
    [raceId, ...params],
  );
}

export function getLapSeries(
  db: SQLiteClient,
  raceId: string,
  filters: LapFilters,
): LapRow[] {
  const { whereSql, params } = buildLapFilterSql(raceId, filters);
  return db.query<LapRow>(
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
        is_green_flag
      FROM normalized_laps
      ${whereSql}
            ORDER BY lap_number ASC
    `,
    params,
  );
}

export function getSummary(
  db: SQLiteClient,
  raceId: string,
  filters: LapFilters,
): SummaryRow {
  const { whereSql, params } = buildLapFilterSql(raceId, filters);
  const aggregate = db.queryOne<SummaryRow>(
    `
      SELECT
        COUNT(*) AS total_laps,
        MIN(lap_time_ms) AS best_lap_ms,
        AVG(CASE WHEN is_green_flag = 1 THEN lap_time_ms END) AS avg_green_ms,
        SUM(CASE WHEN is_outlier = 1 THEN 1 ELSE 0 END) AS long_lap_outliers,
        MIN(position_value) AS best_position,
        MAX(position_value) AS worst_position
      FROM normalized_laps
      ${whereSql}
    `,
    params,
  );

  const raceCounts = db.queryOne<SummaryRow>(
    `
      SELECT
        (SELECT COUNT(*) FROM lap_notes WHERE race_id = ?) AS lap_note_count,
        (SELECT COUNT(*) FROM tagged_incidents WHERE race_id = ?) AS incident_count,
        (SELECT COUNT(*) FROM range_events WHERE race_id = ?) AS range_event_count,
        (SELECT COUNT(*) FROM driver_stints WHERE race_id = ?) AS stint_count,
        (SELECT COUNT(*) FROM journal_entries WHERE race_id = ?) AS journal_count
    `,
    [raceId, raceId, raceId, raceId, raceId],
  );

  return {
    total_laps: 0,
    best_lap_ms: null,
    avg_green_ms: null,
    long_lap_outliers: 0,
    best_position: null,
    worst_position: null,
    lap_note_count: 0,
    incident_count: 0,
    range_event_count: 0,
    stint_count: 0,
    journal_count: 0,
    ...aggregate,
    ...raceCounts,
  };
}

export function getRaceAnnotations(
  db: SQLiteClient,
  raceId: string,
): RaceAnnotations {
  return {
    lapNotes: db.query<LapNote>(
      'SELECT * FROM lap_notes WHERE race_id = ? ORDER BY lap_number ASC, updated_at DESC',
      [raceId],
    ),
    taggedIncidents: db.query<TaggedIncident>(
      'SELECT * FROM tagged_incidents WHERE race_id = ? ORDER BY lap_number ASC, updated_at DESC',
      [raceId],
    ),
    rangeEvents: db.query<RangeEvent>(
      'SELECT * FROM range_events WHERE race_id = ? ORDER BY start_lap ASC, updated_at DESC',
      [raceId],
    ),
    driverStints: db.query<DriverStint>(
      'SELECT * FROM driver_stints WHERE race_id = ? ORDER BY start_lap ASC, updated_at DESC',
      [raceId],
    ),
    journalEntries: db.query<JournalEntry>(
      'SELECT * FROM journal_entries WHERE race_id = ? ORDER BY COALESCE(event_time_iso, created_at) ASC, updated_at DESC',
      [raceId],
    ),
  };
}

export function getRaceTimelineEvents(
  db: SQLiteClient,
  raceId: string,
  filters: LapFilters = {},
): TimelineEvent[] {
  if (!raceId) {
    return [];
  }

  const race = db.queryOne<Pick<RaceRecord, 'race_start_time'>>(
    'SELECT race_start_time FROM races WHERE id = ?',
    [raceId],
  );
  const raceStartTimeIso = race?.race_start_time ?? null;
  const annotations = getRaceAnnotations(db, raceId);
  const laps = getRaceLapsWithOffsets(db, raceId);
  const lapByNumber = new Map<number, LapRow>(
    laps.map((lap) => [lap.lap_number, lap]),
  );

  const lapNoteEvents = annotations.lapNotes.map((item) => {
    const lap = lapByNumber.get(item.lap_number);
    return buildTimelineEvent({
      eventType: 'lapNote',
      eventLabel: 'Lap Note',
      sourceId: item.id,
      lapNumber: item.lap_number,
      driverName:
        item.driver_name ||
        lap?.display_driver_name ||
        lap?.driver_name ||
        null,
      title: item.driver_name ? `Note - ${item.driver_name}` : 'Lap Note',
      body: item.note_text,
      color: item.color || ANNOTATION_COLOR_TOKENS.lapNote,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      raceStartTimeIso,
      lapStartOffsetMs: lap?.lap_start_offset_ms,
    });
  });

  const taggedIncidentEvents = annotations.taggedIncidents.map((item) => {
    const lap = lapByNumber.get(item.lap_number);
    return buildTimelineEvent({
      eventType: 'taggedIncident',
      eventLabel: 'Incident',
      sourceId: item.id,
      lapNumber: item.lap_number,
      driverName: lap?.display_driver_name || lap?.driver_name || null,
      title: item.title,
      body: [item.tag, item.details].filter(Boolean).join(' - '),
      color: item.color || ANNOTATION_COLOR_TOKENS.taggedIncident,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      raceStartTimeIso,
      lapStartOffsetMs: lap?.lap_start_offset_ms,
    });
  });

  const rangeEvents = annotations.rangeEvents.flatMap(
    (item): TimelineEvent[] => {
      const startLap = lapByNumber.get(item.start_lap);
      const endLap = lapByNumber.get(item.end_lap);
      const resolvedTitle = `${item.title ?? ''}`.trim() || 'Range Event';

      const rangeStartEvent = buildTimelineEvent({
        eventType: 'rangeEvent',
        eventLabel: 'Range Event',
        sourceId: item.id,
        lapNumber: item.start_lap,
        lapStart: item.start_lap,
        lapEnd: item.end_lap,
        driverName: null,
        title: resolvedTitle,
        body: [item.tag, item.details].filter(Boolean).join(' - '),
        color: item.color || ANNOTATION_COLOR_TOKENS.rangeEvent,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        raceStartTimeIso,
        lapStartOffsetMs: startLap?.lap_start_offset_ms,
      });

      const rangeEndEvent = buildTimelineEvent({
        eventType: 'rangeEventEnd',
        eventLabel: 'Range Event',
        sourceId: `${item.id}:end`,
        lapNumber: item.end_lap,
        lapStart: item.end_lap,
        lapEnd: item.end_lap,
        driverName: null,
        title: `End of ${resolvedTitle}`,
        body: '',
        color: item.color || ANNOTATION_COLOR_TOKENS.rangeEvent,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        raceStartTimeIso,
        lapStartOffsetMs: endLap?.lap_start_offset_ms,
      });

      return [rangeStartEvent, rangeEndEvent];
    },
  );

  const journalEvents = annotations.journalEntries.map((item) => {
    const journalLapNumber = Number.isInteger(item.lap_number)
      ? item.lap_number
      : null;
    const lap = journalLapNumber ? lapByNumber.get(journalLapNumber) : null;
    return buildTimelineEvent({
      eventType: 'journalEntry',
      eventLabel: 'Journal',
      sourceId: item.id,
      lapNumber: journalLapNumber,
      driverName: lap?.display_driver_name || lap?.driver_name || null,
      title: item.title || 'Journal Entry',
      body: item.entry_text,
      color: item.color || ANNOTATION_COLOR_TOKENS.journalEntry,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      explicitEventTimeIso: item.event_time_iso,
      eventTimeSource: item.event_time_source || null,
      raceStartTimeIso,
      lapStartOffsetMs: lap?.lap_start_offset_ms,
    });
  });

  const driverSwitchEvents = buildDriverSwitchTimelineEvents(
    laps,
    raceStartTimeIso,
  );

  const events = [
    ...driverSwitchEvents,
    ...lapNoteEvents,
    ...taggedIncidentEvents,
    ...rangeEvents,
    ...journalEvents,
  ];

  return events
    .filter((event) => timelineEventMatchesFilters(event, filters))
    .sort(compareTimelineEvents);
}

/**
 * Get candidate laps (outliers) for the active race.
 * Sorted by lap_number, id for deterministic traversal.
 * Returns basic lap data plus candidate_type label.
 */
export function getCandidates(
  db: SQLiteClient,
  raceId: string,
): CandidateLap[] {
  return db.query<CandidateLap>(
    `
      SELECT
                nl.id,
                nl.lap_number,
                ${resolvedDriverNameSql('nl')} AS driver_name,
                nl.lap_time_ms,
                nl.position_value,
                nl.speed_mph,
                nl.gap_ahead_ms,
                nl.gap_ahead_laps,
                nl.gap_ahead_display,
                nl.gap_leader_ms,
                nl.gap_leader_laps,
                nl.gap_leader_display,
                nl.is_outlier,
                nl.is_green_flag,
                'outlier' AS candidate_type
            FROM normalized_laps nl
                        WHERE nl.race_id = ? AND nl.is_outlier = 1
            ORDER BY nl.lap_number ASC, nl.id ASC
    `,
    [raceId],
  );
}

interface ReviewStatus {
  isReviewed: boolean;
  source: string | null;
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
export function inferCandidateReviewedStatus(
  candidate: CandidateLap,
  annotations: RaceAnnotations,
  db: SQLiteClient,
  raceId: string,
): ReviewStatus {
  const { lap_number, driver_name } = candidate;

  // Check for driver change at this lap (stint boundary)
  if (db && raceId && lap_number > 1) {
    const previousLap = db.queryOne<Pick<LapRow, 'driver_name'>>(
      `
            SELECT ${resolvedDriverNameSql('nl')} AS driver_name
            FROM normalized_laps nl
            WHERE nl.race_id = ? AND nl.lap_number = ?
            ORDER BY nl.lap_number DESC
            LIMIT 1
            `,
      [raceId, lap_number - 1],
    );
    if (previousLap && previousLap.driver_name !== driver_name) {
      return { isReviewed: true, source: 'driverChange' };
    }
  }

  // Check for REVIEWED_NO_ACTION lap note
  const hasReviewedNote = annotations.lapNotes.some(
    (note) =>
      note.lap_number === lap_number &&
      note.note_text.startsWith('REVIEWED_NO_ACTION'),
  );
  if (hasReviewedNote) {
    return { isReviewed: true, source: 'lapNote' };
  }

  // Check for tagged incident on same lap
  const hasIncident = annotations.taggedIncidents.some(
    (incident) => incident.lap_number === lap_number,
  );
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
    (stint) => stint.start_lap <= lap_number && lap_number <= stint.end_lap,
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
export function augmentCandidateWithReviewStatus(
  candidate: CandidateLap,
  annotations: RaceAnnotations,
  db: SQLiteClient,
  raceId: string,
): CandidateLap & ReviewStatus {
  const reviewStatus = inferCandidateReviewedStatus(
    candidate,
    annotations,
    db,
    raceId,
  );
  return {
    ...candidate,
    ...reviewStatus,
  };
}

export function getRaceSnapshot(
  db: SQLiteClient,
  raceId: string,
): RaceSnapshot {
  const race = db.queryOne<RaceRecord>('SELECT * FROM races WHERE id = ?', [
    raceId,
  ]);
  const laps = db
    .query<LapRow>(
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
    )
    .map((lap) => {
      const raceStartIso = race?.race_start_time ?? null;
      const lapStartOffsetMs = Number.isFinite(lap.lap_start_offset_ms)
        ? lap.lap_start_offset_ms
        : null;
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

function buildLapStartIso(
  raceStartIso: string | null | undefined,
  lapStartOffsetMs: number | null | undefined,
): string | null {
  if (
    !raceStartIso ||
    typeof lapStartOffsetMs !== 'number' ||
    !Number.isFinite(lapStartOffsetMs)
  ) {
    return null;
  }

  const raceStart = new Date(raceStartIso);
  if (Number.isNaN(raceStart.getTime())) {
    return null;
  }

  return new Date(raceStart.getTime() + lapStartOffsetMs).toISOString();
}

function getRaceLapsWithOffsets(db: SQLiteClient, raceId: string): LapRow[] {
  return db.query<LapRow>(
    `
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
                ) AS lap_start_offset_ms
            FROM normalized_laps nl
            WHERE nl.race_id = ?
            ORDER BY nl.lap_number ASC
        `,
    [raceId],
  );
}

function buildDriverSwitchTimelineEvents(
  laps: LapRow[],
  raceStartTimeIso: string | null,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (let index = 1; index < laps.length; index += 1) {
    const previous = laps[index - 1];
    const current = laps[index];

    const previousDriver =
      `${previous.display_driver_name ?? previous.driver_name ?? ''}`.trim();
    const currentDriver =
      `${current.display_driver_name ?? current.driver_name ?? ''}`.trim();

    if (!previousDriver || !currentDriver || previousDriver === currentDriver) {
      continue;
    }

    events.push(
      buildTimelineEvent({
        eventType: 'driverSwitch',
        eventLabel: 'Driver Switch',
        sourceId: `${previous.id}:${current.id}`,
        lapNumber: current.lap_number,
        driverName: currentDriver,
        oldDriverName: previousDriver,
        newDriverName: currentDriver,
        title: `${previousDriver} -> ${currentDriver}`,
        body: `Driver swap at lap ${current.lap_number}`,
        color: ANNOTATION_COLOR_TOKENS.driverStint,
        createdAt: current.updated_at || current.created_at || null,
        updatedAt: current.updated_at || current.created_at || null,
        raceStartTimeIso,
        lapStartOffsetMs: current.lap_start_offset_ms,
      }),
    );
  }

  return events;
}

interface BuildTimelineEventInput {
  eventType: string;
  eventLabel: string;
  sourceId: string;
  lapNumber?: number | null;
  lapStart?: number | null;
  lapEnd?: number | null;
  driverName?: string | null;
  oldDriverName?: string | null;
  newDriverName?: string | null;
  title?: string | null;
  body?: string | null;
  color?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  explicitEventTimeIso?: string | null;
  eventTimeSource?: string | null;
  raceStartTimeIso?: string | null;
  lapStartOffsetMs?: number | null;
}

function buildTimelineEvent({
  eventType,
  eventLabel,
  sourceId,
  lapNumber = null,
  lapStart = null,
  lapEnd = null,
  driverName = null,
  oldDriverName = null,
  newDriverName = null,
  title = '',
  body = '',
  color = ANNOTATION_COLOR_TOKENS.fallback,
  createdAt = null,
  updatedAt = null,
  explicitEventTimeIso = null,
  eventTimeSource = null,
  raceStartTimeIso = null,
  lapStartOffsetMs = null,
}: BuildTimelineEventInput): TimelineEvent {
  const lapDerivedIso = Number.isFinite(lapStartOffsetMs)
    ? buildLapStartIso(raceStartTimeIso, lapStartOffsetMs)
    : null;

  const explicitIso = normalizeIso(explicitEventTimeIso);
  const createdIso = normalizeIso(createdAt);
  const effectiveEventTimeIso = explicitIso || lapDerivedIso || createdIso;
  const resolvedEventTimeSource = explicitIso
    ? 'manual'
    : eventTimeSource || (lapDerivedIso ? 'lap' : 'created');

  return {
    id: `${eventType}:${sourceId}`,
    event_type: eventType,
    event_label: eventLabel,
    source_id: sourceId,
    lap_number: Number.isInteger(lapNumber) ? lapNumber : null,
    lap_start: Number.isInteger(lapStart)
      ? lapStart
      : Number.isInteger(lapNumber)
        ? lapNumber
        : null,
    lap_end: Number.isInteger(lapEnd)
      ? lapEnd
      : Number.isInteger(lapNumber)
        ? lapNumber
        : null,
    driver_name: driverName || null,
    old_driver_name: oldDriverName || null,
    new_driver_name: newDriverName || null,
    title: title || eventLabel,
    body: body || '',
    color,
    event_time_iso: effectiveEventTimeIso,
    event_time_source: resolvedEventTimeSource,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeIso(value: string | null | undefined): string | null {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return null;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function timelineEventMatchesFilters(
  event: TimelineEvent,
  filters: LapFilters = {},
): boolean {
  const lapMin =
    typeof filters.lapMin === 'number' && Number.isFinite(filters.lapMin)
      ? filters.lapMin
      : null;
  const lapMax =
    typeof filters.lapMax === 'number' && Number.isFinite(filters.lapMax)
      ? filters.lapMax
      : null;

  if (lapMin !== null || lapMax !== null) {
    const startLap =
      typeof event.lap_start === 'number' && Number.isInteger(event.lap_start)
        ? event.lap_start
        : null;
    const endLap =
      typeof event.lap_end === 'number' && Number.isInteger(event.lap_end)
        ? event.lap_end
        : startLap;

    if (startLap === null || endLap === null) {
      // Keep valid manual/no-lap journal entries visible in timeline.
      if (event.event_type !== 'journalEntry') {
        return false;
      }
    } else {
      if (lapMin !== null && endLap < lapMin) {
        return false;
      }

      if (lapMax !== null && startLap > lapMax) {
        return false;
      }
    }
  }

  if (filters.driver) {
    const eventDriver = `${event.driver_name ?? ''}`.trim();
    if (!eventDriver || eventDriver !== filters.driver) {
      return false;
    }
  }

  const search = `${filters.search ?? ''}`.trim().toLowerCase();
  if (search) {
    const haystack = [
      event.event_label,
      event.event_type,
      event.title,
      event.body,
      event.driver_name,
      event.lap_number,
      event.lap_start,
      event.lap_end,
    ]
      .map((value) => `${value ?? ''}`.toLowerCase())
      .join(' ');

    if (!haystack.includes(search)) {
      return false;
    }
  }

  return true;
}

function compareTimelineEvents(
  left: TimelineEvent,
  right: TimelineEvent,
): number {
  const leftLap =
    typeof left.lap_start === 'number' && Number.isInteger(left.lap_start)
      ? left.lap_start
      : Number.POSITIVE_INFINITY;
  const rightLap =
    typeof right.lap_start === 'number' && Number.isInteger(right.lap_start)
      ? right.lap_start
      : Number.POSITIVE_INFINITY;

  if (leftLap === rightLap && Number.isFinite(leftLap)) {
    const leftPriority = left.event_type === 'journalEntry' ? 0 : 1;
    const rightPriority = right.event_type === 'journalEntry' ? 0 : 1;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
  }

  const leftTime = left.event_time_iso
    ? new Date(left.event_time_iso).getTime()
    : Number.POSITIVE_INFINITY;
  const rightTime = right.event_time_iso
    ? new Date(right.event_time_iso).getTime()
    : Number.POSITIVE_INFINITY;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftLap !== rightLap) {
    return leftLap - rightLap;
  }

  const leftCreated = left.created_at
    ? new Date(left.created_at).getTime()
    : Number.POSITIVE_INFINITY;
  const rightCreated = right.created_at
    ? new Date(right.created_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  return `${left.id}`.localeCompare(`${right.id}`);
}

function buildLapFilterSql(
  raceId: string,
  filters: LapFilters,
  alias = '',
  includeRaceId = true,
): { whereSql: string; params: SqlParams } {
  const prefix = alias ? `${alias}.` : '';
  const conditions: string[] = [];
  const params: SqlParams = [];

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

  if (typeof filters.lapMin === 'number' && Number.isFinite(filters.lapMin)) {
    conditions.push(`${prefix}lap_number >= ?`);
    params.push(filters.lapMin);
  }

  if (typeof filters.lapMax === 'number' && Number.isFinite(filters.lapMax)) {
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

function resolvedDriverNameSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `COALESCE((SELECT ds.driver_name FROM driver_stints ds WHERE ds.race_id = ${prefix}race_id AND ${prefix}lap_number BETWEEN ds.start_lap AND ds.end_lap ORDER BY ds.updated_at DESC, ds.start_lap DESC LIMIT 1), ${prefix}driver_name)`;
}

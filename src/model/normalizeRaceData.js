import { computeMedian, formatGapDisplay, parseDurationLike } from '../utils/time.js';
import { formatNumber } from '../utils/format.js';

export function normalizeRaceData(parsedRows) {
    const normalizedRows = parsedRows.map((row) => normalizeRow(row));
    const rollingMedians = buildRollingMedians(normalizedRows);

    const laps = normalizedRows.map((row, index) => {
        const rollingMedianMs = rollingMedians[index];
        const lapTimeMs = row.lapTime.ms;
        const isOutlier = Number.isFinite(lapTimeMs)
            && Number.isFinite(rollingMedianMs)
            && lapTimeMs > rollingMedianMs * 1.3;
        const isPitCandidate = Number.isFinite(lapTimeMs)
            && Number.isFinite(rollingMedianMs)
            && lapTimeMs > rollingMedianMs * 1.55;
        const isRepairCandidate = Number.isFinite(lapTimeMs)
            && Number.isFinite(rollingMedianMs)
            && lapTimeMs > Math.max(rollingMedianMs * 1.85, rollingMedianMs + 120000);
        const isGreenFlag = Number.isFinite(lapTimeMs) && !isOutlier && !isPitCandidate && !isRepairCandidate;

        return {
            ...row,
            rollingMedianMs,
            isOutlier,
            isPitCandidate,
            isRepairCandidate,
            isGreenFlag,
            searchText: [
                row.carNumber,
                row.driverName,
                row.gapAhead.display,
                row.gapLeader.display,
            ]
                .join(' ')
                .toLowerCase(),
        };
    });

    return {
        laps,
        stats: {
            drivers: [...new Set(laps.map((lap) => lap.driverName).filter(Boolean))].sort(),
            cars: [...new Set(laps.map((lap) => lap.carNumber).filter(Boolean))].sort(),
            totalLaps: laps.length,
            minLap: Math.min(...laps.map((lap) => lap.lapNumber)),
            maxLap: Math.max(...laps.map((lap) => lap.lapNumber)),
        },
    };
}

function normalizeRow(row) {
    const lapTime = parseDurationLike(row.values.lap_time);
    const gapAhead = parseDurationLike(row.values.gap_ahead);
    const gapLeader = parseDurationLike(row.values.gap_leader);
    const gapLeaderLaps = gapLeader.kind === 'time' ? 0 : gapLeader.laps;

    return {
        rowIndex: row.rowIndex,
        csvRowNumber: row.csvRowNumber,
        rawLine: row.rawLine,
        rawCells: row.rawCells,
        lapNumber: parseInteger(row.values.lap),
        carNumber: row.values.car.trim(),
        driverName: row.values.driver.trim(),
        lapTime,
        lapTimeText: row.values.lap_time.trim(),
        positionValue: parseNumberLike(row.values.position),
        speedMph: parseNumberLike(row.values.speed),
        gapAhead: {
            ...gapAhead,
            display: formatGapDisplay(gapAhead.ms, gapAhead.laps, row.values.gap_ahead.trim() || '-'),
        },
        gapLeader: {
            ...gapLeader,
            laps: gapLeaderLaps,
            display: Number.isFinite(gapLeaderLaps)
                ? formatNumber(gapLeaderLaps)
                : formatGapDisplay(gapLeader.ms, gapLeader.laps, row.values.gap_leader.trim() || '-'),
        },
    };
}

function buildRollingMedians(rows) {
    const medians = new Array(rows.length).fill(null);
    const rowsByCar = rows.reduce((groups, row, index) => {
        const key = row.carNumber || 'unknown';
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push({ row, index });
        return groups;
    }, new Map());

    for (const group of rowsByCar.values()) {
        group.sort((left, right) => left.row.lapNumber - right.row.lapNumber);

        group.forEach((entry, groupIndex) => {
            const sample = group
                .slice(Math.max(0, groupIndex - 2), Math.min(group.length, groupIndex + 3))
                .filter((candidate) => candidate !== entry)
                .map((candidate) => candidate.row.lapTime.ms)
                .filter((value) => Number.isFinite(value));

            if (!sample.length && Number.isFinite(entry.row.lapTime.ms)) {
                sample.push(entry.row.lapTime.ms);
            }

            medians[entry.index] = computeMedian(sample);
        });
    }

    return medians;
}

function parseInteger(value) {
    const parsed = Number.parseInt(`${value ?? ''}`.replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumberLike(value) {
    const parsed = Number.parseFloat(`${value ?? ''}`.replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}
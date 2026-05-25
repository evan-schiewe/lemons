export function computeMedian(values) {
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .slice()
        .sort((left, right) => left - right);

    if (!sorted.length) {
        return null;
    }

    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? Math.round((sorted[midpoint - 1] + sorted[midpoint]) / 2)
        : sorted[midpoint];
}

export function parseDurationLike(value) {
    const raw = `${value ?? ''}`.trim();

    if (!raw) {
        return { raw, ms: null, laps: null, kind: 'empty' };
    }

    const normalized = raw
        .toLowerCase()
        .replace(/^\+/, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (normalized === 'leader') {
        return { raw, ms: 0, laps: 0, kind: 'leader' };
    }

    const lapMatch = normalized.match(/(-?\d+(?:\.\d+)?)\s*laps?/);
    const laps = lapMatch ? Number(lapMatch[1]) : null;
    const withoutLapWords = normalized
        .replace(/-?\d+(?:\.\d+)?\s*laps?/, ' ')
        .replace(/\b(behind|ahead|to leader|leader)\b/g, ' ')
        .replace(/[()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const ms = parseClockish(withoutLapWords || normalized);

    if (laps !== null) {
        return {
            raw,
            ms,
            laps,
            kind: ms !== null ? 'laps-plus-time' : 'laps',
        };
    }

    if (ms !== null) {
        return { raw, ms, laps: null, kind: 'time' };
    }

    return { raw, ms: null, laps: null, kind: 'text' };
}

function parseClockish(value) {
    const trimmed = `${value ?? ''}`.trim().toLowerCase();

    if (!trimmed || trimmed === 'leader' || trimmed === '-') {
        return null;
    }

    const wordClock = trimmed.match(
        /^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+(?:\.\d+)?)s?)?$/,
    );

    if (wordClock && (wordClock[1] || wordClock[2] || wordClock[3])) {
        const hours = Number(wordClock[1] || 0);
        const minutes = Number(wordClock[2] || 0);
        const seconds = Number(wordClock[3] || 0);
        return Math.round((((hours * 60) + minutes) * 60 + seconds) * 1000);
    }

    if (trimmed.includes(':')) {
        const parts = trimmed.split(':').map((part) => Number(part));

        if (parts.every((part) => Number.isFinite(part))) {
            let seconds = 0;

            for (const part of parts) {
                seconds = (seconds * 60) + part;
            }

            return Math.round(seconds * 1000);
        }
    }

    const numeric = Number(trimmed.replace(/[^\d.-]/g, ''));
    return Number.isFinite(numeric) ? Math.round(numeric * 1000) : null;
}

export function formatDurationMs(milliseconds, fallback = '-') {
    if (!Number.isFinite(milliseconds)) {
        return fallback;
    }

    const totalSeconds = milliseconds / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const secondsLabel = seconds.toFixed(3).padStart(hours ? 6 : 6, '0');

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${secondsLabel}`;
    }

    return `${minutes}:${secondsLabel}`;
}

export function formatGapDisplay(milliseconds, laps, fallbackText = '-') {
    if (Number.isFinite(laps) && laps !== 0) {
        if (Number.isFinite(milliseconds) && milliseconds > 0) {
            return `${laps} lap${Math.abs(laps) === 1 ? '' : 's'}, ${formatDurationMs(milliseconds)}`;
        }

        return `${laps} lap${Math.abs(laps) === 1 ? '' : 's'}`;
    }

    if (Number.isFinite(milliseconds)) {
        return formatDurationMs(milliseconds);
    }

    return fallbackText;
}

export function formatWallClock(startIso, offsetMs, fallback = '-') {
    if (!startIso || !Number.isFinite(offsetMs)) {
        return fallback;
    }

    const raceStart = new Date(startIso);
    if (Number.isNaN(raceStart.getTime())) {
        return fallback;
    }

    const lapStart = new Date(raceStart.getTime() + offsetMs);
    const hours = String(lapStart.getHours()).padStart(2, '0');
    const minutes = String(lapStart.getMinutes()).padStart(2, '0');
    const seconds = String(lapStart.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}
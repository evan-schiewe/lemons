const DEFAULT_HEADERS = [
    'lap',
    'team_slot',
    'driver',
    'lap_time',
    'position',
    'speed',
    'gap_ahead',
    'gap_leader',
];

const HEADER_ALIASES = {
    lap: ['lap', 'lap number', 'lap_no', 'lapno'],
    team_slot: ['team', 'entry', 'slot', 'vehicle'],
    driver: ['driver', 'driver name'],
    lap_time: ['lap time', 'laptime', 'time', 'last lap'],
    position: ['position', 'pos', 'place'],
    speed: ['speed', 'mph', 'avg speed'],
    gap_ahead: ['gap ahead', 'gap in front', 'gapfront', 'interval', 'gap'],
    gap_leader: ['gap leader', 'gap to leader', 'leader gap', 'behind leader', 'gap to front', 'diff to p1'],
};

export function parseRaceCsv(csvText) {
    // Normalize malformed CSV: replace `", lap` with ` lap`
    const normalizedText = csvText.replace(/", lap/g, ' lap');
    const lines = normalizedText.split(/\r?\n/).filter((line) => line.trim().length);

    if (!lines.length) {
        throw new Error('The selected CSV is empty.');
    }

    const warnings = [];
    const firstTokens = repairTokens(tokenizeCsvLine(lines[0]), warnings, 1);
    const hasHeader = looksLikeHeader(firstTokens);
    const headers = hasHeader ? normalizeHeaders(firstTokens) : DEFAULT_HEADERS;
    const fieldMap = buildFieldMap(headers);
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const rows = [];

    dataLines.forEach((line, index) => {
        const rowNumber = index + (hasHeader ? 2 : 1);
        const repairedTokens = repairTokens(tokenizeCsvLine(line), warnings, rowNumber);

        if (repairedTokens.length !== DEFAULT_HEADERS.length) {
            warnings.push(`Skipped row ${rowNumber}: expected 8 columns after repair, found ${repairedTokens.length}.`);
            return;
        }

        const mapped = DEFAULT_HEADERS.reduce((record, header) => {
            const fieldIndex = fieldMap[header];
            record[header] = fieldIndex >= 0 ? repairedTokens[fieldIndex]?.trim() ?? '' : '';
            return record;
        }, {});

        if (!mapped.lap) {
            warnings.push(`Skipped row ${rowNumber}: missing lap number.`);
            return;
        }

        rows.push({
            rowIndex: rows.length,
            csvRowNumber: rowNumber,
            rawLine: line,
            rawCells: repairedTokens,
            values: mapped,
        });
    });

    if (!rows.length) {
        throw new Error('No valid lap rows were found in the CSV.');
    }

    return {
        headers: DEFAULT_HEADERS,
        detectedHeaders: headers,
        hasHeader,
        warnings,
        rows,
    };
}

function tokenizeCsvLine(line) {
    const tokens = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        const nextCharacter = line[index + 1];

        if (character === '"') {
            if (inQuotes && nextCharacter === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (character === ',' && !inQuotes) {
            tokens.push(current.trim());
            current = '';
            continue;
        }

        current += character;
    }

    tokens.push(current.trim());
    return tokens;
}

function repairTokens(tokens, warnings, rowNumber) {
    if (tokens.length === DEFAULT_HEADERS.length) {
        return tokens;
    }

    if (tokens.length < DEFAULT_HEADERS.length) {
        const padded = [...tokens];
        while (padded.length < DEFAULT_HEADERS.length) {
            padded.push('');
        }
        warnings.push(`Padded short row ${rowNumber} from ${tokens.length} to 8 columns.`);
        return padded;
    }

    const fixedPrefix = tokens.slice(0, 6);
    const tail = tokens.slice(6);
    let bestSplit = null;

    for (let splitIndex = 1; splitIndex < tail.length; splitIndex += 1) {
        const gapAhead = tail.slice(0, splitIndex).join(', ').trim();
        const gapLeader = tail.slice(splitIndex).join(', ').trim();
        const score = scoreGapField(gapAhead) + scoreGapField(gapLeader);

        if (!bestSplit || score > bestSplit.score) {
            bestSplit = { score, gapAhead, gapLeader };
        }
    }

    if (!bestSplit) {
        bestSplit = {
            score: 0,
            gapAhead: tail.slice(0, -1).join(', ').trim(),
            gapLeader: tail.slice(-1).join(', ').trim(),
        };
    }

    warnings.push(`Repaired malformed row ${rowNumber} containing ${tokens.length} columns.`);
    return [...fixedPrefix, bestSplit.gapAhead, bestSplit.gapLeader];
}

function scoreGapField(value) {
    const normalized = value.toLowerCase();
    let score = 0;

    if (/leader|lap|sec|\d+:\d+|\d+\.\d+/.test(normalized)) {
        score += 3;
    }

    if (/^\d+(?:\.\d+)?\s*laps?$/.test(normalized)) {
        score += 2;
    }

    if (/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(normalized)) {
        score += 2;
    }

    if (normalized.length <= 24) {
        score += 1;
    }

    return score;
}

function looksLikeHeader(tokens) {
    const normalized = tokens.map((token) => normalizeHeaderCell(token));
    return normalized.some((token) => Object.values(HEADER_ALIASES).some((aliases) => aliases.includes(token)));
}

function normalizeHeaders(tokens) {
    return tokens.map((token) => normalizeHeaderCell(token));
}

function normalizeHeaderCell(value) {
    return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildFieldMap(headers) {
    const mapping = {};
    const usedIndices = new Set();

    // First pass: map headers to their correct columns
    DEFAULT_HEADERS.forEach((header) => {
        const index = headers.findIndex((candidate) => HEADER_ALIASES[header].includes(candidate));
        if (index >= 0) {
            mapping[header] = index;
            usedIndices.add(index);
        }
    });

    // Second pass: for missing headers, use -1 to indicate "not found"
    DEFAULT_HEADERS.forEach((header) => {
        if (!(header in mapping)) {
            mapping[header] = -1;
        }
    });

    return mapping;
}
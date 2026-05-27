export function datetimeLocalToIso(value: unknown): string | null {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

export function promptForRaceImportOptions(fileName: string): {
  cancelled: boolean;
  raceStartTime: string | null;
} {
  while (true) {
    const response = window.prompt(
      `Race start time for ${fileName}\nEnter local time as YYYY-MM-DDTHH:mm.\nLeave blank to skip.`,
      '',
    );

    if (response == null) {
      return { cancelled: true, raceStartTime: null };
    }

    const trimmed = response.trim();
    if (!trimmed) {
      return { cancelled: false, raceStartTime: null };
    }

    const raceStartTime = datetimeLocalToIso(trimmed);
    if (raceStartTime) {
      return { cancelled: false, raceStartTime };
    }

    window.alert(
      'Invalid race start time. Use YYYY-MM-DDTHH:mm, for example 2026-05-25T09:30.',
    );
  }
}

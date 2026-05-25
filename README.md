# Lemons Race Viewer

Static browser app for importing Lemons lap CSVs, repairing malformed gap fields, normalizing laps into an in-browser SQLite database, and reviewing pace, position, gap, and annotation views.

## Stack

- Vanilla Vite app
- `sql.js` for browser-side SQLite
- OPFS-backed database file persistence when available
- Apache ECharts for lap time, position, and gap views

## Chrome and Edge Support

The app is optimized for current Chrome and Edge releases. It relies on:

- modern ES modules
- `crypto.subtle` for import identity hashing
- OPFS through `navigator.storage.getDirectory()` when available
- browser Blob export for `.json` and `.sqlite` backups

If OPFS is unavailable, the app keeps data only in memory for the current session.

## Local Development

Install and run with `pnpm`:

```bash
pnpm install
pnpm dev
```

The Vite dev server and preview server are configured with:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Those headers keep local HTTP-server usage aligned with static-hosted deployment requirements. Use HTTP hosting instead of `file://` so browser storage and WASM assets load consistently.

To test the production bundle locally:

```bash
pnpm build
pnpm preview
```

## GitHub Pages Deployment

This project is static-host friendly. The recommended deployment path is:

1. Build with `pnpm build`.
2. Publish the `dist` directory to GitHub Pages.
3. If you later move from the current exported-file OPFS persistence approach to a stricter SQLite OPFS VFS path, add a lightweight service worker such as `coi-serviceworker` so GitHub Pages can emulate the cross-origin isolation headers required by that setup.

The current implementation already exports durable `.json` and `.sqlite` backups, so OPFS should be treated as a local cache rather than the only permanent store.

## Storage Behavior

- Primary mode: OPFS-backed SQLite file cache in the browser origin.
- Durable workflow: export `.json` or `.sqlite` after annotation work you care about.
- Re-import behavior: importing the same CSV content updates the same race record instead of duplicating it.
- Annotation behavior: re-import refreshes raw and normalized laps while keeping the race identity stable, so stored annotations remain attached to the same race.

## Supported CSV Shape

The importer expects 8 logical columns in this order, or a matching header row that maps onto them:

1. `lap`
2. `car`
3. `driver`
4. `lap_time`
5. `position`
6. `speed`
7. `gap_ahead`
8. `gap_leader`

## Malformed Field Repair Rules

Known malformed rows are repaired with domain-specific handling rather than generic CSV parsing alone:

- quoted CSV rows are tokenized correctly
- short rows are padded to the expected 8-column shape
- long rows are repaired by keeping the first 6 fields fixed and re-splitting the remaining tokens into `gap_ahead` and `gap_leader`
- repair scoring favors values that look like laps, time gaps, or leader-gap phrases
- unrecoverable rows are skipped with warnings reported in the import status

## Normalization Rules

- lap times and gap-like values are parsed into numeric millisecond fields where possible
- gap phrases containing lap counts preserve lap semantics separately from pure time gaps
- `is_outlier = true` when a lap exceeds 130% of the car's rolling median lap time
- “Green Flag Pace” is computed from laps that are not outliers, pit candidates, or repair candidates
- pit and repair candidates are derived from larger rolling-median deviations so long laps are easy to distinguish in summaries and charts

## Verification Checklist

- Import one or more CSV files from the toolbar
- Re-import the same CSV and confirm it updates the existing race
- Refresh the page and confirm the active origin restores stored races
- Use the Reset Storage button to delete all stored races, annotations, and cached SQLite data for the site
- Add lap notes, incidents, range events, and driver stints
- Export the annotated race as `.json` and the whole database as `.sqlite`
- Confirm the lap table, summary cards, and all chart views continue to populate from the persisted SQLite data
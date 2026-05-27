# Lemons Race Viewer

Static browser app for importing Lemons lap CSVs, repairing malformed gap fields, normalizing laps into an in-browser SQLite database, and reviewing pace, position, gap, timeline, and annotation data.

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

Install and run with Node 22.13+ or Node 24 and pnpm 11.3:

```bash
pnpm install
pnpm dev
```

Use the same checks as CI before publishing:

```bash
pnpm check
pnpm build
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

This project is static-host friendly. CI installs with the committed lockfile, runs `pnpm check`, builds, and publishes `dist` to GitHub Pages.

In repository Settings -> Pages, set **Build and deployment -> Source** to **GitHub Actions**. If Source is left in legacy branch mode (`main` + `/`), GitHub Pages serves repository source files instead of the built `dist` artifact and can fail with module MIME errors.

Optional collaborative sync deployment and usage instructions are in [docs/cloudflare-sync-deployment.md](docs/cloudflare-sync-deployment.md).

If you later move from the current exported-file OPFS persistence approach to a stricter SQLite OPFS VFS path, add a lightweight service worker such as `coi-serviceworker` so GitHub Pages can emulate the cross-origin isolation headers required by that setup.

The current implementation already exports durable `.json` and `.sqlite` backups, so OPFS should be treated as a local cache rather than the only permanent store.

## Storage Behavior

- Primary mode: OPFS-backed SQLite file cache in the browser origin.
- Durable workflow: export `.json` or `.sqlite` after annotation work you care about.
- Restore workflow: use **Restore SQLite** to import a previously exported `.sqlite` backup and repopulate all races and annotations.
- Re-import behavior: importing the same CSV content updates the same race record instead of duplicating it.
- Annotation behavior: re-import refreshes raw and normalized laps while keeping the race identity stable, so stored annotations remain attached to the same race.
- Authoring behavior: annotation authoring is local-first. Production builds are standalone by default unless explicitly configured with Cloudflare sync or read-only mode.

## Supported CSV Shape

The importer expects 8 logical columns in this order, or a matching header row that maps onto them:

1. `lap`
2. `team_slot`
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
- `is_outlier = true` when a lap exceeds 130% of the rolling median lap time
- summary pace can be filtered to green-flag laps and trims the slowest 5% from the selected lap set

## Verification Checklist

- Import one or more CSV files from the toolbar
- Re-import the same CSV and confirm it updates the existing race
- Refresh the page and confirm the active origin restores stored races
- In local development, add lap notes, incidents, range events, driver stints, and journal entries
- Export the annotated race as `.json` and the whole database as `.sqlite`
- Restore the exported `.sqlite` and confirm races and annotations reload
- Confirm the lap table, summary cards, and all chart views continue to populate from the persisted SQLite data

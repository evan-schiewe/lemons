## Plan: Standalone Race Viewer

**DRAFT**

Build a static browser app that loads Lemons lap CSVs, repairs/parses the known malformed fields, normalizes them into an in-browser SQLite database, and renders interactive race views. Based on discovery and your decisions, the plan should optimize for Chrome/Edge, hosted static deployment, and local use via a tiny HTTP server rather than `file://` persistence. The first version should support lap notes, tagged incidents, range events, and driver stints, with a lap table, lap-time chart, position chart, gap charts, and a summary dashboard.

**Steps** 0. Using pnpm and a 5-day dependency cooldown, scaffold a vanilla vite project with the necessary dependencies for SQLite WASM, charting, and UI components. Set up a basic file structure to organize features, database code, and utilities.

1. Create the static app shell in [index.html](index.html), [src/main.js](src/main.js), and [src/styles.css](src/styles.css) with a layout for import controls, filter controls, charts, summary cards, and an annotation sidebar.
2. Add a CSV intake pipeline in [src/import/csvLoader.js](src/import/csvLoader.js) and [src/import/parseRaceCsv.js](src/import/parseRaceCsv.js) that:
   - reads user-selected files,
   - repairs malformed rows where gap fields contain embedded commas,
   - validates the expected 8-column schema,
   - preserves raw source values,
   - converts time-like fields into normalized numeric forms for querying/charting.
3. Define a normalization layer in [src/model/normalizeRaceData.js](src/model/normalizeRaceData.js) for typed lap records, including parsed durations, gap semantics, speed extraction, pit/repair outlier flags, and derived metrics used by charts and summaries. Add an explicit `is_outlier` flag that automatically marks laps whose time exceeds $130\%$ of the car's rolling median lap time, and use that to distinguish “Green Flag Pace” from yellow/FCY-affected running in downstream summaries.
4. Add the browser SQLite layer in [src/db/sqliteClient.js](src/db/sqliteClient.js) and [src/db/schema.sql](src/db/schema.sql) using a WASM-backed client running in a worker-friendly setup. Store:
   - imported race metadata,
   - raw CSV rows,
   - normalized lap rows,
   - annotations,
   - events,
   - driver stints.
5. Use a persistence strategy that fits static hosting and Chrome/Edge: worker-based SQLite with OPFS-backed persistence for hosted mode, plus a graceful fallback for sessions where durable storage is unavailable.
6. Model annotation data in [src/db/schema.sql](src/db/schema.sql) and [src/features/annotations/annotationStore.js](src/features/annotations/annotationStore.js) with separate entities for:
   - `lap_notes`,
   - `tagged_incidents`,
   - `range_events`,
   - `driver_stints`.
     Keep event typing extensible so new tags/colors can be added without changing the lap import model.
7. Implement import-to-database orchestration in [src/features/import/importRace.js](src/features/import/importRace.js) so each uploaded CSV becomes a race record with idempotent insert/update behavior and clear handling for re-imports.
8. Build query services in [src/features/query/raceQueries.js](src/features/query/raceQueries.js) for the views you want: lap table rows, lap-time series, position series, gap-to-leader series, gap-in-front series, and dashboard aggregates.
9. Implement the lap table in [src/features/table/lapTable.js](src/features/table/lapTable.js) with sorting, filtering, lap selection, and links into annotations/events.
10. Implement chart modules in:
   - [src/features/charts/lapTimeChart.js](src/features/charts/lapTimeChart.js)
   - [src/features/charts/gapCharts.js](src/features/charts/gapCharts.js)
      Each chart should support zooming, hover detail, lap selection, and visual markers for annotations, incidents, and stint boundaries.
11. Build the dashboard in [src/features/dashboard/summaryCards.js](src/features/dashboard/summaryCards.js) to show best lap, average green-flag pace computed from non-outlier laps, long-lap outliers, pit/repair candidates, total laps, position range, and stint/event counts. Make the distinction between “Green Flag Pace” and yellow/FCY-affected laps explicit in labels and calculations.
12. Add an annotation UI in [src/features/annotations/annotationPanel.js](src/features/annotations/annotationPanel.js) for creating/editing lap notes, incidents, range events, and driver stints directly against stored records.
13. Add import/export support in [src/features/export/exportDb.js](src/features/export/exportDb.js) and/or [src/features/export/exportAnnotations.js](src/features/export/exportAnnotations.js) as a critical workflow, not a fallback, so race data and annotations can be backed up or moved between browser profiles/origins. Support saving annotated races as a standalone shareable file such as `.json` and/or a raw `.sqlite` database blob.
14. Add compatibility and deployment notes in [README.md](README.md) covering:
    - Chrome/Edge target support,
    - local development via a tiny HTTP server,

- tiny HTTP server requirements for OPFS, including `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`,
- GitHub Pages deployment, including a lightweight service-worker approach such as `coi-serviceworker` to emulate the required isolation headers for SQLite OPFS support,
- storage behavior and limitations,
- supported CSV expectations and malformed-field repair rules.

**Verification**

- Start the app from a local HTTP server and confirm a sample CSV imports cleanly.
- Re-import the same CSV and verify duplicate handling matches the chosen race identity rules.
- Confirm SQLite persistence survives refresh in hosted/local-server mode, with OPFS treated as a local cache rather than the sole permanent archive.
- Verify all five v1 views populate from database queries, not just in-memory arrays.
- Add each annotation type and confirm it appears in the database-backed UI and on relevant charts.
- Test malformed rows containing lap-gap phrases with commas and confirm they parse into the correct fields.
- Validate very short, very long, and hour-scale lap times normalize correctly.
- Open the deployed app on GitHub Pages in Chrome/Edge and confirm import, persistence, and chart rendering still work.

**Decisions**

- Optimize for local use via a tiny HTTP server rather than strict `file://` persistence.
- Target Chrome/Edge first.
- Include lap notes, range events, tagged incidents, and driver stints in v1.
- Include lap table, lap-time chart, gap charts, and summary dashboard in v1.
- Treat parsing as domain-specific repair + normalization, not generic CSV parsing only.
- Define “Green Flag Pace” from non-outlier laps, with `is_outlier = true` when lap time is greater than $130\%$ of the car's rolling median lap time.
- Treat OPFS as a cache layer; export/import is required for durable sharing and archival.

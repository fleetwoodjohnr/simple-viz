# Implementation status

_Last updated: 2026-11-05 · M0–M4 complete (with the limits listed), M1 has items pending tests; M5–M9 not started ·
version 0.1.0 (unreleased) · verified with automated tests on Linux (Fedora 44); CI builds, packages and tests on
Linux, Windows and macOS._

"Done" means implemented **and** covered by a passing automated test. A button existing in the UI does not count.

## Test results (current, Fedora 44)

| Suite | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm test` (unit) | ✅ 62 tests |
| `npm run test:integration` (real DuckDB, files, PostgreSQL 17 in podman) | ✅ 72 tests |
| `npm run e2e:headless` (the real app) | ✅ acceptance (24 steps), charts, dashboards, data, model, PostgreSQL, smoke; updater (packaged only) |
| Packaged Linux build (`electron-builder --linux dir`) + e2e | ✅ |
| CI: Linux, Windows, macOS (arm64; Intel under Rosetta) build, test, package, test the packaged app; deb/rpm install on Ubuntu 22.04/24.04, Debian 12, Fedora 44; npm audit; CodeQL | ✅ |
| PostgreSQL tests on Windows and macOS CI | ⏭ skipped (no podman there); the acceptance test uses a CSV for customers and says so |

## M0 — Scaffold ✅

| Feature | Test |
|---|---|
| Shell from Simple Cell (window, secure IPC, settings, recents, recovery, updater), renamed | e2e `smoke`, unit `updater` |
| Engine in a utility process; renderer ⇄ engine MessagePort | e2e `smoke` (`SELECT 40 + 2` from the page) |
| DuckDB lockdown and SQL gate | integration `sandbox` (19 attacks on the gate, 6 on the lockdown alone) |
| DuckDB extensions bundled per platform, SHA-256 pinned | packaged e2e `postgres` loads the postgres extension |
| Icon and accent in the Simple suite template | `npm run icons` |
| CI on Linux, Windows, macOS; deb/rpm install checks; security job | CI run for commit 9741835 |

## M1 — Data and SQL (in progress)

### Done

| Feature | Test |
|---|---|
| Excel xlsx/xlsm sheets, typed from every row (dates, numbers, text, booleans) | unit `sheets`, integration `engine` |
| Excel tables, named ranges, `Sheet!A1:D9` ranges; header and blank-row handling | unit `sheets` |
| CSV, TSV, JSON, JSON Lines, Parquet | integration `engine › flat files` |
| SQLite and DuckDB files (DuckDB file not locked while open) | integration `dbfiles` |
| PostgreSQL: extract and live (filters pushed to the server), table list | integration `postgres` |
| Connection dialog, explained errors (wrong password, unreachable host…) | e2e `postgres`, integration `postgres`, unit `sql › errors` |
| Passwords in the OS keychain (session-only without one), never in the project | e2e `postgres` |
| Excel ⨝ PostgreSQL join; derived columns; datasets; lineage | integration `postgres`, `engine` |
| Preview of any size (virtualized, paged from the engine) | e2e `data`, integration `engine › keeps big results` |
| Column profile (empty, distinct, range, duplicates, geographic roles, currency text) and type corrections | unit `sheets › profiling` |
| SQL editor: run statement/selection, cancel, parameters, explained errors, dataset save | e2e `data`, integration `engine` |
| Refresh: on open, changed file, unchanged file (rollback), missing file (last good data), recovery | integration `engine`, `postgres` |
| Reboot while a refresh runs | integration `reboot` |
| Malformed CSV, non-ZIP xlsx, zip bomb | integration `engine › flat files` |
| `.sviz` save/open, recents, schema version and migrations, no credentials | e2e `data`, unit `project` |

### Still to do in M1

- Source approval prompt for projects from another computer: implemented, test pending.
- Relink wizard: implemented, test pending.
- SQL editor completion, formatting, history, saved queries, plan, export: implemented, manual check; tests pending.
- Crash recovery for projects: implemented (shell), test pending.

## M2 — Charts and calculations ✅

### Done

| Feature | Test |
|---|---|
| Chart → SQL compiler: dimensions, aggregations (sum, average, median, count distinct, percentiles…), date grains | integration `charts` (values against hand-written SQL) |
| Filters: values (include/exclude), ranges, measure (HAVING), top N, context filters | integration `charts`, e2e `charts` |
| Calculated fields: DuckDB SQL + `[Field]`, Tableau `IF … ELSEIF … END`, Tableau function names (ZN, IIF, COUNTD, DATEADD…) | unit `calc`, integration `charts`, e2e `charts` |
| Level of detail: FIXED (before dimension filters, after context filters), INCLUDE, EXCLUDE; aggregated over one row per view × LOD combination, as Tableau documents | integration `charts` (5 LOD cases) |
| Table calculations: RUNNING_*, WINDOW_*, RANK*, LOOKUP, INDEX, SIZE, FIRST, LAST, TOTAL; quick calcs (running total, % of total, rank, difference, moving average, year over year) | integration `charts › table calculations` |
| Chart types: bar (grouped, stacked, 100%, horizontal), line, area, combo/dual axis, pie/donut, scatter/bubble, histogram, box plot, heat map, treemap, KPI card, table, crosstab | unit `charts`, e2e `charts` (bar, line, KPI drawn values = SQL) |
| Recommended chart type from the fields | unit `charts`, e2e `charts` |
| Drag and drop onto shelves; the same from each field's menu (keyboard) | e2e `charts` |
| Number formats, reference lines (average, median, min, max), trend line with R² | unit `charts` (option builders); manual check |
| Theme-aware charts (CSS tokens), tooltips escape data (no HTML injection) | unit `charts`, e2e `charts` |
| PNG (3×) / SVG / CSV export of a chart | manual check; tests pending |

### Known limitations

- Tableau's `+` for joining text is not supported (use `||`); no densification of missing marks.
- Table calculations "compute using" the x-axis dimensions (other dimensions are panes); there is no UI to change it yet.
- Calculated fields can't reference table calculations.

## M3 — Dashboards, refresh, export ✅

### Done

| Feature | Test |
|---|---|
| **Acceptance scenario, all 24 steps** (Excel + PostgreSQL → SQL dataset → charts → dashboard with a region filter → save → workbook changed → reopen with refreshed figures → dark/light → PDF → update check) | e2e `acceptance` |
| Dashboard canvas: add from the palette (free spot), drag charts in, move, resize (8 handles), 8 px grid snap, undo/redo | e2e `dashboards` |
| Align, distribute, group, lock, duplicate, delete; keyboard nudging | unit `charts › dashboard layout`; manual check |
| Layout containers (row/column), text with live values (`{region}`), images, shapes, buttons (reset, refresh, go to dashboard, present) | unit `dynamic titles`, e2e `dashboards` (dynamic text); others manual |
| Filter controls (list, dropdown, search, number range, date range) affecting every chart with the field | e2e `acceptance` |
| Cross-filtering by clicking marks, highlight actions, drill-through (go to dashboard with the selection), reset | unit `dashboard filtering`, e2e `dashboards` |
| Drill-down through a field path (categories or date grains), drill up | e2e `dashboards` |
| Sizes (desktop, laptop, tablet, phone, A4, Letter), fit-to-window, presentation mode with tabs | manual check |
| Refresh on open, on file change, on focus, on a timer, per source; per-dashboard timer; status and stale badges; last good data kept | integration `engine`, `postgres`; e2e `acceptance` |
| Password asked again when the keychain can't keep it or the server refuses it | e2e `acceptance` (CI has no keychain) |
| PDF export (exact page size, charts as images), PNG export | e2e `acceptance` (PDF, text checked with pdftotext), e2e `dashboards` (PNG) |

### Known limitations

- PNG export captures the dashboard as shown on screen (scaled to fit); PDF is at full size.
- Saved filter views (`Dashboard.views`) are in the model but have no UI yet.

## M4 — Data modeling and transforms ✅

### Done

| Feature | Test |
|---|---|
| Models: tables related by fields (logical layer); charts over a model use fields of every table | integration `model`, e2e `model` |
| No duplicated measures: each measure is counted once per combination of dimension values it relates to (fan-out safe); two fact tables sharing dimensions; coarser tables not multiplied; unmatched rows in a Null group | integration `model` (5 cases against known answers) |
| Relationship canvas: draggable table cards, relationship lines, suggestions (same-named keys, `id` ↔ `table_id`), loop and unrelated-table warnings | integration `model`, e2e `model` |
| Relationship preview: cardinality (one/many on each side) and matched rows | e2e `model` |
| Visual transforms: keep columns, rename, filter, calculated column, change type, fill empty, clean text, split, remove duplicates, sort, group and summarize, join, append (union), pivot, unpivot, custom SQL — each step previewed | integration `transform`, e2e `model` |
| Steps ⇄ SQL: the SQL view shows the generated SQL; "Edit as SQL" converts, and undo brings the steps back | e2e `model` |
| Date table (one row per day with year, quarter, month, week, weekday) | integration `transform` |
| Hierarchies: save a drill path, reuse it on any chart of the same data | manual check; test pending |

### Known limitations

- Calculated fields and top-N filters work on single tables and datasets, not on models yet.
- A model can't contain the same table twice (role-playing dimensions); loops are reported, not resolved.
- Transform steps are applied in the order listed; reordering a step doesn't rewrite the steps after it.

## Next

M5 — statistics and forecasting.

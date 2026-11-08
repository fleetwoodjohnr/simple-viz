# Implementation status

_Last updated: 2026-11-05 · M0–M7 complete (with the limits listed); M8 in progress; M9 not started ·
version 0.1.0 (unreleased) · verified with automated tests on Linux (Fedora 44); CI builds, packages and tests on
Linux, Windows and macOS._

"Done" means implemented **and** covered by a passing automated test. A button existing in the UI does not count.

## Test results (current, Fedora 44)

| Suite | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm test` (unit) | ✅ 93 tests |
| `npm run test:integration` (real DuckDB, files; PostgreSQL 17, MariaDB 11, SQL Server 2022, S3Mock, Azurite in podman) | ✅ 97 tests |
| `npm run e2e:headless` (the real app) | ✅ acceptance (24 steps), analytics, arrow/xls, charts, dashboards, data, maps, model, MySQL, PostgreSQL, remote files, SQL Server, smoke; updater (packaged only) |
| `npm run bench` (statistics on 10M rows) | ✅ see M5 |
| Packaged Linux build (`electron-builder --linux dir`) + e2e | ✅ |
| CI: Linux, Windows, macOS (arm64; Intel under Rosetta) build, test, package, test the packaged app; deb/rpm install on Ubuntu 22.04/24.04, Debian 12, Fedora 44; npm audit; CodeQL | ✅ run 42143235883 (commit 8b8a2c3). The M3, M4 and M5 runs had failed (an engine reboot under running queries, a save/recent-files race on Windows, stuck test workers); fixed in 8b8a2c3. The Intel smoke test under Rosetta passed on retry (first-launch translation); its launch wait no longer times out at 30 s |
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
| A project from another computer asks before reading its sources (native dialog); refused sources stay unloaded; allowed ones aren't asked again | e2e `projects` |
| Relink: a moved file is reported, and found again from the refresh status | e2e `projects` |
| Crash recovery: unsaved work restored after the app is killed | e2e `projects` |
| Portable copy (File → Save a Portable Copy): each table's cached data inside the `.sviz` as Parquet; on another computer it seeds the cache and stays the last good data until the sources can be read (live tables aren't included) | integration `formats`; UI path not yet covered by an e2e test |
| SQL editor: schema completion, formatting, plan, history, saved queries (in the project), CSV and Excel export | e2e `sqleditor` |

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
| Number formats, reference lines (average, median, min, max), trend line with R² | unit `charts` (option builders), e2e `layout` (average line in the app) |
| Theme-aware charts (CSS tokens), tooltips escape data (no HTML injection) | unit `charts`, e2e `charts` |
| PNG (high resolution) / SVG / CSV export of a chart | e2e `layout` |

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
| Align, distribute, group, lock, duplicate, delete; keyboard nudging | unit `charts › dashboard layout`, e2e `layout` |
| Layout containers (row/column), text with live values (`{region}`), images, shapes, buttons (reset, refresh, go to dashboard, present) | unit `dynamic titles`, e2e `dashboards` (dynamic text); others manual |
| Filter controls (list, dropdown, search, number range, date range) affecting every chart with the field | e2e `acceptance` |
| Cross-filtering by clicking marks, highlight actions, drill-through (go to dashboard with the selection), reset | unit `dashboard filtering`, e2e `dashboards` |
| Drill-down through a field path (categories or date grains), drill up | e2e `dashboards` |
| Sizes (desktop, laptop, tablet, phone, A4, Letter), fit-to-window, presentation mode with tabs | e2e `layout` (size preset keeps tiles inside, presentation and Escape); fit-to-window manual |
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
| Hierarchies: save a drill path, reuse it on any chart of the same data | e2e `layout` |

### Known limitations

- Calculated fields and top-N filters work on single tables and datasets, not on models yet.
- A model can't contain the same table twice (role-playing dimensions); loops are reported, not resolved.
- Transform steps are applied in the order listed; reordering a step doesn't rewrite the steps after it.

## M5 — Statistics and forecasting ✅

Reference values come from SciPy 1.18 and statsmodels 0.15 (`scripts/stats-ref.py` → `tests/fixtures/stats-ref.json`,
committed), on a 500-row fixture with known structure and a 60-month seasonal series.

### Done

| Feature | Test |
|---|---|
| Analytics workspace: pick an analysis, data and variables; result tables, chart, plain-language summary, assumptions, rows used and left out; CSV export | e2e `analytics` |
| Descriptive statistics (mean with CI, median, mode, sd, variance, percentiles, bias-corrected skewness and excess kurtosis, IQR outliers, histogram with normal curve) | integration `stats` vs SciPy; e2e `analytics` vs SQL |
| Missing values per column | integration `stats` |
| Pearson correlation matrix with p-values and covariances | integration `stats` vs SciPy |
| t-tests: one-sample, Welch two-sample (with Cohen's d), paired | integration `stats` vs SciPy |
| One-way ANOVA (with η²) | integration `stats` vs SciPy |
| Chi-square test of independence (with Cramér's V, small-expected-count warning) | integration `stats` vs SciPy |
| Mann–Whitney U (tie and continuity corrections) and Kruskal–Wallis | integration `stats` vs SciPy |
| Linear regression — simple, multiple, polynomial — from sufficient statistics over every row: coefficients, SE, t, p, CI, R², adjusted R², F, residual quantiles and plot; listwise deletion reported | integration `stats` vs statsmodels; e2e `analytics` vs DuckDB `regr_*` |
| Logistic regression (IRLS on a reproducible sample of up to 100,000 rows): coefficients, SE, odds ratios, McFadden R², likelihood-ratio test, accuracy | integration `stats` vs statsmodels |
| Forecasting: exponential smoothing (level, trend, additive season) with the model chosen by AICc and prediction intervals; missing periods filled | integration `stats` (recursion and forecasts equal statsmodels to 1e-9 for given parameters; fitted SSE within 5% of statsmodels' optimum); e2e `analytics` |
| K-means (standardized, k-means++ seeded, best of 5; k chosen by Calinski–Harabasz); save clusters as a dataset that labels every row | integration `stats`, e2e `analytics` |
| Principal components (correlation matrix, eigenvalues, loadings, Kaiser's rule) | integration `stats` vs NumPy |
| Anomalies by z-score or IQR, with the most extreme rows | integration `stats` |
| Chart overlays: forecast on line/area charts over a date axis (dashed, with its interval); ±1 SD band; existing average/median/min/max/trend lines | unit `charts`, e2e `analytics` |
| 10 million rows: describe 2.7 s, regression 1.7 s, logistic 1.8 s; extract 1.1 s (AMD Ryzen 3 3200U × 4, 13.6 GB, Fedora 44; 484 MB RSS) | `npm run bench` (asserts the known coefficients are recovered) |

### Known limitations

- ARIMA is not implemented; multiplicative seasonality and damped trends aren't either (additive exponential smoothing only).
- Logistic regression, k-means and the residual plot use a reproducible sample (100,000 / 20,000 / 2,000 rows); the
  workspace says so in the assumptions.
- Regression predictors must be numeric (no automatic dummy coding of categories yet).
- Forecast overlays need regular periods: a chart with a missing month, or sorted by value, draws no forecast.
- Statistics run on a dataset or table, not on a model.

## M6 — More chart types and maps ✅

### Done

| Feature | Test |
|---|---|
| Waterfall (running total and total bar), Pareto (sorted, cumulative %), funnel, gauge (scale), bullet (actual vs target) | unit `charts-more`; e2e `maps` (waterfall, Pareto, funnel, gauge = total profit) |
| Radar, sankey (flows between consecutive fields), network, sunburst | unit `charts-more`; e2e `maps` (radar, sunburst, sankey total = revenue) |
| Calendar heat map, candlestick (open/close/low/high), sparklines, Gantt (start/end dates per task) | unit `charts-more`; e2e `maps` (calendar) |
| Density and violin: binned in SQL over every row, Gaussian kernel (Silverman bandwidth) | unit (density integrates to 1), integration `charts` (bins = rows per group), e2e `maps` (violin) |
| Correlation matrix (SQL `corr()` over every row) and cohort retention (first period per entity, periods since) | integration `charts` (vs hand-written SQL), e2e `maps` (correlation = SQL) |
| Small multiples: Panels shelf, one panel per value (up to 24), shared value scale | unit `charts-more`, e2e `maps` |
| Maps: world countries and US states (Natural Earth 1:110m, public domain), matched by name, ISO 3166 alpha-2/3 or postal code, case- and accent-insensitive; automatic map choice; values not on the map listed | unit `charts-more`, e2e `maps` (6 states = totals) |
| Point maps (longitude/latitude, size, color) | unit `charts-more` |
| Custom maps from GeoJSON: checked (areas only, a naming property), kept in the project (portable), 25 MB limit | unit `charts-more`, e2e `maps` |
| Custom visuals: an ECharts option as JSON with `$categories`, `$values`, `$series`, `$items`, `$rows` placeholders; no code is evaluated, prototype keys dropped, tooltips forced to plain text | unit `charts-more`, e2e `maps` |
| A chart that can't be drawn shows why instead of taking the window down | e2e `maps` (map chosen before its data arrives) |
| Fix: histograms and box plots aggregated only the first 20,001 rows (the mark limit sat inside their query) | integration `charts` |
| Fix: ±1 SD bands (M5) didn't draw in the app (ECharts' markArea wasn't registered) | e2e `maps` |

### Known limitations

- Maps: no tile/basemap providers (offline-first and the content security policy); only the two bundled maps plus
  your own GeoJSON. Areas aren't matched across maps (a US state value on the world map is listed as not found).
- Point maps need longitude and latitude columns (no geocoding of addresses or place names).
- Gantt uses the dates' grain as chosen on the shelf; set it to "exact" for day precision.
- Small multiples apply to bar, line and area charts; dual axes are turned off in panels.
- Charts over a model don't use the wrapped queries (density, correlation, cohort) without the mark limit yet.

## M7 — More connectors ✅

Details per source, and what isn't supported (with reasons): [docs/CONNECTORS.md](docs/CONNECTORS.md).

### Done

| Feature | Test |
|---|---|
| MySQL / MariaDB, extract or live (bundled mysql extension, read-only attach, keychain password, SSL mode) | integration `mysql`, e2e `mysql` (MariaDB 11 in podman) |
| SQL Server / Azure SQL, extract (tedious, read-only intent, TLS from the SSL setting); typed columns incl. nullable ones | integration `sqlserver`, e2e `sqlserver` (SQL Server 2022 in podman, x64) |
| Files on the web (HTTP/S, optional bearer token), in Amazon S3 and S3-compatible storage (region, endpoint, path style, keys in the keychain), in Azure Blob (connection string); any format incl. spreadsheets; only each source's exact address is readable | integration `remote` (local server, S3Mock, Azurite), e2e `remote` |
| Excel 97–2003 `.xls`, read natively (BIFF8 in the sheet core: shared strings across records, RK/MULRK, cached formula results, 1900/1904 dates, hidden sheets); encrypted and Excel 95 files refused with a reason | unit `xls` (cell by cell against xlrd; hand-made records), integration `formats`, e2e `arrow` |
| Arrow IPC / Feather v2, uncompressed, LZ4 or ZSTD | unit `arrow` (pyarrow files), integration `formats`, e2e `arrow` |
| Any XML file: the repeated element is a row, attributes/children/nested leaves are typed columns; no entity expansion | unit `xmlrows`, integration `formats` |
| OpenDocument and Excel XML 2003 readers covered here too (they were only tested in Simple Cell) | unit `sheet-formats` |
| Fix: DuckDB's secret store initialised lazily after lockdown and was refused (remote credentials failed); now in memory, initialised before lockdown, persistent secrets off | integration `remote` |

### Known limitations

- `.xlsb`, Excel 95 `.xls`, password-protected workbooks, Redshift, Snowflake, BigQuery, Databricks, Athena, Trino,
  ClickHouse, Oracle, Google Sheets, ODBC/JDBC: not supported (reasons in docs/CONNECTORS.md).
- SQL Server is extract only. S3-compatible services other than the S3 emulator (MinIO, R2, GCS) use the same code but
  weren't tested against the services themselves.
- SQL Server, MySQL, S3 and Azure tests run where podman is available (Linux CI); they are skipped on Windows and macOS
  CI and say so.
- The bundled extensions add about 114 MB (uncompressed, Linux x64) for MySQL, web/S3 and Azure.

## Next

M8 — hardening, performance benchmarks, accessibility, documentation and a draft release.

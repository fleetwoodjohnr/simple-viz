# Architecture

Simple Viz is an Electron app in the Simple family. It shares its shell with [Simple Cell](../simple-cell) and
[Simple Docs](../simple-docs): title bar, settings, recents, crash recovery, the GitHub-Releases updater, the secure IPC
model, CI, and installers. Its own parts are an analytical engine (DuckDB) in a separate process, a project model, and the
data, SQL, chart, dashboard and analytics workspaces.

```
src/main/        Electron main process: window, secure IPC (validated arguments; only paths the user granted), atomic saves,
                 settings/recents/recovery (store.ts), updater, credentials (OS keychain), file watching,
                 engine-host.ts (starts the engine, restarts it, hands the window a port to it)
src/engine/      The engine, in an Electron utility process: DuckDB (@duckdb/node-api), locked down at boot.
                 engine.ts (boot, sandbox, SQL gate, queries, paging, refresh), ingest.ts (files, spreadsheets, databases)
src/preload/     contextBridge API (window.simpleViz) and the engine port handoff
src/shared/      Typed contracts: ipc-types.ts (main ⇄ renderer), engine-protocol.ts (engine messages + validators),
                 project.ts (the .sviz project model)
src/core/        Pure TypeScript, unit-tested: sql/ (AST walk for the gate and lineage, SQL text scanners), project/
                 (.sviz pack, unpack, migrations), calc/ (Tableau function macros), profile.ts, errors.ts,
                 sheets/ (spreadsheet readers and the XLSX writer, copied from Simple Cell; see its README)
src/renderer/    React UI: app/ (Home, Data, SQL editor, dialogs, commands), state/ (zustand store, project lifecycle,
                 engine client), ui/ (Radix-based kit from Simple Cell, virtualized DataGrid)
tests/           unit/ (vitest) · integration/ (real DuckDB, real files, PostgreSQL in podman or a CI service) ·
                 e2e/ (Playwright drives the real app, also the packaged one) · fixtures/ (npm run fixtures)
```

## Processes

| Process | Runs | Talks to |
|---|---|---|
| main | window, IPC, file grants, settings, keychain, file watcher, updater, PDF printing | renderer (IPC), engine (parentPort) |
| engine (utility process) | one DuckDB instance per open project, refresh, exports | main (control), renderer (its own MessagePort) |
| renderer | React UI, chart compilation | main (preload API), engine (MessagePort) |

Query results go from the engine to the window directly over a MessagePort, not through main. The renderer's port
accepts only `query`, `page`, `release`, `cancel`, `describe`, `explain` and `validate`, each validated
(`checkRendererRequest`). Sources, file paths, credentials, refresh and export come only from main.

Full datasets never reach JavaScript: charts receive aggregated SQL results, and grids page through results kept in the
engine (`LIMIT/OFFSET`), so a table of ten million rows costs only the rows on screen.

## Key decisions

**Electron rather than Tauri.** Same reasons as Simple Cell (shared shell, real-app tests on all three systems, identical
Chromium rendering of charts, built-in PDF printing), plus: DuckDB ships prebuilt Node bindings for Windows, macOS and
Linux on x64 and arm64, while a Rust build would compile DuckDB from source.

**DuckDB as the analytical engine.** Columnar, vectorized, spills to disk, reads CSV/Parquet/JSON natively, and attaches
PostgreSQL, SQLite and DuckDB files through official extensions. Extensions are bundled per platform at build time
(`scripts/fetch-duckdb-extensions.ts`, SHA-256 pinned) and loaded from disk: nothing is downloaded at runtime.

**Extracts are the cache.** Each project has `userData/cache/<projectId>.duckdb` holding one extract table per source
table. It is the offline copy, the last-known-good copy when a refresh fails, and what queries read. Views (source
aliases, datasets, Tableau-style macros) live in memory and are rebuilt from `project.json` at every boot, so the cache
can be deleted at any time and needs no migrations.

**Refresh is transactional.** A source is re-read into its extract inside a transaction; an order-independent
fingerprint (`count(*)`, `sum(hash(row))`) decides: identical data rolls back (nothing downstream changes), new data
commits. A failure rolls back and leaves the last good extract, marked stale with the error. Files whose size and
modification time are unchanged are not read again. Datasets are views, so derived columns recalculate on every read.

**Spreadsheets go through Simple Cell's readers.** XLSX/XLSM/ODS/XML 2003 are parsed by the same code Simple Cell uses
(zip-bomb limits, no DOCTYPE, macros never run), then typed from every row and appended to DuckDB. One code path for all
spreadsheet formats, sheets, Excel tables, named ranges and `Sheet!A1:D9` ranges.

**CodeMirror 6 for SQL.** The suite's editor; schema-aware completion from `@codemirror/lang-sql`; no CSP relaxation.

## Security

See [docs/SECURITY.md](docs/SECURITY.md). In short: window isolation and a strict CSP (from the suite); the engine
locks DuckDB to the project's files before any user SQL runs; every SQL string passes a gate that allows one SELECT over
known relations; projects never contain passwords (OS keychain); a project file cannot read files or reach servers the
user has not approved.

## Third-party licenses

| Component | License |
|---|---|
| Electron, React, Radix UI, zustand, Tailwind CSS, fflate, @xmldom/xmldom, CodeMirror 6, sql-formatter | MIT |
| DuckDB, @duckdb/node-api, DuckDB postgres and sqlite extensions | MIT |
| Apache ECharts | Apache-2.0 |
| lucide-react | ISC |
| Inter | SIL OFL 1.1 |
| electron-updater | MIT |

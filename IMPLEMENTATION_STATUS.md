# Implementation status

_Last updated: 2026-11-04 · M0 complete, M1 nearly complete; M2–M9 not started · version 0.1.0 (unreleased) ·
verified with automated tests on Linux (Fedora 44); Windows and macOS: see CI._

"Done" means implemented **and** covered by a passing automated test. A button existing in the UI does not count.

## Test results (current, Fedora 44)

| Suite | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm test` (unit) | ✅ 43 tests |
| `npm run test:integration` (real DuckDB, files, PostgreSQL 17 in podman) | ✅ 50 tests |
| `npm run e2e:headless` (the real app) | ✅ smoke, data workflow, PostgreSQL, updater (packaged only) |
| Packaged Linux build (`electron-builder --linux dir`) + e2e | ✅ |
| Windows, macOS | ⏳ CI (`.github/workflows/ci.yml`) |

## M0 — Scaffold ✅

| Feature | Test |
|---|---|
| Shell from Simple Cell (window, secure IPC, settings, recents, recovery, updater), renamed | e2e `smoke`, unit `updater` |
| Engine in a utility process; renderer ⇄ engine MessagePort | e2e `smoke` (`SELECT 40 + 2` from the page) |
| DuckDB lockdown and SQL gate | integration `sandbox` (19 attacks on the gate, 6 on the lockdown alone) |
| DuckDB extensions bundled per platform, SHA-256 pinned | packaged e2e `postgres` loads the postgres extension |
| Icon and accent in the Simple suite template | `npm run icons` |
| CI on Linux, Windows, macOS; deb/rpm install checks; security job | ⏳ first CI run |

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

## Next

M2 — chart builder and calculated fields.

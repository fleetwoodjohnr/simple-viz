# Security

Simple Viz reads business data. The threat it is built against: **a project file (or SQL pasted from somewhere) that
tries to read, change or send data the user did not intend.** Opening a `.sviz` file runs its SQL (datasets refresh on
open), so project SQL is treated as untrusted.

## Layers

1. **Window isolation** (from the Simple suite): `contextIsolation`, `sandbox`, no `nodeIntegration`, no navigation, no
   new windows, permissions limited to clipboard/fonts/fullscreen, and a strict Content-Security-Policy with no
   `unsafe-eval` and no network (`connect-src 'self'`). Every end-to-end test fails on a CSP violation.
2. **Source approval.** The engine reads only files and servers the user approved: picked in a dialog, dropped on the
   window, or listed in a native "Allow this project to read these data sources?" prompt (main process, not the page)
   when a project names sources this computer has not approved. Database servers count as approved once the user
   connected to them in the connection dialog.
3. **DuckDB lockdown** (`src/engine/engine.ts`, `boot`). Before any user SQL runs, the engine: loads its bundled
   extensions from disk with automatic installing and loading off; attaches the cache and the project's databases
   (PostgreSQL `READ_ONLY`, so the server refuses writes); then sets `allowed_paths` (the project's files),
   `allowed_directories` (the cache), `enable_external_access = false` and `lock_configuration = true`. After that,
   DuckDB itself refuses to read or write any other file, load extensions, attach databases or change settings.
   Adding a source starts a new engine instance.
4. **The SQL gate** (`Engine.gate`, `src/core/sql/ast.ts`). Every user and project SQL string — editor queries, dataset
   definitions, chart queries — must be exactly one statement of type SELECT, and its syntax tree (DuckDB's
   `json_serialize_sql`) may reference only the project's own relations and CTEs, and only the table functions `range`,
   `generate_series` and `unnest`. File paths in `FROM`, `read_csv()`, `query()`, `postgres_scan()`, `duckdb_*()`,
   `information_schema` and the cache are refused. The gate fails closed.
5. **No write path.** Simple Viz never writes to a data source. Exports are written by DuckDB into the cache's staging
   folder, then moved by main to the path the user chose in a save dialog.

`tests/integration/sandbox.test.ts` tries each attack against the gate, and again against the lockdown alone (gate
bypassed): reading `/etc/passwd`-style files, writing files, loading extensions, changing settings, attaching
databases, reading the cache, `postgres_scan` with an arbitrary server, two statements in one.

## Credentials

Database passwords are encrypted with the OS keychain (macOS Keychain, Windows DPAPI, libsecret/KWallet on Linux) via
Electron `safeStorage` and stored in `userData/credentials.json`, keyed by source id. Without a keychain (Linux
`basic_text`), passwords are kept in memory for the session only, and Settings → Security says so. Passwords go to
DuckDB as temporary secrets, never in connection strings (which `duckdb_databases()` would show), and never into the
renderer, logs or project files.

## Files

Spreadsheets are opened with Simple Cell's readers: ZIP limits against zip bombs (entry count, sizes, compression ratio,
checked again after inflating), DOCTYPE stripped before XML parsing (no entity expansion, no external entities). VBA and
other macros are never run. Workbooks over 512 MB are refused.

## Network

Simple Viz contacts only the databases the user adds and, once a day if enabled, GitHub's release feed for updates
(downloads are checked against the release's SHA-512). No telemetry.

## Dependencies

CI runs `npm audit --omit=dev` (what ships) and CodeQL on every push. DuckDB extensions are pinned by SHA-256
(`scripts/duckdb-extensions.lock.json`) and DuckDB verifies their signatures when loading.

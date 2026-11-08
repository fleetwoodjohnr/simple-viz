# Connectors

Every source becomes one or more tables you can query by name with SQL (`transactions`, `postgres_customers`…),
joined across sources. Simple Viz only ever **reads** a source. Passwords, keys and tokens are kept in the system
keychain (Linux without a keychain: for the session only), never in a project file. A project from someone else asks
before it reads any file, server or address it hasn't been allowed to read before.

## Files

| Format | Extensions | How it is read | Tested by |
|---|---|---|---|
| Excel workbook | .xlsx .xlsm .xltx .xltm | Simple Cell's reader: sheets, Excel tables, named ranges, cell ranges; cached formula values; dates from number formats. Macros are never run. | integration `engine`, e2e `data`, `acceptance` |
| Excel 97–2003 | .xls | A native BIFF8 reader in the same sheet core (no conversion, no LibreOffice): sheets, shared strings, numbers, booleans, errors, cached formula results, dates (1900 and 1904 systems). The macro storage is never read. | unit `xls` (against xlrd), integration `formats`, e2e `arrow` |
| OpenDocument spreadsheet | .ods | Simple Cell's reader | unit `sheet-formats` (a LibreOffice-written file) |
| Excel XML 2003 | .xml (SpreadsheetML) | Simple Cell's reader | unit `sheet-formats` |
| Any other XML | .xml | The most repeated element is a row (or the one you pick); attributes, child elements and nested leaves are columns, with types inferred. DOCTYPEs are dropped before parsing (no entities). | unit `xmlrows`, integration `formats` |
| CSV / TSV | .csv .txt .tsv .tab | DuckDB's reader (delimiter, quoting, types detected) | integration `engine` |
| JSON / JSON Lines | .json .jsonl .ndjson | DuckDB's reader | integration `engine` |
| Parquet | .parquet | DuckDB's reader | integration `engine` |
| Arrow IPC / Feather v2 | .arrow .feather .ipc .arrows | Apache Arrow's JS library; LZ4 and ZSTD compression | unit `arrow` (pyarrow files), integration `formats`, e2e `arrow` |
| SQLite | .sqlite .sqlite3 .db | DuckDB's sqlite extension, read-only | integration `dbfiles` |
| DuckDB | .duckdb | Attached read-only during a refresh only (the file isn't kept locked) | integration `dbfiles` |

Local files are watched: when a workbook is saved, the project refreshes (spreadsheet apps save by replacing the file;
the folder is watched). Large files are fine — extracts live in a local DuckDB cache, and charts query aggregates.

## Files on the web and in cloud storage

| Where | Address | Credentials | Tested by |
|---|---|---|---|
| Web (HTTP/HTTPS) | `https://…` | Optional bearer token | integration `remote` (local server, incl. a token-protected file), e2e `remote` |
| Amazon S3 | `s3://bucket/key` | Access key ID and secret key, region | integration `remote` (S3Mock, path style, custom endpoint) |
| S3-compatible (MinIO, Cloudflare R2, Google Cloud Storage with HMAC keys…) | `s3://…` with an endpoint | Same, plus the endpoint | Same code path as S3; not tested against those services themselves |
| Azure Blob / Data Lake | `az://container/blob` | Storage account connection string | integration `remote` (Azurite) |

Any file format above works. Each address is allowed individually: the engine can read that exact address and no
other. Remote files can't be watched, so they refresh on open, when you return to the app, on a timer or on demand;
unchanged data is detected by its content and kept as is.

## Databases

| Database | Modes | How | Tested by |
|---|---|---|---|
| PostgreSQL (and compatible servers) | Extract or live | DuckDB's postgres extension, attached read-only; filters pushed to the server in live mode | integration `postgres`, e2e `postgres`, `acceptance` (PostgreSQL 17) |
| MySQL / MariaDB | Extract or live | DuckDB's mysql extension, attached read-only | integration `mysql`, e2e `mysql` (MariaDB 11) |
| Microsoft SQL Server / Azure SQL | Extract | tedious (the standard Node driver), read-only intent; tables are copied into the cache | integration `sqlserver` (SQL Server 2022) |

*Extract* copies tables into the fast local cache (works offline; refreshed on open and on demand). *Live* queries the
server every time. A failed refresh keeps the last good data, marked stale with the reason; a wrong password asks for
the password again.

## Not supported yet

| Source | Why | Instead |
|---|---|---|
| Excel binary workbooks (.xlsb) | A different binary format (BIFF12); no reader yet | Save as .xlsx in Excel |
| Excel 95 and older (.xls BIFF5) | Old 8-bit format | Save as .xlsx |
| Password-protected workbooks | The file is encrypted | Remove the password in Excel |
| Amazon Redshift | The postgres extension relies on server features Redshift lacks; untested | Unload to S3 (Parquet) and read from S3 |
| Snowflake, BigQuery, Databricks, Athena, Trino, ClickHouse, Oracle | Each needs its own driver or API and authentication (often OAuth), none bundled yet | Export to Parquet/CSV in cloud storage and read it from there |
| Google Sheets | Needs OAuth sign-in | Publish to the web as CSV and add its address |
| ODBC / JDBC | Would need native drivers outside the sandbox | — |
| Writing back to a source | Simple Viz is read-only by design | — |

## Size

The DuckDB extensions are bundled (never downloaded at run time) and SHA-256 pinned per platform
(`scripts/duckdb-extensions.lock.json`): postgres, sqlite, mysql, httpfs and azure — about 225 MB uncompressed on
Linux x64, less in the compressed installers.

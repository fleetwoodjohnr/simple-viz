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
| Excel binary | .xlsb | A native BIFF12 reader in the same sheet core: sheets, shared strings, numbers, booleans, errors, cached formula results, dates by number format (1900 and 1904 systems). The macro part (vbaProject.bin) is never read. | unit `xlsb` (against pyxlsb on files made by Excel), integration `formats` |
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

Password-protected workbooks (.xlsx, .xlsm, .xlsb from Excel 2010 on; ECMA-376 Agile Encryption) are read when the
password is entered: the sheet list asks for it, it is kept in the system keychain with the source (never in the
project), the workbook is decrypted in memory only, and a wrong password asks again. Tested against workbooks
encrypted by msoffcrypto-tool (unit `decrypt`, integration `formats`, e2e `arrow`).

## Files on the web and in cloud storage

| Where | Address | Credentials | Tested by |
|---|---|---|---|
| Web (HTTP/HTTPS) | `https://…` | Optional bearer token | integration `remote` (local server, incl. a token-protected file), e2e `remote` |
| Amazon S3 | `s3://bucket/key` | Access key ID and secret key, region | integration `remote` (S3Mock, path style, custom endpoint) |
| S3-compatible (MinIO, Cloudflare R2, Google Cloud Storage with HMAC keys…) | `s3://…` with an endpoint | Same, plus the endpoint | Same code path as S3; not tested against those services themselves |
| Azure Blob / Data Lake | `az://container/blob` | Storage account connection string | integration `remote` (Azurite) |
| Google Sheets | The spreadsheet's address, `https://docs.google.com/spreadsheets/d/…` | None when it is shared as “Anyone with the link”; otherwise a service account's key (JSON) that the spreadsheet is shared with | integration `cloud-apis`, e2e `connectors`, against a local server answering as Google's export does (by link, through a service account with a read-only Drive token, not shared). **Not tested against Google itself** |

Any file format above works. Each address is allowed individually: the engine can read that exact address and no
other. Remote files can't be watched, so they refresh on open, when you return to the app, on a timer or on demand;
unchanged data is detected by its content and kept as is.

A Google Sheets spreadsheet is fetched as Google's own Excel export and read like any workbook (every sheet, named
tables, ranges). There is no interactive “Sign in with Google”: that needs an application registered with Google by
its publisher. A private spreadsheet read with a service account goes through Google Drive's export, which stops at
10 MB; a larger one must be shared by link.

## Databases

| Database | Modes | How | Tested by |
|---|---|---|---|
| PostgreSQL (and compatible servers) | Extract or live | DuckDB's postgres extension, attached read-only; filters pushed to the server in live mode | integration `postgres`, e2e `postgres`, `acceptance` (PostgreSQL 17) |
| MySQL / MariaDB | Extract or live | DuckDB's mysql extension, attached read-only | integration `mysql`, e2e `mysql` (MariaDB 11) |
| Microsoft SQL Server / Azure SQL | Extract | tedious (the standard Node driver), read-only intent; tables are copied into the cache | integration `sqlserver` (SQL Server 2022) |
| Oracle Database | Extract | node-oracledb in thin mode (no Oracle Client needed): a read-only transaction, 10,000 rows per fetch; dates and timestamps formatted by the server, numbers as text (no precision lost); *Database* is the service name; TLS (tcps) unless SSL is off | integration `warehouses` (Oracle Database 23ai Free: types, a join with Excel, many fetches, table lists, a wrong password) |
| Amazon Redshift | Extract | node-postgres (Redshift speaks PostgreSQL's protocol but lacks what DuckDB's postgres extension needs): a read-only transaction and a server-side cursor, 10,000 rows per fetch, values as the server's text | integration `postgres` (the same reader against PostgreSQL 17: types, many fetches, table lists). **Not tested against Redshift itself** |
| ClickHouse (and ClickHouse Cloud) | Extract | Its HTTP interface (8443 with TLS, 8123 without), every request with `readonly=1`; rows streamed into the cache with their types (64-bit unsigned and wider integers as doubles) | integration `warehouses` (ClickHouse 24.8) |
| Google BigQuery | Extract | Its REST API: a query job per table, result pages followed; signed in with a service-account key (exchanged for a read-only token with a signed JWT) or an access token; the *Database* field is the project (or project.dataset) | integration `warehouses` (the BigQuery emulator, paging included; sign-in against a local token server). Not tested against Google's service itself |
| Snowflake | Extract | The SQL API v2: key-pair authentication (a JWT signed with your private key, issued as ACCOUNT.USER.SHA256:fingerprint) or an OAuth token; statements still running are followed by their handle, results by partition; the user's default warehouse runs the queries | integration `cloud-apis`, against a local server answering as the API's documentation describes (sign-in, 202 replies, partitions, value formats). **Not tested against Snowflake itself** |
| Databricks | Extract | The SQL Statement Execution API with a personal access token; *User* is the SQL warehouse ID, *Database* `catalog.schema`; results inline (up to 25 MB per table), chunks followed on the same workspace only | integration `cloud-apis`, against a local server answering as the API's documentation describes. **Not tested against Databricks itself** |
| Amazon Athena | Extract | Its API, each request signed with your access key (Signature Version 4): one query per table, followed until it finishes (stopped if it runs past the time limit), result pages followed; *Host* is the region (or an endpoint), *Database* the database (or `catalog.database`); the workgroup and, where the workgroup has none, the S3 location for query results are part of the connection | integration `cloud-apis` (the signer against AWS's published examples; a local server answering as the API's documentation describes: queued and running queries, pages, value formats, a failed query) and `warehouses` (moto, an AWS emulator that verifies each request's signature). **Not tested against Athena itself** |
| Any database with an ODBC driver | Extract | DuckDB's odbc_scanner extension with a driver installed on your computer: a data source name (DSN) or a connection string; tables are listed where the database has a standard catalog, and can always be typed by name | integration `odbc`, e2e `connectors` (PostgreSQL 17 through its ODBC driver, psqlodbc, with unixODBC) |
| SAP HANA | Extract | ODBC with SAP's driver (HDBODBC, part of the SAP HANA client), which you install | The connection string and the “no driver installed” message only (integration `odbc`). **Not tested against SAP HANA**: its driver can't be redistributed or installed in our tests |
| Teradata | Extract | ODBC with Teradata's driver (Teradata Tools and Utilities), which you install | As SAP HANA. **Not tested against Teradata** |
| Trino / Presto (and Starburst) | Extract | Its REST protocol, following result pages on the same server only; the *Database* field is `catalog` or `catalog.schema`; passwords sent only over TLS | integration `warehouses` (Trino 470, TPC-H catalog) |

*Extract* copies tables into the fast local cache (works offline; refreshed on open and on demand). *Live* queries the
server every time. A failed refresh keeps the last good data, marked stale with the reason; a wrong password asks for
the password again.

**ODBC** needs a driver manager: Windows has one; on Linux and macOS install unixODBC (`unixodbc` in most package
managers, `brew install unixodbc`). A connection string kept in a project may name an installed driver or a DSN, but
not a password (it goes in the password box, and from there to the keychain), a file data source, or a driver given as
a file path: a project file from someone else can't make the app load a library of their choosing.

**Athena** signs in with an access key ID and secret access key. Temporary credentials (session tokens), SSO and
profiles from `~/.aws` are not supported. Athena bills for the data each query scans, and writes each result to S3:
the location is shown when a project from elsewhere asks to connect.

## Not supported yet

| Source | Why | Instead |
|---|---|---|
| Excel 95 and older (.xls BIFF5) | Old 8-bit format | Save as .xlsx |
| Password-protected .xls (Excel 97–2003) and Excel 2007 workbooks | Older encryption schemes (RC4, Standard) | Open in Excel and save as .xlsx (Excel 2010 and later encryption is read) |
| SQL Server in live mode | DuckDB has no SQL Server extension of its own. The only one is a third-party community extension: not signed by DuckDB, not built for every platform Simple Viz ships on, and it would add functions that user SQL could call | Extract (the default) works; refresh as often as needed |
| JDBC | Needs a Java runtime | The same databases have ODBC drivers |
| Interactive Google or AWS sign-in (OAuth, SSO) | Needs an application registered with each provider | A service account's key (Google); an access key (AWS) |
| Writing back to a source | Simple Viz is read-only by design | — |

## Size

The DuckDB extensions are bundled (never downloaded at run time) and SHA-256 pinned per platform
(`scripts/duckdb-extensions.lock.json`): postgres, sqlite, mysql, httpfs, azure and odbc — about 216 MB uncompressed on
Linux x64, less in the compressed installers.

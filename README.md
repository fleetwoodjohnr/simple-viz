# Simple Viz

<img src="resources/icons/128x128.png" alt="" width="96" align="right">

A fast, modern, open-source business intelligence app for your desktop: connect Excel files, CSVs and databases, query
any of them with SQL, build charts and interactive dashboards, and reopen them with the data refreshed automatically.
Your data stays on your computer. Part of the Simple family of apps, with [Simple Docs](https://github.com/fleetwoodjohnr/simple-docs)
and [Simple Cell](https://github.com/fleetwoodjohnr/simple-cell).

> **Young project.** Data connections, SQL, charts and maps, dashboards, data modeling, statistics and automatic
> refresh all work and are tested; see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exactly what is done, how it is
> tested, and what isn't there yet. Simple Viz does **not** claim Tableau compatibility.

![A dashboard in Simple Viz: a KPI, bars, a map, a forecast line and a filter](docs/screenshots/dashboard.png)

| Build charts by dragging fields | Query files and databases with SQL | Preview any table |
|---|---|---|
| ![The chart builder with fields, shelves and chart types](docs/screenshots/chart-builder.png) | ![The SQL editor with a query and its result](docs/screenshots/sql.png) | ![A table of an Excel workbook in the Data view](docs/screenshots/data.png) |

The screenshots show the example project that ships with the app (Home → *Example project*).

## Install

Download the installer for your computer from the [latest release](https://github.com/fleetwoodjohnr/simple-viz/releases/latest):

| System | File | How |
|---|---|---|
| Windows 10/11 (64-bit) | `Simple-Viz-Setup-<version>.exe` | Run it and follow the installer |
| macOS, Apple silicon (M1 and later) | `Simple-Viz-<version>-arm64.dmg` | Open it and drag Simple Viz to Applications |
| macOS, Intel | `Simple-Viz-<version>.dmg` | Open it and drag Simple Viz to Applications |
| Ubuntu, Debian | `simple-viz_<version>_amd64.deb` | `sudo apt install ./simple-viz_<version>_amd64.deb` |
| Fedora, RHEL, openSUSE | `simple-viz-<version>.x86_64.rpm` | `sudo dnf install ./simple-viz-<version>.x86_64.rpm` |
| Other Linux (x64) | `Simple-Viz-<version>.AppImage` | `chmod +x Simple-Viz-<version>.AppImage`, then run it |

**The installers aren't code-signed yet**, so the system warns the first time:

- **Windows:** on the “Windows protected your PC” screen choose *More info* → *Run anyway*.
- **macOS:** open the app once, then go to System Settings → Privacy & Security and choose *Open Anyway* (on older
  versions: right-click the app → *Open*).

The app checks for a newer release once a day and asks before installing it (turn this off in Settings → About and
updates); on macOS it opens the release page instead. Nothing else is sent anywhere.

To connect through ODBC on Linux or macOS, also install unixODBC (`sudo apt install unixodbc`,
`sudo dnf install unixODBC`, `brew install unixodbc`) and your database's driver.

To build from source: `npm ci`, then `npm run dev` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## What it does

- **Connect.** Excel (`.xlsx`, `.xlsm`, `.xls`, `.xlsb`), OpenDocument (`.ods`), CSV, TSV, JSON, Parquet, Arrow/Feather, XML,
  SQLite and DuckDB files — on your computer, on the web, in Amazon S3 (and compatible storage) or Azure Blob storage —
  and PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, Amazon Redshift, ClickHouse, Trino/Presto, BigQuery, Snowflake, Databricks and Athena, any database with an ODBC driver, and Google Sheets. Choose sheets, Excel tables, named ranges or cell ranges. Drop files
  anywhere in the window. See [docs/CONNECTORS.md](docs/CONNECTORS.md).
- **SQL on any of it.** A sheet called `Transactions` becomes a table called `transactions`. Join it with a PostgreSQL
  table, add calculated columns, and save the query as a dataset — no database import needed. Powered by DuckDB.
- **Always current.** When a project opens, Simple Viz checks every source; edited spreadsheets and changed tables are
  re-read, and everything built on them recalculates. If a source is unavailable you see the last good data, clearly
  marked.
- **Charts and dashboards.** 33 chart types — from bars and lines to waterfalls, sankeys, Gantt charts, cohorts,
  violins, maps of countries or states (or your own GeoJSON) and small multiples. Drag fields to build charts, with calculated fields that follow Tableau's rules (level of
  detail, table calculations), groups, sets and parameters. Relate tables in a model and chart across them without
  double counting. Put charts on a dashboard: clicking one filters the others; filters, drill-down, parameter and set
  actions, saved views, text that shows the current selection, stories; export to PDF, PNG or a self-contained web
  page. Start from the example project on Home.
- **Statistics.** Descriptive statistics, correlation, t-tests, ANOVA, chi-square, rank tests, linear and logistic
  regression, forecasting (exponential smoothing and ARIMA), clustering and principal components, each with a plain-language summary and its
  assumptions, checked against SciPy and statsmodels. Forecasts and bands on charts.
- **Private.** No account, no telemetry. Passwords live in your system keychain, never in project files. Queries only
  read: your files and databases are never changed.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — set up, test, definition of done
- [ARCHITECTURE.md](ARCHITECTURE.md) — processes, engine, key decisions
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and protections
- [docs/CONNECTORS.md](docs/CONNECTORS.md) — every source, how it's read and tested, and what isn't supported yet
- [docs/SQL.md](docs/SQL.md) and [docs/CALCULATIONS.md](docs/CALCULATIONS.md) — writing queries and calculated fields
- [docs/TABLEAU_PARITY.md](docs/TABLEAU_PARITY.md) — what Simple Viz does compared with Tableau, with sources
- [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md) — the `.sviz` file, portable copies, migrations
- [docs/PERFORMANCE_BENCHMARKS.md](docs/PERFORMANCE_BENCHMARKS.md) — timings at 10 thousand to 10 million rows
- [docs/BUILD_AND_RELEASE.md](docs/BUILD_AND_RELEASE.md) — building, testing, signing and releasing

## License

MIT. The bundled world and US state maps and the city list are from [Natural Earth](https://www.naturalearthdata.com/)
(public domain); US ZIP code locations are from the US Census Bureau's 2020 gazetteer (public domain); other countries'
postal codes are from [GeoNames](https://www.geonames.org/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
All are generated by `npm run geo`.

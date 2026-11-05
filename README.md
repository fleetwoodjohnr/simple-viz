# Simple Viz

<img src="resources/icons/128x128.png" alt="" width="96" align="right">

A fast, modern, open-source business intelligence app for your desktop: connect Excel files, CSVs and databases, query
any of them with SQL, build charts and interactive dashboards, and reopen them with the data refreshed automatically.
Your data stays on your computer. Part of the Simple family of apps, with [Simple Docs](https://github.com/fleetwoodjohnr/simple-docs)
and [Simple Cell](https://github.com/fleetwoodjohnr/simple-cell).

> **Early development.** Data connections, the SQL workspace and automatic refresh work today; charts, dashboards and
> analytics are being built. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exactly what is done and
> tested. Simple Viz does **not** claim Tableau compatibility.

## What it does

- **Connect.** Excel (`.xlsx`, `.xlsm`), OpenDocument (`.ods`), CSV, TSV, JSON, Parquet, SQLite and DuckDB files, and
  PostgreSQL. Choose sheets, Excel tables, named ranges or cell ranges. Drop files anywhere in the window.
- **SQL on any of it.** A sheet called `Transactions` becomes a table called `transactions`. Join it with a PostgreSQL
  table, add calculated columns, and save the query as a dataset — no database import needed. Powered by DuckDB.
- **Always current.** When a project opens, Simple Viz checks every source; edited spreadsheets and changed tables are
  re-read, and everything built on them recalculates. If a source is unavailable you see the last good data, clearly
  marked.
- **Private.** No account, no telemetry. Passwords live in your system keychain, never in project files. Queries only
  read: your files and databases are never changed.

## Build from source

- [CONTRIBUTING.md](CONTRIBUTING.md) — set up, test, definition of done
- [ARCHITECTURE.md](ARCHITECTURE.md) — processes, engine, key decisions
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and protections

## License

MIT

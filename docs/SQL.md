# SQL in Simple Viz

The SQL workspace, datasets and every chart run on [DuckDB](https://duckdb.org/docs/sql/introduction)'s SQL dialect
(PostgreSQL-like, with many conveniences). This page covers what is specific to Simple Viz.

## Tables

Every source table has a name you choose (an *alias*), made SQL-friendly from the sheet, file or table name: a sheet
called `Transactions` becomes `transactions`, a PostgreSQL table `public.customers` becomes `customers` (or
`postgres_customers` if the name is taken). The schema list on the left of the SQL workspace shows them all, with
their columns; completion offers them as you type.

Sources join with plain SQL, whatever they are:

```sql
SELECT c.region, sum(t.revenue) AS revenue
FROM transactions t                -- an Excel sheet
JOIN customers c USING (customer_id)  -- a PostgreSQL table
GROUP BY ALL
ORDER BY revenue DESC
```

A **dataset** is a saved query that other queries, charts and dashboards use by name, like a table. It recalculates
when its sources refresh. Save one with **Save as dataset**.

## What a query may do

Simple Viz only reads. Each query is checked before it runs:

- **One statement**, and it must be a query (`SELECT`, or `WITH … SELECT`). `INSERT`,
  `UPDATE`, `DELETE`, `CREATE`, `COPY`, `ATTACH`, `INSTALL`, `LOAD`, `SET`, `PRAGMA` and the like are refused.
- **Only the project's tables and datasets** (and CTEs you define). File paths (`FROM 'data.csv'`), `read_csv`,
  `read_parquet`, `postgres_scan`, `query()` and other table functions that reach files, URLs or servers are refused —
  add the file as a source instead. The table functions `range`, `generate_series` and `unnest` are allowed.
- The engine is locked down besides: it can read only the project's own files and addresses, and its settings can't
  be changed. See [SECURITY.md](SECURITY.md).

Database sources in *live* mode are attached read-only, so a query can't change them even in principle.

## Parameters

Write `$name` in a query and a box appears above the editor to give it a value:

```sql
SELECT * FROM transactions WHERE order_date >= $from AND region = $region
```

Values are bound as parameters (never pasted into the SQL). Numbers and `true`/`false` are recognised; anything else
is text (DuckDB converts text such as `2025-01-31` where a date is compared).

## Editor

| | |
|---|---|
| Run the statement at the cursor (or the selection) | Ctrl/⌘+Enter, or Shift+Enter |
| Format | Ctrl/⌘+Shift+F |
| Cancel a running query | Escape |
| New tab / close a tab | Ctrl/⌘+T / Delete on the tab |
| Plan | Shows how the query runs: which sources are read, and what is pushed down to databases |

Errors point at the place in the query. Results page through any number of rows and export to CSV, Excel or Parquet.
History and saved queries are on the left (saved queries are kept in the project file).

## Tableau function names

Calculated fields — and SQL — understand Tableau's names for common functions: `ZN`, `IIF`, `COUNTD`, `ATTR`,
`DATEADD`, `MID`, `FIND`, `STARTSWITH`, `ENDSWITH`, `STR`, `FLOAT`, `INT`, `TODAY`, `MAKEDATE`, `DIV`, `STDEV`,
`STDEVP`, `VAR`, `VARP`, `PERCENTILE`, `COVAR`, `COVARP`. Many others (`DATEDIFF`, `DATEPART`, `DATETRUNC`,
`CONTAINS`, `LEFT`, `RIGHT`, `UPPER`, `LOWER`, `TRIM`, `ABS`, `ROUND`, `YEAR`, `MONTH`, `DAY`) are DuckDB functions
already. Calculated fields add more on top: see [CALCULATIONS.md](CALCULATIONS.md).

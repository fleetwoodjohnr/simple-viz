# Changelog

## 0.1.0 (unreleased)

- **Data.** Excel (xlsx, xlsm), OpenDocument, XML 2003, CSV, TSV, JSON, JSON Lines, Parquet, SQLite and DuckDB files;
  PostgreSQL as a fast local extract or live. Pick sheets, Excel tables, named ranges or cell ranges. Previews of any
  size, column profiles (empty values, distinct values, ranges, duplicates, geographic roles) and type corrections,
  including numbers stored as currency text.
- **SQL on everything.** Every sheet, file and table is queryable by name with DuckDB SQL, joined across sources.
  Editor with tabs, schema-aware completion, live error checking, formatting, parameters, cancel, history, saved
  queries, execution plans, and CSV/Excel/Parquet export. Save a query as a dataset for charts and other queries.
- **Always current.** Sources refresh when the project opens, when a file changes, when you return to the app, or on a
  timer; a failed refresh keeps the last good data, marked stale with the reason.
- **Charts.** Drag fields onto shelves; Simple Viz suggests the chart type. Bar, line, area, combo, pie, scatter,
  histogram, box plot, heat map, treemap, KPI, table and crosstab. Calculated fields with Tableau's syntax and
  semantics: FIXED/INCLUDE/EXCLUDE level of detail, table calculations, quick calculations. Filters, top N, reference
  and trend lines, number formats; PNG, SVG and CSV export.
- **Dashboards.** Drag charts onto a canvas, resize, align, group, lock; text with live values, filter controls,
  buttons, images. Click a bar to filter the other charts; drill down; go to another dashboard. Presentation mode.
  PDF and PNG export.
- **Data modeling.** Relate tables by shared fields and chart across them without double-counting (Tableau-style
  relationships, several fact tables). Visual transforms — filter, calculate, join, group, pivot, unpivot and more —
  with a live preview and the equivalent SQL. Date tables and hierarchies.
- **Statistics.** An Analytics workspace: descriptive statistics, missing values, correlation, anomalies, t-tests
  (one-sample, Welch, paired), ANOVA, chi-square, Mann–Whitney, Kruskal–Wallis, simple/multiple/polynomial
  regression, logistic regression, exponential-smoothing forecasts (trend and season chosen by AICc, prediction
  intervals), k-means clustering (save the clusters as a dataset) and principal components. Each result has a
  chart, a plain-language summary, its assumptions, and the rows used. Validated against SciPy and statsmodels;
  regression on 10 million rows in under 2 seconds. Forecast overlays and standard-deviation bands on charts.
- **Secure by design.** Read-only SQL, locked-down engine, passwords in the system keychain, approval before a project
  reads new sources.

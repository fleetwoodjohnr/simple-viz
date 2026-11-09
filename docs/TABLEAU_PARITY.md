# Tableau parity

How Simple Viz compares with Tableau Desktop, feature by feature, with a link to Tableau's own documentation for
each. **Simple Viz does not open or save Tableau files** (`.twb`, `.twbx`, `.hyper`) and does not claim compatibility:
the comparison is about what you can do, and — for calculations — whether the results follow Tableau's rules.

✅ supported and tested · ◐ partly (see notes) · ✗ not yet. "Tested" names refer to `IMPLEMENTATION_STATUS.md`.

_Checked against Tableau's documentation on 8 November 2026._

## Data

| Tableau | Simple Viz | |
|---|---|---|
| [Connectors](https://help.tableau.com/current/pro/desktop/en-us/exampleconnections_overview.htm) | Excel (incl. .xls and .xlsb), OpenDocument, CSV/TSV, JSON, Parquet, Arrow, XML, SQLite, DuckDB; PostgreSQL, MySQL/MariaDB, SQL Server; files on the web, S3 and Azure Blob | ◐ Snowflake, BigQuery, Databricks, Oracle, Redshift and others not yet ([CONNECTORS.md](CONNECTORS.md)) |
| [Extracts](https://help.tableau.com/current/pro/desktop/en-us/extracting_data.htm) | Every source can be a local extract (DuckDB), refreshed on open, on file change, on focus or on a timer; last good data kept on failure | ✅ |
| Live connections | PostgreSQL and MySQL, read-only | ◐ SQL Server is extract only |
| [Relationships and the data model](https://help.tableau.com/current/pro/desktop/en-us/datasource_datamodel.htm), [relating tables](https://help.tableau.com/current/pro/desktop/en-us/relate_tables.htm) | Models: tables related by fields, measures aggregated at their own grain (no double counting), unmatched rows kept | ◐ No role-playing (same table twice); no LOD expressions or table calculations on models |
| [Joins and unions](https://help.tableau.com/current/pro/desktop/en-us/datasource_multitable_normalized.htm) | SQL datasets, or visual Join/Append steps | ✅ |
| [Data Interpreter](https://help.tableau.com/current/pro/desktop/en-us/data_interpreter.htm) | Pick a sheet, Excel table, named range or cell range; column profiles; type corrections (incl. currency text, day-first dates) | ◐ No automatic detection of headers and sub-tables in messy sheets |
| Data preparation | Visual transform steps (filter, calculate, split, pivot, unpivot, group, join, append…) ⇄ SQL | ✅ |

## Calculations

| Tableau | Simple Viz | |
|---|---|---|
| [Calculated fields](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_create.htm), [formatting formulas](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_formulas.htm) | `[Field]` references, `IF … ELSEIF … END`, Tableau function names (`ZN`, `IIF`, `COUNTD`, `ATTR`, `DATEADD`…), `+` joining text, plus all of DuckDB SQL | ◐ `+` next to another calculated field that returns text needs `\|\|` |
| [Date functions](https://help.tableau.com/current/pro/desktop/en-us/functions_functions_date.htm) | `DATEADD`, `DATEDIFF`, `DATEPART`, `DATETRUNC`, `TODAY`, `MAKEDATE`… | ✅ |
| [Level of detail expressions](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_lod.htm) | `{FIXED / INCLUDE / EXCLUDE dims : agg}` with Tableau's filter interaction and aggregation rules | ✅ checked against the documentation's examples |
| [Table calculations](https://help.tableau.com/current/pro/desktop/en-us/calculations_tablecalculations.htm), [functions](https://help.tableau.com/current/pro/desktop/en-us/functions_functions_tablecalculation.htm) | Running, window, rank, lookup, index, size, first, last, total, percent of total; quick table calculations | ◐ "Compute using" one dimension of the view (pill menu), not a combination with a restart order; densification (Show missing dates) on a date axis only |
| [Order of operations](https://help.tableau.com/current/pro/desktop/en-us/order_of_operations.htm) | Context filters → FIXED → dimension filters and top N → INCLUDE/EXCLUDE → measure filters → table calculations | ✅ |
| [Context filters](https://help.tableau.com/current/pro/desktop/en-us/filtering_context.htm) | Any filter can be a context filter | ✅ |
| [Parameters](https://help.tableau.com/current/pro/desktop/en-us/parameters_create.htm) | Number, text, date, yes/no, with lists; in formulas (and so in calculated filters), reference lines, dashboard controls and parameter actions | ◐ Filters can't bind to a parameter directly (use a calculated field); no range limits in the control |
| [Hierarchies](https://help.tableau.com/current/pro/desktop/en-us/qs_hierarchies.htm) | Drill paths saved and reused; drill down/up on dashboards | ✅ |
| [Groups](https://help.tableau.com/current/pro/desktop/en-us/sortgroup_groups_creating.htm) | Field menu → Create group…: tick values, name the group (the rest keep their names or become Other); saved as an editable calculated field | ◐ Not by selecting marks in the chart |
| [Sets](https://help.tableau.com/current/pro/desktop/en-us/sortgroup_sets_create.htm) | — | ✗ |

## Charts and analytics

| Tableau | Simple Viz | |
|---|---|---|
| Show Me | Recommended chart type from the fields, among 33 types | ✅ |
| [Marks: color, size, label, detail, tooltip](https://help.tableau.com/current/pro/desktop/en-us/viewparts_marks_markproperties_color.htm) | Shelves for each; small multiples (Panels) | ✅ |
| [Box plots](https://help.tableau.com/current/pro/desktop/en-us/buildexamples_boxplot.htm), [bullet graphs](https://help.tableau.com/current/pro/desktop/en-us/qs_bullet_graphs.htm), [Pareto](https://help.tableau.com/current/pro/desktop/en-us/pareto.htm), [combination charts](https://help.tableau.com/current/pro/desktop/en-us/qs_combo_charts.htm) | All four, plus waterfall, funnel, gauge, radar, sankey, network, sunburst, calendar, candlestick, Gantt, density, violin, correlation matrix, cohort | ✅ |
| [Maps](https://help.tableau.com/current/pro/desktop/en-us/maps_build.htm) | Countries and US states (names or codes), point maps from latitude/longitude | ◐ No background map tiles; no built-in geocoding of cities or postcodes |
| [Spatial files](https://help.tableau.com/current/pro/desktop/en-us/maps_shapefiles.htm) | GeoJSON areas, kept in the project | ◐ No Shapefile, KML or MapInfo |
| [Reference lines and bands](https://help.tableau.com/current/pro/desktop/en-us/reference_lines.htm) | Constant, parameter, average, median, min, max; ±1 standard deviation band | ◐ No distributions other than ±SD, no reference boxes |
| [Trend lines](https://help.tableau.com/current/pro/desktop/en-us/trendlines_add.htm) | Linear with R² on charts; linear, multiple and polynomial regression with full statistics in Analytics | ◐ No logarithmic/exponential/power trend lines on charts |
| [Forecasting](https://help.tableau.com/current/pro/desktop/en-us/forecasting.htm) | Exponential smoothing (level, trend, additive or multiplicative season) chosen by AICc, prediction intervals, on charts and in Analytics | ◐ No multiplicative or damped trend; no ARIMA |
| [Clustering](https://help.tableau.com/current/pro/desktop/en-us/clustering.htm) | k-means (k chosen by Calinski–Harabasz, as Tableau), clusters saved as a dataset | ◐ In Analytics, not dragged onto a chart |
| Statistics | Descriptives, correlation, t-tests, ANOVA, chi-square, rank tests, regression, logistic regression, PCA, anomalies — validated against SciPy and statsmodels | ✅ (beyond Tableau) |
| [Viz in tooltip](https://help.tableau.com/current/pro/desktop/en-us/viz_in_tooltip.htm) | — | ✗ |

## Dashboards

| Tableau | Simple Viz | |
|---|---|---|
| [Dashboards](https://help.tableau.com/current/pro/desktop/en-us/dashboards_create.htm) | Charts, text with live values, images, shapes, buttons, filter controls, layout containers | ✅ |
| [Floating and tiled layout](https://help.tableau.com/current/pro/desktop/en-us/dashboards_organize_floatingandtiled.htm) | Free canvas with grid snapping, align, distribute, group, lock; row/column containers | ◐ No tiled auto-layout |
| [Actions](https://help.tableau.com/current/pro/desktop/en-us/actions.htm) | Filter, highlight, go to dashboard, open a web page (`{Field}` or `<Field>` in the address), set a parameter | ◐ No set actions |
| [Device layouts](https://help.tableau.com/current/pro/desktop/en-us/dashboards_dsd_create.htm) | Size presets (desktop, laptop, tablet, phone, A4, Letter) | ◐ One layout per dashboard |
| Presentation | Presentation mode with dashboard tabs | ✅ |
| [Stories](https://help.tableau.com/current/pro/desktop/en-us/stories.htm) | — | ✗ |
| Export | Dashboards: PDF (page sizes), PNG and a self-contained web page (HTML); charts: PNG, SVG and CSV; query results: CSV, Excel and Parquet | ✅ |

## Sharing

| Tableau | Simple Viz | |
|---|---|---|
| Packaged workbooks (`.twbx`) | Portable copy: the project with its data (Parquet) inside | ✅ |
| Tableau Server / Cloud, subscriptions, permissions | Simple Viz is a desktop app; share project files | ✗ Out of scope |
| Opening Tableau workbooks | — | ✗ Not planned |

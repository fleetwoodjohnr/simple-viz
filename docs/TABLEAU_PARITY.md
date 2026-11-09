# Tableau parity

How Simple Viz compares with Tableau Desktop, feature by feature, with a link to Tableau's own documentation for
each. **Simple Viz does not open or save Tableau files** (`.twb`, `.twbx`, `.hyper`) and does not claim compatibility:
the comparison is about what you can do, and — for calculations — whether the results follow Tableau's rules.

✅ supported and tested · ◐ partly (see notes) · ✗ not yet. "Tested" names refer to `IMPLEMENTATION_STATUS.md`.

_Checked against Tableau's documentation on 8 November 2026._

## Data

| Tableau | Simple Viz | |
|---|---|---|
| [Connectors](https://help.tableau.com/current/pro/desktop/en-us/exampleconnections_overview.htm) | Excel (incl. .xls and .xlsb), OpenDocument, CSV/TSV, JSON, Parquet, Arrow, XML, SQLite, DuckDB; PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, Redshift, ClickHouse, Trino/Presto, BigQuery, Snowflake, Databricks; files on the web, S3 and Azure Blob | ◐ Athena, SAP HANA, Teradata and others not yet; Snowflake, Databricks and Redshift tested against their documented APIs or protocol, not the services ([CONNECTORS.md](CONNECTORS.md)) |
| [Extracts](https://help.tableau.com/current/pro/desktop/en-us/extracting_data.htm) | Every source can be a local extract (DuckDB), refreshed on open, on file change, on focus or on a timer; last good data kept on failure | ✅ |
| Live connections | PostgreSQL and MySQL, read-only | ◐ SQL Server is extract only |
| [Relationships and the data model](https://help.tableau.com/current/pro/desktop/en-us/datasource_datamodel.htm), [relating tables](https://help.tableau.com/current/pro/desktop/en-us/relate_tables.htm) | Models: tables related by fields, measures aggregated at their own grain (no double counting), unmatched rows kept; one table in several roles (order and ship dates); LOD expressions, table calculations and computed sets on models | ✅ |
| [Joins and unions](https://help.tableau.com/current/pro/desktop/en-us/datasource_multitable_normalized.htm) | SQL datasets, or visual Join/Append steps | ✅ |
| [Data Interpreter](https://help.tableau.com/current/pro/desktop/en-us/data_interpreter.htm) | Tables inside messy sheets found and picked (titles and notes above or below left out, several tables in one sheet, headers found, an empty row inside a table kept); or pick a sheet, Excel table, named range or cell range; column profiles; type corrections (incl. currency text, day-first dates) | ◐ Tables side by side (separated only by empty columns) aren't split; merged header rows aren't combined |
| Data preparation | Visual transform steps (filter, calculate, split, pivot, unpivot, group, join, append…) ⇄ SQL | ✅ |

## Calculations

| Tableau | Simple Viz | |
|---|---|---|
| [Calculated fields](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_create.htm), [formatting formulas](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_formulas.htm) | `[Field]` references, `IF … ELSEIF … END`, Tableau function names (`ZN`, `IIF`, `COUNTD`, `ATTR`, `DATEADD`…), `+` joining text (next to text values, fields, functions or calculated fields that return text), plus all of DuckDB SQL | ✅ |
| [Date functions](https://help.tableau.com/current/pro/desktop/en-us/functions_functions_date.htm) | `DATEADD`, `DATEDIFF`, `DATEPART`, `DATETRUNC`, `TODAY`, `MAKEDATE`… | ✅ |
| [Level of detail expressions](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_lod.htm) | `{FIXED / INCLUDE / EXCLUDE dims : agg}` with Tableau's filter interaction and aggregation rules | ✅ checked against the documentation's examples |
| [Table calculations](https://help.tableau.com/current/pro/desktop/en-us/calculations_tablecalculations.htm), [functions](https://help.tableau.com/current/pro/desktop/en-us/functions_functions_tablecalculation.htm) | Running, window, rank, lookup, index, size, first, last, total, percent of total; quick table calculations; "compute using" any of the view's dimensions, in a chosen order, restarting every one of them | ◐ Densification (Show missing dates) on a date axis only |
| [Order of operations](https://help.tableau.com/current/pro/desktop/en-us/order_of_operations.htm) | Context filters → FIXED → dimension filters and top N → INCLUDE/EXCLUDE → measure filters → table calculations | ✅ |
| [Context filters](https://help.tableau.com/current/pro/desktop/en-us/filtering_context.htm) | Any filter can be a context filter | ✅ |
| [Parameters](https://help.tableau.com/current/pro/desktop/en-us/parameters_create.htm) | Number, text, date, yes/no, with lists; in formulas (and so in calculated filters), reference lines, dashboard controls and parameter actions; filters follow a parameter (a value, either end of a range, top N); a range with limits and steps makes the control a slider | ✅ |
| [Hierarchies](https://help.tableau.com/current/pro/desktop/en-us/qs_hierarchies.htm) | Drill paths saved and reused; drill down/up on dashboards | ✅ |
| [Groups](https://help.tableau.com/current/pro/desktop/en-us/sortgroup_groups_creating.htm) | Field menu → Create group…: tick values, name the group (the rest keep their names or become Other); saved as an editable calculated field; or pick marks on the chart and Group them | ✅ |
| [Sets](https://help.tableau.com/current/pro/desktop/en-us/sortgroup_sets_create.htm), [combined sets](https://help.tableau.com/current/pro/desktop/en-us/sortgroup_sets_combine.htm) | Field menu → Create set…: picked members, a condition (`SUM([Sales]) > 1000`) or the top/bottom N by a measure, computed after context filters; two sets combined (either, both, first only); set actions change the members | ✅ |

## Charts and analytics

| Tableau | Simple Viz | |
|---|---|---|
| Show Me | Recommended chart type from the fields, among 33 types | ✅ |
| [Marks: color, size, label, detail, tooltip](https://help.tableau.com/current/pro/desktop/en-us/viewparts_marks_markproperties_color.htm) | Shelves for each; small multiples (Panels) | ✅ |
| [Box plots](https://help.tableau.com/current/pro/desktop/en-us/buildexamples_boxplot.htm), [bullet graphs](https://help.tableau.com/current/pro/desktop/en-us/qs_bullet_graphs.htm), [Pareto](https://help.tableau.com/current/pro/desktop/en-us/pareto.htm), [combination charts](https://help.tableau.com/current/pro/desktop/en-us/qs_combo_charts.htm) | All four, plus waterfall, funnel, gauge, radar, sankey, network, sunburst, calendar, candlestick, Gantt, density, violin, correlation matrix, cohort | ✅ |
| [Maps](https://help.tableau.com/current/pro/desktop/en-us/maps_build.htm), [geographic roles](https://help.tableau.com/current/pro/desktop/en-us/maps_geographicroles.htm) | Countries and US states (names or codes); point maps from latitude/longitude, or placed by name: 7,342 cities worldwide ("City", "City, State", "City, Country", or a second field naming the state or country) and US ZIP codes; values not found are counted on the map; background tiles from a tile server you set (off by default) | ◐ Postcodes outside the US aren't placed; tiles under point maps only (filled maps draw their areas) |
| [Spatial files](https://help.tableau.com/current/pro/desktop/en-us/maps_shapefiles.htm) | GeoJSON, Esri Shapefile (zipped, or .shp with .dbf), KML and KMZ areas, kept in the project | ◐ Longitude/latitude (WGS 84) only: projected shapefiles are refused with the reason; no MapInfo, TopoJSON or geodatabases |
| [Reference lines and bands](https://help.tableau.com/current/pro/desktop/en-us/reference_lines.htm) | Constant, parameter, average, median, min, max and percentile lines; ±SD band and the 95% confidence interval of the mean; quartile reference boxes with whiskers; per pane (each small multiple) or one per color | ◐ No per-cell scope |
| [Trend lines](https://help.tableau.com/current/pro/desktop/en-us/trendlines_add.htm) | Linear, logarithmic, exponential, power and polynomial (degree 2–8) with R² on charts, over the pane or one per color; linear, multiple and polynomial regression with full statistics in Analytics | ✅ |
| [Forecasting](https://help.tableau.com/current/pro/desktop/en-us/forecasting.htm) | Exponential smoothing (level; additive, damped or multiplicative trend; additive or multiplicative season) chosen by AICc, prediction intervals, on charts and in Analytics; seasonal ARIMA in Analytics (beyond Tableau) | ✅ |
| [Clustering](https://help.tableau.com/current/pro/desktop/en-us/clustering.htm) | k-means (k chosen by Calinski–Harabasz, as Tableau): on a scatter plot (Analytics → Clusters, the marks colored by cluster) or in Analytics, saved as a dataset | ✅ |
| Statistics | Descriptives, correlation, t-tests, ANOVA, chi-square, rank tests, regression, logistic regression, PCA, anomalies — validated against SciPy and statsmodels | ✅ (beyond Tableau) |
| [Viz in tooltip](https://help.tableau.com/current/pro/desktop/en-us/viz_in_tooltip.htm) | Format → Chart in tooltip: another saved chart, filtered to the hovered mark (by every shared field or one chosen field), at a chosen size | ✅ |

## Dashboards

| Tableau | Simple Viz | |
|---|---|---|
| [Dashboards](https://help.tableau.com/current/pro/desktop/en-us/dashboards_create.htm) | Charts, text with live values, images, shapes, buttons, filter controls, layout containers | ✅ |
| [Floating and tiled layout](https://help.tableau.com/current/pro/desktop/en-us/dashboards_organize_floatingandtiled.htm) | Free canvas with grid snapping, align, distribute, group, lock; row/column containers; tiled layout (objects fill the dashboard in rows, re-flow when added, moved or resized; floating objects stay on top) | ✅ |
| [Actions](https://help.tableau.com/current/pro/desktop/en-us/actions.htm) | Filter, highlight, go to dashboard, open a web page (`{Field}` or `<Field>` in the address), set a parameter, change set values | ✅ |
| [Device layouts](https://help.tableau.com/current/pro/desktop/en-us/dashboards_dsd_create.htm) | Size presets; tablet and phone layouts made from the default (phone: one column), edited on their own (removing an object hides it there); view mode picks the layout by the window's width | ◐ The window is at least 960 px wide, so the phone layout is shown by choosing it (and in presentations on small screens) |
| Presentation | Presentation mode with dashboard tabs | ✅ |
| [Stories](https://help.tableau.com/current/pro/desktop/en-us/stories.htm) | Dashboards in order with captions; each point can keep its own filter choices; reorder, present full screen with ← → | ◐ Clicked-mark selections aren't kept, only filter choices |
| Export | Dashboards: PDF (page sizes), PNG and a self-contained web page (HTML); charts: PNG, SVG and CSV; query results: CSV, Excel and Parquet | ✅ |

## Sharing

| Tableau | Simple Viz | |
|---|---|---|
| Packaged workbooks (`.twbx`) | Portable copy: the project with its data (Parquet) inside | ✅ |
| Tableau Server / Cloud, subscriptions, permissions | Simple Viz is a desktop app; share project files | ✗ Out of scope |
| Opening Tableau workbooks | — | ✗ Not planned |

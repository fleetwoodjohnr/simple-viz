# Performance benchmarks

`npm run bench` runs `tests/perf/` and prints these tables. `SV_BENCH_SIZES=10000,100000` limits the sizes;
`SV_BENCH_ROWS` sets the statistics size.

**What is measured:** the engine and SQL path of the app — extracting sources into the project cache, then the
chart queries a dashboard sends (compiled by the real chart compiler and passed through the SQL gate), one by one and
all at once. **Not measured here:** drawing in the window (ECharts) and the hop between the window and the engine
process; charts draw at most 20,000 marks, so drawing time doesn't grow with the data.

## Run of 8 November 2026

Hardware: AMD Ryzen 3 3200U (2 cores, 4 threads), 13.6 GB RAM, Fedora 44 x64, Node 24.18, DuckDB 2.0.0. A modest
laptop: desktops and recent laptops are several times faster.

### Sales dashboard at four sizes

Data: orders (Parquet: date over 5 years, customer, product, quantity, revenue, cost) joined with 5,000 customers
(CSV, another source) in a dataset that also computes profit. Twelve charts, each a typical dashboard tile.

| Rows | Extract (both sources) | Revenue by region | Revenue by month | Top 10 products by profit | Region × segment crosstab | KPI total profit | Revenue by year and region | Filtered (2023, East) | Distinct customers by month | Average order by segment | Quantity by product and region | Median revenue by region | FIXED level of detail | All 12 at once | Memory (RSS) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | 108 ms | 13 ms | 12 ms | 21 ms | 13 ms | 9 ms | 13 ms | 12 ms | 14 ms | 13 ms | 13 ms | 12 ms | 19 ms | 68 ms | 229 MB |
| 100,000 | 129 ms | 53 ms | 17 ms | 29 ms | 16 ms | 11 ms | 20 ms | 13 ms | 22 ms | 12 ms | 17 ms | 16 ms | 23 ms | 99 ms | 245 MB |
| 1,000,000 | 245 ms | 15 ms | 26 ms | 31 ms | 25 ms | 13 ms | 28 ms | 16 ms | 57 ms | 16 ms | 22 ms | 40 ms | 49 ms | 257 ms | 322 MB |
| 10,000,000 | 1.43 s | 54 ms | 178 ms | 177 ms | 118 ms | 54 ms | 213 ms | 56 ms | 510 ms | 57 ms | 138 ms | 376 ms | 470 ms | 2.01 s | 991 MB |

The join of the two sources runs inside every chart query (the dataset is a view), so these times include it.
Distinct counts, medians and level-of-detail calculations are the costliest; everything else stays under a quarter of
a second at 10 million rows.

### Other measurements

| What | Result |
|---|---|
| Excel workbook, 100,000 rows × 5 columns (xlsx) | extracted in 2.25 s (the workbook is parsed in JavaScript; flat files are faster) |
| A 5,000,000-row sort under a 256 MB memory limit | finished in 4.33 s, spilling to the cache's temporary folder instead of failing |
| Statistics on 10,000,000 rows | describe 2.72 s, multiple regression 1.43 s (every row), logistic regression 1.16 s (100,000-row sample); extract 1.04 s |

## How the work is kept small

- Sources are extracted once into a local DuckDB file and refreshed only when they change (file size and time, or a
  content fingerprint); unchanged data is never rewritten.
- Charts query aggregates: the result is at most 20,000 marks (one more is fetched to tell you when a chart is cut
  off), and previews page through results instead of loading them.
- Wrapped analyses (histograms, density, correlation, cohorts) aggregate in SQL over every row; only statistics that
  need individual rows (logistic regression, k-means) use a reproducible sample.
- DuckDB uses up to 40% of RAM and spills larger sorts and joins to disk.

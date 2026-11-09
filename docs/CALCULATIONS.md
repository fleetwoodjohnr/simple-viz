# Calculated fields

A calculated field is a formula over a dataset's fields, used on charts like any other field. Formulas are DuckDB SQL
expressions plus the conventions Tableau users know, with Tableau's meaning.

## Writing formulas

| | Example |
|---|---|
| A field (or another calculated field) | `[Revenue] - [Cost]` |
| Tableau's IF | `IF [Profit] > 0 THEN 'Gain' ELSEIF [Profit] = 0 THEN 'Even' ELSE 'Loss' END` |
| SQL's CASE (also fine) | `CASE WHEN [Profit] > 0 THEN 'Gain' ELSE 'Loss' END` |
| Tableau function names | `ZN([Discount])`, `IIF([Paid], 1, 0)`, `COUNTD([Customer ID])`, `DATEADD('month', 1, [Order Date])` |
| Any DuckDB function | `regexp_extract([Email], '@(.*)$', 1)`, `date_trunc('week', [Order Date])` |

`[…]` is a field only when it names one; otherwise it is DuckDB's list syntax. The editor checks a formula as you type
and says whether it is a *row* calculation (computed per row), an *aggregate* (like `SUM([Profit]) / SUM([Revenue])`)
or a *table calculation*.

## Kinds

**Row calculations** work per row and can be dimensions or measures (`[Revenue] * 1.2`, `UPPER([Region])`).

**Aggregate calculations** combine rows: `SUM([Profit]) / SUM([Revenue])` is a margin per mark, not an average of
row margins — as in Tableau.

**Level of detail expressions** compute an aggregate at a level independent of the view:

| | Means |
|---|---|
| `{FIXED [Region] : SUM([Revenue])}` | revenue per region, whatever the chart shows |
| `{FIXED : SUM([Revenue])}` | the grand total |
| `{INCLUDE [Customer] : SUM([Revenue])}` | per customer within each mark (then aggregated to the mark) |
| `{EXCLUDE [Month] : SUM([Revenue])}` | ignoring the month the view is split by |

As in Tableau, FIXED is computed after context filters and before dimension filters; INCLUDE and EXCLUDE after
dimension filters. When an LOD is aggregated in the view, each distinct (view dimensions, LOD dimensions) value counts
once — the rule that keeps `AVG({FIXED [Customer] : SUM([Sales])})` an average per customer.

**Table calculations** compute over the chart's aggregated marks:

`RUNNING_SUM/AVG/MIN/MAX/COUNT(…)`, `WINDOW_SUM/AVG/MIN/MAX/MEDIAN/COUNT/STDEV(…, start, end)`, `RANK`, `RANK_DENSE`,
`RANK_UNIQUE`, `RANK_PERCENTILE`, `LOOKUP(…, offset)`, `INDEX()`, `SIZE()`, `FIRST()`, `LAST()`, `TOTAL(…)`,
`PERCENT_OF_TOTAL(…)`. For example `SUM([Revenue]) / LOOKUP(SUM([Revenue]), -1) - 1` is growth over the previous
mark. A field's menu also offers the usual ones as **quick calculations** (running total, percent of total, rank,
difference, percent difference, moving average, year over year).

## Order of operations

Context filters → FIXED → dimension filters (and top N) → INCLUDE / EXCLUDE → aggregation → measure filters →
table calculations → sorting and limits. Mark a filter as a context filter to apply it before FIXED.

## Parameters

A parameter is a value the reader picks: a number, text, date or yes/no, optionally from a list of allowed values.
Create one in the chart builder (Parameters → +). Use it in a formula as `[Parameters].[Name]` (or `$Name` when the
name has no spaces) — for example `IF [Sales] >= [Parameters].[Threshold] THEN 'Above' ELSE 'Below' END`, which you
can then filter or color by; draw a reference line at its value (Analytics → Line at); let readers change it with a
parameter control on a dashboard; or set it by clicking a mark (a "Set a parameter" dashboard action).

## On models (related tables)

Fields are written `[table.column]`. As in Tableau, a row-level calculation reads one table — `[orders.revenue] -
[orders.cost]` — and becomes a field of that table. An aggregate calculation can combine tables:
`SUM([returns.refund]) / SUM([orders.revenue])` sums each table at its own level (no duplication by the join) and
divides per mark.

Level of detail expressions work on models with Tableau's rules. `{FIXED [customers.customer_id] :
SUM([orders.revenue])}` is computed per customer (after context filters, before dimension filters); used row by row
(a dimension, `IF {FIXED …} > 100 THEN …`) it becomes a field of the table holding its dimensions, and aggregated
(`AVG({FIXED …})`) it counts once per combination of the view's and its own dimensions. INCLUDE and EXCLUDE follow the
view and respect dimension filters; they must be aggregated (they have no single table to belong to). Table
calculations and quick calculations run over the marks as on a dataset. Not on models: `TOTAL()` (use
`WINDOW_SUM(SUM(…))`), an LOD inside another LOD, and an aggregate mixing an LOD with a table's fields.

## Groups

Field menu → **Create group…** on a dimension: tick values, name the group, add it; repeat. The group becomes a
calculated field, `<field> (group)`, with a `CASE … WHEN [field] IN (…) THEN 'name' … END` formula you can edit like
any other.

## Sets

Field menu → **Create set…** on a dimension: tick the members. The set is a field, `<field> (set)`, that is `In` for
them and `Out` for the rest — put it on Color or filter by it. On a dashboard, a **Change set values** action makes the
clicked mark's value the set's member, so every chart using the set follows the click.

## Joining text

`+` joins text as in Tableau — `[First name] + ' ' + [Last name]`, `STR([Year]) + '%'` — when the value next to it is
text: a quoted value, a text field, or a text function (`STR`, `UPPER`, `LEFT`, `MID`, `TRIM`, `REPLACE`…). For
anything else, such as another calculated field that returns text, use `||` or `concat()`.

## Not supported (yet)

Densification beyond a date axis, and "compute using" a combination of dimensions with a chosen order.

**Compute using** (the measure's menu, for a quick or calculated table calculation): by default a table calculation
runs along the x axis and restarts for each value of the other dimensions; choose another dimension of the view to run
along it instead, restarting for each combination of the rest.

**Show missing values** (chart format panel) fills every period of a date axis with a grain (such as month) from the
first to the last, and every combination of the values on the axes, colors and panels (Tableau's empty rows and
columns); empty marks have no value, so lines show a gap, and table calculations (running totals, moving averages,
differences) run over them as Tableau's densification does. With fields on detail, tooltip, label or size, only dates
are filled.

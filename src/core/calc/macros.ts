// Tableau function names, as DuckDB macros, so calculated fields read the way Tableau users expect:
// ZN([Sales]), COUNTD([Customer]), IIF([Profit] > 0, 'Gain', 'Loss'), DATEADD('month', 1, [Order Date]).
// Functions DuckDB already has under the Tableau name with the same meaning (DATEDIFF, DATEPART, DATETRUNC, CONTAINS,
// LEFT, RIGHT, UPPER, LOWER, TRIM, ABS, ROUND, YEAR, MONTH, DAY, QUARTER…) need no macro. docs/CALCULATIONS.md lists both.

export interface Macro {
  name: string
  /** Contains an aggregate: a calculated field using it is an aggregate calculation. */
  aggregate?: boolean
  sql: string
}

const m = (name: string, params: string, body: string, aggregate = false): Macro => ({ name, aggregate, sql: `CREATE OR REPLACE MACRO memory.main.${name}(${params}) AS ${body}` })

export const MACROS: Macro[] = [
  // logic and nulls
  m('zn', 'x', 'coalesce(x, 0)'),
  m('iif', 'c, a, b', 'CASE WHEN c THEN a ELSE b END'),
  m('isnull', 'x', '(x IS NULL)'),
  // strings
  m('mid', 's, start, n := NULL', 'CASE WHEN n IS NULL THEN substring(s, start) ELSE substring(s, start, n) END'),
  m('find', 's, sub', 'instr(s, sub)'),
  m('startswith', 's, prefix', 'starts_with(s, prefix)'),
  m('endswith', 's, suffix', 'suffix(s, suffix)'),
  m('str', 'x', 'CAST(x AS VARCHAR)'),
  m('float', 'x', 'TRY_CAST(x AS DOUBLE)'),
  m('int', 'x', 'CAST(trunc(TRY_CAST(x AS DOUBLE)) AS BIGINT)'),
  // dates
  m('today', '', 'current_date'),
  m('makedate', 'y, mo, d', 'make_date(y, mo, d)'),
  m(
    'dateadd',
    'part, n, d',
    "CASE lower(part) WHEN 'year' THEN d + to_years(CAST(n AS INTEGER)) WHEN 'quarter' THEN d + to_months(CAST(n AS INTEGER) * 3) WHEN 'month' THEN d + to_months(CAST(n AS INTEGER)) WHEN 'week' THEN d + to_days(CAST(n AS INTEGER) * 7) WHEN 'day' THEN d + to_days(CAST(n AS INTEGER)) WHEN 'hour' THEN d + to_hours(CAST(n AS BIGINT)) WHEN 'minute' THEN d + to_minutes(CAST(n AS BIGINT)) WHEN 'second' THEN d + to_seconds(CAST(n AS DOUBLE)) END"
  ),
  m('div', 'a, b', '(a // b)'),
  // aggregates
  m('countd', 'x', 'count(DISTINCT x)', true),
  m('attr', 'x', 'CASE WHEN min(x) = max(x) THEN min(x) END', true),
  m('stdev', 'x', 'stddev_samp(x)', true),
  m('stdevp', 'x', 'stddev_pop(x)', true),
  m('var', 'x', 'var_samp(x)', true),
  m('varp', 'x', 'var_pop(x)', true),
  m('percentile', 'x, p', 'quantile_cont(x, p)', true),
  m('covar', 'x, y', 'covar_samp(x, y)', true),
  m('covarp', 'x, y', 'covar_pop(x, y)', true)
]

export const AGGREGATE_MACROS = new Set(MACROS.filter((x) => x.aggregate).map((x) => x.name))

// Visual transform steps → SQL. Each step reads the previous one (a chain of CTEs), so the SQL view of a transform
// always matches its steps exactly. Joined columns with clashing names get a _1 suffix (DuckDB's rule).

import type { TransformStep } from '../shared/project'

const q = (s: string) => `"${s.replace(/"/g, '""')}"`
const lit = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : `'${v.replace(/'/g, "''")}'`)

export const STEP_LABELS: Record<TransformStep['kind'], string> = {
  select: 'Keep columns',
  rename: 'Rename column',
  filter: 'Filter rows',
  calc: 'Add calculated column',
  cast: 'Change type',
  fill: 'Fill empty values',
  text: 'Clean text',
  split: 'Split column',
  dedupe: 'Remove duplicates',
  sort: 'Sort',
  group: 'Group and summarize',
  join: 'Join another table',
  union: 'Append rows from another table',
  pivot: 'Pivot (rows to columns)',
  unpivot: 'Unpivot (columns to rows)',
  sql: 'Custom SQL'
}

function stepSql(s: TransformStep, prev: string): string {
  switch (s.kind) {
    case 'select':
      return `SELECT ${s.columns.length ? s.columns.map(q).join(', ') : '*'} FROM ${prev}`
    case 'rename':
      return `SELECT * RENAME (${q(s.from)} AS ${q(s.to)}) FROM ${prev}`
    case 'filter': {
      const c = q(s.column)
      const v = s.value ?? ''
      const cond =
        s.op === 'null' ? `${c} IS NULL`
        : s.op === 'not_null' ? `${c} IS NOT NULL`
        : s.op === 'contains' ? `contains(CAST(${c} AS VARCHAR), ${lit(v)})`
        : s.op === 'starts' ? `starts_with(CAST(${c} AS VARCHAR), ${lit(v)})`
        : s.op === 'in' ? `${c} IN (${v.split(',').map((x) => lit(x.trim())).join(', ')})`
        : `${c} ${s.op} ${lit(v)}`
      return `SELECT * FROM ${prev} WHERE ${cond}`
    }
    case 'calc':
      return `SELECT *, (${s.expr}) AS ${q(s.name)} FROM ${prev}`
    case 'cast':
      return `SELECT * REPLACE (TRY_CAST(${q(s.column)} AS ${/^[A-Za-z]+(\(\d+(,\s?\d+)?\))?$/.test(s.type) ? s.type : 'VARCHAR'}) AS ${q(s.column)}) FROM ${prev}`
    case 'fill':
      return `SELECT * REPLACE (coalesce(${q(s.column)}, ${lit(s.value)}) AS ${q(s.column)}) FROM ${prev}`
    case 'text': {
      const c = q(s.column)
      const e = s.fn === 'trim' ? `trim(${c})` : s.fn === 'upper' ? `upper(${c})` : s.fn === 'lower' ? `lower(${c})` : `array_to_string(list_transform(string_split(lower(${c}), ' '), w -> upper(w[1]) || w[2:]), ' ')`
      return `SELECT * REPLACE (${e} AS ${c}) FROM ${prev}`
    }
    case 'split':
      return `SELECT *, ${s.into.map((n, i) => `split_part(CAST(${q(s.column)} AS VARCHAR), ${lit(s.sep)}, ${i + 1}) AS ${q(n)}`).join(', ')} FROM ${prev}`
    case 'dedupe':
      return s.columns.length ? `SELECT * FROM ${prev} QUALIFY row_number() OVER (PARTITION BY ${s.columns.map(q).join(', ')}) = 1` : `SELECT DISTINCT * FROM ${prev}`
    case 'sort':
      return `SELECT * FROM ${prev} ORDER BY ${q(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`
    case 'group': {
      const fn = { sum: 'sum', avg: 'avg', min: 'min', max: 'max', count: 'count', count_distinct: 'count(DISTINCT', median: 'median' }
      const aggs = s.aggs.map((a) => (a.fn === 'count_distinct' ? `count(DISTINCT ${q(a.column)}) AS ${q(a.as)}` : `${fn[a.fn]}(${q(a.column)}) AS ${q(a.as)}`))
      return `SELECT ${[...s.by.map(q), ...aggs].join(', ')} FROM ${prev}${s.by.length ? ' GROUP BY ALL' : ''}`
    }
    case 'join':
      return `SELECT * FROM ${prev} AS l ${s.type.toUpperCase()} JOIN ${q(s.with)} AS r ON ${s.on.map((o) => `l.${q(o.left)} = r.${q(o.right)}`).join(' AND ') || 'TRUE'}`
    case 'union':
      return `SELECT * FROM ${prev} UNION ALL BY NAME SELECT * FROM ${q(s.with)}`
    case 'pivot':
      // The pivoted values are listed (a view can't discover them at query time); see pivotValues.
      return `SELECT * FROM ${prev} PIVOT (${s.fn}(${q(s.value)}) FOR ${q(s.column)} IN (${s.values.length ? s.values.map(lit).join(', ') : "''"}))`
    case 'unpivot':
      return `SELECT * FROM ${prev} UNPIVOT (${q(s.value)} FOR ${q(s.name)} IN (${s.columns.map(q).join(', ')}))`
    case 'sql':
      // The previous step is available as `previous`.
      return `WITH previous AS (SELECT * FROM ${prev}) ${s.sql.trim().replace(/;\s*$/, '')}`
  }
}

/** The SQL for a transform: its input relation, then each step in order. */
export function transformSql(input: string, steps: TransformStep[]): string {
  if (!steps.length) return `SELECT * FROM ${q(input)}`
  const ctes = [`s0 AS (SELECT * FROM ${q(input)})`]
  steps.forEach((s, i) => ctes.push(`s${i + 1} AS (${stepSql(s, `s${i}`)})`))
  return `WITH ${ctes.join(',\n')}\nSELECT * FROM s${steps.length}`
}

/** SQL of the transform up to (and including) step n, for previews of a step. */
export const transformSqlUntil = (input: string, steps: TransformStep[], n: number) => transformSql(input, steps.slice(0, n + 1))

/** A date table: one row per day with year, quarter, month, week and day-of-week fields. */
export function dateTableSql(start: string, end: string): string {
  return `SELECT CAST(d AS DATE) AS date, year(d) AS year, quarter(d) AS quarter, month(d) AS month, monthname(d) AS month_name, week(d) AS week, dayofweek(d) AS day_of_week, dayname(d) AS day_name, CAST(date_trunc('month', d) AS DATE) AS month_start, CAST(date_trunc('quarter', d) AS DATE) AS quarter_start, (dayofweek(d) IN (0, 6)) AS is_weekend
FROM generate_series(DATE ${lit(start)}, DATE ${lit(end)}, INTERVAL 1 DAY) AS t(d)`
}

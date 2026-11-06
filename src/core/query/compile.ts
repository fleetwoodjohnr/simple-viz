// Chart → SQL. One query per chart, in stages that follow Tableau's order of operations:
//
//   base   dataset rows + row-level calculated fields + FIXED LODs        (context filters apply here)
//   f      base minus dimension filters, + INCLUDE/EXCLUDE LODs and TOTAL() windows
//   a      GROUP BY the view's dimensions: measures, hidden aggregates    (measure filters: HAVING)
//   final  table calculations and quick calcs (windows over a), sort, mark limit
//
// Output columns are d0…dn (dimensions, in role order) and m0…mn (measures), described in `fields`.

import type { Agg, CalcField, Chart, ChartFilter, DateGrain, FieldRef, Parameter } from '../../shared/charts'
import type { ColumnInfo } from '../../shared/engine-protocol'
import { compileCalc, AGGREGATES, type Compiled, type Lod } from '../calc/compile'

export type Role = 'x' | 'y' | 'color' | 'size' | 'label' | 'detail' | 'tooltip' | 'facet'

export interface OutField {
  key: string
  role: Role
  ref: FieldRef
  kind: 'dim' | 'measure'
  /** Display name: label, or "SUM(Revenue)", or the field name. */
  title: string
  /** Source column type (dimension) — DATE, VARCHAR, DOUBLE… */
  type: string
}

export interface CompiledQuery {
  sql: string
  fields: OutField[]
  limit: number
}

export interface QueryInput {
  chart: Pick<Chart, 'dataset' | 'enc' | 'filters' | 'options' | 'type'>
  columns: ColumnInfo[]
  calcs: CalcField[]
  params?: Parameter[]
  /** Dashboard filters and cross-filter selections, applied as dimension filters. */
  extra?: ChartFilter[]
  /** Most marks a chart may draw; one more row is fetched to detect overflow. null: no limit (the query is wrapped
   * by one that aggregates it, like histogram bins). */
  maxMarks?: number | null
  /** Query shape: aggregate (default), raw rows (scatter without dimensions, tables of rows). */
  mode?: 'aggregate' | 'raw'
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`
export const lit = (v: string | number | boolean | null): string => (v === null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${v.replace(/'/g, "''")}'`)

export const isNumeric = (t: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL|REAL)/.test(t)
export const isDate = (t: string) => /^(DATE|TIMESTAMP)/.test(t)

const AGG_SQL: Record<Agg, (e: string) => string> = {
  sum: (e) => `sum(${e})`,
  avg: (e) => `avg(${e})`,
  min: (e) => `min(${e})`,
  max: (e) => `max(${e})`,
  count: (e) => `count(${e})`,
  countd: (e) => `count(DISTINCT ${e})`,
  median: (e) => `median(${e})`,
  stdev: (e) => `stddev_samp(${e})`,
  var: (e) => `var_samp(${e})`,
  p25: (e) => `quantile_cont(${e}, 0.25)`,
  p75: (e) => `quantile_cont(${e}, 0.75)`,
  p90: (e) => `quantile_cont(${e}, 0.9)`,
  none: (e) => e
}

export const AGG_LABEL: Record<Agg, string> = { sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count', countd: 'Count distinct', median: 'Median', stdev: 'Std. dev.', var: 'Variance', p25: '25th pct', p75: '75th pct', p90: '90th pct', none: '' }

export function fieldTitle(ref: FieldRef): string {
  if (ref.label) return ref.label
  if (ref.agg && ref.agg !== 'none') return `${AGG_LABEL[ref.agg]} of ${ref.field}`
  if (ref.grain && ref.grain !== 'exact') return `${ref.grain[0].toUpperCase()}${ref.grain.slice(1)} of ${ref.field}`
  return ref.field
}

function grainSql(e: string, grain: DateGrain | undefined, type: string): string {
  if (!isDate(type) || !grain || grain === 'exact') return e
  if (grain === 'hour') return `date_trunc('hour', ${e})`
  return `CAST(date_trunc('${grain}', ${e}) AS DATE)`
}

export class QueryError extends Error {}

/**
 * Compiles a chart (or a dashboard tile, with `extra` filters) into SQL.
 * Throws QueryError for charts that can't be computed (unknown field, calculation errors).
 */
export function compileQuery(input: QueryInput): CompiledQuery {
  const { chart, columns, calcs } = input
  const colType = new Map(columns.map((c) => [c.name.toLowerCase(), c.type]))
  const colName = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]))
  const calcBy = new Map(calcs.map((c) => [c.name.toLowerCase(), c]))
  const params = new Map((input.params ?? []).map((p) => [p.name.toLowerCase(), p]))
  const maxMarks = input.maxMarks === undefined ? 20_000 : input.maxMarks
  const limitSql = maxMarks === null ? '' : `\nLIMIT ${maxMarks + 1}`
  const enc = chart.enc

  // ---- calculated fields used anywhere in the chart
  const compiled = new Map<string, Compiled>()
  let ci = 0
  const calcOf = (name: string): Compiled | null => {
    const c = calcBy.get(name.toLowerCase())
    if (!c) return null
    if (!compiled.has(c.name)) {
      try {
        compiled.set(c.name, compileCalc(substituteParams(c.formula, params), columns.map((x) => x.name), calcs.map((x) => ({ name: x.name, formula: substituteParams(x.formula, params) })), `c${ci++}`))
      } catch (e) {
        throw new QueryError(`Calculated field “${c.name}”: ${(e as Error).message}`)
      }
    }
    return compiled.get(c.name)!
  }

  /** SQL for a field over base rows (row-level only). */
  const rowExpr = (name: string): { sql: string; type: string } => {
    const col = colName.get(name.toLowerCase())
    if (col) return { sql: q(col), type: colType.get(name.toLowerCase())! }
    const c = calcOf(name)
    if (!c) throw new QueryError(`There is no field “${name}” in ${chart.dataset}. It may have been renamed or removed.`)
    if (c.kind !== 'row') throw new QueryError(`“${name}” is an aggregate calculation; it can’t be used as a dimension.`)
    return { sql: q(name), type: 'CALC' }
  }

  // ---- roles → output fields
  const fields: OutField[] = []
  const add = (role: Role, ref: FieldRef | undefined) => {
    if (!ref) return
    const c = calcOf(ref.field)
    const t = colType.get(ref.field.toLowerCase()) ?? 'CALC'
    const measure = !!ref.agg || (c !== null && c.kind !== 'row')
    const key = measure ? `m${fields.filter((f) => f.kind === 'measure').length}` : `d${fields.filter((f) => f.kind === 'dim').length}`
    // An aggregate calculation already aggregates: it is titled by its own name, not "Sum of …".
    fields.push({ key, role, ref, kind: measure ? 'measure' : 'dim', title: c && c.kind !== 'row' ? (ref.label ?? ref.field) : fieldTitle(ref), type: t })
  }
  enc.x.forEach((r) => add('x', r))
  enc.y.forEach((r) => add('y', r))
  add('color', enc.color)
  add('size', enc.size)
  add('label', enc.label)
  enc.detail.forEach((r) => add('detail', r))
  enc.tooltip.forEach((r) => add('tooltip', r))
  add('facet', enc.facet)

  const dims = fields.filter((f) => f.kind === 'dim')
  const measures = fields.filter((f) => f.kind === 'measure')

  // ---- base stage: row calcs and FIXED LODs (context filters only)
  const rowCalcCols: string[] = []
  const fixedCols: string[] = []
  const lateCols: string[] = []
  const usedCalcs = new Set<string>()
  const collect = (name: string) => {
    const c = calcOf(name)
    if (!c || usedCalcs.has(name.toLowerCase())) return
    usedCalcs.add(name.toLowerCase())
    for (const d of c.deps) collect(d)
  }
  for (const f of fields) collect(f.ref.field)
  for (const f of [...chart.filters, ...(input.extra ?? [])]) collect(f.field)

  // Row-level calcs are columns (their expressions already inline other row calcs). Those using INCLUDE/EXCLUDE
  // values come after the dimension filters, where those values are computed.
  const lateCalcCols: string[] = []
  for (const c of calcs) {
    if (!usedCalcs.has(c.name.toLowerCase())) continue
    const comp = calcOf(c.name)!
    if (comp.kind !== 'row') continue
    if (comp.lods.some((l) => l.kind !== 'fixed')) lateCalcCols.push(`${comp.expr} AS ${q(c.name)}`)
    else rowCalcCols.push(`${comp.expr} AS ${q(c.name)}`)
  }
  /** A field as an expression over raw columns (LOD dimensions are computed before calc columns exist). */
  const inlineExpr = (name: string): string => {
    const col = colName.get(name.toLowerCase())
    if (col) return q(col)
    const c = calcOf(name)
    if (!c || c.kind !== 'row' || c.lods.length) throw new QueryError(`“${name}” can’t be a level-of-detail dimension.`)
    return `(${c.expr})`
  }

  const dimSql = (f: OutField) => grainSql(rowExpr(f.ref.field).sql, f.ref.grain, rowExpr(f.ref.field).type)
  const viewDims = dims.map((d) => dimSql(d))

  // LODs from every compiled calc in use
  for (const comp of compiled.values()) {
    for (const lod of comp.lods) {
      const ds = lod.dims.map((d) => (lod.kind === 'fixed' ? inlineExpr(d) : rowExpr(d).sql))
      if (lod.kind === 'fixed') fixedCols.push(`${windowAgg(lod.agg, ds)} AS ${q(lod.id)}`)
      else {
        const part = lod.kind === 'include' ? [...new Set([...viewDims, ...ds])] : viewDims.filter((v) => !ds.includes(v))
        lateCols.push(`${windowAgg(lod.agg, part)} AS ${q(lod.id)}`)
      }
    }
  }

  // ---- filters
  const allFilters = [...chart.filters, ...(input.extra ?? [])]
  const context = allFilters.filter((f) => f.context && !f.agg).map((f) => filterSql(f, rowExpr, params))
  const dimFilters = allFilters.filter((f) => !f.context && !f.agg && f.op !== 'top').map((f) => filterSql(f, rowExpr, params))
  const topFilters = allFilters.filter((f) => f.op === 'top' && f.top)
  const measureFilters = allFilters.filter((f) => f.agg && f.op !== 'top')

  // ---- aggregate stage
  const aggCols: string[] = dims.map((d) => `${dimSql(d)} AS ${d.key}`)
  const finalCols: string[] = dims.map((d) => d.key)
  const partitionDims = dims.filter((d) => d.role !== 'x' && d.role !== 'tooltip').map((d) => d.key)
  const orderDims = dims.filter((d) => d.role === 'x').map((d) => d.key)
  const pby = partitionDims.length ? `PARTITION BY ${partitionDims.join(', ')}` : ''
  const win: Windows = {
    ordered: (order) => `OVER (${pby ? `${pby} ` : ''}ORDER BY ${order ?? (orderDims.length ? orderDims.join(', ') : '1')})`,
    all: () => `OVER (${pby})`
  }

  // Level-of-detail placeholders and the row-level calcs made only of them (their value has the LOD's grain).
  const lodById = new Map<string, Lod>()
  for (const comp of compiled.values()) for (const l of comp.lods) lodById.set(l.id, l)
  const lodCalc = new Map<string, Lod[]>()
  for (const [name, comp] of compiled) {
    if (comp.kind !== 'row' || !comp.lods.length) continue
    const ids = quotedNames(comp.expr)
    if (ids.length && ids.every((x) => lodById.has(x))) lodCalc.set(name.toLowerCase(), ids.map((x) => lodById.get(x)!))
  }
  /** The LODs an aggregate's argument is made of, or null when it reads ordinary row values. */
  const lodGrain = (inner: string): Lod[] | null => {
    const names = quotedNames(inner)
    const found = names.flatMap((n) => (lodById.has(n) ? [lodById.get(n)!] : lodCalc.get(n.toLowerCase()) ?? []))
    return found.length && names.every((n) => lodById.has(n) || lodCalc.has(n.toLowerCase())) ? found : null
  }
  const tuples: string[] = []
  const joins: string[] = []
  let hidden = 0

  for (const m of measures) {
    const c = calcOf(m.ref.field)
    let aggExpr: string
    if (c && c.kind === 'tablecalc') {
      for (const a of c.aggs) aggCols.push(`${a.expr} AS ${q(a.id)}`)
      for (const t of c.totals) {
        lateCols.push(`${windowAgg(t.expr, partitionDims.length ? dims.filter((d) => partitionDims.includes(d.key)).map(dimSql) : [])} AS ${q(t.id)}`)
        aggCols.push(`any_value(${q(t.id)}) AS ${q(t.id)}`)
      }
      // The final stage computes the table calc; carry its inputs through.
      finalCols.push(`${tableCalcSql(c, win)} AS ${m.key}`)
      continue
    }
    if (c && c.kind === 'aggregate') aggExpr = c.expr
    else {
      const e = c ? q(m.ref.field) : rowExpr(m.ref.field).sql
      aggExpr = AGG_SQL[m.ref.agg ?? 'sum'](e)
    }
    const calls = aggregateCalls(aggExpr)
    if (!calls.some((call) => lodGrain(call.inner))) {
      aggCols.push(`${aggExpr} AS ${m.key}`)
      finalCols.push(quickCalc(m, win, dims))
      continue
    }
    // Aggregates of level-of-detail values run over one row per combination of the view's dimensions and the LOD's
    // dimensions (Tableau: finer LODs aggregate their own values; coarser ones repeat on every mark). Each such
    // aggregate is a subquery joined to the view by its dimensions; plain aggregates become hidden columns of a.
    let expr = aggExpr
    for (const call of [...calls].reverse()) {
      let replacement: string
      const lods = lodGrain(call.inner)
      if (lods) {
        const t = `t${tuples.length}`
        const distinct = /^\s*DISTINCT\s+/i.test(call.inner)
        const val = call.inner.replace(/^\s*DISTINCT\s+/i, '')
        const lodDims = [...new Set(lods.flatMap((l) => l.dims.map((d) => rowExpr(d).sql)))]
        const keys = dims.map((d) => `${dimSql(d)} AS ${t}_${d.key}`)
        const inner = [...keys, ...lodDims.map((l, i) => `${l} AS ${t}_l${i}`), `${val} AS __val`]
        tuples.push(`${t} AS (\n  SELECT ${[...dims.map((d) => `${t}_${d.key}`), `${call.fn}(${distinct ? 'DISTINCT ' : ''}__val) AS ${t}_v`].join(', ')}\n  FROM (SELECT DISTINCT ${inner.join(', ')} FROM f)${dims.length ? '\n  GROUP BY ALL' : ''}\n)`)
        joins.push(dims.length ? `LEFT JOIN ${t} ON ${dims.map((d) => `a.${d.key} IS NOT DISTINCT FROM ${t}.${t}_${d.key}`).join(' AND ')}` : `CROSS JOIN ${t}`)
        replacement = `${t}.${t}_v`
      } else {
        const h = `__h${hidden++}`
        aggCols.push(`${call.text} AS ${h}`)
        replacement = `a.${h}`
      }
      expr = expr.slice(0, call.start) + replacement + expr.slice(call.end)
    }
    finalCols.push(`${expr} AS ${m.key}`)
  }

  const having = measureFilters.map((f) => {
    const c = calcOf(f.field)
    const e = c && c.kind === 'aggregate' ? `(${c.expr})` : AGG_SQL[f.agg!](rowExpr(f.field).sql)
    return rangeSql(e, f, params)
  })

  const raw = input.mode === 'raw' || (!dims.length && !measures.length)
  const ordered = orderBy(chart, fields)

  let sql = `WITH base0 AS (\n  SELECT *${fixedCols.length ? `, ${fixedCols.join(', ')}` : ''}\n  FROM ${q(chart.dataset)}${context.length ? `\n  WHERE ${context.join(' AND ')}` : ''}\n),\nbase AS (\n  SELECT *${rowCalcCols.length ? `, ${rowCalcCols.join(', ')}` : ''} FROM base0\n)`
  // Top-N filters keep the dimension values with the highest measure (after context filters, before others).
  const topWhere = topFilters.map((f) => {
    const by = f.top!.by
    const bc = calcOf(by.field)
    const byExpr = bc && bc.kind === 'aggregate' ? bc.expr : AGG_SQL[by.agg ?? 'sum'](rowExpr(by.field).sql)
    const col = rowExpr(f.field).sql
    return `${col} IN (SELECT ${col} FROM base GROUP BY ${col} ORDER BY ${byExpr} ${f.top!.bottom ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${Math.max(1, Math.floor(f.top!.n))})`
  })
  const where = [...dimFilters, ...topWhere]
  sql += `,\nf0 AS (\n  SELECT *${lateCols.length ? `, ${lateCols.join(', ')}` : ''}\n  FROM base${where.length ? `\n  WHERE ${where.join(' AND ')}` : ''}\n),\nf AS (\n  SELECT *${lateCalcCols.length ? `, ${lateCalcCols.join(', ')}` : ''} FROM f0\n)`

  if (raw) {
    // Row-level view (scatter of individual rows, a table of records): no grouping.
    const cols = fields.map((f) => (f.kind === 'dim' ? `${dimSql(f)} AS ${f.key}` : `${(() => {
      const c = calcOf(f.ref.field)
      if (c && c.kind !== 'row') throw new QueryError(`“${f.ref.field}” aggregates, so it can’t be shown row by row.`)
      return c ? q(f.ref.field) : rowExpr(f.ref.field).sql
    })()} AS ${f.key}`))
    sql += `\nSELECT ${cols.length ? cols.join(', ') : '*'} FROM f${ordered ? ` ORDER BY ${ordered}` : ''}${limitSql}`
    return { sql, fields, limit: maxMarks ?? Infinity }
  }

  sql += `,\na AS (\n  SELECT ${aggCols.join(', ')}\n  FROM f${dims.length ? '\n  GROUP BY ALL' : ''}${having.length ? `\n  HAVING ${having.join(' AND ')}` : ''}\n)`
  for (const t of tuples) sql += `,\n${t}`
  sql += `\nSELECT ${finalCols.join(', ')} FROM a${joins.length ? `\n${joins.join('\n')}` : ''}${ordered ? `\nORDER BY ${ordered}` : ''}${limitSql}`
  return { sql, fields, limit: maxMarks ?? Infinity }
}

const WINDOWABLE = 'sum|avg|mean|min|max|count|median|mode|stddev_samp|stddev_pop|var_samp|var_pop|quantile_cont|quantile_disc|any_value|first|last|string_agg|bool_and|bool_or|corr|covar_samp|covar_pop|approx_count_distinct|product|kurtosis|skewness|entropy'
const AGG_CALL = new RegExp(`\\b(${WINDOWABLE})\\s*\\(((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*)\\)`, 'gi')

/** An aggregate expression computed per partition on every row: each aggregate call gets OVER (PARTITION BY …). */
export function windowAgg(agg: string, partition: string[]): string {
  const over = ` OVER (${partition.length ? `PARTITION BY ${partition.join(', ')}` : ''})`
  // Tableau-name macros can't take OVER: spell them out first.
  const plain = agg
    .replace(/\bcountd\s*\(/gi, 'count(DISTINCT ')
    .replace(/\bstdevp\s*\(/gi, 'stddev_pop(')
    .replace(/\bstdev\s*\(/gi, 'stddev_samp(')
    .replace(/\bvarp\s*\(/gi, 'var_pop(')
    .replace(/\bvar\s*\(/gi, 'var_samp(')
    .replace(/\bcovarp\s*\(/gi, 'covar_pop(')
    .replace(/\bcovar\s*\(/gi, 'covar_samp(')
    .replace(/\bpercentile\s*\(/gi, 'quantile_cont(')
  return plain.replace(AGG_CALL, (m) => `${m}${over}`)
}

interface Windows {
  /** OVER (PARTITION BY panes ORDER BY the x axis, or `order`) */
  ordered: (order?: string) => string
  /** OVER (PARTITION BY panes) — the whole pane */
  all: () => string
}

function tableCalcSql(c: Compiled, w: Windows): string {
  let expr = c.expr
  for (const t of c.tcs) {
    const a = t.arg ? q(t.arg) : ''
    const o = w.ordered()
    let s: string
    switch (t.fn) {
      case 'running_sum':
        s = `sum(${a}) ${o}`
        break
      case 'running_avg':
        s = `avg(${a}) ${o}`
        break
      case 'running_min':
        s = `min(${a}) ${o}`
        break
      case 'running_max':
        s = `max(${a}) ${o}`
        break
      case 'running_count':
        s = `count(${a}) ${o}`
        break
      case 'rank':
        s = `rank() ${w.ordered(`${a} DESC`)}`
        break
      case 'rank_dense':
        s = `dense_rank() ${w.ordered(`${a} DESC`)}`
        break
      case 'rank_unique':
        s = `row_number() ${w.ordered(`${a} DESC`)}`
        break
      case 'rank_percentile':
        s = `percent_rank() ${w.ordered(`${a} ASC`)}`
        break
      case 'lookup': {
        const k = t.nums[0] ?? 0
        s = k === 0 ? a : k < 0 ? `lag(${a}, ${-k}) ${o}` : `lead(${a}, ${k}) ${o}`
        break
      }
      case 'index':
        s = `row_number() ${o}`
        break
      case 'size':
        s = `count(*) ${w.all()}`
        break
      case 'first':
        s = `(1 - row_number() ${o})`
        break
      case 'last':
        s = `(count(*) ${w.all()} - row_number() ${o})`
        break
      default: {
        // window_sum(expr, start, end): a frame relative to the current row (Tableau's offsets).
        const fn = t.fn.replace('window_', '').replace('stdev', 'stddev_samp')
        const [from, to] = t.nums
        const bound = (v: number, side: 'start' | 'end') => (!Number.isFinite(v) ? (side === 'start' ? 'UNBOUNDED PRECEDING' : 'UNBOUNDED FOLLOWING') : v === 0 ? 'CURRENT ROW' : v < 0 ? `${-v} PRECEDING` : `${v} FOLLOWING`)
        s = `${fn}(${a}) ${o.replace(/\)$/, ` ROWS BETWEEN ${bound(from, 'start')} AND ${bound(to, 'end')})`)}`
      }
    }
    expr = expr.split(q(t.id)).join(`(${s})`)
  }
  return expr
}

/** Quick table calculations on a measure (running total, percent of total, rank, difference, year over year…). */
function quickCalc(m: OutField, w: Windows, dims: OutField[]): string {
  const k = m.key
  switch (m.ref.quick) {
    case 'running_sum':
      return `sum(${k}) ${w.ordered()} AS ${k}`
    case 'running_avg':
      return `avg(${k}) ${w.ordered()} AS ${k}`
    case 'pct_total':
      return `${k} / nullif(sum(${k}) ${w.all()}, 0) AS ${k}`
    case 'rank':
      return `rank() ${w.ordered(`${k} DESC`)} AS ${k}`
    case 'diff_prev':
      return `${k} - lag(${k}) ${w.ordered()} AS ${k}`
    case 'pct_diff_prev':
      return `(${k} - lag(${k}) ${w.ordered()}) / nullif(abs(lag(${k}) ${w.ordered()}), 0) AS ${k}`
    case 'moving_avg_3':
      return `avg(${k}) ${w.ordered().replace(/\)$/, ' ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)')} AS ${k}`
    case 'yoy': {
      // Change from the same period a year earlier when the x axis is a date at month/quarter/week grain.
      const date = dims.find((d) => d.role === 'x' && isDate(d.type))
      const n = date?.ref.grain ? ({ month: 12, quarter: 4, week: 52, year: 1 } as Record<string, number>)[date.ref.grain] ?? 1 : 1
      return `(${k} - lag(${k}, ${n}) ${w.ordered()}) / nullif(abs(lag(${k}, ${n}) ${w.ordered()}), 0) AS ${k}`
    }
    default:
      return k
  }
}

function orderBy(chart: QueryInput['chart'], fields: OutField[]): string {
  const dims = fields.filter((f) => f.kind === 'dim')
  const measures = fields.filter((f) => f.kind === 'measure')
  const s = chart.options.sort
  const x = dims.find((d) => d.role === 'x')
  const ys = dims.find((d) => d.role === 'y')
  if (s?.by === 'value' && measures[0]) return `${measures[0].key} ${s.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`
  const cat = x ?? ys ?? dims[0]
  if (!cat) return ''
  const rest = dims.filter((d) => d !== cat).map((d) => d.key)
  return [`${cat.key} ${s?.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`, ...rest].join(', ')
}

/** Parameters in formulas: [Parameters].[Name] or $Name become literals. */
function substituteParams(formula: string, params: Map<string, Parameter>): string {
  return formula.replace(/\[Parameters\]\.\[([^\]]+)\]|\$([A-Za-z_]\w*)/g, (m, a?: string, b?: string) => {
    const p = params.get((a ?? b ?? '').toLowerCase())
    return p ? lit(p.value as never) : m
  })
}

function paramValue(f: ChartFilter, params: Map<string, Parameter>) {
  return f.param ? params.get(f.param.toLowerCase())?.value ?? null : null
}

function rangeSql(e: string, f: ChartFilter, params: Map<string, Parameter>): string {
  const pv = paramValue(f, params)
  const min = f.param && f.op === 'gte' ? pv : f.min
  const max = f.param && f.op === 'lte' ? pv : f.max
  const parts: string[] = []
  if (min !== undefined && min !== null && min !== '') parts.push(`${e} >= ${lit(min as never)}`)
  if (max !== undefined && max !== null && max !== '') parts.push(`${e} ${f.maxExclusive ? '<' : '<='} ${lit(max as never)}`)
  return parts.length ? `(${parts.join(' AND ')})` : 'TRUE'
}

export function filterSql(f: ChartFilter, rowExpr: (n: string) => { sql: string; type: string }, params: Map<string, Parameter> = new Map()): string {
  const { sql: e, type } = rowExpr(f.field)
  const pv = paramValue(f, params)
  switch (f.op) {
    case 'in':
    case 'not_in': {
      const vals = f.param ? [pv] : (f.values ?? [])
      if (!vals.length) return f.op === 'in' ? 'FALSE' : 'TRUE'
      const nonNull = vals.filter((v) => v !== null)
      const hasNull = nonNull.length < vals.length
      const cast = isDate(type) ? (v: string | number | boolean | null) => `CAST(${lit(v)} AS ${type.startsWith('TIMESTAMP') ? 'TIMESTAMP' : 'DATE'})` : lit
      const inList = nonNull.length ? `${e} IN (${nonNull.map(cast).join(', ')})` : 'FALSE'
      const pos = hasNull ? `(${inList} OR ${e} IS NULL)` : inList
      return f.op === 'in' ? pos : `NOT coalesce(${pos}, FALSE)`
    }
    case 'between':
    case 'gte':
    case 'lte':
      return rangeSql(isDate(type) ? e : e, f, params)
    case 'contains':
      return `contains(lower(CAST(${e} AS VARCHAR)), lower(${lit(String(f.param ? pv : (f.values?.[0] ?? '')))}))`
    case 'null':
      return `${e} IS NULL`
    case 'not_null':
      return `${e} IS NOT NULL`
    case 'relative': {
      const r = f.relative ?? { n: 1, unit: 'month', includeCurrent: true }
      const start = `date_trunc('${r.unit}', current_date) - INTERVAL ${Math.max(0, Math.floor(r.n) - (r.includeCurrent ? 1 : 0))} ${r.unit}`
      const end = r.includeCurrent ? `date_trunc('${r.unit}', current_date) + INTERVAL 1 ${r.unit}` : `date_trunc('${r.unit}', current_date)`
      return `(${e} >= ${start} AND ${e} < ${end})`
    }
    default:
      return 'TRUE'
  }
}

/** Double-quoted identifiers in SQL text (outside single-quoted strings). */
function quotedNames(sql: string): string[] {
  const out: string[] = []
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch !== "'" && ch !== '"') continue
    let j = i + 1
    for (; j < sql.length; j++) if (sql[j] === ch) {
      if (sql[j + 1] === ch) j++
      else break
    }
    if (ch === '"') out.push(sql.slice(i + 1, j).replace(/""/g, '"'))
    i = j
  }
  return out
}

/** Outermost aggregate calls in an expression: sum(…), count(DISTINCT …), countd(…). */
export function aggregateCalls(sql: string): { start: number; end: number; fn: string; inner: string; text: string }[] {
  const out: { start: number; end: number; fn: string; inner: string; text: string }[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      for (; j < sql.length; j++) if (sql[j] === ch) {
        if (sql[j + 1] === ch) j++
        else break
      }
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(ch) && !/[\w$]/.test(sql[i - 1] ?? '')) {
      let j = i
      while (j < sql.length && /[\w$]/.test(sql[j])) j++
      let k = j
      while (k < sql.length && /\s/.test(sql[k])) k++
      if (sql[k] === '(' && AGGREGATES.has(sql.slice(i, j).toLowerCase())) {
        let depth = 0
        let e = k
        for (; e < sql.length; e++) {
          const c = sql[e]
          if (c === "'" || c === '"') {
            const close = sql.indexOf(c, e + 1)
            e = close < 0 ? sql.length : close
            continue
          }
          if (c === '(') depth++
          else if (c === ')' && --depth === 0) break
        }
        out.push({ start: i, end: e + 1, fn: sql.slice(i, j), inner: sql.slice(k + 1, e), text: sql.slice(i, e + 1) })
        i = e + 1
        continue
      }
      i = j
      continue
    }
    i++
  }
  return out
}

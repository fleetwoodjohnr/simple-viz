// Charts over a model: several tables related by fields (Tableau's relationships, its "logical layer").
//
// Measures are never duplicated by joins. Each measure is computed from its own table: that table's rows are joined
// (left) to the tables holding the chart's dimensions and filters, along the relationships, and every row of the
// measure's table is counted once per combination of dimension values it relates to (rows are numbered, and the joined
// rows reduced to distinct (dimensions, row number) pairs before aggregating). The per-table results are stacked with
// UNION ALL BY NAME and combined per dimension combination. So two fact tables sharing a customer dimension, or a
// measure from a "one" side shown by a field of the "many" side, come out the way Tableau shows them.
//
// Fields are written table.column. Calculated fields follow Tableau's rules for related tables: a row-level calculation
// reads one table (it becomes a column of that table); an aggregate calculation aggregates each part at its own table
// (SUM([orders.revenue]) / SUM([customers.credit])) and combines the results per mark. A level-of-detail expression is
// its own question to the same planner (its value per combination of its dimensions), joined back by them; table
// calculations and quick calculations are windows over the marks.

import type { CalcField, Chart, Parameter, SetDef } from '../../shared/charts'
import { compileCalc, setTable, CalcError, type CalcSource, type Lod } from '../calc/compile'
import type { ColumnInfo } from '../../shared/engine-protocol'
import { tableSource, type Model } from '../../shared/project'
import { aggregateCalls, fieldTitle, filterSql, isDate, lit, quickCalc, quotedNames, substituteParams, tableCalcSql, topN, QueryError, type CompiledQuery, type OutField, type Role, type Windows } from './compile'

const q = (s: string) => `"${s.replace(/"/g, '""')}"`

const AGG: Record<string, (e: string) => string> = {
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
  p90: (e) => `quantile_cont(${e}, 0.9)`
}

export function splitField(field: string): { table: string; column: string } {
  const dot = field.indexOf('.')
  if (dot <= 0) throw new QueryError(`“${field}” should be written table.column in a model.`)
  return { table: field.slice(0, dot), column: field.slice(dot + 1) }
}

/** Shortest paths (breadth first) from `start` to every table, as join steps. */
function joinTree(model: Model, start: string): Map<string, { from: string; on: [string, string] }> {
  const tree = new Map<string, { from: string; on: [string, string] }>()
  const seen = new Set([start.toLowerCase()])
  const queue = [start]
  while (queue.length) {
    const t = queue.shift()!
    for (const r of model.relationships) {
      const [other, mine, theirs] = r.left.toLowerCase() === t.toLowerCase() ? [r.right, r.leftField, r.rightField] : r.right.toLowerCase() === t.toLowerCase() ? [r.left, r.rightField, r.leftField] : [null, '', '']
      if (!other || seen.has(other.toLowerCase())) continue
      seen.add(other.toLowerCase())
      tree.set(other.toLowerCase(), { from: t, on: [mine, theirs] })
      queue.push(other)
    }
  }
  return tree
}

/** Tables reachable from more than one way: relationships forming a loop make a chart ambiguous. */
export function modelProblems(model: Model): string[] {
  const out: string[] = []
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!
    return x
  }
  for (const r of model.relationships) {
    const a = find(r.left.toLowerCase())
    const b = find(r.right.toLowerCase())
    if (a === b) out.push(`${r.left} and ${r.right} are already related through other tables; this relationship makes a loop, so which path to use is ambiguous.`)
    else parent.set(a, b)
  }
  const tables = model.tables.map((t) => t.name.toLowerCase())
  for (const t of tables) if (tables.length > 1 && !model.relationships.some((r) => r.left.toLowerCase() === t || r.right.toLowerCase() === t)) out.push(`${model.tables.find((x) => x.name.toLowerCase() === t)!.name} isn’t related to any other table yet.`)
  return out
}

type ModelInput = {
  chart: Pick<Chart, 'enc' | 'filters' | 'options' | 'type'>
  model: Model
  columns: Record<string, ColumnInfo[]>
  maxMarks?: number
  extra?: Chart['filters']
  calcs?: (CalcSource & Partial<Pick<CalcField, 'set' | 'id'>>)[]
  params?: Parameter[]
  /** Internal (level of detail): aggregate SQL over the model's fields, added as measures after the chart's own. */
  aggExprs?: string[]
}

export function compileModelQuery(input: ModelInput): CompiledQuery {
  const { chart, model } = input
  const maxMarks = input.maxMarks ?? 20_000
  const calcs = input.calcs ?? []
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const params = new Map((input.params ?? []).map((p) => [p.name.toLowerCase(), p]))
  /** The same planner for a sub-question (a level of detail, the members of a top N), with the same fields. */
  const sub = (enc: Partial<Chart['enc']>, filters: Chart['filters'], extra: Partial<ModelInput> = {}) =>
    compileModelQuery({ chart: { type: 'bar', options: {}, filters, enc: { x: [], y: [], detail: [], tooltip: [], ...enc } }, model, columns: input.columns, calcs, params: input.params, maxMarks: 1e9, ...extra })
  // Every field of the model, as table.column, for calculated fields' [table.column] references.
  const allCols = model.tables.flatMap((t) => (input.columns[tableSource(t).toLowerCase()] ?? []).map((c) => `${t.name}.${c.name}`))
  // Level-of-detail values that became columns of a table (FIXED used row by row): joined to the table's rows by their
  // dimensions, so the table reads as if it had the column.
  const augment = new Map<string, { id: string; sql: string; on: string[] }[]>()
  /** FROM item for a model table: the data it reads, named as the model calls it. */
  const fromItem = (name: string) => {
    const t = model.tables.find((x) => x.name.toLowerCase() === name.toLowerCase())
    const base = t && tableSource(t) !== t.name ? `${q(tableSource(t))} AS ${q(t.name)}` : q(name)
    const lods = augment.get(name.toLowerCase())
    if (!lods?.length) return base
    const cols = lods.map((l, i) => `l${i}.m0 AS ${q(l.id)}`)
    const joins = lods.map((l, i) => `LEFT JOIN (${l.sql}) AS l${i} ON ${l.on.length ? l.on.map((k, j) => `${k} IS NOT DISTINCT FROM l${i}.d${j}`).join(' AND ') : 'TRUE'}`)
    return `(SELECT ${q(t?.name ?? name)}.*, ${cols.join(', ')} FROM ${base} ${joins.join(' ')}) AS ${q(t?.name ?? name)}`
  }
  const colSet = new Map(allCols.map((c) => [c.toLowerCase(), c]))
  /** "table.column" (as the calc compiler writes a reference) → "table"."column". */
  const toSql = (expr: string) => expr.replace(/"((?:[^"]|"")*)"/g, (m, name: string) => {
    const full = colSet.get(name.replace(/""/g, '"').toLowerCase())
    if (!full) return m
    const { table, column } = splitField(full)
    return `${q(table)}.${q(column)}`
  })
  const tablesIn = (expr: string) => [...new Set([...expr.matchAll(/"((?:[^"]|"")*)"/g)].map((x) => colSet.get(x[1].replace(/""/g, '"').toLowerCase())).filter((x): x is string => !!x).map((x) => splitField(x).table))]
  const calcCache = new Map<string, ReturnType<typeof compileCalc>>()
  const lodById = new Map<string, Lod>()
  const calcOf = (name: string) => {
    const c = calcs.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!c) return null
    if (!calcCache.has(c.name)) {
      try {
        const sub = (f: string) => substituteParams(f, params)
        const comp = compileCalc(sub(c.formula), allCols, calcs.map((x) => ({ name: x.name, formula: sub(x.formula) })), `mc${calcCache.size}`)
        // Computed sets (this one, or ones it reads): their member tables become sub-questions to this planner.
        for (const x of calcs) {
          const table = `"${setTable(x.id ?? x.name)}"`
          if ((x.set?.condition || x.set?.top) && comp.expr.includes(table)) comp.expr = comp.expr.split(table).join(`(${setMembers(x.name, x.set)})`)
        }
        if (comp.totals.length) throw new QueryError(`“${c.name}”: TOTAL() isn’t available on models yet; use WINDOW_SUM(SUM(…)) for a total over the marks.`)
        for (const l of comp.lods) lodById.set(l.id, l)
        calcCache.set(c.name, comp)
      } catch (e) {
        throw e instanceof CalcError ? new QueryError(`Calculated field “${c.name}”: ${e.message}`) : e
      }
    }
    return { name: c.name, ...calcCache.get(c.name)! }
  }
  const allFilters = [...chart.filters, ...(input.extra ?? [])]
  const contextFilters = allFilters.filter((f) => f.context && !f.agg && f.op !== 'top')
  /** A computed set's members (column k): the field's values meeting the condition, or the top N, after context filters. */
  const setMembers = (owner: string, s: SetDef): string => {
    if (s.top) {
      const n = Math.max(1, Math.floor(s.top.n))
      const by = calcs.some((x) => same(x.name, s.top!.by)) && calcOf(s.top.by)?.kind === 'aggregate' ? { field: s.top.by } : { field: s.top.by, agg: s.top.agg ?? 'sum' }
      const sql = sub({ x: [{ field: s.field }], y: [by] }, contextFilters, { maxMarks: n - 1 }).sql.replace(/ ORDER BY [^\n]*? LIMIT \d+$/, ` ORDER BY m0 ${s.top.bottom ? 'ASC' : 'DESC'} NULLS LAST, d0 LIMIT ${n}`)
      return `SELECT d0 AS k FROM (${sql})`
    }
    let cond: ReturnType<typeof compileCalc>
    try {
      cond = compileCalc(substituteParams(s.condition!, params), allCols, calcs.map((x) => ({ name: x.name, formula: substituteParams(x.formula, params) })), `ms${calcCache.size}`)
    } catch (e) {
      throw new QueryError(`Set “${owner}”: ${(e as Error).message}`)
    }
    if (cond.kind !== 'aggregate' || cond.lods.length) throw new QueryError(`Set “${owner}”: the condition must aggregate, e.g. SUM([orders.revenue]) > 1000.`)
    return `SELECT d0 AS k FROM (${sub({ x: [{ field: s.field }] }, contextFilters, { aggExprs: [cond.expr] }).sql}) WHERE m0`
  }
  /**
   * A FIXED level of detail made a column of the one table holding its dimensions: its value per combination of
   * those dimensions (computed by this planner, before dimension filters, after context filters) joined to that
   * table's rows. Returns the column, as "table"."id".
   */
  const lodColumn = (lod: Lod, owner: string): { table: string; sql: string } => {
    if (lod.kind !== 'fixed') throw new QueryError('INCLUDE and EXCLUDE depend on the view, so they can’t be read row by row on a model; aggregate them (e.g. AVG({INCLUDE …})) or use FIXED.')
    const dimCols = lod.dims.map((d) => colOf(d))
    const tables = [...new Set(dimCols.map((c) => c.table))]
    if (tables.length > 1) throw new QueryError(`“${owner}”: on a model, a FIXED expression used row by row needs dimensions from one table (these are in ${tables.join(' and ')}).`)
    const table = tables[0] ?? tablesIn(lod.agg)[0]
    if (!table) throw new QueryError(`“${owner}”: this level-of-detail expression reads no field.`)
    const list = augment.get(table.toLowerCase()) ?? []
    if (!list.some((l) => l.id === lod.id)) {
      list.push({ id: lod.id, sql: sub({ x: lod.dims.map((field) => ({ field })) }, contextFilters, { aggExprs: [lod.agg] }).sql, on: dimCols.map((c) => c.sql) })
      augment.set(table.toLowerCase(), list)
    }
    return { table, sql: `${q(table)}.${q(lod.id)}` }
  }
  /** A row-level expression with level-of-detail placeholders: each placeholder becomes its table column. */
  const withLods = (expr: string, owner: string): { sql: string; tables: string[] } => {
    let sql = toSql(expr)
    const tables = tablesIn(expr)
    for (const id of quotedNames(expr)) {
      const lod = lodById.get(id)
      if (!lod) continue
      const c = lodColumn(lod, owner)
      tables.push(c.table)
      sql = sql.split(q(id)).join(c.sql)
    }
    return { sql, tables: [...new Set(tables)] }
  }
  const colOf = (field: string): { table: string; column: string; type: string; sql: string } => {
    const calc = !field.includes('.') || !colSet.has(field.toLowerCase()) ? calcOf(field) : null
    if (calc) {
      if (calc.kind !== 'row') throw new QueryError(`“${calc.name}” aggregates: use it as a measure.`)
      const { sql, tables } = withLods(calc.expr, calc.name)
      if (tables.length !== 1) throw new QueryError(`“${calc.name}” reads ${tables.length ? `fields of ${tables.join(' and ')}` : 'no field'}; a row-level calculation on a model reads one table (aggregate each table’s part instead, e.g. SUM([a.x]) / SUM([b.y])).`)
      return { table: tables[0], column: calc.name, type: 'VARCHAR', sql: `(${sql})` }
    }
    const { table, column } = splitField(field)
    const t = model.tables.find((x) => x.name.toLowerCase() === table.toLowerCase())
    if (!t) throw new QueryError(`The model ${model.name} has no table “${table}”.`)
    const c = input.columns[tableSource(t).toLowerCase()]?.find((x) => x.name.toLowerCase() === column.toLowerCase())
    if (!c) throw new QueryError(`There is no field “${column}” in ${t.name}.`)
    return { table: t.name, column: c.name, type: c.type, sql: `${q(t.name)}.${q(c.name)}` }
  }

  const fields: OutField[] = []
  /** Measures that are calculations (aggregate or table calculation), or aggregates of a level of detail, by key. */
  const calcMeasures = new Map<string, { name: string; kind: 'aggregate' | 'tablecalc'; expr: string; comp?: ReturnType<typeof compileCalc> }>()
  const add = (role: Role, ref: Chart['enc']['x'][number] | undefined) => {
    if (!ref) return
    const calc = colSet.has(ref.field.toLowerCase()) ? null : calcOf(ref.field)
    if (calc && (calc.kind === 'aggregate' || calc.kind === 'tablecalc')) {
      const key = `m${fields.filter((f) => f.kind === 'measure').length}`
      calcMeasures.set(key, { name: calc.name, kind: calc.kind, expr: calc.expr, comp: calc })
      fields.push({ key, role, ref: { ...ref, agg: 'none' }, kind: 'measure', title: ref.label ?? calc.name, type: 'DOUBLE' })
      return
    }
    const measure = !!ref.agg && ref.agg !== 'none'
    // An aggregated row calculation made of levels of detail: aggregated like Tableau, over one row per combination of
    // the view's and the LOD's dimensions.
    if (calc && measure && calc.lods.length) {
      const key = `m${fields.filter((f) => f.kind === 'measure').length}`
      calcMeasures.set(key, { name: calc.name, kind: 'aggregate', expr: AGG[ref.agg!](calc.expr) })
      fields.push({ key, role, ref, kind: 'measure', title: fieldTitle(ref), type: 'DOUBLE' })
      return
    }
    const c = colOf(ref.field)
    const key = measure ? `m${fields.filter((f) => f.kind === 'measure').length}` : `d${fields.filter((f) => f.kind === 'dim').length}`
    fields.push({ key, role, ref, kind: measure ? 'measure' : 'dim', title: fieldTitle({ ...ref, field: ref.label ? ref.field : c.column }), type: c.type })
  }
  const e = chart.enc
  e.x.forEach((r) => add('x', r))
  e.y.forEach((r) => add('y', r))
  add('color', e.color)
  add('size', e.size)
  add('label', e.label)
  e.detail.forEach((r) => add('detail', r))
  e.tooltip.forEach((r) => add('tooltip', r))
  add('facet', e.facet)
  for (const expr of input.aggExprs ?? []) {
    const key = `m${fields.filter((f) => f.kind === 'measure').length}`
    for (const id of quotedNames(expr)) if (lodById.has(id)) throw new QueryError('A level-of-detail expression inside another isn’t available on models yet.')
    calcMeasures.set(key, { name: 'level of detail', kind: 'aggregate', expr })
    fields.push({ key, role: 'y', ref: { field: key, agg: 'none' }, kind: 'measure', title: key, type: 'DOUBLE' })
  }

  const dims = fields.filter((f) => f.kind === 'dim')
  const measures = fields.filter((f) => f.kind === 'measure')
  const dimSql = (f: OutField) => {
    const c = colOf(f.ref.field)
    return isDate(c.type) && f.ref.grain && f.ref.grain !== 'exact' ? `CAST(date_trunc('${f.ref.grain}', ${c.sql}) AS DATE)` : c.sql
  }
  const dimFilters = allFilters.filter((f) => !f.agg && f.op !== 'top')
  const measureFilters = allFilters.filter((f) => f.agg && f.op !== 'top')
  const tops = allFilters.filter((f) => f.op === 'top' && f.top)
  const filterTables = [...dimFilters, ...tops].map((f) => colOf(f.field).table)
  const where = dimFilters.map((f) =>
    filterSql(
      f,
      (n) => {
        const c = colOf(n)
        return { sql: c.sql, type: c.type }
      },
      params
    )
  )
  // Top N: the values with the highest (or lowest) measure, computed by the same planner (after the other
  // dimension filters), so the measure is not duplicated by joins either.
  for (const f of tops) {
    const by = f.top!.by
    const n = topN(f, params)
    const s = sub({ x: [{ field: f.field }], y: [{ field: by.field, agg: by.agg && by.agg !== 'none' ? by.agg : 'sum' }] }, dimFilters, { maxMarks: n - 1 })
    const sorted = s.sql.replace(/ ORDER BY [^\n]*? LIMIT \d+$/, ` ORDER BY m0 ${f.top!.bottom ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${n}`)
    where.push(`${colOf(f.field).sql} IN (SELECT d0 FROM (${sorted}))`)
  }

  /** FROM the start table, left-joining every table needed along the relationships. */
  const fromClause = (start: string, needed: string[], numbered: boolean) => {
    const tree = joinTree(model, start)
    const order: string[] = []
    const need = (t: string) => {
      if (t.toLowerCase() === start.toLowerCase() || order.includes(t)) return
      const step = tree.get(t.toLowerCase())
      if (!step) throw new QueryError(`No relationship connects ${start} and ${t} in ${model.name}. Relate them in the model.`)
      need(step.from)
      order.push(t)
    }
    needed.forEach(need)
    const startSql = numbered ? `(SELECT *, row_number() OVER () AS __rid FROM ${fromItem(start)}) AS ${q(start)}` : fromItem(start)
    return `${startSql}${order.map((t) => {
      const step = tree.get(t.toLowerCase())!
      return `\n    LEFT JOIN ${fromItem(t)} ON ${q(step.from)}.${q(step.on[0])} = ${q(t)}.${q(step.on[1])}`
    }).join('')}`
  }

  const dimTables = [...new Set([...dims.map((d) => colOf(d.ref.field).table), ...filterTables])]
  const branches: string[] = []
  // What each table aggregates: the chart's measures, and the parts of aggregate calculations (hidden columns h0, h1…).
  type Part = { key: string; sql: string; agg: (v: string) => string }
  const byTable = new Map<string, Part[]>()
  const put = (table: string, part: Part) => byTable.set(table, [...(byTable.get(table) ?? []), part])
  const lodKeys: string[] = []
  let hidden = 0
  const viewRefs = dims.map((d) => d.ref)
  /**
   * An aggregate of a level of detail, as Tableau computes it: the LOD's value per combination of its dimensions
   * (FIXED: its own; INCLUDE: the view's and its own; EXCLUDE: the view's without them), then the aggregate over one
   * row per combination of the view's and the LOD's dimensions. A branch of its own, joined to the marks by the view's
   * dimensions.
   */
  const lodBranch = (lod: Lod, call: { fn: string; inner: string }, key: string) => {
    const distinct = /^\s*DISTINCT\s+/i.test(call.inner) ? 'DISTINCT ' : ''
    const val = toSql(call.inner.replace(/^\s*DISTINCT\s+/i, '')).split(q(lod.id)).join('v.m0')
    if (tablesIn(val).length) throw new QueryError('On a model, an aggregate of a level-of-detail expression reads only level-of-detail values (e.g. AVG({FIXED [orders.customer_id] : SUM([orders.revenue])})).')
    const agg = `${call.fn}(${distinct}${val}) AS ${key}`
    const viewKeys = dims.map((d, i) => `c.d${i} AS ${d.key}`)
    const group = dims.length ? ' GROUP BY ALL' : ''
    if (lod.kind === 'include') {
      const extra = lod.dims.filter((f) => !viewRefs.some((v) => same(v.field, f))).map((field) => ({ field }))
      const v = sub({ x: [...viewRefs, ...extra] }, allFilters.filter((f) => !f.agg), { aggExprs: [lod.agg] })
      lodKeys.push(key)
      return branches.push(`SELECT ${[...dims.map((d, i) => `v.d${i} AS ${d.key}`), agg].join(', ')} FROM (${v.sql}) AS v${group}`)
    }
    const lodRefs = lod.kind === 'exclude' ? viewRefs.filter((r) => !lod.dims.some((f) => same(f, r.field))) : lod.dims.map((field) => ({ field }))
    const v = sub({ x: lodRefs }, lod.kind === 'fixed' ? contextFilters : allFilters.filter((f) => !f.agg), { aggExprs: [lod.agg] })
    lodKeys.push(key)
    if (!dims.length && (lod.kind === 'exclude' || !lodRefs.length)) return branches.push(`SELECT ${agg} FROM (${v.sql}) AS v`)
    // The marks (and, for FIXED, the LOD's dimensions with them): the combinations the LOD's own rows have, filtered
    // like the view, so rows without a match form a Null group as they do for plain measures.
    const comboRefs = lod.kind === 'fixed' ? [...viewRefs, ...lodRefs] : viewRefs
    const combos = sub({ x: comboRefs }, allFilters.filter((f) => !f.agg), { aggExprs: [lod.agg] })
    const on = lodRefs.map((r, j) => `c.d${lod.kind === 'fixed' ? dims.length + j : viewRefs.indexOf(r)} IS NOT DISTINCT FROM v.d${j}`)
    branches.push(`SELECT ${[...viewKeys, agg].join(', ')} FROM (SELECT DISTINCT ${comboRefs.map((_, i) => `d${i}`).join(', ')} FROM (${combos.sql})) AS c LEFT JOIN (${v.sql}) AS v ON ${on.length ? on.join(' AND ') : 'TRUE'}${group}`)
  }
  /** An aggregate expression split into per-table parts (and LOD branches); returns it over the parts' keys. */
  const aggParts = (exprIn: string, owner: string): string => {
    let expr = exprIn
    for (const call of aggregateCalls(exprIn).reverse()) {
      const key = `h${hidden++}`
      const lods = [...new Set(quotedNames(call.inner).filter((n) => lodById.has(n)))]
      if (lods.length > 1) throw new QueryError(`“${owner}”: ${call.text} combines several level-of-detail expressions; on a model, aggregate each on its own.`)
      if (lods.length && !tablesIn(call.inner).length) lodBranch(lodById.get(lods[0])!, call, key)
      else {
        const { sql, tables } = withLods(call.inner, owner)
        if (tables.length !== 1) throw new QueryError(`“${owner}”: ${call.text} ${tables.length ? `reads fields of ${tables.join(' and ')}` : 'reads no field'}; on a model each aggregate reads one table.`)
        const distinct = /^\s*DISTINCT\s+/i.test(call.inner)
        put(tables[0], { key, sql: sql.replace(/^\s*DISTINCT\s+/i, ''), agg: (v) => `${call.fn}(${distinct ? 'DISTINCT ' : ''}${v})` })
      }
      expr = expr.slice(0, call.start) + key + expr.slice(call.end)
    }
    if (tablesIn(expr).length) throw new QueryError(`“${owner}” uses a field outside an aggregate; on a model every field in an aggregate calculation must be aggregated.`)
    return expr
  }

  const finalExpr = new Map<string, string>()
  /** Table calculations' aggregate inputs (by id), computed per mark before the windows. */
  const tcInputs: string[] = []
  for (const m of measures) {
    const calc = calcMeasures.get(m.key)
    if (!calc) {
      const c = colOf(m.ref.field)
      put(c.table, { key: m.key, sql: c.sql, agg: (v) => AGG[m.ref.agg!](v) })
      continue
    }
    if (calc.kind === 'tablecalc') {
      for (const a of calc.comp!.aggs) tcInputs.push(`${aggParts(a.expr, calc.name)} AS ${q(a.id)}`)
      continue
    }
    finalExpr.set(m.key, aggParts(calc.expr, calc.name))
  }
  const partKeys = [...[...byTable.values()].flat().map((p) => p.key), ...lodKeys]
  for (const [table, ms] of byTable) {
    const from = fromClause(table, dimTables, true)
    const inner = [...dims.map((d) => `${dimSql(d)} AS ${d.key}`), `${q(table)}.__rid`, ...ms.map((m) => `${m.sql} AS __v_${m.key}`)]
    const outer = [...dims.map((d) => d.key), ...ms.map((m) => `${m.agg(`__v_${m.key}`)} AS ${m.key}`)]
    branches.push(`SELECT ${outer.join(', ')} FROM (\n  SELECT DISTINCT ${inner.join(', ')}\n  FROM ${from}${where.length ? `\n  WHERE ${where.join(' AND ')}` : ''}\n)${dims.length ? ' GROUP BY ALL' : ''}`)
  }
  if (!measures.length) {
    if (!dims.length) throw new QueryError('Add a field to the chart.')
    const start = colOf(dims[0].ref.field).table
    branches.push(`SELECT DISTINCT ${dims.map((d) => `${dimSql(d)} AS ${d.key}`).join(', ')}\n  FROM ${fromClause(start, dimTables, false)}${where.length ? `\n  WHERE ${where.join(' AND ')}` : ''}`)
  }

  const having = measureFilters.map((f) => {
    const m = measures.find((x) => x.ref.field === f.field && x.ref.agg === f.agg)
    if (!m) throw new QueryError(`Put ${f.field} on the chart to filter on its total in a model.`)
    const parts = [f.min != null && f.min !== '' ? `${m.key} >= ${lit(f.min as never)}` : '', f.max != null && f.max !== '' ? `${m.key} ${f.maxExclusive ? '<' : '<='} ${lit(f.max as never)}` : ''].filter(Boolean)
    return parts.length ? parts.join(' AND ') : 'TRUE'
  })
  const sortDim = dims.find((d) => d.role === 'x') ?? dims[0]
  // Then by the other dimensions, so marks with the same first value always come in the same order.
  const rest = dims.filter((d) => d !== sortDim).map((d) => `${d.key} ASC NULLS LAST`)
  const order = [chart.options.sort?.by === 'value' && measures[0] ? `${measures[0].key} ${chart.options.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : sortDim ? `${sortDim.key} ${chart.options.sort?.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : '', ...rest].filter(Boolean).join(', ')
  const combined = branches.length === 1 && !measures.length ? branches[0] : `SELECT ${[...dims.map((d) => d.key), ...partKeys.map((k) => `any_value(${k}) AS ${k}`)].join(', ')} FROM (\n${branches.join('\nUNION ALL BY NAME\n')}\n)${dims.length ? ' GROUP BY ALL' : ''}`
  const perMark = [...dims.map((d) => d.key), ...measures.filter((m) => calcMeasures.get(m.key)?.kind !== 'tablecalc').map((m) => (finalExpr.has(m.key) ? `${finalExpr.get(m.key)} AS ${m.key}` : m.key)), ...tcInputs]
  const marks = `SELECT ${perMark.join(', ')} FROM (\n${combined}\n)${having.length ? ` WHERE ${having.join(' AND ')}` : ''}`
  // Table calculations and quick calculations: windows over the marks, along the x axis within each pane (or along
  // the "compute using" dimensions), as on datasets.
  const windowed = measures.some((m) => calcMeasures.get(m.key)?.kind === 'tablecalc' || !!m.ref.quick)
  if (!windowed) return { sql: `${marks}${order ? ` ORDER BY ${order}` : ''} LIMIT ${maxMarks + 1}`, fields, limit: maxMarks }
  const along = (m: OutField): Windows => {
    const want = (m.ref.computeUsing ?? []).map((f) => f.toLowerCase())
    const by = want.length ? dims.filter((d) => d.role !== 'tooltip' && want.includes(d.ref.field.toLowerCase())) : dims.filter((d) => d.role === 'x')
    const part = dims.filter((d) => d.role !== 'tooltip' && !by.includes(d)).map((d) => d.key)
    const p = part.length ? `PARTITION BY ${part.join(', ')}` : ''
    return { ordered: (o) => `OVER (${p ? `${p} ` : ''}ORDER BY ${o ?? (by.length ? by.map((d) => d.key).join(', ') : '1')})`, all: () => `OVER (${p})` }
  }
  const finalCols = [...dims.map((d) => d.key), ...measures.map((m) => {
    const c = calcMeasures.get(m.key)
    if (c?.kind === 'tablecalc') return `${tableCalcSql(c.comp!, along(m))} AS ${m.key}`
    return quickCalc(m, along(m), dims)
  })]
  return { sql: `SELECT ${finalCols.join(', ')} FROM (\n${marks}\n)${order ? ` ORDER BY ${order}` : ''} LIMIT ${maxMarks + 1}`, fields, limit: maxMarks }
}

/** Relationship suggestions for two tables: same-named columns of compatible types (customer_id ↔ customer_id, id ↔ customer_id). */
export function suggestRelationships(a: { name: string; columns: ColumnInfo[] }, b: { name: string; columns: ColumnInfo[] }): { leftField: string; rightField: string; why: string }[] {
  const out: { leftField: string; rightField: string; why: string }[] = []
  const kind = (t: string) => (/INT|DECIMAL|DOUBLE|FLOAT|REAL/.test(t) ? 'num' : /DATE|TIME/.test(t) ? 'date' : 'text')
  const singular = (s: string) => s.toLowerCase().replace(/(ies)$/, 'y').replace(/s$/, '')
  for (const ca of a.columns)
    for (const cb of b.columns) {
      if (kind(ca.type) !== kind(cb.type)) continue
      const na = ca.name.toLowerCase()
      const nb = cb.name.toLowerCase()
      if (na === nb && (/(_id|id|_key|code|_no|number)$/.test(na) || kind(ca.type) !== 'num')) out.push({ leftField: ca.name, rightField: cb.name, why: 'Same name' })
      else if (na === 'id' && nb === `${singular(a.name)}_id`) out.push({ leftField: ca.name, rightField: cb.name, why: `${b.name}.${cb.name} refers to ${a.name}` })
      else if (nb === 'id' && na === `${singular(b.name)}_id`) out.push({ leftField: ca.name, rightField: cb.name, why: `${a.name}.${ca.name} refers to ${b.name}` })
    }
  return out
}

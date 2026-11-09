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
// (SUM([orders.revenue]) / SUM([customers.credit])) and combines the results per mark. LOD expressions and table
// calculations aren't available on models yet.

import type { Chart, Parameter } from '../../shared/charts'
import { compileCalc, CalcError, type CalcSource } from '../calc/compile'
import type { ColumnInfo } from '../../shared/engine-protocol'
import { tableSource, type Model } from '../../shared/project'
import { aggregateCalls, fieldTitle, filterSql, isDate, lit, substituteParams, QueryError, type CompiledQuery, type OutField, type Role } from './compile'

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

export function compileModelQuery(input: { chart: Pick<Chart, 'enc' | 'filters' | 'options' | 'type'>; model: Model; columns: Record<string, ColumnInfo[]>; maxMarks?: number; extra?: Chart['filters']; calcs?: CalcSource[]; params?: Parameter[] }): CompiledQuery {
  const { chart, model } = input
  const maxMarks = input.maxMarks ?? 20_000
  const calcs = input.calcs ?? []
  const params = new Map((input.params ?? []).map((p) => [p.name.toLowerCase(), p]))
  // Every field of the model, as table.column, for calculated fields' [table.column] references.
  const allCols = model.tables.flatMap((t) => (input.columns[tableSource(t).toLowerCase()] ?? []).map((c) => `${t.name}.${c.name}`))
  /** FROM item for a model table: the data it reads, named as the model calls it. */
  const fromItem = (name: string) => {
    const t = model.tables.find((x) => x.name.toLowerCase() === name.toLowerCase())
    return t && tableSource(t) !== t.name ? `${q(tableSource(t))} AS ${q(t.name)}` : q(name)
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
  const calcOf = (name: string) => {
    const c = calcs.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!c) return null
    if (!calcCache.has(c.name)) {
      try {
        const sub = (f: string) => substituteParams(f, params)
        const comp = compileCalc(sub(c.formula), allCols, calcs.map((x) => ({ name: x.name, formula: sub(x.formula) })), `mc${calcCache.size}`)
        if (comp.kind === 'tablecalc' || comp.lods.length) throw new QueryError(`“${c.name}”: level of detail expressions and table calculations aren’t available on models yet.`)
        calcCache.set(c.name, comp)
      } catch (e) {
        throw e instanceof CalcError ? new QueryError(`Calculated field “${c.name}”: ${e.message}`) : e
      }
    }
    return { name: c.name, ...calcCache.get(c.name)! }
  }
  const colOf = (field: string): { table: string; column: string; type: string; sql: string } => {
    const calc = !field.includes('.') || !colSet.has(field.toLowerCase()) ? calcOf(field) : null
    if (calc) {
      if (calc.kind !== 'row') throw new QueryError(`“${calc.name}” aggregates: use it as a measure.`)
      const tables = tablesIn(calc.expr)
      if (tables.length !== 1) throw new QueryError(`“${calc.name}” reads ${tables.length ? `fields of ${tables.join(' and ')}` : 'no field'}; a row-level calculation on a model reads one table (aggregate each table’s part instead, e.g. SUM([a.x]) / SUM([b.y])).`)
      return { table: tables[0], column: calc.name, type: 'VARCHAR', sql: `(${toSql(calc.expr)})` }
    }
    const { table, column } = splitField(field)
    const t = model.tables.find((x) => x.name.toLowerCase() === table.toLowerCase())
    if (!t) throw new QueryError(`The model ${model.name} has no table “${table}”.`)
    const c = input.columns[tableSource(t).toLowerCase()]?.find((x) => x.name.toLowerCase() === column.toLowerCase())
    if (!c) throw new QueryError(`There is no field “${column}” in ${t.name}.`)
    return { table: t.name, column: c.name, type: c.type, sql: `${q(t.name)}.${q(c.name)}` }
  }

  const fields: OutField[] = []
  /** Aggregate calculations in the view, by measure key. */
  const aggCalcs = new Map<string, NonNullable<ReturnType<typeof calcOf>>>()
  const add = (role: Role, ref: Chart['enc']['x'][number] | undefined) => {
    if (!ref) return
    const calc = colSet.has(ref.field.toLowerCase()) ? null : calcOf(ref.field)
    if (calc && calc.kind === 'aggregate') {
      const key = `m${fields.filter((f) => f.kind === 'measure').length}`
      aggCalcs.set(key, calc)
      fields.push({ key, role, ref: { ...ref, agg: 'none' }, kind: 'measure', title: ref.label ?? calc.name, type: 'DOUBLE' })
      return
    }
    const c = colOf(ref.field)
    const measure = !!ref.agg && ref.agg !== 'none'
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

  const dims = fields.filter((f) => f.kind === 'dim')
  const measures = fields.filter((f) => f.kind === 'measure')
  const dimSql = (f: OutField) => {
    const c = colOf(f.ref.field)
    return isDate(c.type) && f.ref.grain && f.ref.grain !== 'exact' ? `CAST(date_trunc('${f.ref.grain}', ${c.sql}) AS DATE)` : c.sql
  }
  const allFilters = [...chart.filters, ...(input.extra ?? [])]
  const dimFilters = allFilters.filter((f) => !f.agg && f.op !== 'top')
  const measureFilters = allFilters.filter((f) => f.agg && f.op !== 'top')
  const tops = allFilters.filter((f) => f.op === 'top' && f.top)
  const filterTables = [...dimFilters, ...tops].map((f) => colOf(f.field).table)
  const where = dimFilters.map((f) => filterSql(f, (n) => {
    const c = colOf(n)
    return { sql: c.sql, type: c.type }
  }))
  // Top N: the values with the highest (or lowest) measure, computed by the same planner (after the other
  // dimension filters), so the measure is not duplicated by joins either.
  for (const f of tops) {
    const by = f.top!.by
    const sub = compileModelQuery({
      chart: { type: 'bar', enc: { x: [{ field: f.field }], y: [{ field: by.field, agg: by.agg && by.agg !== 'none' ? by.agg : 'sum' }], detail: [], tooltip: [] }, filters: dimFilters, options: { sort: { by: 'value', dir: f.top!.bottom ? 'asc' : 'desc' } } },
      model,
      columns: input.columns,
      maxMarks: Math.max(1, Math.floor(f.top!.n)) - 1
    })
    where.push(`${colOf(f.field).sql} IN (SELECT d0 FROM (${sub.sql}))`)
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
  const finalExpr = new Map<string, string>()
  let hidden = 0
  for (const m of measures) {
    const calc = aggCalcs.get(m.key)
    if (!calc) {
      const c = colOf(m.ref.field)
      put(c.table, { key: m.key, sql: c.sql, agg: (v) => AGG[m.ref.agg!](v) })
      continue
    }
    let expr = calc.expr
    for (const call of aggregateCalls(calc.expr).reverse()) {
      const tables = tablesIn(call.inner)
      if (tables.length !== 1) throw new QueryError(`“${calc.name}”: ${call.text} ${tables.length ? `reads fields of ${tables.join(' and ')}` : 'reads no field'}; on a model each aggregate reads one table.`)
      const distinct = /^\s*DISTINCT\s+/i.test(call.inner)
      const key = `h${hidden++}`
      put(tables[0], { key, sql: toSql(call.inner.replace(/^\s*DISTINCT\s+/i, '')), agg: (v) => `${call.fn}(${distinct ? 'DISTINCT ' : ''}${v})` })
      expr = expr.slice(0, call.start) + key + expr.slice(call.end)
    }
    if (tablesIn(expr).length) throw new QueryError(`“${calc.name}” uses a field outside an aggregate; on a model every field in an aggregate calculation must be aggregated.`)
    finalExpr.set(m.key, expr)
  }
  const partKeys = [...byTable.values()].flat().map((p) => p.key)
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
  const order = chart.options.sort?.by === 'value' && measures[0] ? `${measures[0].key} ${chart.options.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : sortDim ? `${sortDim.key} ${chart.options.sort?.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : ''
  const combined = branches.length === 1 && !measures.length ? branches[0] : `SELECT ${[...dims.map((d) => d.key), ...partKeys.map((k) => `any_value(${k}) AS ${k}`)].join(', ')} FROM (\n${branches.join('\nUNION ALL BY NAME\n')}\n)${dims.length ? ' GROUP BY ALL' : ''}`
  const sql = `SELECT ${[...dims.map((d) => d.key), ...measures.map((m) => (finalExpr.has(m.key) ? `${finalExpr.get(m.key)} AS ${m.key}` : m.key))].join(', ')} FROM (\n${combined}\n)${having.length ? ` WHERE ${having.join(' AND ')}` : ''}${order ? ` ORDER BY ${order}` : ''} LIMIT ${maxMarks + 1}`
  return { sql, fields, limit: maxMarks }
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

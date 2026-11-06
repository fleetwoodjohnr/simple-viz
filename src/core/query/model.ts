// Charts over a model: several tables related by fields (Tableau's relationships, its "logical layer").
//
// Measures are never duplicated by joins. Each measure is computed from its own table: that table's rows are joined
// (left) to the tables holding the chart's dimensions and filters, along the relationships, and every row of the
// measure's table is counted once per combination of dimension values it relates to (rows are numbered, and the joined
// rows reduced to distinct (dimensions, row number) pairs before aggregating). The per-table results are stacked with
// UNION ALL BY NAME and combined per dimension combination. So two fact tables sharing a customer dimension, or a
// measure from a "one" side shown by a field of the "many" side, come out the way Tableau shows them.
//
// Fields are written table.column. Calculated fields and top-N filters are single-table features for now.

import type { Chart } from '../../shared/charts'
import type { ColumnInfo } from '../../shared/engine-protocol'
import type { Model } from '../../shared/project'
import { fieldTitle, filterSql, isDate, lit, QueryError, type CompiledQuery, type OutField, type Role } from './compile'

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

export function compileModelQuery(input: { chart: Pick<Chart, 'enc' | 'filters' | 'options' | 'type'>; model: Model; columns: Record<string, ColumnInfo[]>; maxMarks?: number; extra?: Chart['filters'] }): CompiledQuery {
  const { chart, model } = input
  const maxMarks = input.maxMarks ?? 20_000
  const colOf = (field: string) => {
    const { table, column } = splitField(field)
    const t = model.tables.find((x) => x.name.toLowerCase() === table.toLowerCase())
    if (!t) throw new QueryError(`The model ${model.name} has no table “${table}”.`)
    const c = input.columns[t.name.toLowerCase()]?.find((x) => x.name.toLowerCase() === column.toLowerCase())
    if (!c) throw new QueryError(`There is no field “${column}” in ${t.name}.`)
    return { table: t.name, column: c.name, type: c.type, sql: `${q(t.name)}.${q(c.name)}` }
  }

  const fields: OutField[] = []
  const add = (role: Role, ref: Chart['enc']['x'][number] | undefined) => {
    if (!ref) return
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
  if (allFilters.some((f) => f.op === 'top')) throw new QueryError('Top N filters work on single tables and datasets for now, not on models.')
  const dimFilters = allFilters.filter((f) => !f.agg)
  const measureFilters = allFilters.filter((f) => f.agg)
  const filterTables = dimFilters.map((f) => colOf(f.field).table)
  const where = dimFilters.map((f) => filterSql(f, (n) => {
    const c = colOf(n)
    return { sql: c.sql, type: c.type }
  }))

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
    const startSql = numbered ? `(SELECT *, row_number() OVER () AS __rid FROM ${q(start)}) AS ${q(start)}` : q(start)
    return `${startSql}${order.map((t) => {
      const step = tree.get(t.toLowerCase())!
      return `\n    LEFT JOIN ${q(t)} ON ${q(step.from)}.${q(step.on[0])} = ${q(t)}.${q(step.on[1])}`
    }).join('')}`
  }

  const dimTables = [...new Set([...dims.map((d) => colOf(d.ref.field).table), ...filterTables])]
  const branches: string[] = []
  const byTable = new Map<string, OutField[]>()
  for (const m of measures) {
    const t = colOf(m.ref.field).table
    byTable.set(t, [...(byTable.get(t) ?? []), m])
  }
  for (const [table, ms] of byTable) {
    const from = fromClause(table, dimTables, true)
    const inner = [...dims.map((d) => `${dimSql(d)} AS ${d.key}`), `${q(table)}.__rid`, ...ms.map((m) => `${colOf(m.ref.field).sql} AS __v_${m.key}`)]
    const outer = [...dims.map((d) => d.key), ...ms.map((m) => `${AGG[m.ref.agg!](`__v_${m.key}`)} AS ${m.key}`)]
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
  const combined = branches.length === 1 && !measures.length ? branches[0] : `SELECT ${[...dims.map((d) => d.key), ...measures.map((m) => `any_value(${m.key}) AS ${m.key}`)].join(', ')} FROM (\n${branches.join('\nUNION ALL BY NAME\n')}\n)${dims.length ? ' GROUP BY ALL' : ''}`
  const sql = `SELECT ${[...dims.map((d) => d.key), ...measures.map((m) => m.key)].join(', ')} FROM (\n${combined}\n)${having.length ? ` WHERE ${having.join(' AND ')}` : ''}${order ? ` ORDER BY ${order}` : ''} LIMIT ${maxMarks + 1}`
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

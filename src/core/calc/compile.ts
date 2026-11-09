// Calculated fields: DuckDB SQL expressions, plus the Tableau conventions analysts already know:
//   [Field Name]                          a column or another calculated field
//   IF c THEN a ELSEIF c2 THEN b ELSE d END  (Tableau's IF; DuckDB's if(c, a, b) also works)
//   {FIXED [Region] : SUM([Sales])}       level of detail: FIXED, INCLUDE, EXCLUDE
//   RUNNING_SUM(SUM([Sales])), WINDOW_AVG(SUM([x]), -2, 0), RANK(SUM([x])), LOOKUP(SUM([x]), -1),
//   INDEX(), SIZE(), FIRST(), LAST(), TOTAL(SUM([x]))   table calculations
//   ZN, IIF, COUNTD, ATTR, DATEADD, …     Tableau function names (src/core/calc/macros.ts)
// Everything else is passed to DuckDB, which parses and checks it.
//
// A calculation compiles to one of three kinds, which the chart query compiler places at the right stage:
//   row        an expression over the dataset's rows (aggregated in the view like a column)
//   aggregate  an aggregate expression (SUM([Profit]) / SUM([Sales]))
//   tablecalc  an expression over the view's aggregated rows, with window functions

import { AGGREGATE_MACROS } from './macros'

export interface CalcSource {
  name: string
  formula: string
}

export interface Lod {
  id: string
  kind: 'fixed' | 'include' | 'exclude'
  /** Dimension field names (columns or row-level calcs). */
  dims: string[]
  /** Aggregate SQL over row columns. */
  agg: string
}

export interface TableCalc {
  id: string
  fn: string
  /** Hidden aggregate measure the window runs over (absent for INDEX(), SIZE(), FIRST(), LAST()). */
  arg?: string
  /** Numeric arguments: LOOKUP offset; WINDOW_* start and end. */
  nums: number[]
}

export interface Compiled {
  kind: 'row' | 'aggregate' | 'tablecalc'
  /** row: SQL over base rows (may use LOD placeholders); aggregate: aggregate SQL; tablecalc: SQL over aggregated rows. */
  expr: string
  lods: Lod[]
  /** tablecalc: aggregate expressions computed as hidden measures, referenced by id. */
  aggs: { id: string; expr: string }[]
  tcs: TableCalc[]
  /** TOTAL(): an aggregate re-computed over the underlying rows of each partition. */
  totals: { id: string; expr: string }[]
  /** Field names referenced (columns and calcs). */
  deps: string[]
}

export class CalcError extends Error {
  constructor(
    message: string,
    readonly at = 0
  ) {
    super(message)
  }
}

export const TABLE_CALCS = new Set(['running_sum', 'running_avg', 'running_min', 'running_max', 'running_count', 'window_sum', 'window_avg', 'window_min', 'window_max', 'window_median', 'window_count', 'window_stdev', 'rank', 'rank_dense', 'rank_unique', 'rank_percentile', 'lookup', 'index', 'size', 'first', 'last', 'total', 'percent_of_total'])

export const AGGREGATES = new Set([
  ...['sum', 'avg', 'mean', 'min', 'max', 'count', 'median', 'mode', 'stddev', 'stddev_samp', 'stddev_pop', 'variance', 'var_samp', 'var_pop', 'quantile', 'quantile_cont', 'quantile_disc', 'approx_count_distinct', 'approx_quantile', 'any_value', 'arg_max', 'arg_min', 'max_by', 'min_by', 'string_agg', 'list', 'array_agg', 'bool_and', 'bool_or', 'corr', 'covar_samp', 'covar_pop', 'regr_slope', 'regr_intercept', 'regr_r2', 'regr_count', 'kurtosis', 'skewness', 'entropy', 'product', 'count_if', 'fsum', 'favg', 'geomean', 'first', 'last'],
  ...AGGREGATE_MACROS
])

const q = (s: string) => `"${s.replace(/"/g, '""')}"`

interface Ctx {
  /** Column and calc names (lower case) → canonical name. */
  columns: Map<string, string>
  calcs: Map<string, CalcSource>
  prefix: string
  seq: { n: number }
  stack: string[]
  /** Text columns (lower case): `+` next to one joins text, as in Tableau. */
  text: Set<string>
}

/** Functions returning text: `+` next to a call of one joins text. */
const TEXT_FNS = new Set(['str', 'upper', 'lower', 'ucase', 'lcase', 'left', 'right', 'mid', 'trim', 'ltrim', 'rtrim', 'replace', 'concat', 'substr', 'substring', 'lpad', 'rpad', 'repeat', 'reverse', 'strftime', 'monthname', 'dayname'])

/** Compiles one calculated field. `calcs`: every calculated field of the dataset (for references between them). */
export function compileCalc(formula: string, columns: string[], calcs: CalcSource[], prefix = 'c', textColumns: string[] = []): Compiled {
  const ctx: Ctx = { columns: new Map(columns.map((c) => [c.toLowerCase(), c])), calcs: new Map(calcs.map((c) => [c.name.toLowerCase(), c])), prefix, seq: { n: 0 }, stack: [], text: new Set(textColumns.map((c) => c.toLowerCase())) }
  return compile(formula, ctx)
}

function compile(formula: string, ctx: Ctx): Compiled {
  if (!formula.trim()) throw new CalcError('The formula is empty.')
  const out: Compiled = { kind: 'row', expr: '', lods: [], aggs: [], tcs: [], totals: [], deps: [] }
  let expr = ''
  let hasAgg = false
  let hasTc = false
  const s = formula
  let i = 0
  const n = s.length
  const id = (kind: string) => `__${ctx.prefix}_${kind}${ctx.seq.n++}`
  // Tableau's `+` joins text: it becomes || when the operand on either side is text — a quoted value, a text field
  // or a call of a text function (STR, UPPER, LEFT…). Only the neighbouring operand is looked at.
  let prevText = false
  let textCall = false
  const parens: boolean[] = []
  const isText = (k: number): boolean => {
    while (k < n && /\s/.test(s[k])) k++
    // A quoted value, unless it is cast ('1 day'::INTERVAL).
    if (s[k] === "'") return !/^'(?:[^']|'')*'\s*::/.test(s.slice(k))
    if (s[k] === '[' || s[k] === '"') {
      const j = s[k] === '[' ? closing(s, k, '[', ']') : s.indexOf('"', k + 1)
      const r = j > k ? resolve(s.slice(k + 1, j).replace(/\]\]/g, ']'), ctx) : null
      return r?.kind === 'column' && ctx.text.has(r.name.toLowerCase())
    }
    const w = /^([A-Za-z_]\w*)\s*\(/.exec(s.slice(k))
    return !!w && TEXT_FNS.has(w[1].toLowerCase())
  }

  while (i < n) {
    const ch = s[i]
    // strings and quoted identifiers pass through
    if (ch === "'" || ch === '"') {
      let j = i + 1
      for (; j < n; j++) if (s[j] === ch) {
        if (s[j + 1] === ch) j++
        else break
      }
      if (j >= n) throw new CalcError(ch === "'" ? 'A text value is missing its closing quote.' : 'A name in double quotes is missing its closing quote.', i)
      if (ch === '"') addDep(s.slice(i + 1, j).replace(/""/g, '"'), ctx, out)
      prevText = ch === "'" || ctx.text.has(s.slice(i + 1, j).replace(/""/g, '"').toLowerCase())
      expr += s.slice(i, j + 1)
      i = j + 1
      continue
    }
    // comments: SQL -- and /* */, and Tableau's //
    if ((ch === '-' && s[i + 1] === '-') || (ch === '/' && s[i + 1] === '/')) {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j
      continue
    }
    if (ch === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
      continue
    }
    // [Field Name]
    if (ch === '[') {
      const j = closing(s, i, '[', ']')
      const inner = s.slice(i + 1, j).replace(/\]\]/g, ']')
      const ref = resolve(inner, ctx)
      if (ref) {
        prevText = ref.kind === 'column' && ctx.text.has(ref.name.toLowerCase())
        if (ref.kind === 'column') {
          expr += q(ref.name)
          addDep(ref.name, ctx, out)
        } else {
          const sub = inlineCalc(ref.name, ctx, out)
          expr += `(${sub.expr})`
          if (sub.kind === 'aggregate') hasAgg = true
          if (sub.kind === 'tablecalc') throw new CalcError(`[${ref.name}] is a table calculation; it can’t be used inside another calculation yet.`, i)
        }
        i = j + 1
        continue
      }
      // Not a field: a DuckDB list literal ([1, 2, 3]) or a typo, which DuckDB reports.
      if (/^[A-Za-z_][\w ]*$/.test(inner.trim()) && !/^\s*\d/.test(inner)) throw new CalcError(`There is no field called [${inner}].`, i)
      expr += '['
      i++
      continue
    }
    // {FIXED|INCLUDE|EXCLUDE dims : aggregate}
    if (ch === '{') {
      const m = /^\{\s*(FIXED|INCLUDE|EXCLUDE)\b/i.exec(s.slice(i))
      if (m) {
        const j = closing(s, i, '{', '}')
        const body = s.slice(i + m[0].length, j)
        const colon = topLevel(body, ':')
        if (colon < 0) throw new CalcError(`A ${m[1].toUpperCase()} expression needs a colon: {${m[1].toUpperCase()} [Dimension] : SUM([Measure])}.`, i)
        const dimsText = body.slice(0, colon).trim()
        const dims = dimsText ? splitTop(dimsText, ',').map((d) => {
          const t = d.trim()
          const mm = /^\[(.*)\]$/.exec(t)
          const r = resolve(mm ? mm[1] : t.replace(/^"|"$/g, ''), ctx)
          if (!r) throw new CalcError(`There is no field called ${t}.`, i)
          addDep(r.name, ctx, out)
          return r.name
        }) : []
        const inner = compile(body.slice(colon + 1), { ...ctx, stack: ctx.stack })
        if (inner.kind !== 'aggregate') throw new CalcError('The part after the colon must aggregate, for example SUM([Sales]).', i)
        out.lods.push(...inner.lods)
        inner.deps.forEach((d) => addDep(d, ctx, out))
        const lid = id('lod')
        out.lods.push({ id: lid, kind: m[1].toLowerCase() as Lod['kind'], dims, agg: inner.expr.trim() })
        expr += q(lid)
        i = j + 1
        continue
      }
      expr += ch
      i++
      continue
    }
    // identifiers: keywords, aggregates, table calculations
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < n && /[\w$]/.test(s[j])) j++
      const word = s.slice(i, j)
      const lw = word.toLowerCase()
      let k = j
      while (k < n && /\s/.test(s[k])) k++
      const call = s[k] === '('
      if (lw === 'if' && !call) {
        expr += 'CASE WHEN'
        i = j
        continue
      }
      if (lw === 'elseif') {
        expr += 'WHEN'
        i = j
        continue
      }
      if (call && TABLE_CALCS.has(lw) && !(['first', 'last'].includes(lw) && !/^\(\s*\)/.test(s.slice(k)))) {
        const end = closing(s, k, '(', ')')
        const args = s.slice(k + 1, end).trim() ? splitTop(s.slice(k + 1, end), ',') : []
        hasTc = true
        expr += tableCalc(lw, args, ctx, out, i, id)
        i = end + 1
        continue
      }
      if (call && AGGREGATES.has(lw)) hasAgg = true
      prevText = false
      textCall = call && TEXT_FNS.has(lw)
      expr += word
      i = j
      continue
    }
    if (ch === '+') {
      expr += prevText || isText(i + 1) ? '||' : '+'
      prevText = false
    } else if (ch === '(') {
      parens.push(textCall)
      expr += ch
    } else if (ch === ')') {
      prevText = parens.pop() ?? false
      expr += ch
    } else {
      if (!/\s/.test(ch)) prevText = false
      expr += ch
    }
    if (!/\s/.test(ch)) textCall = false
    i++
  }

  out.expr = expr
  if (hasTc) {
    out.kind = 'tablecalc'
    // Aggregates outside the table calculations become hidden measures too (SUM([x]) / TOTAL(SUM([x]))).
    out.expr = hoistAggregates(expr, ctx, out, id)
  } else if (hasAgg) out.kind = 'aggregate'
  return out
}

function tableCalc(fn: string, args: string[], ctx: Ctx, out: Compiled, at: number, id: (k: string) => string): string {
  const need = (k: number) => {
    if (args.length < k) throw new CalcError(`${fn.toUpperCase()} needs ${k} argument${k > 1 ? 's' : ''}.`, at)
  }
  const aggArg = (text: string) => {
    const c = compile(text, ctx)
    if (c.kind !== 'aggregate') throw new CalcError(`${fn.toUpperCase()} works on an aggregate, for example ${fn.toUpperCase()}(SUM([Sales])).`, at)
    out.lods.push(...c.lods)
    c.deps.forEach((d) => addDep(d, ctx, out))
    return c.expr
  }
  const num = (text: string | undefined, d: number) => {
    if (text === undefined) return d
    const v = Number(text.trim())
    if (!Number.isFinite(v)) throw new CalcError(`${fn.toUpperCase()} expects a number here, not “${text.trim()}”.`, at)
    return v
  }
  if (fn === 'total') {
    need(1)
    const tid = id('tot')
    out.totals.push({ id: tid, expr: aggArg(args[0]) })
    return q(tid)
  }
  if (fn === 'percent_of_total') {
    need(1)
    const a = aggArg(args[0])
    const aid = id('agg')
    const tid = id('tot')
    out.aggs.push({ id: aid, expr: a })
    out.totals.push({ id: tid, expr: a })
    return `(${q(aid)} / nullif(${q(tid)}, 0))`
  }
  if (['index', 'size', 'first', 'last'].includes(fn)) {
    const tcid = id('tc')
    out.tcs.push({ id: tcid, fn, nums: [] })
    return q(tcid)
  }
  need(1)
  const aid = id('agg')
  out.aggs.push({ id: aid, expr: aggArg(args[0]) })
  const tcid = id('tc')
  const nums = fn === 'lookup' ? [num(args[1], 0)] : fn.startsWith('window_') ? [num(args[1], -Infinity), num(args[2], Infinity)] : []
  out.tcs.push({ id: tcid, fn, arg: aid, nums })
  return q(tcid)
}

/** In a table calculation's outer expression, replace each aggregate call with a hidden measure. */
function hoistAggregates(expr: string, ctx: Ctx, out: Compiled, id: (k: string) => string): string {
  let res = ''
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      for (; j < expr.length; j++) if (expr[j] === ch) {
        if (expr[j + 1] === ch) j++
        else break
      }
      res += expr.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < expr.length && /[\w$]/.test(expr[j])) j++
      let k = j
      while (k < expr.length && /\s/.test(expr[k])) k++
      if (expr[k] === '(' && AGGREGATES.has(expr.slice(i, j).toLowerCase())) {
        const end = closing(expr, k, '(', ')')
        const aid = id('agg')
        out.aggs.push({ id: aid, expr: expr.slice(i, end + 1) })
        res += q(aid)
        i = end + 1
        continue
      }
      res += expr.slice(i, j)
      i = j
      continue
    }
    res += ch
    i++
  }
  void ctx
  return res
}

function inlineCalc(name: string, ctx: Ctx, out: Compiled): Compiled {
  if (ctx.stack.includes(name.toLowerCase())) throw new CalcError(`[${name}] refers to itself (${[...ctx.stack, name.toLowerCase()].join(' → ')}).`)
  const c = ctx.calcs.get(name.toLowerCase())!
  const sub = compile(c.formula, { ...ctx, stack: [...ctx.stack, name.toLowerCase()] })
  out.lods.push(...sub.lods)
  sub.deps.forEach((d) => addDep(d, ctx, out))
  return sub
}

function resolve(name: string, ctx: Ctx): { kind: 'column' | 'calc'; name: string } | null {
  const k = name.trim().toLowerCase()
  if (ctx.calcs.has(k)) return { kind: 'calc', name: ctx.calcs.get(k)!.name }
  if (ctx.columns.has(k)) return { kind: 'column', name: ctx.columns.get(k)! }
  return null
}

function addDep(name: string, ctx: Ctx, out: Compiled) {
  const r = resolve(name, ctx)
  if (r && !out.deps.includes(r.name)) out.deps.push(r.name)
}

/** Index of the bracket closing the one at `open`, skipping quotes. */
function closing(s: string, open: number, a: string, b: string): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" || (ch === '"' && a !== '[')) {
      const j = s.indexOf(ch, i + 1)
      if (j < 0) break
      i = j
      continue
    }
    if (a === '[' && ch === ']' && s[i + 1] === ']') {
      i++
      continue
    }
    if (ch === a) depth++
    else if (ch === b && --depth === 0) return i
  }
  throw new CalcError(`A “${a}” has no matching “${b}”.`, open)
}

/** Position of `sep` at nesting depth 0 (outside brackets and quotes), or -1. */
function topLevel(s: string, sep: string): number {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      const j = s.indexOf(ch, i + 1)
      i = j < 0 ? s.length : j
      continue
    }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === sep && depth === 0) return i
  }
  return -1
}

function splitTop(s: string, sep: string): string[] {
  const parts: string[] = []
  let rest = s
  for (let k = topLevel(rest, sep); k >= 0; k = topLevel(rest, sep)) {
    parts.push(rest.slice(0, k))
    rest = rest.slice(k + 1)
  }
  parts.push(rest)
  return parts
}

/** A group (Tableau's "Create Group"): a calculated field mapping chosen values of a dimension to group names; the
 *  values in no group keep their own name, or become "Other". */
export function groupFormula(field: string, groups: { name: string; values: (string | number | boolean)[] }[], other: boolean, text = true): string {
  const lit = (v: string | number | boolean) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v))
  const ref = `[${field.replace(/\]/g, ']]')}]`
  const whens = groups.filter((g) => g.values.length).map((g) => `  WHEN ${ref} IN (${g.values.map(lit).join(', ')}) THEN ${lit(g.name)}`)
  return `CASE\n${whens.join('\n')}\n  ELSE ${other ? "'Other'" : text ? ref : `STR(${ref})`}\nEND`
}

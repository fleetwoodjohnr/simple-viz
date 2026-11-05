// Evaluates a formula syntax tree. Cell values are read through `ctx.read`, which lets the recalculation engine compute
// a cell that is still out of date before it is used.

import { refCorner, type Node, type RefNode, type StructNode } from './parser'
import {
  CellError,
  ERR,
  MAX_COLS,
  MAX_ROWS,
  at,
  compareScalars,
  isArray,
  isError,
  isLambda,
  isRef,
  makeArray,
  toNumber,
  toText,
  type Area,
  type ArrayValue,
  type LambdaValue,
  type RefValue,
  type Scalar,
  type Value
} from './values'
import type { Workbook } from '../model/workbook'

export interface EvalContext {
  wb: Workbook
  /** Sheet id, row and column of the formula's cell. */
  sheet: number
  row: number
  col: number
  /** LET and LAMBDA bindings in scope (upper-case names). */
  env: Map<string, Value> | null
  /** Legacy (pre-dynamic-array) formula: ranges given where one value is expected use implicit intersection. */
  legacy: boolean
  /** Value of a cell, computing it first if it is out of date. */
  read(sheet: number, r: number, c: number): Scalar
  /** Make sure every out-of-date formula in the area is computed (before reading it in bulk). */
  ensure(area: Area): void
  /** Spilled area of an anchor cell, or null. */
  spillArea(sheet: number, r: number, c: number): Area | null
  /** Depth guard for recursive LAMBDA calls. */
  depth: number
}

export interface FnSpec {
  name: string
  min: number
  max: number
  /**
   * How each argument arrives; the last kind repeats for further arguments.
   *  v  any single value (references are read; a range or array in its place makes the function return an array)
   *  n  a number (coerced; errors are returned before the function runs), lifted over arrays like v
   *  s  text, lifted   b  a logical, lifted
   *  r  raw: references stay references, arrays stay arrays
   *  a  an array: references are read into an array of values
   *  l  a LAMBDA
   * A "|" starts a group that repeats: SUMIFS is "r|rv" (sum range, then range/criteria pairs).
   */
  params: string
  volatile?: boolean
  /** Receives the unevaluated argument nodes (IF, IFERROR, LET, LAMBDA, CHOOSE …). */
  lazy?: boolean
  fn: (args: any[], ctx: EvalContext) => Value
}

const registry = new Map<string, FnSpec>()

export function defineFunctions(specs: FnSpec[]) {
  for (const s of specs) registry.set(s.name, s)
}
export const getFunction = (name: string) => registry.get(name)
export const allFunctions = () => [...registry.values()]

// ---------- reading references ----------

export function refValue(n: RefNode, ctx: EvalContext): RefValue | CellError {
  const a = refCorner(n, ctx)
  if (!a) return ERR.REF
  if (!n.sheet) return { kind: 'ref', areas: [{ sheet: ctx.sheet, ...a }] }
  if (n.sheet.id < 0) return ERR.REF
  const i0 = ctx.wb.sheetIndex(n.sheet.id)
  if (i0 < 0) return ERR.REF
  if (n.sheet.id2 === undefined) return { kind: 'ref', areas: [{ sheet: n.sheet.id, ...a }] }
  const i1 = ctx.wb.sheetIndex(n.sheet.id2)
  if (i1 < 0) return ERR.REF
  const areas: Area[] = []
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) areas.push({ sheet: ctx.wb.sheets[i].id, ...a })
  return { kind: 'ref', areas }
}

/** All values of an area as an array (empty cells are null). */
export function areaArray(a: Area, ctx: EvalContext): ArrayValue {
  ctx.ensure(a)
  const rows = a.r1 - a.r0 + 1
  const cols = a.c1 - a.c0 + 1
  const data: Scalar[] = new Array(rows * cols).fill(null)
  const sheet = ctx.wb.sheetById(a.sheet)
  sheet?.forEachIn(a, (r, c, cell) => {
    data[(r - a.r0) * cols + (c - a.c0)] = cell.v
  })
  return makeArray(rows, cols, data)
}

/** Calls fn for each non-empty cell value in the area (row-major). */
export function eachInArea(a: Area, ctx: EvalContext, fn: (v: Scalar, r: number, c: number) => void) {
  ctx.ensure(a)
  ctx.wb.sheetById(a.sheet)?.forEachIn(a, (r, c, cell) => {
    if (cell.v !== null) fn(cell.v, r, c)
  })
}

/** Implicit intersection: the cell of `a` in the formula's row (single column) or column (single row). */
export function intersectAt(a: Area, ctx: EvalContext): Scalar {
  if (a.r0 === a.r1 && a.c0 === a.c1) return ctx.read(a.sheet, a.r0, a.c0)
  if (a.c0 === a.c1 && ctx.row >= a.r0 && ctx.row <= a.r1) return ctx.read(a.sheet, ctx.row, a.c0)
  if (a.r0 === a.r1 && ctx.col >= a.c0 && ctx.col <= a.c1) return ctx.read(a.sheet, a.r0, ctx.col)
  return ERR.VALUE
}

/** One value from anything: single cells are read, multi-cell references intersect, arrays give their first item. */
export function toScalar(v: Value, ctx: EvalContext): Scalar {
  if (isRef(v)) {
    if (v.areas.length !== 1) return ERR.VALUE
    return intersectAt(v.areas[0], ctx)
  }
  if (isArray(v)) return v.data[0]
  if (isLambda(v)) return ERR.CALC
  return v
}

/** A reference or array as an array of values; a single value becomes 1×1. */
export function toArray(v: Value, ctx: EvalContext): ArrayValue | CellError {
  if (isRef(v)) {
    if (v.areas.length !== 1) return ERR.VALUE
    return areaArray(v.areas[0], ctx)
  }
  if (isArray(v)) return v
  if (isLambda(v)) return ERR.CALC
  return makeArray(1, 1, [v])
}

const isMulti = (v: Value) => (isRef(v) && (v.areas.length > 1 || v.areas[0].r0 !== v.areas[0].r1 || v.areas[0].c0 !== v.areas[0].c1)) || (isArray(v) && v.rows * v.cols > 1)

// ---------- evaluation ----------

export function evaluate(n: Node, ctx: EvalContext): Value {
  switch (n.t) {
    case 'num':
      return n.v
    case 'str':
      return n.v
    case 'bool':
      return n.v
    case 'err':
      return CellError.of(n.v)
    case 'missing':
      return null
    case 'paren':
      return evaluate(n.a, ctx)
    case 'ref':
      return refValue(n, ctx)
    case 'xref':
      return ERR.REF
    case 'struct':
      return structRef(n, ctx)
    case 'name':
      return nameValue(n, ctx)
    case 'array': {
      const rows = n.rows.length
      const cols = n.rows[0].length
      const data: Scalar[] = []
      for (const r of n.rows) for (const e of r) data.push(evaluate(e, ctx) as Scalar)
      return makeArray(rows, cols, data)
    }
    case 'un': {
      const v = evaluate(n.a, ctx)
      if (n.op === '@') return isRef(v) ? (v.areas.length === 1 ? intersectAt(v.areas[0], ctx) : ERR.VALUE) : isArray(v) ? v.data[0] : v
      if (n.op === '+') return v
      return lift1(v, ctx, (x) => {
        const num = toNumber(x)
        return isError(num) ? num : -num
      })
    }
    case 'pct':
      return lift1(evaluate(n.a, ctx), ctx, (x) => {
        const num = toNumber(x)
        return isError(num) ? num : num / 100
      })
    case 'spill': {
      const v = evaluate(n.a, ctx)
      if (!isRef(v) || v.areas.length !== 1) return ERR.REF
      const a = v.areas[0]
      ctx.read(a.sheet, a.r0, a.c0) // make sure the anchor is calculated
      const s = ctx.spillArea(a.sheet, a.r0, a.c0)
      if (!s) return ERR.REF
      return { kind: 'ref', areas: [s] }
    }
    case 'bin':
      return binary(n.op, n.a, n.b, ctx)
    case 'func':
      return callFunction(n.name, n.args, ctx)
    case 'call': {
      const f = evaluate(n.fn, ctx)
      if (isError(f)) return f
      if (!isLambda(f)) return ERR.VALUE
      return invokeLambda(
        f,
        n.args.map((a) => evaluate(a, ctx)),
        ctx
      )
    }
  }
}

function nameValue(n: Extract<Node, { t: 'name' }>, ctx: EvalContext): Value {
  const key = n.name.toUpperCase()
  if (!n.sheet && ctx.env) {
    const v = ctx.env.get(key)
    if (v !== undefined) return v
  }
  const scope = n.sheet ? n.sheet.id : ctx.sheet
  const def = ctx.wb.findName(n.name, scope)
  if (!def || !def.ast) {
    // A built-in function passed by name (eta-reduced LAMBDA): =GROUPBY(A2:A9, B2:B9, SUM)
    const spec = !n.sheet && registry.get(key)
    if (spec && !spec.lazy) return { kind: 'lambda', params: [], body: null, env: null, native: (args) => applySpec(spec, args, ctx) }
    return ERR.NAME
  }
  // Names are evaluated relative to the formula cell (relative names follow the cell, like Excel).
  if (ctx.depth > 64) return ERR.CALC
  return evaluate(def.ast, { ...ctx, env: null, depth: ctx.depth + 1 })
}

function structRef(n: StructNode, ctx: EvalContext): Value {
  const t = n.table ? ctx.wb.tableByName(n.table) : ctx.wb.tableAt(ctx.sheet, ctx.row, ctx.col)
  if (!t) return ERR.REF
  const { r0, r1, c0 } = t.area
  const dataTop = t.headerRow ? r0 + 1 : r0
  const dataBottom = t.totalsRow ? r1 - 1 : r1
  const colAt = (name: string | null) => {
    if (name === null) return -1
    const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())
    return i
  }
  let ca = 0
  let cb = t.columns.length - 1
  if (n.col0 !== null) {
    ca = colAt(n.col0)
    cb = n.col1 !== null ? colAt(n.col1) : ca
    if (ca < 0 || cb < 0) return ERR.REF
    if (ca > cb) [ca, cb] = [cb, ca]
  }
  const items = n.items.length ? n.items : ['data' as const]
  let top = Infinity
  let bottom = -Infinity
  for (const it of items) {
    if (it === 'thisrow') {
      if (ctx.row < dataTop || ctx.row > dataBottom) return ERR.VALUE
      top = Math.min(top, ctx.row)
      bottom = Math.max(bottom, ctx.row)
    } else if (it === 'all') {
      top = Math.min(top, r0)
      bottom = Math.max(bottom, r1)
    } else if (it === 'headers') {
      if (!t.headerRow) return ERR.REF
      top = Math.min(top, r0)
      bottom = Math.max(bottom, r0)
    } else if (it === 'totals') {
      if (!t.totalsRow) return ERR.REF
      top = Math.min(top, r1)
      bottom = Math.max(bottom, r1)
    } else {
      if (dataBottom < dataTop) return ERR.REF
      top = Math.min(top, dataTop)
      bottom = Math.max(bottom, dataBottom)
    }
  }
  return { kind: 'ref', areas: [{ sheet: t.sheet, r0: top, r1: bottom, c0: c0 + ca, c1: c0 + cb }] }
}

// ---------- operators ----------

type Op2 = (a: Scalar, b: Scalar) => Scalar

const arith = (f: (x: number, y: number) => number | CellError): Op2 => (a, b) => {
  if (isError(a)) return a
  if (isError(b)) return b
  const x = toNumber(a)
  if (isError(x)) return x
  const y = toNumber(b)
  if (isError(y)) return y
  const r = f(x, y)
  if (typeof r === 'number' && !Number.isFinite(r)) return ERR.NUM
  return r
}

const compare = (test: (c: number) => boolean): Op2 => (a, b) => {
  if (isError(a)) return a
  if (isError(b)) return b
  return test(compareScalars(a, b))
}

const OPS: Record<string, Op2> = {
  '+': arith((x, y) => x + y),
  '-': arith((x, y) => x - y),
  '*': arith((x, y) => x * y),
  '/': arith((x, y) => (y === 0 ? ERR.DIV0 : x / y)),
  '^': arith((x, y) => {
    if (x === 0 && y === 0) return ERR.NUM
    if (x === 0 && y < 0) return ERR.DIV0
    const r = Math.pow(x, y)
    return Number.isNaN(r) ? ERR.NUM : r
  }),
  '&': (a, b) => {
    if (isError(a)) return a
    if (isError(b)) return b
    return (toText(a) as string) + (toText(b) as string)
  },
  '=': compare((c) => c === 0),
  '<>': compare((c) => c !== 0),
  '<': compare((c) => c < 0),
  '>': compare((c) => c > 0),
  '<=': compare((c) => c <= 0),
  '>=': compare((c) => c >= 0)
}

function binary(op: string, an: Node, bn: Node, ctx: EvalContext): Value {
  if (op === ':' || op === ' ' || op === ',') {
    const a = evaluate(an, ctx)
    const b = evaluate(bn, ctx)
    if (isError(a)) return a
    if (isError(b)) return b
    if (!isRef(a) || !isRef(b)) return ERR.VALUE
    if (op === ',') return { kind: 'ref', areas: [...a.areas, ...b.areas] }
    if (op === ':') {
      const all = [...a.areas, ...b.areas]
      const sheet = all[0].sheet
      if (all.some((x) => x.sheet !== sheet)) return ERR.VALUE
      return { kind: 'ref', areas: [{ sheet, r0: Math.min(...all.map((x) => x.r0)), c0: Math.min(...all.map((x) => x.c0)), r1: Math.max(...all.map((x) => x.r1)), c1: Math.max(...all.map((x) => x.c1)) }] }
    }
    const out: Area[] = []
    for (const x of a.areas)
      for (const y of b.areas) {
        if (x.sheet !== y.sheet) continue
        const r0 = Math.max(x.r0, y.r0)
        const r1 = Math.min(x.r1, y.r1)
        const c0 = Math.max(x.c0, y.c0)
        const c1 = Math.min(x.c1, y.c1)
        if (r0 <= r1 && c0 <= c1) out.push({ sheet: x.sheet, r0, r1, c0, c1 })
      }
    return out.length ? { kind: 'ref', areas: out } : ERR.NULL
  }
  const f = OPS[op]
  const x = cellOperand(an, ctx)
  const y = cellOperand(bn, ctx)
  return lift2(x === NOT_CELL ? evaluate(an, ctx) : x, y === NOT_CELL ? evaluate(bn, ctx) : y, ctx, f)
}

const NOT_CELL = Symbol('not a cell')

/** A same-sheet single-cell reference, read directly without building a reference value (the common operand). */
function cellOperand(n: Node, ctx: EvalContext): Scalar | typeof NOT_CELL {
  if (n.t !== 'ref' || n.sheet) return NOT_CELL
  const r = n.ra0 ? n.r0 : n.r0 + ctx.row
  const c = n.ca0 ? n.c0 : n.c0 + ctx.col
  if (r !== (n.ra1 ? n.r1 : n.r1 + ctx.row) || c !== (n.ca1 ? n.c1 : n.c1 + ctx.col)) return NOT_CELL
  if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) return NOT_CELL
  return ctx.read(ctx.sheet, r, c)
}

/** Operand for an operator: one value, or an array when the operand is a range/array (dynamic arrays). */
function operand(v: Value, ctx: EvalContext): Scalar | ArrayValue {
  if (isRef(v)) {
    if (v.areas.length !== 1) return ERR.VALUE
    const a = v.areas[0]
    if (a.r0 === a.r1 && a.c0 === a.c1) return ctx.read(a.sheet, a.r0, a.c0)
    if (ctx.legacy) return intersectAt(a, ctx)
    return areaArray(a, ctx)
  }
  if (isLambda(v)) return ERR.CALC
  return v
}

export function lift1(v: Value, ctx: EvalContext, f: (x: Scalar) => Scalar): Scalar | ArrayValue {
  const x = operand(v, ctx)
  if (!isArray(x)) return f(x)
  return makeArray(x.rows, x.cols, x.data.map(f))
}

/** Element-wise operation with Excel's broadcasting: a single row/column/value stretches; other mismatches give #N/A. */
export function lift2(av: Value, bv: Value, ctx: EvalContext, f: Op2): Scalar | ArrayValue {
  const a = operand(av, ctx)
  const b = operand(bv, ctx)
  if (!isArray(a) && !isArray(b)) return f(a, b)
  const A = isArray(a) ? a : makeArray(1, 1, [a])
  const B = isArray(b) ? b : makeArray(1, 1, [b])
  const rows = Math.max(A.rows, B.rows)
  const cols = Math.max(A.cols, B.cols)
  const data: Scalar[] = new Array(rows * cols)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = pick(A, r, c)
      const y = pick(B, r, c)
      data[r * cols + c] = x === undefined || y === undefined ? ERR.NA : f(x, y)
    }
  return makeArray(rows, cols, data)
}

/** Broadcast read: single rows/columns repeat; outside the array is undefined (#N/A). */
export function pick(a: ArrayValue, r: number, c: number): Scalar | undefined {
  const rr = a.rows === 1 ? 0 : r
  const cc = a.cols === 1 ? 0 : c
  if (rr >= a.rows || cc >= a.cols) return undefined
  return a.data[rr * a.cols + cc]
}

// ---------- functions ----------

export function callFunction(name: string, argNodes: Node[], ctx: EvalContext): Value {
  const spec = registry.get(name)
  if (!spec) {
    // A LAMBDA bound by LET or a defined name: =MyFunc(1, 2)
    const lam = ctx.env?.get(name) ?? (() => {
      const def = ctx.wb.findName(name, ctx.sheet)
      return def?.ast ? evaluate(def.ast, { ...ctx, env: null }) : undefined
    })()
    if (lam !== undefined) {
      if (!isLambda(lam)) return isError(lam) ? lam : ERR.VALUE
      return invokeLambda(
        lam,
        argNodes.map((a) => evaluate(a, ctx)),
        ctx
      )
    }
    return ERR.NAME
  }
  if (argNodes.length < spec.min || argNodes.length > spec.max) return ERR.VALUE
  if (spec.lazy) return spec.fn(argNodes, ctx)
  const raw = argNodes.map((a) => evaluate(a, ctx))
  return applySpec(spec, raw, ctx)
}

/** Run a function on already-evaluated arguments: coercion, error short-circuit and lifting over arrays. */
export function paramKind(params: string, i: number): string {
  const bar = params.indexOf('|')
  if (bar < 0) return params[Math.min(i, params.length - 1)] ?? 'v'
  if (i < bar) return params[i]
  const rep = params.slice(bar + 1)
  return rep[(i - bar) % rep.length]
}

export function applySpec(spec: FnSpec, raw: Value[], ctx: EvalContext): Value {
  const kinds = raw.map((_, i) => paramKind(spec.params, i))
  // Scalar parameters that received a range or array make the function return an array (lifting).
  let shape: { rows: number; cols: number } | null = null
  const prepared: (Scalar | ArrayValue | Value)[] = raw.map((v, i) => {
    const k = kinds[i]
    if (k === 'r' || k === 'l') return v
    if (k === 'a') return toArray(v, ctx)
    if (isMulti(v) && !ctx.legacy) {
      const arr = toArray(v, ctx)
      if (isError(arr)) return arr
      shape = shape ? { rows: Math.max(shape.rows, arr.rows), cols: Math.max(shape.cols, arr.cols) } : { rows: arr.rows, cols: arr.cols }
      return arr
    }
    if (isArray(v) && v.rows * v.cols > 1) {
      shape = shape ? { rows: Math.max(shape.rows, v.rows), cols: Math.max(shape.cols, v.cols) } : { rows: v.rows, cols: v.cols }
      return v
    }
    return toScalar(v, ctx)
  })
  const run = (args: unknown[]): Value => {
    const out: unknown[] = []
    for (let i = 0; i < args.length; i++) {
      const k = kinds[i]
      const v = args[i]
      if (k === 'n') {
        if (v === undefined) {
          out.push(undefined)
          continue
        }
        const num = toNumber(v as Scalar)
        if (isError(num)) return num
        out.push(num)
      } else if (k === 's') {
        const s = toText(v as Scalar)
        if (isError(s)) return s
        out.push(s)
      } else if (k === 'b') {
        if (v === null) {
          out.push(false)
          continue
        }
        if (isError(v)) return v
        if (typeof v === 'string') {
          const u = v.toUpperCase()
          if (u !== 'TRUE' && u !== 'FALSE') return ERR.VALUE
          out.push(u === 'TRUE')
          continue
        }
        out.push(typeof v === 'number' ? v !== 0 : v)
      } else if (k === 'a' && isError(v)) return v
      else out.push(v)
    }
    return spec.fn(out, ctx)
  }
  if (!shape) return run(prepared)
  const { rows, cols } = shape as { rows: number; cols: number }
  const data: Scalar[] = new Array(rows * cols)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let na = false
      const args = prepared.map((p, i) => {
        const k = kinds[i]
        if (k === 'r' || k === 'a' || k === 'l' || !isArray(p)) return p
        const x = pick(p, r, c)
        if (x === undefined) na = true
        return x
      })
      const v = na ? ERR.NA : run(args)
      data[r * cols + c] = isArray(v) ? v.data[0] : isRef(v) ? toScalar(v, ctx) : isLambda(v) ? ERR.CALC : v
    }
  return makeArray(rows, cols, data)
}

export function invokeLambda(f: LambdaValue, args: Value[], ctx: EvalContext): Value {
  if (f.native) return f.native(args)
  if (args.length > f.params.length) return ERR.VALUE
  if (ctx.depth > 1000) return ERR.NUM
  const env = new Map(f.env ?? [])
  f.params.forEach((p, i) => env.set(p, i < args.length ? args[i] : null))
  return evaluate(f.body as Node, { ...ctx, env, depth: ctx.depth + 1 })
}

// ---------- results ----------

/** The final value of a cell's formula: a single value, or an array to spill. Empty becomes 0, like Excel. */
export function finalValue(v: Value, ctx: EvalContext, spill: boolean): Scalar | ArrayValue {
  if (isRef(v)) {
    if (v.areas.length !== 1) return ERR.VALUE
    const a = v.areas[0]
    if (a.r0 === a.r1 && a.c0 === a.c1) return orZero(ctx.read(a.sheet, a.r0, a.c0))
    if (!spill || ctx.legacy) return orZero(intersectAt(a, ctx))
    const arr = areaArray(a, ctx)
    return { ...arr, data: arr.data.map(orZero) }
  }
  if (isArray(v)) {
    if (v.rows === 1 && v.cols === 1) return orZero(v.data[0])
    if (!spill || ctx.legacy) return orZero(v.data[0])
    return { ...v, data: v.data.map(orZero) }
  }
  if (isLambda(v)) return ERR.CALC
  return orZero(v)
}

const orZero = (v: Scalar): Scalar => (v === null ? 0 : v)

export { at, MAX_ROWS, MAX_COLS }

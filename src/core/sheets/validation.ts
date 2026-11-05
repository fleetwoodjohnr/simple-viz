// Data validation: which values a cell accepts, the dropdown list, and the messages Excel shows.
import type { Node } from './engine/parser'
import { evaluate, finalValue } from './engine/evaluate'
import { CellError, ERR, compareScalars, isArray, numberToText, type Area, type Scalar, type Value } from './engine/values'
import type { Engine } from './engine/engine'
import type { Sheet } from './model/workbook'
import { formatValue } from './numfmt/format'

export type DvType = 'none' | 'whole' | 'decimal' | 'list' | 'date' | 'time' | 'textLength' | 'custom'
export type DvOperator = 'between' | 'notBetween' | 'equal' | 'notEqual' | 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual'

export interface DataValidation {
  ranges: Area[]
  type: DvType
  operator?: DvOperator
  /** Formulas relative to the top-left cell of the first range. A list's literal items are a string constant "a,b,c". */
  formulas?: Node[]
  /** "Ignore blank". */
  allowBlank?: boolean
  /** Hide the in-cell dropdown of a list (Excel's showDropDown="1" means hidden). */
  noDropdown?: boolean
  showInput?: boolean
  promptTitle?: string
  prompt?: string
  showError?: boolean
  errorStyle?: 'stop' | 'warning' | 'information'
  errorTitle?: string
  error?: string
  /** File attributes kept for round trips (imeMode…). */
  carry?: Record<string, string>
}

/** What the UI shows when a typed value breaks a rule. */
export interface DvAlert {
  style: 'stop' | 'warning' | 'information'
  title: string
  message: string
}

const scalarToText = (v: Scalar) => (v instanceof CellError ? v.code : v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? numberToText(v) : v)

export const DEFAULT_ERROR = 'This value doesn’t match the data validation restrictions defined for this cell.'

const inside = (a: Area, r: number, c: number) => r >= a.r0 && r <= a.r1 && c >= a.c0 && c <= a.c1

export function validationAt(sh: Sheet, r: number, c: number): DataValidation | undefined {
  // The last rule wins where ranges overlap (Excel doesn't allow overlaps; files can still have them).
  for (let i = sh.validations.length - 1; i >= 0; i--) if (sh.validations[i].ranges.some((a) => inside(a, r, c))) return sh.validations[i]
  return undefined
}

function evalAt(engine: Engine, ast: Node, sheet: number, r: number, c: number): Value {
  try {
    return evaluate(ast, engine.contextAt(sheet, r, c))
  } catch {
    return ERR.VALUE
  }
}

function scalarAt(engine: Engine, ast: Node, sheet: number, r: number, c: number): Scalar {
  const ctx = engine.contextAt(sheet, r, c)
  try {
    const v = finalValue(evaluate(ast, ctx), ctx, false)
    return isArray(v) ? (v.data[0] ?? null) : v
  } catch {
    return ERR.VALUE
  }
}

/** The items of a list rule: value and shown text. Literal lists are split on commas; ranges give their cells. */
export function listItems(engine: Engine, sh: Sheet, dv: DataValidation, r: number, c: number): { v: Scalar; t: string }[] {
  const f = dv.formulas?.[0]
  if (!f) return []
  if (f.t === 'str') return f.v.split(',').map((s) => s.trim()).filter((s) => s !== '').map((s) => ({ v: s, t: s }))
  const v = evalAt(engine, f, sh.id, r, c)
  const out: { v: Scalar; t: string }[] = []
  if (v && typeof v === 'object' && 'kind' in v) {
    if (v.kind === 'ref') {
      for (const a of v.areas) {
        const s = engine.wb.sheetById(a.sheet)
        if (!s) continue
        engine.ensure(a)
        const u = s.used()
        // ponytail: a whole-column source stops at the used range; very long lists are cut at 10,000 items.
        for (let rr = a.r0; rr <= Math.min(a.r1, u.r) && out.length < 10_000; rr++) for (let cc = a.c0; cc <= Math.min(a.c1, u.c); cc++) {
          const cell = s.get(rr, cc)
          const x = cell?.v ?? null
          if (x !== null && x !== '') out.push({ v: x, t: formatValue(x, engine.wb.styles.get(cell?.s).numFmt, engine.wb.date1904, 255).text })
        }
      }
    } else if (v.kind === 'array') for (const x of v.data) if (x !== null && x !== '') out.push({ v: x, t: scalarToText(x) })
  } else if (v !== null && v !== '' && !(v instanceof CellError)) out.push({ v: v as Scalar, t: scalarToText(v as Scalar) })
  return out
}

function compare(v: number, op: DvOperator | undefined, a: Scalar, b: Scalar): boolean {
  const x = typeof a === 'number' ? a : Number(a)
  const y = typeof b === 'number' ? b : Number(b)
  switch (op ?? 'between') {
    case 'between':
      return v >= Math.min(x, y) && v <= Math.max(x, y)
    case 'notBetween':
      return v < Math.min(x, y) || v > Math.max(x, y)
    case 'equal':
      return v === x
    case 'notEqual':
      return v !== x
    case 'lessThan':
      return v < x
    case 'lessThanOrEqual':
      return v <= x
    case 'greaterThan':
      return v > x
    case 'greaterThanOrEqual':
      return v >= x
  }
}

/** Whether the cell's current value satisfies its rule. */
export function isValid(engine: Engine, sh: Sheet, dv: DataValidation, r: number, c: number): boolean {
  const v = sh.get(r, c)?.v ?? null
  if (v === null || v === '') return dv.allowBlank !== false
  const f = (i: number) => (dv.formulas?.[i] ? scalarAt(engine, dv.formulas[i], sh.id, r, c) : null)
  switch (dv.type) {
    case 'none':
      return true
    case 'whole':
    case 'decimal':
    case 'date':
    case 'time': {
      if (typeof v !== 'number') return false
      if (dv.type === 'whole' && !Number.isInteger(v)) return false
      // Time rules compare the time of day.
      const n = dv.type === 'time' ? v - Math.floor(v) : v
      const a = f(0)
      const b = f(1)
      if (a instanceof CellError || b instanceof CellError) return false
      return compare(n, dv.operator, a, b)
    }
    case 'textLength': {
      const len = (typeof v === 'string' ? v : v instanceof CellError ? v.code : String(v)).length
      return compare(len, dv.operator, f(0), f(1))
    }
    case 'list': {
      const items = listItems(engine, sh, dv, r, c)
      return items.some(({ v: x }) => (typeof x === 'number' && typeof v === 'number' ? x === v : compareScalars(scalarToText(x), scalarToText(v)) === 0))
    }
    case 'custom': {
      const x = f(0)
      return x === true || (typeof x === 'number' && x !== 0)
    }
  }
}

export function alertFor(dv: DataValidation): DvAlert {
  return { style: dv.errorStyle ?? 'stop', title: dv.errorTitle || 'Simple Cell', message: dv.error || DEFAULT_ERROR }
}

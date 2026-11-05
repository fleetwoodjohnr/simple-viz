// Values the calculation engine works with, and Excel's rules for converting between them.

export const ERROR_CODES = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!', '#FIELD!', '#BLOCKED!', '#CONNECT!', '#BUSY!', '#UNKNOWN!'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** An Excel error value. One shared instance per code, so `===` and `instanceof` both work. */
export class CellError {
  private constructor(readonly code: ErrorCode) {}
  static readonly all = new Map<ErrorCode, CellError>(ERROR_CODES.map((c) => [c, new CellError(c)]))
  static of(code: ErrorCode): CellError {
    return CellError.all.get(code)!
  }
  toString() {
    return this.code
  }
}

export const ERR = {
  NULL: CellError.of('#NULL!'),
  DIV0: CellError.of('#DIV/0!'),
  VALUE: CellError.of('#VALUE!'),
  REF: CellError.of('#REF!'),
  NAME: CellError.of('#NAME?'),
  NUM: CellError.of('#NUM!'),
  NA: CellError.of('#N/A'),
  SPILL: CellError.of('#SPILL!'),
  CALC: CellError.of('#CALC!'),
  FIELD: CellError.of('#FIELD!'),
  BLOCKED: CellError.of('#BLOCKED!'),
  CONNECT: CellError.of('#CONNECT!'),
  BUSY: CellError.of('#BUSY!'),
  GETTING_DATA: CellError.of('#GETTING_DATA')
}

/** `null` is an empty cell (or an omitted argument after coercion). */
export type Scalar = number | string | boolean | CellError | null

/** A 2-D array, row-major. Arrays are never 0×0 (Excel has no empty arrays: that is #CALC!). */
export interface ArrayValue {
  kind: 'array'
  rows: number
  cols: number
  data: Scalar[]
}

/** A rectangle of cells, 0-based and inclusive. `sheet` is a sheet id. */
export interface Area {
  sheet: number
  r0: number
  c0: number
  r1: number
  c1: number
}

/** A reference (one or more areas: unions come from the `,` operator inside parentheses). */
export interface RefValue {
  kind: 'ref'
  areas: Area[]
}

export interface LambdaValue {
  kind: 'lambda'
  params: string[]
  body: unknown // engine Node; typed loosely to keep this module free of the parser
  env: Map<string, Value> | null
  /** Built-in functions passed as values (e.g. `=BYROW(A1:B3, SUM)` is not Excel; Excel allows eta-lambdas like `SUM` in some functions) */
  native?: (args: Value[]) => Value
}

export type Value = Scalar | ArrayValue | RefValue | LambdaValue

export const MAX_ROWS = 1_048_576
export const MAX_COLS = 16_384

export const isError = (v: unknown): v is CellError => v instanceof CellError
export const isArray = (v: unknown): v is ArrayValue => typeof v === 'object' && v !== null && (v as ArrayValue).kind === 'array'
export const isRef = (v: unknown): v is RefValue => typeof v === 'object' && v !== null && (v as RefValue).kind === 'ref'
export const isLambda = (v: unknown): v is LambdaValue => typeof v === 'object' && v !== null && (v as LambdaValue).kind === 'lambda'

export function makeArray(rows: number, cols: number, data: Scalar[]): ArrayValue {
  return { kind: 'array', rows, cols, data }
}

export function arrayFrom(rows: Scalar[][]): ArrayValue {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const data: Scalar[] = []
  for (const r of rows) for (let c = 0; c < cols; c++) data.push(c < r.length ? r[c] : ERR.NA)
  return makeArray(rows.length, cols, data)
}

export const at = (a: ArrayValue, r: number, c: number): Scalar => a.data[r * a.cols + c]

/** Number of cells in an area. */
export const areaSize = (a: Area) => (a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1)

// ---------- number ⇄ text ----------

/**
 * A number as Excel turns it into text (`=A1&""`, CONCAT, TEXTJOIN…): up to 15 significant digits,
 * scientific notation for very large or very small magnitudes.
 */
export function numberToText(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (Number.isInteger(n) && abs < 1e15) return String(n)
  let s = n.toPrecision(15)
  if (s.includes('e')) {
    // "1.23450000000000e+21" → "1.2345E+21"
    const [m, e] = s.split('e')
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m
    const exp = Number(e)
    s = `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
    return s
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  // Very small numbers: Excel switches to scientific once the digits would run past 15 decimals.
  if (abs < 1e-9) {
    const e = n.toExponential(14)
    const [m, ex] = e.split('e')
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m
    const exp = Number(ex)
    return `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  return s
}

/** Round to 15 significant digits, as Excel does before comparing or displaying results. */
export function round15(n: number): number {
  if (n === 0 || !Number.isFinite(n)) return n
  return Number(n.toPrecision(15))
}

// Text → number, the way Excel coerces typed or quoted text: "1,234.5", "50%", "$12", "(3)", "1e3", dates and times.
const NUM_RE = /^\s*([+-])?\s*(\$)?\s*(\()?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)\s*(\))?\s*(%)?\s*$/
const SCI_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+\s*$/

/** Parse text the way Excel's value coercion does. Returns null when it is not numeric. `dateParser` handles dates/times. */
export function parseNumber(s: string, dateParser?: (s: string) => number | null): number | null {
  if (s === '') return null
  if (SCI_RE.test(s)) return Number(s.trim())
  const m = NUM_RE.exec(s)
  if (m) {
    const [, sign, , open, digits, close, pct] = m
    if (!!open !== !!close) return null
    let n = Number(digits.replace(/,/g, ''))
    if (Number.isNaN(n)) return null
    if (sign === '-' || open) n = -n
    if (pct) n /= 100
    return n
  }
  return dateParser ? dateParser(s) : null
}

// ---------- coercion (used by operators and functions) ----------

export type DateParser = (s: string) => number | null
let dateParser: DateParser | undefined
/** The engine installs the date/time text parser here (it depends on the workbook's date system). */
export function setDateParser(p: DateParser) {
  dateParser = p
}

export function toNumber(v: Scalar): number | CellError {
  if (typeof v === 'number') return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof CellError) return v
  const n = parseNumber(v, dateParser)
  return n === null ? ERR.VALUE : n
}

export function toText(v: Scalar): string | CellError {
  if (typeof v === 'string') return v
  if (v === null) return ''
  if (typeof v === 'number') return numberToText(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

export function toBool(v: Scalar): boolean | CellError {
  if (typeof v === 'boolean') return v
  if (v === null) return false
  if (typeof v === 'number') return v !== 0
  if (v instanceof CellError) return v
  const u = v.toUpperCase()
  if (u === 'TRUE') return true
  if (u === 'FALSE') return false
  return ERR.VALUE
}

/** Excel's ordering for comparisons and sorting: numbers < text < logicals; errors are handled by the caller. */
export function typeRank(v: Scalar): number {
  if (v === null) return 0
  if (typeof v === 'number') return 1
  if (typeof v === 'string') return 2
  if (typeof v === 'boolean') return 3
  return 4
}

const collator = new Intl.Collator('en', { sensitivity: 'accent', numeric: false })

/** Compare two text values case-insensitively, as Excel's = < > do. */
export function compareText(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x === y) return 0
  return collator.compare(x, y) || (x < y ? -1 : 1)
}

/**
 * Compare two scalars with Excel's rules. An empty cell compares as 0 against a number, "" against text, FALSE against
 * a logical. Returns -1, 0, 1. Errors must be handled before calling.
 */
export function compareScalars(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  if (typeof a === 'number') {
    const x = round15(a)
    const y = round15(b as number)
    return x === y ? 0 : x < y ? -1 : 1
  }
  if (typeof a === 'string') return Math.sign(compareText(a, b as string))
  return a === b ? 0 : a ? 1 : -1
}

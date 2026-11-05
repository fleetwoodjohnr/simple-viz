// Excel formula lexer, parser and printer.
//
// References are stored relative to the formula's own cell (R1C1 style) unless they are absolute ($), so one syntax
// tree is shared by every cell of a filled range and copying a formula needs no rewriting.
// Formulas are always in the en-US invariant form OOXML uses: `,` between arguments, `.` as the decimal point.

import { colIndex, colName, quoteSheet } from '../refs'
import { ERROR_CODES, MAX_COLS, MAX_ROWS, numberToText, type ErrorCode } from './values'

export type BinOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=' | ':' | ' ' | ','

/** A sheet reference inside a formula. `id` is the sheet id; 3-D references (Sheet1:Sheet3!A1) set `id2`. */
export interface SheetRef {
  id: number
  id2?: number
}

export interface RefNode {
  t: 'ref'
  sheet: SheetRef | null
  /** Row/column of each corner: an offset from the formula cell when relative, the 0-based index when absolute. */
  r0: number
  c0: number
  r1: number
  c1: number
  ra0: boolean
  ca0: boolean
  ra1: boolean
  ca1: boolean
  /** A:C (rows span the whole sheet) or 2:5 (columns span the whole sheet). */
  span?: 'cols' | 'rows'
}

/** Structured table reference: Table1[[#Headers],[Col1]:[Col2]], [@Col] … */
export interface StructNode {
  t: 'struct'
  table: string | null
  /** #All #Data #Headers #Totals #This Row */
  items: ('all' | 'data' | 'headers' | 'totals' | 'thisrow')[]
  col0: string | null
  col1: string | null
}

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: ErrorCode }
  | RefNode
  | StructNode
  | { t: 'name'; name: string; sheet: SheetRef | null }
  /** Reference into another workbook: kept as written; formulas using one keep their cached result. */
  | { t: 'xref'; text: string }
  | { t: 'func'; name: string; args: Node[] }
  | { t: 'call'; fn: Node; args: Node[] }
  | { t: 'un'; op: '-' | '+' | '@'; a: Node }
  | { t: 'pct'; a: Node }
  | { t: 'spill'; a: Node }
  | { t: 'bin'; op: BinOp; a: Node; b: Node }
  | { t: 'array'; rows: Node[][] }
  | { t: 'paren'; a: Node }
  | { t: 'missing' }

export interface ParseContext {
  /** Formula cell (0-based), the origin for relative references. */
  row: number
  col: number
  /** Sheet name → id, case-insensitive; null if there is no such sheet. */
  sheetId?: (name: string) => number | null
}

export interface PrintContext {
  row: number
  col: number
  sheetName?: (id: number) => string | null
  /** Add the _xlfn. prefixes OOXML needs for functions newer than Excel 2007. */
  fileNames?: (name: string) => string
  /** LAMBDA/LET parameters in scope (printing for files only). */
  paramNames?: Set<string>
  /** Print references in R1C1 notation (XML Spreadsheet 2003). */
  r1c1?: boolean
}

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly pos: number
  ) {
    super(message)
  }
}

// ---------- lexer ----------

type Tok =
  | { k: 'num'; v: number; p: number }
  | { k: 'str'; v: string; p: number }
  | { k: 'bool'; v: boolean; p: number }
  | { k: 'err'; v: ErrorCode; p: number }
  | { k: 'ref'; text: string; sheet: SheetPrefix | null; p: number }
  | { k: 'name'; v: string; sheet: SheetPrefix | null; p: number }
  | { k: 'func'; v: string; p: number }
  | { k: 'struct'; table: string | null; body: string; p: number }
  | { k: 'xref'; text: string; p: number }
  | { k: 'op'; v: string; p: number }
  | { k: '(' | ')' | ',' | ';' | '{' | '}' | 'ws' | 'eof'; p: number }

interface SheetPrefix {
  name: string
  name2?: string
  book?: string
}

const IDENT_START = /[A-Za-z_\\À-￿]/
const IDENT_CHAR = /[A-Za-z0-9_.\\?À-￿]/
const CELL_RE = /^\$?[A-Za-z]{1,3}\$?\d{1,7}/
const COLS_RE = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![A-Za-z0-9_(])/
const ROWS_RE = /^\$?\d{1,7}:\$?\d{1,7}(?![A-Za-z0-9_.(])/
const NUM_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/
const ERRORS_SORTED = [...ERROR_CODES].sort((a, b) => b.length - a.length)

function validCell(text: string): boolean {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text)
  if (!m) return false
  const r = Number(m[2])
  return colIndex(m[1]) >= 0 && r >= 1 && r <= MAX_ROWS
}

function lex(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = src.length
  // Unquoted sheet names allow these characters (letters, digits, _ and .).
  const readSheetPrefix = (): SheetPrefix | null => {
    // 'quoted name'! or '[Book]Sheet'!
    if (src[i] === "'") {
      let j = i + 1
      let name = ''
      while (j < n) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            name += "'"
            j += 2
            continue
          }
          break
        }
        name += src[j++]
      }
      if (src[j] !== "'" || src[j + 1] !== '!') return null
      i = j + 2
      return splitPrefix(name)
    }
    // [1]Sheet1! / Sheet1! / Sheet1:Sheet3!
    const m = /^((?:\[[^\]]+\])?[A-Za-z0-9_.À-￿]+(?::[A-Za-z0-9_.À-￿]+)?)!/.exec(src.slice(i))
    if (!m) return null
    // A bare cell address followed by ! is not a sheet prefix.
    i += m[0].length
    return splitPrefix(m[1])
  }
  const splitPrefix = (raw: string): SheetPrefix => {
    let book: string | undefined
    let rest = raw
    const b = /^\[([^\]]+)\](.*)$/.exec(raw)
    if (b) {
      book = b[1]
      rest = b[2]
    }
    const parts = rest.split(':')
    return { name: parts[0], name2: parts[1], book }
  }

  while (i < n) {
    const ch = src[i]
    const p = i
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      while (i < n && /[ \n\r\t]/.test(src[i])) i++
      toks.push({ k: 'ws', p })
      continue
    }
    if (ch === '"') {
      let v = ''
      i++
      for (;;) {
        if (i >= n) throw new FormulaSyntaxError('A quote is missing at the end of a text value', p)
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            v += '"'
            i += 2
            continue
          }
          i++
          break
        }
        v += src[i++]
      }
      toks.push({ k: 'str', v, p })
      continue
    }
    if (ch === '#') {
      const e = ERRORS_SORTED.find((code) => src.slice(i, i + code.length).toUpperCase() === code)
      if (e) {
        toks.push({ k: 'err', v: e, p })
        i += e.length
        continue
      }
      // Spill operator (A1#)
      toks.push({ k: 'op', v: '#', p })
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      const rows = ROWS_RE.exec(src.slice(i))
      if (rows && !/[A-Za-z_]/.test(src[i - 1] ?? '')) {
        toks.push({ k: 'ref', text: rows[0], sheet: null, p })
        i += rows[0].length
        continue
      }
      const m = NUM_RE.exec(src.slice(i))
      if (m) {
        // A sheet name may start with a digit: 2024!A1
        const sp = /^[0-9A-Za-z_.]+!/.exec(src.slice(i))
        if (!sp) {
          toks.push({ k: 'num', v: Number(m[0]), p })
          i += m[0].length
          continue
        }
      }
    }
    if (ch === "'" || ch === '[' || IDENT_START.test(ch) || /[0-9$]/.test(ch)) {
      const save = i
      // Structured reference without table: [@Col], [Col]
      if (ch === '[') {
        const sheet = readSheetPrefix()
        if (sheet) {
          toks.push(...afterPrefix(sheet, p))
          continue
        }
        i = save
        const body = readBrackets()
        toks.push({ k: 'struct', table: null, body, p })
        continue
      }
      const sheet = readSheetPrefix()
      if (sheet) {
        toks.push(...afterPrefix(sheet, p))
        continue
      }
      i = save
      const t = readRefOrName(null, p)
      if (t) {
        toks.push(t)
        continue
      }
    }
    if (ch === '$') {
      const t = readRefOrName(null, p)
      if (t) {
        toks.push(t)
        continue
      }
    }
    const two = src.slice(i, i + 2)
    if (two === '<>' || two === '<=' || two === '>=') {
      toks.push({ k: 'op', v: two, p })
      i += 2
      continue
    }
    if ('+-*/^&=<>%:@'.includes(ch)) {
      toks.push({ k: 'op', v: ch, p })
      i++
      continue
    }
    if ('(),;{}'.includes(ch)) {
      toks.push({ k: ch as '(' | ')' | ',' | ';' | '{' | '}', p })
      i++
      continue
    }
    throw new FormulaSyntaxError(`Unexpected character “${ch}”`, p)
  }
  toks.push({ k: 'eof', p: n })
  return toks

  function readBrackets(): string {
    // Balanced [...] with ' as the escape character inside column names.
    const start = i
    let depth = 0
    for (; i < n; i++) {
      const c = src[i]
      if (c === "'") {
        i++
        continue
      }
      if (c === '[') depth++
      else if (c === ']') {
        depth--
        if (depth === 0) {
          i++
          return src.slice(start + 1, i - 1)
        }
      }
    }
    throw new FormulaSyntaxError('A ] is missing in a table reference', start)
  }

  function afterPrefix(sheet: SheetPrefix, p: number): Tok[] {
    if (sheet.book !== undefined) {
      // External reference: keep the text up to the end of the reference.
      const m = /^(\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+|[A-Za-z_\\][\w.\\?]*)/.exec(src.slice(i))
      const end = i + (m ? m[0].length : 0)
      const text = src.slice(p, end)
      i = end
      return [{ k: 'xref', text, p }]
    }
    const t = readRefOrName(sheet, p)
    if (!t) throw new FormulaSyntaxError('A reference is missing after the sheet name', i)
    return [t]
  }

  function readRefOrName(sheet: SheetPrefix | null, p: number): Tok | null {
    const rest = src.slice(i)
    const cols = COLS_RE.exec(rest)
    if (cols) {
      const [a, b] = cols[0].replace(/\$/g, '').split(':')
      if (colIndex(a) >= 0 && colIndex(b) >= 0) {
        i += cols[0].length
        return { k: 'ref', text: cols[0], sheet, p }
      }
    }
    const rows = ROWS_RE.exec(rest)
    if (rows) {
      i += rows[0].length
      return { k: 'ref', text: rows[0], sheet, p }
    }
    // Cell (A1, $A$1, A$1) unless more name characters or a ( follow: LOG10( is a function, A1B a name.
    const cell = CELL_RE.exec(rest)
    if (cell && validCell(cell[0])) {
      const after = rest[cell[0].length] ?? ''
      if (!IDENT_CHAR.test(after) && after !== '(' && after !== '[') {
        i += cell[0].length
        return { k: 'ref', text: cell[0], sheet, p }
      }
    }
    let j = i
    if (!IDENT_START.test(src[j] ?? '')) {
      return null
    }
    while (j < n && IDENT_CHAR.test(src[j])) j++
    const word = src.slice(i, j)
    if (src[j] === '(' && !sheet) {
      i = j + 1
      return { k: 'func', v: word, p }
    }
    if (src[j] === '[' && !sheet) {
      i = j
      const body = readBrackets()
      return { k: 'struct', table: word, body, p }
    }
    // Cell followed by more identifier characters (e.g. A1B) is a name; R1C1-looking words are not allowed as names.
    i = j
    const up = word.toUpperCase()
    if (!sheet && (up === 'TRUE' || up === 'FALSE')) return { k: 'bool', v: up === 'TRUE', p }
    return { k: 'name', v: word, sheet, p }
  }
}

// ---------- parser ----------

const BP: Record<string, number> = { '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10, '&': 20, '+': 30, '-': 30, '*': 40, '/': 40, '^': 50, ',': 75, ' ': 80, ':': 90 }
const PREFIX_BP = 70
const PCT_BP = 60

/** Strip the prefixes OOXML adds to newer functions and LAMBDA parameters. */
export function cleanName(name: string): string {
  return name.replace(/^(_xlfn\.)?(_xlws\.)?/i, '').replace(/^_xlpm\./i, '')
}

export function parseFormula(text: string, ctx: ParseContext): Node {
  const src = text.startsWith('=') ? text.slice(1) : text
  const toks = lex(src)
  let k = 0
  const peek = () => toks[k]
  const next = () => toks[k++]
  const skipWs = () => {
    while (toks[k].k === 'ws') k++
  }
  const resolveSheet = (s: SheetPrefix | null, p: number): SheetRef | null => {
    if (!s) return null
    const id = ctx.sheetId ? ctx.sheetId(s.name) : 0
    if (id === null) return { id: -1 } // unknown sheet: evaluates to #REF!
    if (s.name2) {
      const id2 = ctx.sheetId ? ctx.sheetId(s.name2) : 0
      if (id2 === null) return { id: -1 }
      return { id, id2 }
    }
    void p
    return { id }
  }

  const refFromText = (text: string, sheet: SheetRef | null): RefNode => {
    const rel = (abs: boolean, v: number, origin: number) => (abs ? v : v - origin)
    if (text.includes(':')) {
      const [a, b] = text.split(':')
      if (/^\$?[A-Za-z]+$/.test(a)) {
        const ca0 = a.startsWith('$')
        const ca1 = b.startsWith('$')
        let c0 = colIndex(a.replace('$', ''))
        let c1 = colIndex(b.replace('$', ''))
        if (c0 > c1) [c0, c1] = [c1, c0]
        return { t: 'ref', sheet, r0: 0, r1: MAX_ROWS - 1, ra0: true, ra1: true, c0: rel(ca0, c0, ctx.col), c1: rel(ca1, c1, ctx.col), ca0, ca1, span: 'cols' }
      }
      const ra0 = a.startsWith('$')
      const ra1 = b.startsWith('$')
      let r0 = Number(a.replace('$', '')) - 1
      let r1 = Number(b.replace('$', '')) - 1
      if (r0 > r1) [r0, r1] = [r1, r0]
      if (r0 < 0 || r1 >= MAX_ROWS) throw new FormulaSyntaxError('Row out of range', 0)
      return { t: 'ref', sheet, c0: 0, c1: MAX_COLS - 1, ca0: true, ca1: true, r0: rel(ra0, r0, ctx.row), r1: rel(ra1, r1, ctx.row), ra0, ra1, span: 'rows' }
    }
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text)!
    const ca = m[1] === '$'
    const ra = m[3] === '$'
    const c = colIndex(m[2])
    const r = Number(m[4]) - 1
    const rr = rel(ra, r, ctx.row)
    const cc = rel(ca, c, ctx.col)
    return { t: 'ref', sheet, r0: rr, c0: cc, r1: rr, c1: cc, ra0: ra, ca0: ca, ra1: ra, ca1: ca }
  }

  const startsOperand = (t: Tok) => ['num', 'str', 'bool', 'err', 'ref', 'name', 'func', 'struct', 'xref', '(', '{'].includes(t.k) || (t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === '@'))

  function parseExpr(minBp: number, union: boolean): Node {
    skipWs()
    let left = parsePrefix(union)
    for (;;) {
      const t = peek()
      if (t.k === 'ws') {
        // Whitespace is insignificant, except between two operands, where it is the intersection operator.
        const save = k
        skipWs()
        const after = peek()
        if (startsOperand(after) && after.k !== 'op') {
          if (BP[' '] <= minBp) {
            k = save
            break
          }
          const right = parseExpr(BP[' '], union)
          left = { t: 'bin', op: ' ', a: left, b: right }
        }
        continue
      }
      if (t.k === ',' && union && BP[','] > minBp) {
        next()
        const right = parseExpr(BP[','], union)
        left = { t: 'bin', op: ',', a: left, b: right }
        continue
      }
      if (t.k === '(') {
        // Calling a lambda: LAMBDA(x, x+1)(2)
        if (left.t === 'func' || left.t === 'call' || left.t === 'name' || left.t === 'paren') {
          next()
          const args = parseArgs()
          left = { t: 'call', fn: left, args }
          continue
        }
        break
      }
      if (t.k !== 'op') break
      if (t.v === '%') {
        if (PCT_BP <= minBp) break
        next()
        left = { t: 'pct', a: left }
        continue
      }
      if (t.v === '#') {
        next()
        left = { t: 'spill', a: left }
        continue
      }
      const bp = BP[t.v]
      if (bp === undefined || bp <= minBp) break
      next()
      // ^ is left-associative in Excel (2^3^2 = 64), like the other operators.
      const right = parseExpr(bp, union)
      if (t.v === ':' && left.t === 'ref' && right.t === 'ref' && !left.span && !right.span && (right.sheet === null || sameSheet(left.sheet, right.sheet))) {
        left = mergeRange(left, right)
        continue
      }
      left = { t: 'bin', op: t.v as BinOp, a: left, b: right }
    }
    return left
  }

  function sameSheet(a: SheetRef | null, b: SheetRef | null) {
    return (a?.id ?? null) === (b?.id ?? null) && (a?.id2 ?? null) === (b?.id2 ?? null)
  }

  function mergeRange(a: RefNode, b: RefNode): RefNode {
    // Normalise so that corner 0 is top-left (compare absolute positions).
    const ar = a.ra0 ? a.r0 : a.r0 + ctx.row
    const br = b.ra0 ? b.r0 : b.r0 + ctx.row
    const ac = a.ca0 ? a.c0 : a.c0 + ctx.col
    const bc = b.ca0 ? b.c0 : b.c0 + ctx.col
    const top = ar <= br ? a : b
    const bottom = ar <= br ? b : a
    const left = ac <= bc ? a : b
    const right = ac <= bc ? b : a
    return {
      t: 'ref',
      sheet: a.sheet,
      r0: top.r0,
      ra0: top.ra0,
      r1: bottom.r0,
      ra1: bottom.ra0,
      c0: left.c0,
      ca0: left.ca0,
      c1: right.c0,
      ca1: right.ca0
    }
  }

  function parseArgs(): Node[] {
    const args: Node[] = []
    skipWs()
    if (peek().k === ')') {
      next()
      return args
    }
    for (;;) {
      skipWs()
      const t = peek()
      if (t.k === ',' || t.k === ')') args.push({ t: 'missing' })
      else args.push(parseExpr(0, false))
      skipWs()
      const sep = next()
      if (sep.k === ')') return args
      if (sep.k !== ',') throw new FormulaSyntaxError('Expected , or ) in the argument list', sep.p)
    }
  }

  function parseArrayConst(): Node {
    const rows: Node[][] = [[]]
    for (;;) {
      skipWs()
      const t = next()
      let el: Node
      if (t.k === 'op' && (t.v === '-' || t.v === '+')) {
        const nt = next()
        if (nt.k !== 'num') throw new FormulaSyntaxError('Arrays can only hold numbers, text, logical values and errors', nt.p)
        el = { t: 'num', v: t.v === '-' ? -nt.v : nt.v }
      } else if (t.k === 'num') el = { t: 'num', v: t.v }
      else if (t.k === 'str') el = { t: 'str', v: t.v }
      else if (t.k === 'bool') el = { t: 'bool', v: t.v }
      else if (t.k === 'err') el = { t: 'err', v: t.v }
      else throw new FormulaSyntaxError('Arrays can only hold numbers, text, logical values and errors', t.p)
      rows[rows.length - 1].push(el)
      skipWs()
      const sep = next()
      if (sep.k === '}') break
      if (sep.k === ',') continue
      if (sep.k === ';') {
        rows.push([])
        continue
      }
      throw new FormulaSyntaxError('Expected , ; or } in the array', sep.p)
    }
    const w = rows[0].length
    if (rows.some((r) => r.length !== w)) throw new FormulaSyntaxError('Every row of an array must have the same number of items', 0)
    return { t: 'array', rows }
  }

  function parsePrefix(union: boolean): Node {
    skipWs()
    const t = next()
    switch (t.k) {
      case 'num':
        return { t: 'num', v: t.v }
      case 'str':
        return { t: 'str', v: t.v }
      case 'bool':
        return { t: 'bool', v: t.v }
      case 'err':
        return { t: 'err', v: t.v }
      case 'ref':
        return refFromText(t.text, resolveSheet(t.sheet, t.p))
      case 'xref':
        return { t: 'xref', text: t.text }
      case 'name': {
        const sheet = resolveSheet(t.sheet, t.p)
        return { t: 'name', name: cleanName(t.v), sheet }
      }
      case 'struct':
        return parseStruct(t.table, t.body, t.p)
      case 'func': {
        const args = parseArgs()
        const name = cleanName(t.v).toUpperCase()
        // In files the spill operator is written ANCHORARRAY(A1) and @ is SINGLE(x).
        if (name === 'ANCHORARRAY' && args.length === 1) return { t: 'spill', a: args[0] }
        if (name === 'SINGLE' && args.length === 1) return { t: 'un', op: '@', a: args[0] }
        return { t: 'func', name, args }
      }
      case '(': {
        const inner = parseExpr(0, true)
        skipWs()
        const c = next()
        if (c.k !== ')') throw new FormulaSyntaxError('A closing parenthesis is missing', c.p)
        return { t: 'paren', a: inner }
      }
      case '{':
        return parseArrayConst()
      case 'op':
        if (t.v === '-' || t.v === '+' || t.v === '@') return { t: 'un', op: t.v, a: parseExpr(PREFIX_BP, union) }
        throw new FormulaSyntaxError(`Unexpected “${t.v}”`, t.p)
      case 'eof':
        throw new FormulaSyntaxError('The formula ends too early', t.p)
      default:
        throw new FormulaSyntaxError(`Unexpected “${t.k}”`, t.p)
    }
  }

  const node = parseExpr(0, false)
  skipWs()
  const end = peek()
  if (end.k !== 'eof') throw new FormulaSyntaxError(`Unexpected “${src.slice(end.p, end.p + 10)}”`, end.p)
  return node
}

function parseStruct(table: string | null, body: string, p: number): StructNode {
  const node: StructNode = { t: 'struct', table, items: [], col0: null, col1: null }
  const unescape = (s: string) => s.replace(/'(.)/g, '$1')
  const special = (s: string): StructNode['items'][number] | null => {
    const u = s.trim().toLowerCase()
    if (u === '#all') return 'all'
    if (u === '#data') return 'data'
    if (u === '#headers') return 'headers'
    if (u === '#totals') return 'totals'
    if (u === '#this row' || u === '@') return 'thisrow'
    return null
  }
  let b = body.trim()
  if (b.startsWith('@')) {
    node.items.push('thisrow')
    b = b.slice(1).trim()
    if (!b) return node
  }
  if (!b.startsWith('[')) {
    const sp = special(b)
    if (sp) node.items.push(sp)
    else node.col0 = unescape(b)
    return node
  }
  // [[#Headers],[Col1]:[Col2]]
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (c === "'") {
      cur += c + (b[i + 1] ?? '')
      i++
      continue
    }
    if (c === '[') {
      depth++
      if (depth === 1) continue
    }
    if (c === ']') {
      depth--
      if (depth === 0) {
        parts.push(cur)
        cur = ''
        continue
      }
    }
    if (depth === 0) {
      if (c === ':') parts.push(':')
      continue
    }
    cur += c
  }
  const cols: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]
    if (s === ':') continue
    const sp = special(s)
    if (sp) node.items.push(sp)
    else cols.push(unescape(s))
  }
  if (cols.length > 2) throw new FormulaSyntaxError('A table reference names too many columns', p)
  node.col0 = cols[0] ?? null
  node.col1 = cols[1] ?? null
  return node
}

// ---------- printer ----------

export function printFormula(node: Node, ctx: PrintContext): string {
  const p = (n: Node): string => printNode(n, ctx)
  return p(node)
}

function sheetPrefix(s: SheetRef | null, ctx: PrintContext): string {
  if (!s) return ''
  const name = (id: number) => (id < 0 ? null : ctx.sheetName ? ctx.sheetName(id) : `Sheet${id + 1}`)
  const a = name(s.id)
  if (a === null) return '#REF!'
  if (s.id2 !== undefined) {
    const b = name(s.id2)
    if (b === null) return '#REF!'
    const both = `${a}:${b}`
    return `${quoteSheet(a) === a && quoteSheet(b) === b ? both : `'${both.replace(/'/g, "''")}'`}!`
  }
  return `${quoteSheet(a)}!`
}

/** Absolute position of a reference corner; null when it falls off the sheet (#REF!). */
export function refCorner(n: RefNode, ctx: { row: number; col: number }): { r0: number; c0: number; r1: number; c1: number } | null {
  const r0 = n.ra0 ? n.r0 : n.r0 + ctx.row
  const r1 = n.ra1 ? n.r1 : n.r1 + ctx.row
  const c0 = n.ca0 ? n.c0 : n.c0 + ctx.col
  const c1 = n.ca1 ? n.c1 : n.c1 + ctx.col
  if (r0 < 0 || c0 < 0 || r1 < 0 || c1 < 0 || r0 >= MAX_ROWS || r1 >= MAX_ROWS || c0 >= MAX_COLS || c1 >= MAX_COLS) return null
  return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) }
}

function printRef(n: RefNode, ctx: PrintContext): string {
  const pre = sheetPrefix(n.sheet, ctx)
  if (pre === '#REF!') return '#REF!'
  const a = refCorner(n, ctx)
  if (!a) return '#REF!'
  const r0 = n.ra0 ? n.r0 : n.r0 + ctx.row
  const r1 = n.ra1 ? n.r1 : n.r1 + ctx.row
  const c0 = n.ca0 ? n.c0 : n.c0 + ctx.col
  const c1 = n.ca1 ? n.c1 : n.c1 + ctx.col
  if (ctx.r1c1) {
    const R = (abs: boolean, v: number, off: number) => (abs ? `R${v + 1}` : off ? `R[${off}]` : 'R')
    const C = (abs: boolean, v: number, off: number) => (abs ? `C${v + 1}` : off ? `C[${off}]` : 'C')
    if (n.span === 'cols') return `${pre}${C(n.ca0, c0, n.c0)}:${C(n.ca1, c1, n.c1)}`
    if (n.span === 'rows') return `${pre}${R(n.ra0, r0, n.r0)}:${R(n.ra1, r1, n.r1)}`
    const a1 = R(n.ra0, r0, n.r0) + C(n.ca0, c0, n.c0)
    const b1 = R(n.ra1, r1, n.r1) + C(n.ca1, c1, n.c1)
    return pre + (a1 === b1 ? a1 : `${a1}:${b1}`)
  }
  const col = (abs: boolean, c: number) => (abs ? '$' : '') + colName(c)
  const row = (abs: boolean, r: number) => (abs ? '$' : '') + (r + 1)
  if (n.span === 'cols') return `${pre}${col(n.ca0, c0)}:${col(n.ca1, c1)}`
  if (n.span === 'rows') return `${pre}${row(n.ra0, r0)}:${row(n.ra1, r1)}`
  const first = col(n.ca0, c0) + row(n.ra0, r0)
  if (r0 === r1 && c0 === c1 && n.ra0 === n.ra1 && n.ca0 === n.ca1) return pre + first
  return `${pre}${first}:${col(n.ca1, c1)}${row(n.ra1, r1)}`
}

function printStruct(n: StructNode): string {
  const esc = (s: string) => s.replace(/(['#[\]@])/g, "'$1")
  const spec: Record<string, string> = { all: '#All', data: '#Data', headers: '#Headers', totals: '#Totals', thisrow: '#This Row' }
  const cols = n.col0 === null ? [] : n.col1 === null ? [n.col0] : [n.col0, n.col1]
  const table = n.table ?? ''
  if (n.items.length === 1 && n.items[0] === 'thisrow' && cols.length === 1) {
    const c = cols[0]
    return `${table}[@${/^[\w.]+$/.test(c) ? c : `[${esc(c)}]`}]`
  }
  if (n.items.length === 0 && cols.length === 1) return `${table}[${esc(cols[0])}]`
  if (n.items.length === 1 && cols.length === 0) return `${table}[${spec[n.items[0]]}]`
  const parts = n.items.map((i) => `[${spec[i]}]`)
  if (cols.length) parts.push(cols.map((c) => `[${esc(c)}]`).join(':'))
  return `${table}[${parts.join(',')}]`
}

function printNode(n: Node, ctx: PrintContext): string {
  switch (n.t) {
    case 'num':
      return numberToText(n.v)
    case 'str':
      return `"${n.v.replace(/"/g, '""')}"`
    case 'bool':
      return n.v ? 'TRUE' : 'FALSE'
    case 'err':
      return n.v
    case 'ref':
      return printRef(n, ctx)
    case 'struct':
      return printStruct(n)
    case 'xref':
      return n.text
    case 'name': {
      const pre = sheetPrefix(n.sheet, ctx)
      return pre === '#REF!' ? '#REF!' : pre + (ctx.fileNames && ctx.paramNames?.has(n.name.toUpperCase()) ? `_xlpm.${n.name}` : n.name)
    }
    case 'func': {
      const name = ctx.fileNames ? ctx.fileNames(n.name) : n.name
      const inner = ctx.fileNames && (n.name === 'LAMBDA' || n.name === 'LET') ? withParams(n, ctx) : null
      return `${name}(${(inner ?? n.args.map((a) => printNode(a, ctx))).join(',')})`
    }
    case 'call':
      return `${printNode(n.fn, ctx)}(${n.args.map((a) => printNode(a, ctx)).join(',')})`
    case 'un':
      if (n.op === '@' && ctx.fileNames) return `_xlfn.SINGLE(${printNode(n.a, ctx)})`
      return n.op + printNode(n.a, ctx)
    case 'pct':
      return printNode(n.a, ctx) + '%'
    case 'spill':
      if (ctx.fileNames) return `_xlfn.ANCHORARRAY(${printNode(n.a, ctx)})`
      return printNode(n.a, ctx) + '#'
    case 'bin':
      return printNode(n.a, ctx) + n.op + printNode(n.b, ctx)
    case 'array':
      return `{${n.rows.map((r) => r.map((e) => printNode(e, ctx)).join(',')).join(';')}}`
    case 'paren':
      return `(${printNode(n.a, ctx)})`
    case 'missing':
      return ''
  }
}

/** In files, LAMBDA and LET parameter names carry an _xlpm. prefix. */
function withParams(n: Extract<Node, { t: 'func' }>, ctx: PrintContext): string[] {
  const params = new Set(ctx.paramNames ?? [])
  const names: number[] = n.name === 'LAMBDA' ? n.args.slice(0, -1).map((_, i) => i) : n.args.map((_, i) => i).filter((i) => i % 2 === 0 && i < n.args.length - 1)
  for (const i of names) {
    const a = n.args[i]
    if (a.t === 'name') params.add(a.name.toUpperCase())
  }
  const inner: PrintContext = { ...ctx, paramNames: params }
  return n.args.map((a, i) => (names.includes(i) && a.t === 'name' ? `_xlpm.${a.name}` : printNode(a, inner)))
}

/** Visit every node (pre-order). */
export function walk(n: Node, fn: (n: Node) => void) {
  fn(n)
  switch (n.t) {
    case 'func':
    case 'call':
      if (n.t === 'call') walk(n.fn, fn)
      n.args.forEach((a) => walk(a, fn))
      break
    case 'un':
    case 'pct':
    case 'spill':
    case 'paren':
      walk(n.a, fn)
      break
    case 'bin':
      walk(n.a, fn)
      walk(n.b, fn)
      break
    case 'array':
      n.rows.forEach((r) => r.forEach((e) => walk(e, fn)))
      break
  }
}

/** Rebuild a tree bottom-up; `fn` returns a replacement or undefined to keep the node. */
export function mapNode(n: Node, fn: (n: Node) => Node | undefined): Node {
  let out: Node = n
  switch (n.t) {
    case 'func': {
      const args = n.args.map((a) => mapNode(a, fn))
      if (args.some((a, i) => a !== n.args[i])) out = { ...n, args }
      break
    }
    case 'call': {
      const f = mapNode(n.fn, fn)
      const args = n.args.map((a) => mapNode(a, fn))
      if (f !== n.fn || args.some((a, i) => a !== n.args[i])) out = { ...n, fn: f, args }
      break
    }
    case 'un':
    case 'pct':
    case 'spill':
    case 'paren': {
      const a = mapNode(n.a, fn)
      if (a !== n.a) out = { ...n, a } as Node
      break
    }
    case 'bin': {
      const a = mapNode(n.a, fn)
      const b = mapNode(n.b, fn)
      if (a !== n.a || b !== n.b) out = { ...n, a, b }
      break
    }
  }
  return fn(out) ?? out
}

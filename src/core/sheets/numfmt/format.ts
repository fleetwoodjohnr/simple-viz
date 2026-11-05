// Excel number format codes: "#,##0.00", "0%", "[Red]-0.0;0.0", "yyyy-mm-dd hh:mm", "# ?/?", "0.00E+00", "@" …
// formatValue() renders a cell value the way Excel displays it (en-US).

import { serialToDate, timeParts, weekday } from './dates'
import { CellError, numberToText, type Scalar } from '../engine/values'

export interface Formatted {
  text: string
  /** Colour from a [Red]-style section. */
  color?: string
  /** True when the code is a date/time format (used for alignment, autofill and TEXT checks). */
  isDate?: boolean
}

type Tok =
  | { k: 'lit'; v: string }
  | { k: 'digit'; v: '0' | '#' | '?' }
  | { k: 'dot' }
  | { k: 'comma' }
  | { k: 'pct' }
  | { k: 'exp'; plus: boolean }
  | { k: 'slash' }
  | { k: 'text' }
  | { k: 'skip'; v: string } // _x: space as wide as x
  | { k: 'fill'; v: string } // *x: repeat x to fill the cell
  | { k: 'date'; v: string } // y, m, d, h, s, AM/PM, [h] …
  | { k: 'general' }

interface Section {
  toks: Tok[]
  color?: string
  cond?: { op: string; v: number }
  date: boolean
  text: boolean
  general: boolean
  /** Number-format analysis */
  pct: number
  scale: number
  thousands: boolean
  hasExp: boolean
  fraction: boolean
}

const COLORS: Record<string, string> = { black: '#000000', blue: '#0000FF', cyan: '#00FFFF', green: '#00FF00', magenta: '#FF00FF', red: '#FF0000', white: '#FFFFFF', yellow: '#FFFF00' }
const PALETTE = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080', '#9999FF', '#993366', '#FFFFCC', '#CCFFFF', '#660066', '#FF8080', '#0066CC', '#CCCCFF', '#000080', '#FF00FF', '#FFFF00', '#00FFFF', '#800080', '#800000', '#008080', '#0000FF', '#00CCFF', '#CCFFFF', '#CCFFCC', '#FFFF99', '#99CCFF', '#FF99CC', '#CC99FF', '#FFCC99', '#3366FF', '#33CCCC', '#99CC00', '#FFCC00', '#FF9900', '#FF6600', '#666699', '#969696', '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333']

/** Built-in number formats by id (OOXML numFmtId), en-US. */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@'
}

const cache = new Map<string, Section[]>()

function parse(code: string): Section[] {
  let secs = cache.get(code)
  if (secs) return secs
  secs = splitSections(code).map(parseSection)
  if (cache.size > 2000) cache.clear()
  cache.set(code, secs)
  return secs
}

function splitSections(code: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '"') {
      const j = code.indexOf('"', i + 1)
      const end = j < 0 ? code.length : j
      cur += code.slice(i, end + 1)
      i = end
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      cur += code.slice(i, i + 2)
      i++
    } else if (ch === '[') {
      const j = code.indexOf(']', i)
      const end = j < 0 ? code.length : j
      cur += code.slice(i, end + 1)
      i = end
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const DATE_RE = /^(yyyy|yyy|yy|y|eeee|ee|e|bbbb|bb|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p)/i

function parseSection(src: string): Section {
  const sec: Section = { toks: [], date: false, text: false, general: false, pct: 0, scale: 0, thousands: false, hasExp: false, fraction: false }
  const t = sec.toks
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const rest = src.slice(i)
    if (ch === '"') {
      const j = src.indexOf('"', i + 1)
      const end = j < 0 ? src.length : j
      t.push({ k: 'lit', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (ch === '\\') {
      t.push({ k: 'lit', v: src[i + 1] ?? '' })
      i += 2
      continue
    }
    if (ch === '_') {
      t.push({ k: 'skip', v: src[i + 1] ?? ' ' })
      i += 2
      continue
    }
    if (ch === '*') {
      t.push({ k: 'fill', v: src[i + 1] ?? ' ' })
      i += 2
      continue
    }
    if (ch === '[') {
      const j = src.indexOf(']', i)
      const inner = src.slice(i + 1, j < 0 ? src.length : j)
      i = j < 0 ? src.length : j + 1
      const low = inner.toLowerCase()
      if (COLORS[low]) sec.color = COLORS[low]
      else if (/^color\s*\d+$/.test(low)) sec.color = PALETTE[Number(low.replace(/\D/g, '')) - 1]
      else if (/^(<=|>=|<>|<|>|=)\s*-?[\d.]+(e[+-]?\d+)?$/.test(low)) {
        const m = /^(<=|>=|<>|<|>|=)\s*(.+)$/.exec(low)!
        sec.cond = { op: m[1], v: Number(m[2]) }
      } else if (/^(h+|m+|s+)$/.test(low)) {
        t.push({ k: 'date', v: `[${low}]` })
        sec.date = true
      } else if (inner.startsWith('$')) {
        // [$€-407] currency symbol with locale; [$-409] locale only
        const sym = inner.slice(1).split('-')[0]
        if (sym) t.push({ k: 'lit', v: sym })
      }
      continue
    }
    if (/^general/i.test(rest)) {
      t.push({ k: 'general' })
      sec.general = true
      i += 7
      continue
    }
    const dm = DATE_RE.exec(rest)
    if (dm && !(dm[0].toLowerCase() === 'e' && /^e[+-]/i.test(rest))) {
      const v = dm[0]
      // "e" inside a number section is the exponent marker, not the era year
      t.push({ k: 'date', v: v.toLowerCase() === 'am/pm' || v.toLowerCase() === 'a/p' ? v : v.toLowerCase() })
      sec.date = true
      i += v.length
      continue
    }
    if (ch === '0' || ch === '#' || ch === '?') {
      t.push({ k: 'digit', v: ch })
      i++
      continue
    }
    if (ch === '.') {
      t.push({ k: 'dot' })
      i++
      continue
    }
    if (ch === ',') {
      t.push({ k: 'comma' })
      i++
      continue
    }
    if (ch === '%') {
      t.push({ k: 'pct' })
      sec.pct++
      i++
      continue
    }
    if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      t.push({ k: 'exp', plus: src[i + 1] === '+' })
      sec.hasExp = true
      i += 2
      continue
    }
    if (ch === '/') {
      t.push({ k: 'slash' })
      i++
      continue
    }
    if (ch === '@') {
      t.push({ k: 'text' })
      sec.text = true
      i++
      continue
    }
    t.push({ k: 'lit', v: ch })
    i++
  }
  if (!sec.date) analyseNumber(sec)
  return sec
}

function analyseNumber(sec: Section) {
  const t = sec.toks
  const dot = t.findIndex((x) => x.k === 'dot')
  const intEnd = dot >= 0 ? dot : t.length
  // A comma followed by a digit placeholder in the integer part is the thousands separator; commas after the last
  // placeholder of a part (before the point, a literal or the end) divide by 1000 each.
  for (let i = 0; i < t.length; i++) {
    if (t[i].k !== 'comma') continue
    const before = t.slice(0, i).some((x) => x.k === 'digit')
    let j = i
    while (j < t.length && t[j].k === 'comma') j++
    if (!before) continue
    if (t[j]?.k === 'digit' && i < intEnd) sec.thousands = true
    else sec.scale += j - i
    i = j - 1
  }
  sec.fraction = t.some((x) => x.k === 'slash') && t.some((x) => x.k === 'digit') && !sec.hasExp
}

function pickSection(secs: Section[], v: number): { sec: Section; abs: boolean } {
  const conds = secs.filter((s) => s.cond)
  if (conds.length) {
    const test = (s: Section) => {
      const c = s.cond!
      return c.op === '<' ? v < c.v : c.op === '<=' ? v <= c.v : c.op === '>' ? v > c.v : c.op === '>=' ? v >= c.v : c.op === '=' ? v === c.v : v !== c.v
    }
    for (let i = 0; i < Math.min(secs.length, 2); i++) if (secs[i].cond && test(secs[i])) return { sec: secs[i], abs: v < 0 && secs[i].cond!.v <= 0 && (secs[i].cond!.op.startsWith('<')) }
    const rest = secs.filter((s) => !s.cond && !s.text)
    const sec = rest[0] ?? secs[secs.length - 1]
    return { sec, abs: false }
  }
  const numSecs = secs.filter((s, i) => !(s.text && i === 3) && !(i === secs.length - 1 && i > 0 && s.text && !s.toks.some((x) => x.k === 'digit')))
  if (v > 0 || numSecs.length === 1) return { sec: numSecs[0], abs: false }
  if (v < 0) return { sec: numSecs[1] ?? numSecs[0], abs: numSecs.length > 1 }
  return { sec: numSecs[2] ?? numSecs[0], abs: false }
}

export function isDateFormat(code: string | undefined): boolean {
  if (!code) return false
  return parse(code).some((s) => s.date)
}

/** Format a cell value with a number format code (General when absent). */
export function formatValue(v: Scalar, code: string | undefined, date1904 = false, width = 11): Formatted {
  if (v === null) return { text: '' }
  if (v instanceof CellError) return { text: v.code }
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' }
  const secs = parse(code && code !== '' ? code : 'General')
  if (typeof v === 'string') {
    const ts = secs.length >= 4 ? secs[3] : secs.find((s) => s.text)
    if (!ts) return { text: v }
    return { text: renderText(ts, v), color: ts.color }
  }
  if (!Number.isFinite(v)) return { text: '#NUM!' }
  const { sec, abs } = pickSection(secs, v)
  if (!sec || sec.general || (sec.toks.length === 0 && secs.length === 1)) {
    const pre = sec ? literalsAround(sec, generalNumber(abs ? Math.abs(v) : v, width)) : generalNumber(v, width)
    return { text: pre, color: sec?.color }
  }
  if (sec.date) {
    if (v < 0 || v >= 2958466) return { text: '#'.repeat(Math.max(1, Math.min(width, 11))), isDate: true }
    return { text: renderDate(sec, v, date1904), color: sec.color, isDate: true }
  }
  if (sec.toks.length === 0) return { text: '', color: sec.color }
  if (sec.text && !sec.toks.some((x) => x.k === 'digit')) return { text: renderText(sec, generalNumber(v, width)), color: sec.color }
  const x = abs ? Math.abs(v) : v
  return { text: renderNumber(sec, x, !abs && v < 0 && secs.length >= 1), color: sec.color }
}

function literalsAround(sec: Section, inner: string): string {
  let out = ''
  for (const t of sec.toks) {
    if (t.k === 'general') out += inner
    else if (t.k === 'lit') out += t.v
    else if (t.k === 'skip') out += ' '
  }
  return out || inner
}

/** General format: up to `width` characters, switching to scientific notation when needed (as Excel does in a cell). */
export function generalNumber(v: number, width = 11): string {
  const s = numberToText(v)
  if (s.length <= width) return s
  const abs = Math.abs(v)
  if (abs >= 1e-4 && abs < 1e11) {
    // Round the decimals to fit.
    const intLen = Math.floor(Math.log10(Math.max(abs, 1))) + 1 + (v < 0 ? 1 : 0)
    const dec = Math.max(0, width - intLen - 1)
    let r = v.toFixed(dec)
    if (r.includes('.')) r = r.replace(/0+$/, '').replace(/\.$/, '')
    if (r.length <= width) return r
  }
  // Scientific with as many mantissa digits as fit: 1.23457E+11
  for (let d = Math.max(0, width - 6 - (v < 0 ? 1 : 0)); d >= 0; d--) {
    const [m, e] = v.toExponential(d).split('e')
    const exp = Number(e)
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m
    const out = `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
    if (out.length <= width) return out
  }
  return s
}

function renderText(sec: Section, s: string): string {
  let out = ''
  for (const t of sec.toks) {
    if (t.k === 'text') out += s
    else if (t.k === 'lit') out += t.v
    else if (t.k === 'skip') out += ' '
    else if (t.k === 'digit' || t.k === 'general') out += t.k === 'general' ? s : ''
  }
  return out
}

// ---------- numbers ----------

function roundTo(x: number, d: number): number {
  const p = Math.pow(10, d)
  return Math.round(Number((Math.abs(x) * p).toPrecision(15))) / p
}

function renderNumber(sec: Section, value: number, negSign: boolean): string {
  let x = (Math.abs(value) * Math.pow(100, sec.pct)) / Math.pow(1000, sec.scale)
  const toks = sec.toks
  if (sec.fraction) return renderFraction(sec, x, negSign && value !== 0)
  const dot = toks.findIndex((t) => t.k === 'dot')
  const expAt = toks.findIndex((t) => t.k === 'exp')
  const mantEnd = expAt >= 0 ? expAt : toks.length
  const intToks = toks.slice(0, dot >= 0 ? dot : mantEnd)
  const decToks = dot >= 0 ? toks.slice(dot + 1, mantEnd) : []
  const decPlaces = decToks.filter((t) => t.k === 'digit').length
  const intPlaces = intToks.filter((t) => t.k === 'digit').length
  let expStr = ''
  if (expAt >= 0) {
    const expDigits = toks.slice(expAt + 1).filter((t) => t.k === 'digit')
    let e = x === 0 ? 0 : Math.floor(Math.log10(x))
    // Engineering notation: ##0.0E+0 keeps exponents a multiple of the integer placeholder count.
    const step = intPlaces > 1 && intToks.some((t) => t.k === 'digit' && t.v === '#') ? intPlaces : 1
    if (step > 1) e = Math.floor(e / step) * step
    else e = e - (Math.max(intPlaces, 1) - 1)
    let m = x / Math.pow(10, e)
    if (roundTo(m, decPlaces) >= Math.pow(10, step > 1 ? step : Math.max(intPlaces, 1))) {
      e += step
      m = x / Math.pow(10, e)
    }
    x = m
    const plus = (toks[expAt] as { plus: boolean }).plus
    const sign = e < 0 ? '-' : plus ? '+' : ''
    expStr = 'E' + sign + String(Math.abs(e)).padStart(Math.max(1, expDigits.filter((d) => d.v === '0').length), '0')
  }
  const r = roundTo(x, decPlaces)
  const [ip, fp = ''] = r.toFixed(decPlaces).split('.')
  const intDigits = ip === '0' ? '' : ip
  // Integer part: fill placeholders from the right; the leftmost placeholder takes any extra digits.
  let intOut = ''
  let count = 0
  let di = intDigits.length - 1
  const firstPh = intToks.findIndex((t) => t.k === 'digit')
  const pushDigit = (ch: string) => {
    if (sec.thousands && count > 0 && count % 3 === 0) intOut = ',' + intOut
    intOut = ch + intOut
    count++
  }
  for (let i = intToks.length - 1; i >= 0; i--) {
    const t = intToks[i]
    if (t.k === 'digit') {
      if (di >= 0) pushDigit(intDigits[di--])
      else if (t.v === '0') pushDigit('0')
      else if (t.v === '?') intOut = ' ' + intOut
      if (i === firstPh) while (di >= 0) pushDigit(intDigits[di--])
    } else intOut = tokText(t) + intOut
  }
  if (firstPh < 0 && intDigits) intOut = intDigits + intOut
  let decOut = ''
  if (dot >= 0) {
    let fi = 0
    const parts: string[] = []
    // Optional trailing digits (#) are dropped when zero; ? become spaces.
    let lastSig = fp.length - 1
    while (lastSig >= 0 && fp[lastSig] === '0') lastSig--
    let di = 0
    for (const t of decToks) {
      if (t.k === 'digit') {
        const d = fp[fi++] ?? '0'
        if (di <= lastSig || t.v === '0') parts.push(d)
        else parts.push(t.v === '?' ? ' ' : '')
        di++
      } else parts.push(tokText(t))
    }
    decOut = '.' + parts.join('')
  }
  const rest = expAt >= 0 ? toks.slice(expAt + 1).filter((t) => t.k !== 'digit').map(tokText).join('') : ''
  const negative = negSign && (Number(r) !== 0 || (intDigits !== '' && intDigits !== '0'))
  return (negative ? '-' : '') + intOut + decOut + expStr + rest
}

function tokText(t: Tok): string {
  switch (t.k) {
    case 'lit':
      return t.v
    case 'skip':
      return ' '
    case 'fill':
      return ''
    case 'pct':
      return '%'
    case 'comma':
      return ''
    case 'slash':
      return '/'
    case 'text':
      return ''
    case 'dot':
      return '.'
    default:
      return ''
  }
}

function renderFraction(sec: Section, x: number, neg: boolean): string {
  const toks = sec.toks
  const slash = toks.findIndex((t) => t.k === 'slash')
  const denToks = toks.slice(slash + 1)
  const fixedDen = Number(denToks.filter((t) => t.k === 'lit' && /\d/.test(t.v)).map((t) => (t as { v: string }).v).join('')) || 0
  const denPlaces = denToks.filter((t) => t.k === 'digit').length
  // Split: [integer placeholders] [space literal] [numerator placeholders] / [denominator]
  const before = toks.slice(0, slash)
  let numStart = before.length
  while (numStart > 0 && before[numStart - 1].k === 'digit') numStart--
  const intPart = before.slice(0, numStart)
  const hasInt = intPart.some((t) => t.k === 'digit')
  const whole = hasInt ? Math.floor(x) : 0
  const frac = x - whole
  let num: number
  let den: number
  if (fixedDen) {
    den = fixedDen
    num = Math.round(frac * den)
  } else {
    ;[num, den] = bestFraction(frac, Math.pow(10, Math.max(1, denPlaces)) - 1)
  }
  let w = whole
  if (num === den && hasInt) {
    w += 1
    num = 0
  }
  const numPh = before.slice(numStart).length
  const denStr = String(den)
  const intStr = hasInt ? (w === 0 && intPart.some((t) => t.k === 'digit' && t.v === '#') ? '' : String(w)) : ''
  const lead = intPart.filter((t) => t.k !== 'digit').map(tokText).join('')
  if (num === 0 && hasInt) {
    const blank = ' '.repeat(numPh + 1 + Math.max(denPlaces, denStr.length))
    return (neg ? '-' : '') + (intStr || '0') + lead.replace(/\s+$/, '') + (w === 0 ? '' : ' ' + blank.slice(1))
  }
  const numStr = String(num).padStart(numPh, ' ')
  const denOut = fixedDen ? denStr : denStr.padEnd(denPlaces, ' ')
  const tail = denToks.filter((t) => t.k !== 'digit' && !(t.k === 'lit' && /\d/.test(t.v))).map(tokText).join('')
  return (neg ? '-' : '') + (hasInt ? intStr + lead : '') + numStr + '/' + denOut + tail
}

/** Closest fraction with a denominator up to maxDen (Stern–Brocot / continued fractions). */
function bestFraction(x: number, maxDen: number): [number, number] {
  if (x === 0) return [0, 1]
  let [a0, b0, a1, b1] = [0, 1, 1, 0]
  let y = x
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(y)
    const a2 = a * a1 + a0
    const b2 = a * b1 + b0
    if (b2 > maxDen) {
      // best semiconvergent
      const k = Math.floor((maxDen - b0) / b1)
      const c = [k * a1 + a0, k * b1 + b0]
      return Math.abs(c[0] / c[1] - x) < Math.abs(a1 / b1 - x) ? [c[0], c[1]] : [a1, b1]
    }
    ;[a0, b0, a1, b1] = [a1, b1, a2, b2]
    if (Math.abs(y - a) < 1e-12) break
    y = 1 / (y - a)
  }
  return [a1, b1]
}

// ---------- dates ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function renderDate(sec: Section, serial: number, date1904: boolean): string {
  const toks = sec.toks
  const ampm = toks.some((t) => t.k === 'date' && /^(am\/pm|a\/p)$/i.test(t.v))
  // Fractional seconds: s.000 → round to that precision.
  let fracDigits = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.k === 'date' && (t.v === 's' || t.v === 'ss' || t.v === '[s]' || t.v === '[ss]') && toks[i + 1]?.k === 'dot') {
      let j = i + 2
      while (toks[j]?.k === 'digit') {
        fracDigits++
        j++
      }
    }
  }
  const unit = 86400 * Math.pow(10, fracDigits)
  const rounded = Math.round(serial * unit) / unit
  const ymd = serialToDate(rounded, date1904)
  const tp = timeParts(rounded)
  const totalSec = rounded * 86400
  // Decide m = month or minute: minute after h or before s.
  const kinds = toks.map((t) => (t.k === 'date' ? t.v : null))
  const isMinute = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const k = kinds[j]
      if (k === null) {
        if (toks[j].k === 'lit' || toks[j].k === 'skip') continue
        break
      }
      if (/^h|^\[h/.test(k)) return true
      break
    }
    for (let j = i + 1; j < kinds.length; j++) {
      const k = kinds[j]
      if (k === null) {
        if (toks[j].k === 'lit' || toks[j].k === 'skip') continue
        break
      }
      return /^s|^\[s/.test(k)
    }
    return false
  }
  let out = ''
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.k !== 'date') {
      if (t.k === 'dot' && i > 0 && toks[i - 1].k === 'date' && /s/.test((toks[i - 1] as { v: string }).v)) {
        let digits = ''
        let j = i + 1
        while (toks[j]?.k === 'digit') {
          digits += '0'
          j++
        }
        const frac = Math.round((rounded * 86400 - Math.floor(rounded * 86400 + 1e-9)) * Math.pow(10, digits.length))
        out += '.' + String(Math.min(frac, Math.pow(10, digits.length) - 1)).padStart(digits.length, '0')
        i = j - 1
        continue
      }
      out += t.k === 'comma' ? ',' : t.k === 'digit' ? t.v : tokText(t)
      continue
    }
    const v = t.v
    switch (v) {
      case 'yyyy':
      case 'yyy':
      case 'eeee':
      case 'ee':
      case 'e':
        out += String(ymd.y)
        break
      case 'yy':
      case 'y':
        out += String(ymd.y % 100).padStart(2, '0')
        break
      case 'bbbb':
        out += String(ymd.y + 543)
        break
      case 'bb':
        out += String((ymd.y + 543) % 100).padStart(2, '0')
        break
      case 'mmmmm':
        out += MONTHS[ymd.m - 1][0]
        break
      case 'mmmm':
        out += MONTHS[ymd.m - 1]
        break
      case 'mmm':
        out += MONTHS[ymd.m - 1].slice(0, 3)
        break
      case 'mm':
        out += isMinute(i) ? String(tp.mi).padStart(2, '0') : String(ymd.m).padStart(2, '0')
        break
      case 'm':
        out += isMinute(i) ? String(tp.mi) : String(ymd.m)
        break
      case 'dddd':
        out += DAYS[weekday(serial, date1904)]
        break
      case 'ddd':
        out += DAYS[weekday(serial, date1904)].slice(0, 3)
        break
      case 'dd':
        out += String(ymd.d).padStart(2, '0')
        break
      case 'd':
        out += String(ymd.d)
        break
      case 'hh':
      case 'h': {
        let h = tp.h
        if (ampm) h = h % 12 === 0 ? 12 : h % 12
        out += v === 'hh' ? String(h).padStart(2, '0') : String(h)
        break
      }
      case 'ss':
        out += String(tp.s).padStart(2, '0')
        break
      case 's':
        out += String(tp.s)
        break
      case '[h]':
      case '[hh]':
        out += String(Math.floor(totalSec / 3600 + 1e-9)).padStart(v.length - 2, '0')
        break
      case '[m]':
      case '[mm]':
        out += String(Math.floor(totalSec / 60 + 1e-9)).padStart(v.length - 2, '0')
        break
      case '[s]':
      case '[ss]':
        out += String(Math.floor(totalSec + 1e-9)).padStart(v.length - 2, '0')
        break
      default:
        if (/^am\/pm$/i.test(v)) out += tp.h < 12 ? (v[0] === 'a' ? 'am' : 'AM') : v[0] === 'a' ? 'pm' : 'PM'
        else if (/^a\/p$/i.test(v)) out += tp.h < 12 ? (v[0] === 'a' ? 'a' : 'A') : v[0] === 'a' ? 'p' : 'P'
    }
  }
  return out
}

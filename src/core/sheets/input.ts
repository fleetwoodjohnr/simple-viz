// What a user typed into a cell → a value, or a formula, plus the number format Excel would apply automatically.
import { CellError, ERROR_CODES, parseNumber, type Scalar } from './engine/values'
import { parseDateTime } from './numfmt/dates'

export interface ParsedInput {
  value?: Scalar
  /** Formula text including the leading "=". */
  formula?: string
  /** Number format to apply when the cell's format is still General. */
  format?: string
  /** Typed with a leading apostrophe: always text. */
  quoted?: boolean
}

export function parseInput(text: string, date1904 = false): ParsedInput {
  if (text === '') return { value: null }
  if (text.startsWith("'")) return { value: text.slice(1), quoted: true }
  if (text.startsWith('=') && text.length > 1) return { formula: text }
  // "+A1*2" and "-A1" are formulas in Excel too, unless they are plain numbers.
  if ((text.startsWith('+') || text.startsWith('-')) && text.length > 1 && parseNumber(text) === null && /[A-Za-z(]/.test(text)) return { formula: '=' + text }
  const t = text.trim()
  const up = t.toUpperCase()
  if (up === 'TRUE' || up === 'FALSE') return { value: up === 'TRUE' }
  if ((ERROR_CODES as readonly string[]).includes(up)) return { value: CellError.of(up as never) }
  const n = parseNumber(t)
  if (n !== null) return { value: n, format: numberFormatFor(t) }
  const d = parseDateTime(t, date1904)
  if (d !== null) return { value: d, format: dateFormatFor(t) }
  return { value: text }
}

function numberFormatFor(t: string): string | undefined {
  const dec = /\.(\d+)/.exec(t)?.[1].length ?? 0
  const decs = dec ? '.' + '0'.repeat(Math.min(dec, 2)) : ''
  if (t.includes('%')) return `0${dec ? '.' + '0'.repeat(dec) : ''}%`
  if (t.includes('$')) return `"$"#,##0${decs}_);\\("$"#,##0${decs}\\)`
  if (/[eE]/.test(t)) return '0.00E+00'
  if (t.includes(',')) return `#,##0${decs}`
  if (/^\s*\(.*\)\s*$/.test(t)) return `#,##0${decs}_);\\(#,##0${decs}\\)`
  return undefined
}

function dateFormatFor(t: string): string {
  const hasTime = /\d:\d/.test(t)
  const ampm = /\d\s*(am|pm|a|p)\s*$/i.test(t)
  const secs = /\d:\d\d:\d/.test(t)
  const time = ampm ? (secs ? 'h:mm:ss AM/PM' : 'h:mm AM/PM') : secs ? 'h:mm:ss' : 'h:mm'
  const datePart = t.replace(/\s*\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(am|pm|a|p)?\s*$/i, '').trim()
  if (!datePart) return time
  let date = 'm/d/yyyy'
  if (/^\d{1,2}[-\s][A-Za-z]{3,}[-\s,]+\d{2,4}$/.test(datePart)) date = 'd-mmm-yy'
  else if (/^\d{1,2}[-\s][A-Za-z]{3,}$/.test(datePart)) date = 'd-mmm'
  else if (/^[A-Za-z]{3,}[-\s]\d{4}$/.test(datePart)) date = 'mmm-yy'
  else if (/^[A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4}$/.test(datePart)) date = 'd-mmm-yy'
  else if (/^\d{1,2}\/\d{1,2}$/.test(datePart)) date = 'd-mmm'
  return hasTime ? `${date} ${time}` : date
}

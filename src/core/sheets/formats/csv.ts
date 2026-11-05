// CSV and tab-separated text. Opening converts numbers and dates as Excel does; saving writes what cells display.
import { Workbook } from '../model/workbook'
import { parseInput } from '../input'
import { parseFormula } from '../engine/parser'
import { formatValue } from '../numfmt/format'
import { Warnings, type ExportResult, type ImportResult } from './types'

/** Decode bytes: BOMs, then UTF-8, falling back to Windows-1252 for files from older Excel versions. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** Guess the delimiter from the first lines: the candidate that splits them into the same number of fields. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 20).filter(Boolean)
  let best = ','
  let bestScore = -1
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => parseDelimited(l, d)[0]?.length ?? 0)
    if (!counts.length || counts[0] < 2) continue
    const same = counts.filter((n) => n === counts[0]).length
    const score = same * 10 + counts[0]
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

/** RFC 4180 parsing: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseDelimited(text: string, delim: string, maxRows = Infinity): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (ch === delim) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      if (rows.length >= maxRows) return rows
      row = []
      field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export interface CsvOptions {
  delimiter?: string
  /** false: keep every field as text (the import wizard's "Text" column type). */
  convert?: boolean
  sheetName?: string
}

export function importDelimited(bytes: Uint8Array, opts: CsvOptions = {}): ImportResult {
  const text = decodeText(bytes)
  const delim = opts.delimiter ?? sniffDelimiter(text)
  const rows = parseDelimited(text, delim)
  const wb = new Workbook()
  const sh = wb.addSheet(opts.sheetName ?? 'Sheet1')
  const w = new Warnings()
  if (rows.length > 1_048_576) w.add('loss', `Only the first 1,048,576 rows were opened (the file has ${rows.length.toLocaleString('en-US')}).`)
  const styleFor = new Map<string, number>()
  rows.slice(0, 1_048_576).forEach((line, r) => {
    if (line.length > 16384) w.add('loss', 'Columns beyond XFD (16,384) were not opened.')
    line.slice(0, 16384).forEach((t, c) => {
      if (t === '') return
      if (opts.convert === false) return sh.set(r, c, { v: t })
      const p = parseInput(t)
      if (p.formula) {
        try {
          sh.set(r, c, { v: 0, f: { ast: parseFormula(p.formula, { row: r, col: c, sheetId: (n) => wb.sheetByName(n)?.id ?? null }) } })
        } catch {
          sh.set(r, c, { v: t })
        }
        return
      }
      let s: number | undefined
      if (p.format) {
        s = styleFor.get(p.format)
        if (s === undefined) styleFor.set(p.format, (s = wb.styles.intern({ numFmt: p.format })))
      }
      sh.set(r, c, s ? { v: p.value ?? null, s } : { v: p.value ?? null })
    })
  })
  return { workbook: wb, warnings: w.list }
}

/** Text a spreadsheet application could mistake for a formula when the file is opened (CSV injection). */
const INJECTION = /^[=+\-@\t\r]/

export function exportDelimited(wb: Workbook, delim: string, opts: { sheet?: number; guard?: boolean } = {}): ExportResult {
  const w = new Warnings()
  const sh = opts.sheet !== undefined ? wb.sheetById(opts.sheet)! : wb.sheets[wb.activeSheet]
  if (wb.sheets.length > 1) w.add('loss', `Only the sheet “${sh.name}” is saved; CSV holds one sheet.`)
  let formats = false
  let formulas = false
  const u = sh.used()
  const lines: string[] = []
  for (let r = 0; r <= u.r; r++) {
    const row = sh.rows.get(r)
    const fields: string[] = []
    let last = -1
    for (let c = 0; c <= u.c; c++) {
      const cell = row?.get(c)
      if (!cell) {
        fields.push('')
        continue
      }
      if (cell.f) formulas = true
      const st = wb.styles.get(cell.s)
      if (Object.keys(st).some((k) => k !== 'numFmt')) formats = true
      let t = formatValue(cell.v, st.numFmt, wb.date1904, 255).text
      if (opts.guard && typeof cell.v === 'string' && INJECTION.test(t)) t = "'" + t
      if (t.includes(delim) || t.includes('"') || t.includes('\n') || t.includes('\r') || /^\s|\s$/.test(t)) t = `"${t.replace(/"/g, '""')}"`
      fields.push(t)
      if (t !== '') last = c
    }
    lines.push(fields.slice(0, last + 1).join(delim))
  }
  if (formulas) w.add('loss', 'Formulas are saved as their current results.')
  if (formats) w.add('loss', 'Cell formatting (fonts, colours, borders) is not saved.')
  return { data: new TextEncoder().encode(lines.join('\r\n') + (lines.length ? '\r\n' : '')), warnings: w.list }
}

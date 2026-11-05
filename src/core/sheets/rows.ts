// Spreadsheet → typed columns, for loading into DuckDB. Written for Simple Viz (the rest of this folder is copied from
// Simple Cell, see README.md). Values are the ones saved in the file: nothing is recalculated and no macro ever runs.

import { Workbook, type Sheet } from './model/workbook'
import { CellError, type Area, type Scalar } from './engine/values'
import { isDateFormat, formatValue } from './numfmt/format'
import { serialToDate, timeParts } from './numfmt/dates'
import { parseArea } from './refs'
import { readXlsx } from './formats/xlsx/read'
import { readOds } from './formats/ods/read'
import { importXml2003 } from './formats/xml2003'

export type SheetFormat = 'xlsx' | 'ods' | 'xml2003'
export type ColumnType = 'BOOLEAN' | 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'DATE' | 'TIMESTAMP'

export interface SheetColumn {
  name: string
  type: ColumnType
  /** DATE: days since 1970-01-01. TIMESTAMP: ms since 1970-01-01 (UTC wall time). */
  values: (boolean | number | string | null)[]
}

export interface SheetTable {
  columns: SheetColumn[]
  rowCount: number
  /** Cells holding errors (#N/A, #DIV/0!…), loaded as NULL. */
  errorCells: number
}

export interface SheetTableRef {
  ref: string
  kind: 'sheet' | 'table' | 'name'
  rows: number
  columns: number
}

export function readWorkbook(bytes: Uint8Array, format: SheetFormat): Workbook {
  if (format === 'xlsx') return readXlsx(bytes, { keepSpillValues: true }).workbook
  if (format === 'ods') return readOds(bytes).workbook
  return importXml2003(bytes).workbook
}

/** Everything in a workbook that can become a table: sheets, Excel tables, and named ranges. */
export function listTables(wb: Workbook): SheetTableRef[] {
  const out: SheetTableRef[] = []
  for (const s of wb.sheets) {
    const a = usedArea(s)
    if (a) out.push({ ref: s.name, kind: 'sheet', rows: a.r1 - a.r0, columns: a.c1 - a.c0 + 1 })
  }
  for (const t of wb.tables) out.push({ ref: t.displayName || t.name, kind: 'table', rows: t.area.r1 - t.area.r0 - (t.totalsRow ? 1 : 0), columns: t.area.c1 - t.area.c0 + 1 })
  for (const n of wb.names) {
    if (n.name.startsWith('_xlnm.') || n.scope !== null) continue
    const r = resolveRange(wb, n.text)
    if (r) out.push({ ref: n.name, kind: 'name', rows: r.area.r1 - r.area.r0, columns: r.area.c1 - r.area.c0 + 1 })
  }
  return out
}

function usedArea(s: Sheet): Area | null {
  const u = s.used()
  if (u.r < 0) return null
  let r0 = Infinity
  let c0 = Infinity
  s.forEachIn({ sheet: s.id, r0: 0, c0: 0, r1: u.r, c1: u.c }, (r, c, cell) => {
    if (cell.v === null || cell.v === '') return
    if (r < r0) r0 = r
    if (c < c0) c0 = c
  })
  return r0 === Infinity ? null : { sheet: s.id, r0, c0, r1: u.r, c1: u.c }
}

function resolveRange(wb: Workbook, text: string): { sheet: Sheet; area: Area } | null {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(text.replace(/^=/, '').trim())
  if (!m) return null
  const sheet = wb.sheetByName((m[1] ?? m[2]).replace(/''/g, "'"))
  const area = sheet && parseArea(m[3].replace(/\$/g, ''))
  return sheet && area ? { sheet, area } : null
}

/** Which cells `ref` means: a sheet name, a table name, a defined name, or `Sheet!A1:D20`. Default: the first sheet. */
export function resolveRef(wb: Workbook, ref: string | undefined): { sheet: Sheet; area: Area; header: boolean | null; totals: boolean } {
  if (!ref) {
    const sheet = wb.sheets.find((s) => usedArea(s)) ?? wb.sheets[0]
    if (!sheet) throw new Error('The workbook has no sheets.')
    return { sheet, area: usedArea(sheet) ?? { sheet: sheet.id, r0: 0, c0: 0, r1: -1, c1: -1 }, header: null, totals: false }
  }
  const t = wb.tableByName(ref)
  if (t) return { sheet: wb.sheetById(t.sheet)!, area: t.area, header: t.headerRow, totals: t.totalsRow }
  const sheet = wb.sheetByName(ref)
  if (sheet) return { sheet, area: usedArea(sheet) ?? { sheet: sheet.id, r0: 0, c0: 0, r1: -1, c1: -1 }, header: null, totals: false }
  const name = wb.names.find((n) => n.scope === null && n.name.toLowerCase() === ref.toLowerCase())
  const range = resolveRange(wb, name ? name.text : ref)
  if (range) return { ...range, header: null, totals: false }
  throw new Error(`“${ref}” is not a sheet, table or range in this workbook.`)
}

/** Reads cells as a table: the first row names the columns (unless header is false); types come from every row. */
export function tableRows(wb: Workbook, ref: string | undefined, header = true): SheetTable {
  const { sheet, area, header: tableHeader, totals } = resolveRef(wb, ref)
  const hasHeader = tableHeader ?? header
  const r1 = totals ? area.r1 - 1 : area.r1
  const width = area.c1 - area.c0 + 1
  if (width <= 0 || r1 < area.r0) return { columns: [], rowCount: 0, errorCells: 0 }
  const fmt = (s: number | undefined) => wb.styles.get(s).numFmt

  // Column names: header text, or F1, F2… (Excel's convention); blanks and duplicates get unique names.
  const names: string[] = []
  const used = new Set<string>()
  for (let i = 0; i < width; i++) {
    const v = hasHeader ? sheet.get(area.r0, area.c0 + i)?.v : null
    let n = v === null || v === undefined || v instanceof CellError ? '' : String(typeof v === 'number' ? formatValue(v, fmt(sheet.get(area.r0, area.c0 + i)?.s), wb.date1904, 255).text : v).trim()
    if (!n) n = `F${i + 1}`
    let unique = n
    for (let k = 2; used.has(unique.toLowerCase()); k++) unique = `${n}_${k}`
    used.add(unique.toLowerCase())
    names.push(unique)
  }

  // Raw cells, skipping rows that are entirely empty.
  const start = hasHeader ? area.r0 + 1 : area.r0
  const raw: { v: Scalar; f?: string }[][] = names.map(() => [])
  let errorCells = 0
  for (let r = start; r <= r1; r++) {
    let any = false
    const row: { v: Scalar; f?: string }[] = []
    for (let i = 0; i < width; i++) {
      const cell = sheet.get(r, area.c0 + i)
      let v: Scalar = cell?.v ?? null
      if (v instanceof CellError) {
        errorCells++
        v = null
      }
      if (v === '') v = null
      if (v !== null) any = true
      row.push({ v, f: cell?.s ? fmt(cell.s) : undefined })
    }
    if (any) row.forEach((x, i) => raw[i].push(x))
  }

  const columns = names.map((name, i) => toColumn(name, raw[i], wb.date1904))
  return { columns, rowCount: raw[0]?.length ?? 0, errorCells }
}

const DAY_MS = 86_400_000

function toColumn(name: string, cells: { v: Scalar; f?: string }[], date1904: boolean): SheetColumn {
  let bools = 0
  let nums = 0
  let ints = 0
  let dates = 0
  let times = 0
  let texts = 0
  for (const { v, f } of cells) {
    if (v === null) continue
    if (typeof v === 'boolean') bools++
    else if (typeof v === 'number') {
      nums++
      if (Number.isSafeInteger(v)) ints++
      if (isDateFormat(f)) {
        dates++
        if (v % 1 !== 0) times++
      }
    } else texts++
  }
  const filled = bools + nums + texts
  let type: ColumnType = 'VARCHAR'
  if (filled === 0) type = 'VARCHAR'
  else if (bools === filled) type = 'BOOLEAN'
  else if (nums === filled && dates === filled) type = times ? 'TIMESTAMP' : 'DATE'
  else if (nums === filled) type = ints === filled ? 'BIGINT' : 'DOUBLE'

  const values = cells.map(({ v, f }) => {
    if (v === null) return null
    switch (type) {
      case 'BOOLEAN':
      case 'BIGINT':
      case 'DOUBLE':
        return v as boolean | number
      case 'DATE':
      case 'TIMESTAMP': {
        const n = v as number
        const { y, m, d } = serialToDate(n, date1904)
        const day = Date.UTC(y, m - 1, d)
        if (type === 'DATE') return Math.round(day / DAY_MS)
        const t = timeParts(n)
        return day + ((t.h * 60 + t.mi) * 60 + t.s) * 1000 + t.ms
      }
      default:
        return typeof v === 'number' ? formatValue(v, f, date1904, 255).text : String(v)
    }
  })
  return { name, type, values }
}

export { Workbook }

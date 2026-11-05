// Query results → an XLSX workbook (Simple Viz's Excel export), through Simple Cell's writer.
import { Workbook } from './model/workbook'
import { writeXlsx } from './formats/xlsx/write'
import { dateSerial } from './numfmt/dates'

type Value = string | number | boolean | null

/** Excel's last row is 1,048,576, including the header. */
export const XLSX_MAX_ROWS = 1_048_575

export function rowsToXlsx(columns: { name: string; type: string }[], rows: Value[][], sheetName = 'Results'): Uint8Array {
  const wb = new Workbook()
  const sh = wb.addSheet(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Results')
  const bold = wb.styles.intern({ bold: true })
  const dateStyle = wb.styles.intern({ numFmt: 'yyyy-mm-dd' })
  const tsStyle = wb.styles.intern({ numFmt: 'yyyy-mm-dd hh:mm:ss' })
  columns.forEach((c, i) => sh.set(0, i, { v: c.name, s: bold }))
  const kind = columns.map((c) => (/^DATE$/.test(c.type) ? 'date' : /^TIMESTAMP/.test(c.type) ? 'ts' : /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL|REAL|U)/.test(c.type) ? 'num' : 'other'))
  rows.slice(0, XLSX_MAX_ROWS).forEach((row, r) =>
    row.forEach((v, i) => {
      if (v === null) return
      if ((kind[i] === 'date' || kind[i] === 'ts') && typeof v === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?))?/.exec(v)
        if (m) {
          const serial = dateSerial(+m[1], +m[2], +m[3]) + (m[4] ? (+m[4] * 3600 + +m[5] * 60 + +m[6]) / 86400 : 0)
          sh.set(r + 1, i, { v: serial, s: kind[i] === 'date' ? dateStyle : tsStyle })
          return
        }
      }
      if (kind[i] === 'num' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return sh.set(r + 1, i, { v: Number(v) })
      sh.set(r + 1, i, { v: typeof v === 'boolean' || typeof v === 'number' ? v : String(v) })
    })
  )
  return writeXlsx(wb).data
}

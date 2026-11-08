// Excel 97–2003 workbooks: the reader against xlrd (an independent reader) on a file xlwt wrote
// (scripts/xls-fixtures.py), and hand-made records for what xlwt can't write (cached formula results, errors).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { importXls, importBiff, readCfb } from '../../src/core/sheets/formats/xls'
import { tableRows, readWorkbook } from '../../src/core/sheets/rows'
import { CellError } from '../../src/core/sheets/engine/values'

const fx = (n: string) => path.resolve('tests/fixtures', n)
const ref = JSON.parse(readFileSync(fx('Sales.xls.json'), 'utf8')) as Record<string, { hidden: boolean; rows: unknown[][] }>
const DAY = 86_400_000

describe('Excel 97–2003 (.xls)', () => {
  const wb = readWorkbook(new Uint8Array(readFileSync(fx('Sales.xls'))), 'xls')

  it('reads every sheet, with the visibility xlrd sees', () => {
    expect(wb.sheets.map((s) => [s.name, !!s.hidden])).toEqual(Object.entries(ref).map(([n, v]) => [n, v.hidden]))
  })

  it('matches xlrd cell by cell, with dates and timestamps typed by their number formats', () => {
    for (const name of ['Transactions', 'Notes']) {
      const t = tableRows(wb, name, true)
      const rows = ref[name].rows
      expect(t.columns.map((c) => c.name), name).toEqual(rows[0])
      expect(t.rowCount, name).toBe(rows.length - 1)
      t.columns.forEach((c, ci) => {
        for (let r = 1; r < rows.length; r++) {
          const want = rows[r][ci] as unknown
          const got = c.values[r - 1]
          if (want && typeof want === 'object' && 'date' in want) {
            const ms = Date.parse(`${(want as { date: string }).date}Z`)
            expect(c.type === 'DATE' ? (got as number) * DAY : got, `${name}!${c.name}${r}`).toBe(ms)
          } else expect(got, `${name}!${c.name}${r}`).toEqual(want === '' ? null : want)
        }
      })
    }
    const types = Object.fromEntries(tableRows(wb, 'Notes', true).columns.map((c) => [c.name, c.type]))
    expect(types).toEqual({ label: 'VARCHAR', flag: 'BOOLEAN', count: 'BIGINT', share: 'DOUBLE', when: 'TIMESTAMP' })
    expect(tableRows(wb, 'Transactions', true).columns.find((c) => c.name === 'order_date')!.type).toBe('DATE')
  })

  // A BIFF8 stream from records: [type, bytes] pairs.
  const biff = (recs: [number, number[]][]) => new Uint8Array(recs.flatMap(([t, d]) => [t & 255, t >> 8, d.length & 255, d.length >> 8, ...d]))
  const u16 = (v: number) => [v & 255, (v >> 8) & 255]
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
  const f64 = (v: number) => [...new Uint8Array(new Float64Array([v]).buffer)]
  const str8 = (s: string) => [...u16(s.length), 0, ...[...s].map((c) => c.charCodeAt(0))]

  it('cached formula results (number, text, true/false, error), errors, and a 1904 date system', () => {
    const globals: [number, number[]][] = [[0x0809, [0, 6, 5, 0]], [0x0022, u16(1)], [0x00e0, [0, 0, ...u16(0), 0, 0]], [0x00e0, [0, 0, ...u16(14), 0, 0]]]
    // A hidden worksheet (hsState 1) named S.
    const sheetAt = (pos: number): [number, number[]] => [0x0085, [...u32(pos), 1, 0, 1, 0, ...'S'.split('').map((c) => c.charCodeAt(0))]]
    const sheet: [number, number[]][] = [
      [0x0809, [0, 6, 16, 0]],
      [0x0006, [...u16(0), ...u16(0), ...u16(0), ...f64(42), 0, 0, 0, 0, 0, 0]],
      [0x0006, [...u16(0), ...u16(1), ...u16(0), 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]],
      [0x0207, str8('done')],
      [0x0006, [...u16(0), ...u16(2), ...u16(0), 1, 0, 1, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]],
      [0x0006, [...u16(0), ...u16(3), ...u16(0), 2, 0, 0x07, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]],
      [0x0205, [...u16(0), ...u16(4), ...u16(0), 0x2a, 1]],
      [0x0203, [...u16(0), ...u16(5), ...u16(1), ...f64(0)]],
      [0x000a, []]
    ]
    const head = biff([...globals, sheetAt(0), [0x000a, []]])
    const stream = biff([...globals, sheetAt(head.length), [0x000a, []], ...sheet])
    const s = importBiff(stream).workbook.sheets[0]
    expect([s.name, s.hidden]).toEqual(['S', 'hidden'])
    expect([0, 1, 2, 3, 4].map((c) => s.get(0, c)?.v)).toEqual([42, 'done', true, CellError.of('#DIV/0!'), CellError.of('#N/A')])
    // 1904 system: serial 0 is 1904-01-01, which is 1462 in the 1900 system the model uses.
    expect(s.get(0, 5)?.v).toBe(1462)
  })

  it('refuses what it can’t read, with a reason', () => {
    expect(() => importXls(new Uint8Array(1024))).toThrow(/isn’t an Excel 97–2003/)
    expect(() => importBiff(new Uint8Array([0x2f, 0, 0, 0]))).toThrow(/no BOF|password/)
    expect(() => importBiff(biff([[0x0809, [0, 6, 5, 0]], [0x002f, [0, 0]]]))).toThrow(/password-protected/)
    expect(readCfb(new Uint8Array(readFileSync(fx('Sales.xls')))).has('Workbook')).toBe(true)
  })
})

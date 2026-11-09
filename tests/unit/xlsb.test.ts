// Excel binary workbooks (.xlsb) made by Excel (Apache POI's test files), against pyxlsb, an independent reader
// (scripts/xlsb-ref.py): every cell value of every sheet; dates typed by their number format.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { importXlsb, records } from '../../src/core/sheets/formats/xlsb'
import { tableRows, readWorkbook } from '../../src/core/sheets/rows'
import { CellError } from '../../src/core/sheets/engine/values'

const fx = (n: string) => path.resolve('tests/fixtures/xlsb', n)
const ref = JSON.parse(readFileSync(fx('expected.json'), 'utf8')) as Record<string, Record<string, [number, number, unknown][]>>

describe('Excel binary workbooks (.xlsb)', () => {
  for (const [file, sheets] of Object.entries(ref)) {
    it(`${file}: the same sheets and cell values as pyxlsb`, () => {
      const wb = importXlsb(new Uint8Array(readFileSync(fx(file)))).workbook
      expect(wb.sheets.map((s) => s.name)).toEqual(Object.keys(sheets))
      for (const [name, cells] of Object.entries(sheets)) {
        const sh = wb.sheets.find((s) => s.name === name)!
        for (const [r, c, v] of cells) {
          const got = sh.get(r, c)?.v
          if (typeof v === 'number') expect(got, `${file} ${name} R${r}C${c}`).toBeCloseTo(v, 9)
          else if (got instanceof CellError) expect(String(got), `${file} ${name} R${r}C${c}`).toMatch(/^#/)
          else expect(got, `${file} ${name} R${r}C${c}`).toEqual(v)
        }
      }
    })
  }

  it('dates are dates (by their number format)', () => {
    const t = tableRows(readWorkbook(new Uint8Array(readFileSync(fx('date.xlsb'))), 'xlsb'), 'Sheet1', false)
    expect(t.columns[0].type).toBe('DATE')
    expect(new Date(Number(t.columns[0].values[0]) * 86_400_000).toISOString().slice(0, 10)).toBe('2013-01-12')
  })

  it('reads record headers with multi-byte types and sizes', () => {
    // type 0x269 (two bytes: 0xE9 0x04), size 200 (two bytes: 0xC8 0x01)
    const b = new Uint8Array([0xe9, 0x04, 0xc8, 0x01, ...new Array(200).fill(7), 0x13, 0x01, 0x09])
    expect([...records(b)].map((r) => [r.type, r.data.length])).toEqual([[0x269, 200], [0x13, 1]])
  })

  it('refuses a file without a workbook part', () => {
    expect(() => importXlsb(new Uint8Array(readFileSync(path.resolve('tests/fixtures/Sales.xlsx'))))).toThrow(/not an Excel binary workbook/)
  })
})

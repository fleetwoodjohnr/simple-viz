import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readWorkbook, listTables, tableRows } from '@/core/sheets/rows'
import { rowsToXlsx } from '@/core/sheets/fromRows'
import { Workbook } from '@/core/sheets/model/workbook'
import { writeXlsx } from '@/core/sheets/formats/xlsx/write'
import { profileSql, readProfile, geoRole, numberFromText } from '@/core/profile'

const fixture = (n: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', n)))
const exp = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'expected.json'), 'utf8'))

describe('spreadsheet tables', () => {
  it('reads the Transactions sheet with types from every row', () => {
    const wb = readWorkbook(fixture('Sales.xlsx'), 'xlsx')
    expect(listTables(wb)).toEqual([{ ref: 'Transactions', kind: 'sheet', rows: 1000, columns: 7 }])
    const t = tableRows(wb, 'Transactions')
    expect(t.rowCount).toBe(1000)
    expect(t.columns.map((c) => c.type)).toEqual(['BIGINT', 'DATE', 'BIGINT', 'VARCHAR', 'BIGINT', 'DOUBLE', 'DOUBLE'])
    const revenue = t.columns[5].values.reduce((a, b) => (a as number) + (b as number), 0) as number
    expect(Math.abs(revenue - exp.v1.revenue)).toBeLessThan(0.01)
    // 2025-01-01 is day 20089 since 1970-01-01.
    expect(t.columns[1].values[0]).toBe(20089)
  })

  it('handles headers, blanks, mixed columns, errors, ranges and tables', () => {
    const wb = new Workbook()
    const s = wb.addSheet('Data')
    const rowsIn: (string | number | boolean | null)[][] = [
      ['Report title', null, null],
      [null, null, null],
      ['Name', 'Amount', 'Name'],
      ['a', 1, 'x'],
      ['b', 'n/a', 'y'],
      [null, null, null],
      ['c', 3.5, true]
    ]
    rowsIn.forEach((r, i) => r.forEach((v, j) => v !== null && s.set(i, j, { v })))
    const bytes = writeXlsx(wb).data
    const back = readWorkbook(bytes, 'xlsx')
    const t = tableRows(back, 'Data!A3:C7')
    expect(t.columns.map((c) => c.name)).toEqual(['Name', 'Amount', 'Name_2'])
    expect(t.rowCount).toBe(3) // the empty row is skipped
    expect(t.columns[1].type).toBe('VARCHAR') // 1, 'n/a', 3.5 → text
    expect(t.columns[1].values).toEqual(['1', 'n/a', '3.5'])
  })

  it('exports query results that read back the same', () => {
    const bytes = rowsToXlsx([{ name: 'd', type: 'DATE' }, { name: 'n', type: 'DOUBLE' }, { name: 's', type: 'VARCHAR' }], [['2025-03-01', 1.25, 'x'], [null, 2, null]])
    const t = tableRows(readWorkbook(bytes, 'xlsx'), undefined)
    expect(t.columns.map((c) => c.type)).toEqual(['DATE', 'DOUBLE', 'VARCHAR'])
    expect(t.columns[0].values[0]).toBe(Date.UTC(2025, 2, 1) / 86_400_000)
  })
})

describe('profiling', () => {
  it('recognizes geographic roles by name', () => {
    expect(['State', 'country_code', 'Latitude', 'lng', 'ZIP', 'city', 'amount'].map(geoRole)).toEqual(['state', 'country', 'latitude', 'longitude', 'postcode', 'city', null])
  })
  it('suggests numbers for currency text', () => {
    const cols = [{ name: 'price', type: 'VARCHAR' }, { name: 'n', type: 'BIGINT' }]
    expect(profileSql('t', cols)).toMatch(/approx_count_distinct\("price"\)/)
    const p = readProfile(cols, { n: 10, dup: 0, nn_0: 8, nd_0: 8, num_0: 8, cur_0: 8, date_0: 0, nn_1: 10, nd_1: 3, min_1: '1', max_1: '9' })
    expect(p.columns[0]).toMatchObject({ nulls: 2, suggest: { type: 'DOUBLE', why: 'Looks like currency' } })
    expect(p.columns[1]).toMatchObject({ nulls: 0, min: '1', max: '9' })
    expect(numberFromText('price')).toMatch(/regexp_replace/)
  })
})

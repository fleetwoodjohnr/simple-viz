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
    // The table under the title is found (an empty row inside it doesn't end it).
    expect(listTables(back).filter((x) => x.kind === 'detected').map((x) => x.ref)).toEqual(['Data!A3:C7'])
  })

  it('reads a header over two rows: the group above names its columns, merged or running to the next group', () => {
    const wb = new Workbook()
    const s = wb.addSheet('Years')
    const cells: (string | number | null)[][] = [
      ['Regional results', null, null, null, null, null],
      [null, null, null, null, null, null],
      [null, 2023, null, 2024, null, null],
      ['Region', 'Sales', 'Profit', 'Sales', 'Profit', 'Notes'],
      ['East', 10, 2, 12, 3, 'ok'],
      ['West', 7, 1, 9, 2, null]
    ]
    cells.forEach((r, i) => r.forEach((v, j) => v !== null && s.set(i, j, { v })))
    // Merged the way Excel does it: 2023 over B:C, 2024 over D:E, so “Notes” belongs to no group.
    s.merges.push({ sheet: s.id, r0: 2, c0: 1, r1: 2, c1: 2 }, { sheet: s.id, r0: 2, c0: 3, r1: 2, c1: 4 })
    const back = readWorkbook(writeXlsx(wb).data, 'xlsx')
    const found = listTables(back).filter((x) => x.kind === 'detected')
    expect(found.map((x) => [x.ref, x.rows])).toEqual([['Years!A3:F6', 2]])
    const t = tableRows(back, found[0].ref)
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([['Region', 'VARCHAR'], ['2023 Sales', 'BIGINT'], ['2023 Profit', 'BIGINT'], ['2024 Sales', 'BIGINT'], ['2024 Profit', 'BIGINT'], ['Notes', 'VARCHAR']])
    expect(t.columns[3].values).toEqual([12, 9])
    // Without merged cells a group runs to the next one.
    s.merges.length = 0
    expect(tableRows(wb, 'Years!A3:E6').columns.map((c) => c.name)).toEqual(['Region', '2023 Sales', '2023 Profit', '2024 Sales', '2024 Profit'])
    // A title right above the header, or a first data row of text, is not a group row.
    const plain = new Workbook()
    const ps = plain.addSheet('P')
    ;[['Report', null, null], ['Name', 'City', 'Age'], ['Ann', 'Paris', 30]].forEach((r, i) => r.forEach((v, j) => v !== null && ps.set(i, j, { v })))
    expect(tableRows(plain, 'P!A2:C3').columns.map((c) => c.name)).toEqual(['Name', 'City', 'Age'])
    expect(tableRows(plain, 'P').columns.map((c) => c.name)).toEqual(['Report', 'F2', 'F3'])
    const gap = new Workbook()
    const gs = gap.addSheet('G')
    ;[['Name', null, 'City'], ['Ann', 'x', 'Paris'], ['Bob', 'y', 'Rome']].forEach((r, i) => r.forEach((v, j) => v !== null && gs.set(i, j, { v })))
    expect(tableRows(gap, 'G').columns.map((c) => c.name)).toEqual(['Name', 'F2', 'City'])
  })

  it('finds the tables in a messy sheet: titles and notes left out, two tables apart, headers found', () => {
    const wb = new Workbook()
    const s = wb.addSheet('Report 2025')
    const rowsIn: (string | number | null)[][] = [
      ['Quarterly sales report', null, null, null],
      ['Prepared by Finance', null, null, null],
      [null, null, null, null],
      [null, 'Region', 'Q1', 'Q2'],
      [null, 'East', 10, 12],
      [null, 'West', 7, 9],
      ['Source: ledger', null, null, null],
      [null, null, null, null],
      [null, null, null, null],
      ['Product', 'Units', null, null],
      ['A', 5, null, null],
      ['B', 6, null, null]
    ]
    rowsIn.forEach((r, i) => r.forEach((v, j) => v !== null && s.set(i, j, { v })))
    const found = listTables(wb).filter((x) => x.kind === 'detected')
    expect(found.map((x) => [x.ref, x.rows, x.columns, x.sheet])).toEqual([["'Report 2025'!B4:D6", 2, 3, 'Report 2025'], ["'Report 2025'!A10:B12", 2, 2, 'Report 2025']])
    const t = tableRows(wb, found[0].ref)
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([['Region', 'VARCHAR'], ['Q1', 'BIGINT'], ['Q2', 'BIGINT']])
    // Two tables side by side (an empty column between), each with a title above.
    const side = new Workbook()
    const ss = side.addSheet('Side')
    const sideRows: (string | number | null)[][] = [
      ['Sales', null, null, null, 'Costs', null],
      ['Region', 'Q1', null, null, 'Item', 'Amount'],
      ['East', 10, null, null, 'Rent', 5],
      ['West', 7, null, null, 'Staff', 9],
      [null, null, null, null, 'Power', 2]
    ]
    sideRows.forEach((r, i) => r.forEach((v, j) => v !== null && ss.set(i, j, { v })))
    expect(listTables(side).filter((x) => x.kind === 'detected').map((x) => x.ref)).toEqual(['Side!A2:B4', 'Side!E2:F5'])
    // A tidy sheet offers nothing extra.
    const tidy = new Workbook()
    const ts = tidy.addSheet('T')
    ;[['a', 'b'], [1, 2], [3, 4]].forEach((r, i) => r.forEach((v, j) => ts.set(i, j, { v })))
    expect(listTables(tidy).map((x) => x.kind)).toEqual(['sheet'])
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

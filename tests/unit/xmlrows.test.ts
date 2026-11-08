// Ordinary XML files as tables: records, columns, types; no entity expansion.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { xmlRecords, xmlTables, isSpreadsheetXml } from '../../src/core/xmlrows'

describe('XML files', () => {
  it('finds the repeated element and reads attributes, children and nested leaves with their types', () => {
    const t = xmlRecords(readFileSync(path.resolve('tests/fixtures/orders.xml'), 'utf8'))
    expect(t.record).toBe('order')
    expect(t.rowCount).toBe(3)
    const col = (n: string) => t.columns.find((c) => c.name === n)!
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([['id', 'BIGINT'], ['placed', 'DATE'], ['customer', 'VARCHAR'], ['amount', 'DOUBLE'], ['paid', 'BOOLEAN'], ['ship_city', 'VARCHAR'], ['ship_zip', 'BIGINT']])
    expect(col('customer').values).toEqual(['Ann', 'Bo & Co', 'Côte'])
    expect(col('amount').values).toEqual([10.5, 7, null])
    expect(col('placed').values[0]).toBe(Date.UTC(2025, 0, 2) / 86_400_000)
    expect(col('ship_city').values).toEqual(['Austin', 'Dallas', null])
  })

  it('a chosen record element, text-only records, and the listing', () => {
    const xml = '<r><tag>a</tag><tag>b</tag><item k="1"/><item k="2"/><item k="3"/></r>'
    expect(xmlRecords(xml).record).toBe('item')
    expect(xmlRecords(xml, 'tag').columns).toEqual([{ name: 'value', type: 'VARCHAR', values: ['a', 'b'] }])
    expect(xmlTables(xml).map((x) => [x.ref, x.rows])).toEqual([['item', 3], ['tag', 2]])
    expect(() => xmlRecords('<r><only/></r>')).toThrow(/No repeated elements/)
    expect(() => xmlRecords(xml, 'nope')).toThrow(/no “nope” elements/)
  })

  it('entities are not expanded (a DOCTYPE is dropped before parsing)', () => {
    const lol = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY x SYSTEM "file:///etc/passwd">]><r><i>&b;</i><i>&x;</i></r>`
    const t = xmlRecords(lol)
    expect(JSON.stringify(t.columns[0].values)).not.toMatch(/aaaa|root:/)
  })

  it('tells Excel’s XML spreadsheets from other XML', () => {
    expect(isSpreadsheetXml('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">')).toBe(true)
    expect(isSpreadsheetXml('<shop/>')).toBe(false)
  })
})

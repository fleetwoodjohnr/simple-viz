// The OpenDocument and Excel XML 2003 readers (Simple Cell's), through the same table extraction sources use.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readWorkbook, tableRows, listTables } from '@/core/sheets/rows'

describe('spreadsheet formats', () => {
  it('OpenDocument (.ods, written by LibreOffice): sheets, a named range, typed columns, cached formula results', () => {
    const wb = readWorkbook(new Uint8Array(readFileSync(path.resolve('tests/fixtures/features.ods'))), 'ods')
    expect(listTables(wb).map((t) => [t.ref, t.kind])).toEqual([['Data', 'sheet'], ['Summary', 'sheet'], ['Prices', 'name']])
    const t = tableRows(wb, 'Data', true)
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([['Item', 'VARCHAR'], ['Qty', 'BIGINT'], ['Price', 'DOUBLE'], ['Total', 'DOUBLE'], ['Date', 'VARCHAR']])
    expect(t.columns[0].values).toEqual(['Widget', 'Gadget', 'Gizmo & Co "quoted"', 'Merged note'])
    expect(t.columns[3].values.slice(0, 3)).toEqual([5002, 199.9, 1.5])
  })

  it('Excel XML 2003 (SpreadsheetML): numbers, text, dates and booleans', () => {
    const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="d"><NumberFormat ss:Format="Short Date"/></Style></Styles>
<Worksheet ss:Name="Orders"><Table>
<Row><Cell><Data ss:Type="String">id</Data></Cell><Cell><Data ss:Type="String">when</Data></Cell><Cell><Data ss:Type="String">paid</Data></Cell><Cell><Data ss:Type="String">who</Data></Cell></Row>
<Row><Cell><Data ss:Type="Number">1</Data></Cell><Cell ss:StyleID="d"><Data ss:Type="DateTime">2025-03-01T00:00:00.000</Data></Cell><Cell><Data ss:Type="Boolean">1</Data></Cell><Cell><Data ss:Type="String">Ann</Data></Cell></Row>
<Row><Cell><Data ss:Type="Number">2</Data></Cell><Cell ss:StyleID="d"><Data ss:Type="DateTime">2025-03-02T00:00:00.000</Data></Cell><Cell><Data ss:Type="Boolean">0</Data></Cell><Cell><Data ss:Type="String">Bo &amp; Co</Data></Cell></Row>
</Table></Worksheet></Workbook>`
    const t = tableRows(readWorkbook(new TextEncoder().encode(xml), 'xml2003'), 'Orders', true)
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([['id', 'BIGINT'], ['when', 'DATE'], ['paid', 'BOOLEAN'], ['who', 'VARCHAR']])
    expect(t.columns[1].values).toEqual([Date.UTC(2025, 2, 1) / 86_400_000, Date.UTC(2025, 2, 2) / 86_400_000])
    expect(t.columns[3].values).toEqual(['Ann', 'Bo & Co'])
  })
})

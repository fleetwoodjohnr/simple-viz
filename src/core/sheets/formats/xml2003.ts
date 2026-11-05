// XML Spreadsheet 2003 (SpreadsheetML 2003, "Excel 2003 XML"): the XML interchange format older Excel versions
// and many reporting tools write. Formulas in this format use R1C1 references.
import { Workbook } from '../model/workbook'
import type { Style } from '../model/styles'
import { parseFormula, printFormula } from '../engine/parser'
import { CellError, ERROR_CODES } from '../engine/values'
import { colName } from '../refs'
import { parseDateTime } from '../numfmt/dates'
import { attr, kid, kids, parseXml, textOf } from './xml'
import { esc } from './opc'
import { Warnings, type ExportResult, type ImportResult } from './types'
import { decodeText } from './csv'
import { isDateFormat } from '../numfmt/format'
import { serialToDate, timeParts } from '../numfmt/dates'

const SS = 'urn:schemas-microsoft-com:office:spreadsheet'

/** R1C1 references in a formula → A1, relative to (row, col). Text in quotes is left alone. */
export function r1c1Formula(f: string, row: number, col: number): string {
  return f.replace(/"(?:[^"]|"")*"|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?\bR(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![\w(])/g, (m, sheet: string | undefined, r: string | undefined, c: string | undefined) => {
    if (m.startsWith('"')) return m
    const rr = r === undefined ? row : r.startsWith('[') ? row + Number(r.slice(1, -1)) : Number(r) - 1
    const cc = c === undefined ? col : c.startsWith('[') ? col + Number(c.slice(1, -1)) : Number(c) - 1
    if (rr < 0 || cc < 0) return '#REF!'
    return `${sheet ?? ''}${c && !c.startsWith('[') ? '$' : ''}${colName(cc)}${r && !r.startsWith('[') ? '$' : ''}${rr + 1}`
  })
}

export function importXml2003(bytes: Uint8Array): ImportResult {
  const w = new Warnings()
  const doc = parseXml(decodeText(bytes))
  const root = doc.documentElement
  if (root.localName !== 'Workbook') throw new Error('This XML file is not an XML Spreadsheet 2003 workbook.')
  const wb = new Workbook()
  const styles = new Map<string, number>()
  for (const st of kids(kid(root, 'Styles'), 'Style')) {
    const s: Style = {}
    const font = kid(st, 'Font')
    if (attr(font, 'Bold') === '1') s.bold = true
    if (attr(font, 'Italic') === '1') s.italic = true
    if (attr(font, 'Underline') && attr(font, 'Underline') !== 'None') s.underline = 'single'
    if (attr(font, 'StrikeThrough') === '1') s.strike = true
    const color = attr(font, 'Color')
    if (color && color !== '#000000') s.color = color
    if (attr(font, 'Size')) s.size = Number(attr(font, 'Size'))
    if (attr(font, 'FontName')) s.font = attr(font, 'FontName')!
    const interior = kid(st, 'Interior')
    if (attr(interior, 'Color') && attr(interior, 'Pattern') !== 'None') s.fill = attr(interior, 'Color')!
    const al = kid(st, 'Alignment')
    const h = attr(al, 'Horizontal')
    if (h === 'Center') s.hAlign = 'center'
    if (h === 'Right') s.hAlign = 'right'
    if (h === 'Left') s.hAlign = 'left'
    if (attr(al, 'WrapText') === '1') s.wrap = true
    const v = attr(al, 'Vertical')
    if (v === 'Top') s.vAlign = 'top'
    if (v === 'Center') s.vAlign = 'center'
    const nf = attr(kid(st, 'NumberFormat'), 'Format')
    if (nf) s.numFmt = { 'Short Date': 'm/d/yyyy', 'General Date': 'm/d/yyyy h:mm', Percent: '0.00%', Fixed: '0.00', Standard: '#,##0.00', Currency: '"$"#,##0.00_);\\("$"#,##0.00\\)', Scientific: '0.00E+00', 'Long Date': 'dddd, mmmm d, yyyy', 'Short Time': 'h:mm', 'Long Time': 'h:mm:ss AM/PM' }[nf] ?? nf
    for (const b of kids(kid(st, 'Borders'), 'Border')) {
      const pos = attr(b, 'Position')
      const side = { style: (attr(b, 'Weight') === '2' ? 'medium' : attr(b, 'Weight') === '3' ? 'thick' : 'thin') as 'thin', color: attr(b, 'Color') ?? undefined }
      if (pos === 'Top') s.borderTop = side
      if (pos === 'Bottom') s.borderBottom = side
      if (pos === 'Left') s.borderLeft = side
      if (pos === 'Right') s.borderRight = side
    }
    styles.set(attr(st, 'ID') ?? '', wb.styles.intern(s))
  }
  const worksheets = kids(root, 'Worksheet')
  for (const ws of worksheets) wb.addSheet(attr(ws, 'Name') ?? `Sheet${wb.sheets.length + 1}`)
  const sheetId = (n: string) => wb.sheetByName(n)?.id ?? null
  worksheets.forEach((ws, i) => {
    const sh = wb.sheets[i]
    const table = kid(ws, 'Table')
    let c = -1
    for (const col of kids(table, 'Column')) {
      const idx = attr(col, 'Index')
      c = idx ? Number(idx) - 1 : c + 1
      const span = Number(attr(col, 'Span') ?? 0)
      const width = attr(col, 'Width')
      for (let k = 0; k <= span; k++) if (width) sh.cols.set(c + k, { width: Math.round((Number(width) * 96) / 72), ...(attr(col, 'Hidden') === '1' ? { hidden: true } : {}) })
      c += span
    }
    let r = -1
    for (const row of kids(table, 'Row')) {
      const ri = attr(row, 'Index')
      r = ri ? Number(ri) - 1 : r + 1
      if (attr(row, 'Height') && attr(row, 'AutoFitHeight') !== '1') sh.rowInfo.set(r, { height: Math.round((Number(attr(row, 'Height')) * 96) / 72), custom: true })
      if (attr(row, 'Hidden') === '1') sh.rowInfo.set(r, { ...(sh.rowInfo.get(r) ?? {}), hidden: true })
      let cc = -1
      for (const cell of kids(row, 'Cell')) {
        const ci = attr(cell, 'Index')
        cc = ci ? Number(ci) - 1 : cc + 1
        const data = kid(cell, 'Data')
        const type = attr(data, 'Type')
        const raw = textOf(data)
        const s = styles.get(attr(cell, 'StyleID') ?? '')
        let v: unknown = null
        if (type === 'Number') v = Number(raw)
        else if (type === 'Boolean') v = raw === '1'
        else if (type === 'DateTime') v = parseDateTime(raw.replace('T', ' ').replace(/\.\d+$/, '')) ?? raw
        else if (type === 'Error') v = (ERROR_CODES as readonly string[]).includes(raw) ? CellError.of(raw as never) : CellError.of('#VALUE!')
        else if (data) v = raw
        const cellObj: { v: unknown; s?: number; f?: { ast: ReturnType<typeof parseFormula> } } = { v }
        if (s) cellObj.s = s
        const f = attr(cell, 'Formula')
        if (f) {
          try {
            cellObj.f = { ast: parseFormula(r1c1Formula(f, r, cc), { row: r, col: cc, sheetId }) }
          } catch {
            w.add('loss', 'Some formulas could not be read and are kept as values.')
          }
        }
        const across = Number(attr(cell, 'MergeAcross') ?? 0)
        const down = Number(attr(cell, 'MergeDown') ?? 0)
        if (across || down) sh.merges.push({ sheet: sh.id, r0: r, c0: cc, r1: r + down, c1: cc + across })
        if (cellObj.v !== null || cellObj.f || cellObj.s) sh.set(r, cc, cellObj as never)
        cc += across
      }
    }
    const opts = kid(ws, 'WorksheetOptions')
    if (kid(opts, 'FreezePanes')) sh.freeze = { rows: Number(textOf(kid(opts, 'SplitHorizontal')) || 0), cols: Number(textOf(kid(opts, 'SplitVertical')) || 0) }
    if (kid(opts, 'DoNotDisplayGridlines')) sh.showGridlines = false
  })
  for (const n of kids(kid(root, 'Names'), 'NamedRange')) {
    const name = attr(n, 'Name')
    const ref = attr(n, 'RefersTo')
    if (!name || !ref || /^_xlnm\./i.test(name)) continue
    try {
      wb.names.push({ name, scope: null, text: r1c1Formula(ref, 0, 0).slice(1), ast: parseFormula(r1c1Formula(ref, 0, 0), { row: 0, col: 0, sheetId }) })
    } catch {
      w.add('loss', `The name “${name}” could not be read.`)
    }
  }
  return { workbook: wb, warnings: w.list }
}

export function exportXml2003(wb: Workbook): ExportResult {
  const w = new Warnings()
  const sheetName = (id: number) => wb.sheetById(id)?.name ?? null
  const styleXml: string[] = ['<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/></Style>']
  const ids = new Map<number, string>()
  const sid = (id: number | undefined) => {
    if (!id) return ''
    let n = ids.get(id)
    if (!n) {
      n = `s${ids.size + 1}`
      ids.set(id, n)
      const s = wb.styles.get(id)
      const font = [s.bold && 'ss:Bold="1"', s.italic && 'ss:Italic="1"', s.underline && 'ss:Underline="Single"', s.strike && 'ss:StrikeThrough="1"', s.color && `ss:Color="${s.color}"`, s.size && `ss:Size="${s.size}"`, s.font && `ss:FontName="${esc(s.font)}"`].filter(Boolean).join(' ')
      const al = [s.hAlign && s.hAlign !== 'general' && `ss:Horizontal="${s.hAlign[0].toUpperCase() + s.hAlign.slice(1)}"`, s.vAlign && `ss:Vertical="${s.vAlign === 'center' ? 'Center' : s.vAlign === 'top' ? 'Top' : 'Bottom'}"`, s.wrap && 'ss:WrapText="1"'].filter(Boolean).join(' ')
      const borders = (['Top', 'Bottom', 'Left', 'Right'] as const)
        .map((p) => {
          const b = s[`border${p}` as 'borderTop']
          return b ? `<Border ss:Position="${p}" ss:LineStyle="${b.style === 'double' ? 'Double' : /dash/.test(b.style) ? 'Dash' : /dot/.test(b.style) ? 'Dot' : 'Continuous'}" ss:Weight="${b.style === 'thick' ? 3 : b.style === 'medium' ? 2 : 1}"${b.color ? ` ss:Color="${b.color}"` : ''}/>` : ''
        })
        .join('')
      styleXml.push(`<Style ss:ID="${n}">${al ? `<Alignment ${al}/>` : ''}${borders ? `<Borders>${borders}</Borders>` : ''}${font ? `<Font ${font}/>` : ''}${s.fill ? `<Interior ss:Color="${s.fill}" ss:Pattern="Solid"/>` : ''}${s.numFmt ? `<NumberFormat ss:Format="${esc(s.numFmt)}"/>` : ''}</Style>`)
    }
    return n
  }
  const sheets = wb.sheets.map((sh) => {
    const u = sh.used()
    const cols = [...sh.cols.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([c, i]) => `<Column ss:Index="${c + 1}"${i.width !== undefined ? ` ss:Width="${((i.width * 72) / 96).toFixed(2)}"` : ''}${i.hidden ? ' ss:Hidden="1"' : ''}/>`)
      .join('')
    const mergeAt = new Map(sh.merges.map((m) => [`${m.r0},${m.c0}`, m]))
    const covered = new Set<string>()
    for (const m of sh.merges) for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(`${r},${c}`)
    const rows: string[] = []
    for (let r = 0; r <= u.r; r++) {
      const row = sh.rows.get(r)
      const ri = sh.rowInfo.get(r)
      if (!row && !ri) continue
      const cells: string[] = []
      let prev = -1
      for (const c of [...(row?.keys() ?? [])].sort((a, b) => a - b)) {
        if (covered.has(`${r},${c}`)) continue
        const cell = row!.get(c)!
        if (cell.spillOf !== undefined && !cell.f && cell.v === null) continue
        const a: string[] = []
        if (c !== prev + 1) a.push(`ss:Index="${c + 1}"`)
        const st = sid(cell.s)
        if (st) a.push(`ss:StyleID="${st}"`)
        if (cell.f) a.push(`ss:Formula="=${esc(printFormula(cell.f.ast, { row: r, col: c, sheetName, r1c1: true }))}"`)
        const m = mergeAt.get(`${r},${c}`)
        if (m) a.push(...(m.c1 > m.c0 ? [`ss:MergeAcross="${m.c1 - m.c0}"`] : []), ...(m.r1 > m.r0 ? [`ss:MergeDown="${m.r1 - m.r0}"`] : []))
        const v = cell.v
        const fmt = wb.styles.get(cell.s).numFmt
        let data = ''
        if (typeof v === 'number' && fmt && isDateFormat(fmt)) {
          const d = serialToDate(v, wb.date1904)
          const t = timeParts(v)
          data = `<Data ss:Type="DateTime">${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}T${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}:${String(t.s).padStart(2, '0')}.000</Data>`
        } else if (typeof v === 'number') data = `<Data ss:Type="Number">${v}</Data>`
        else if (typeof v === 'boolean') data = `<Data ss:Type="Boolean">${v ? 1 : 0}</Data>`
        else if (v instanceof CellError) data = `<Data ss:Type="Error">${esc(v.code)}</Data>`
        else if (typeof v === 'string') data = `<Data ss:Type="String">${esc(v).replace(/\n/g, '&#10;')}</Data>`
        cells.push(`<Cell${a.length ? ' ' + a.join(' ') : ''}>${data}</Cell>`)
        prev = c + (m ? m.c1 - m.c0 : 0)
      }
      rows.push(`<Row ss:Index="${r + 1}"${ri?.height !== undefined ? ` ss:AutoFitHeight="0" ss:Height="${((ri.height * 72) / 96).toFixed(2)}"` : ''}${ri?.hidden ? ' ss:Hidden="1"' : ''}>${cells.join('')}</Row>`)
    }
    const opts = `<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">${sh.freeze.rows || sh.freeze.cols ? `<FreezePanes/><FrozenNoSplit/>${sh.freeze.rows ? `<SplitHorizontal>${sh.freeze.rows}</SplitHorizontal><TopRowBottomPane>${sh.freeze.rows}</TopRowBottomPane>` : ''}${sh.freeze.cols ? `<SplitVertical>${sh.freeze.cols}</SplitVertical><LeftColumnRightPane>${sh.freeze.cols}</LeftColumnRightPane>` : ''}` : ''}${sh.showGridlines ? '' : '<DoNotDisplayGridlines/>'}</WorksheetOptions>`
    return `<Worksheet ss:Name="${esc(sh.name)}"${sh.hidden ? ' ss:Visible="SheetHidden"' : ''}><Table>${cols}${rows.join('')}</Table>${opts}</Worksheet>`
  })
  const names = wb.names.filter((n) => n.ast && n.scope === null).map((n) => `<NamedRange ss:Name="${esc(n.name)}" ss:RefersTo="=${esc(printFormula(n.ast!, { row: 0, col: 0, sheetName, r1c1: true }))}"/>`)
  const xml = `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="${SS}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="${SS}" xmlns:html="http://www.w3.org/TR/REC-html40"><Styles>${styleXml.join('')}</Styles>${names.length ? `<Names>${names.join('')}</Names>` : ''}${sheets.join('')}</Workbook>\n`
  if (wb.carry) w.add('loss', 'XML Spreadsheet 2003 can’t hold charts, pictures, conditional formatting, tables or other newer features; they are left out.')
  return { data: new TextEncoder().encode(xml), warnings: w.list }
}

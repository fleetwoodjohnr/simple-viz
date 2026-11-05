// AutoFilter in SpreadsheetML: <autoFilter> in worksheets and tables.
import type { AutoFilter, FilterColumn, FilterOp } from '../../filter'
import { areaName, parseArea } from '../../refs'
import { esc } from '../opc'
import { attr, boolAttr, elements, kid, kids, numAttr, parseXml, serialize, type El } from '../xml'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

/** The criteria inside an <autoFilter> element (its range comes from the caller for tables). */
export function readFilterColumns(root: El): { columns: FilterColumn[]; carry?: string } {
  const columns: FilterColumn[] = []
  for (const fc of kids(root, 'filterColumn')) {
    const col = numAttr(fc, 'colId') ?? 0
    const f: FilterColumn = { col }
    const inner = elements(fc)
    const filters = kid(fc, 'filters')
    const custom = kid(fc, 'customFilters')
    const top = kid(fc, 'top10')
    const plain = inner.length === 1 && !fc.hasAttribute('hiddenButton') && !fc.hasAttribute('showButton')
    if (plain && filters && kids(filters, 'filter').length === elements(filters).length) {
      f.values = kids(filters, 'filter').map((x) => attr(x, 'val') ?? '')
      if (boolAttr(filters, 'blank')) f.blanks = true
    } else if (plain && custom) {
      f.custom = { conds: kids(custom, 'customFilter').map((x) => ({ op: (attr(x, 'operator') ?? 'equal') as FilterOp, val: attr(x, 'val') ?? '' })) }
      if (boolAttr(custom, 'and')) f.custom.and = true
    } else if (plain && top) f.top10 = { top: attr(top, 'top') !== '0', percent: boolAttr(top, 'percent'), val: numAttr(top, 'val') ?? 10 }
    else f.raw = serialize(fc).replace(/ xmlns="[^"]*"/, '')
    columns.push(f)
  }
  const rest = elements(root).filter((e) => e.localName !== 'filterColumn')
  return { columns, carry: rest.length ? rest.map((e) => serialize(e).replace(/ xmlns="[^"]*"/, '')).join('') : undefined }
}

export function readAutoFilter(xml: string, sheet: number): AutoFilter | null {
  try {
    const root = parseXml(`<w ${NS}>${xml}</w>`).documentElement.firstChild as El
    const area = parseArea(attr(root, 'ref') ?? '', sheet)
    if (!area) return null
    return { area, ...readFilterColumns(root) }
  } catch {
    return null
  }
}

export function filterColumnsXml(columns: FilterColumn[]): string {
  return columns
    .map((f) => {
      if (f.raw) return f.raw
      let inner = ''
      if (f.values) inner = `<filters${f.blanks ? ' blank="1"' : ''}>${f.values.map((v) => `<filter val="${esc(v)}"/>`).join('')}</filters>`
      else if (f.custom) inner = `<customFilters${f.custom.and ? ' and="1"' : ''}>${f.custom.conds.map((c) => `<customFilter${c.op !== 'equal' ? ` operator="${c.op}"` : ''} val="${esc(c.val)}"/>`).join('')}</customFilters>`
      else if (f.top10) inner = `<top10${f.top10.top ? '' : ' top="0"'}${f.top10.percent ? ' percent="1"' : ''} val="${f.top10.val}"/>`
      else if (f.blanks !== undefined) inner = `<filters blank="${f.blanks ? 1 : 0}"/>`
      return `<filterColumn colId="${f.col}">${inner}</filterColumn>`
    })
    .join('')
}

export function autoFilterXml(af: AutoFilter): string {
  const inner = filterColumnsXml(af.columns) + (af.carry ?? '')
  return `<autoFilter ref="${areaName(af.area)}"${inner ? `>${inner}</autoFilter>` : '/>'}`
}

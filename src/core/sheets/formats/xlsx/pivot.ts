// PivotTables in SpreadsheetML: pivotTableDefinition and pivotCacheDefinition parts.
import type { Agg, PivotConfig, PivotTable, PivotValue } from '../../pivot'
import { emptyPivot, newPivotId } from '../../pivot'
import type { Scalar } from '../../engine/values'
import { CellError } from '../../engine/values'
import { areaName, parseArea, quoteSheet } from '../../refs'
import { esc } from '../opc'
import { attr, elements, kid, kids, numAttr, parseXml, type El } from '../xml'

export const REL_PIVOT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable'
export const REL_PIVOT_CACHE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition'
export const REL_PIVOT_RECORDS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords'
export const CT_PIVOT_TABLE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml'
export const CT_PIVOT_CACHE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml'

const XL_AGG: Record<Agg, string> = { sum: 'sum', count: 'count', average: 'average', max: 'max', min: 'min', product: 'product', countNums: 'countNums', stdDev: 'stdDev', stdDevP: 'stdDevp', var: 'var', varP: 'varp' }
const SHOW: Record<string, PivotValue['showAs']> = { percentOfTotal: 'percentOfTotal', percentOfRow: 'percentOfRow', percentOfCol: 'percentOfCol' }

/** What a PivotTable's parts are generated from: unchanged ones are written back as they were. */
export const pivotSig = (p: PivotTable) => JSON.stringify([p.name, p.source, p.config])

/** A pivotTableDefinition (and its cache definition) → model, or null when it can't be understood. */
export function readPivot(tableXml: string, cacheXml: string, sheetName: string, parts: Record<string, string>): PivotTable | null {
  const t = parseXml(tableXml).documentElement
  const cache = parseXml(cacheXml).documentElement
  const ws = kid(kid(cache, 'cacheSource'), 'worksheetSource')
  if (!ws) return null
  const fields = kids(kid(cache, 'cacheFields'), 'cacheField').map((f) => attr(f, 'name') ?? '')
  const ref = attr(ws, 'ref')
  const srcSheet = attr(ws, 'sheet') ?? sheetName
  const source = attr(ws, 'name') ?? (ref ? `${quoteSheet(srcSheet)}!${ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}` : null)
  const loc = parseArea(attr(kid(t, 'location'), 'ref') ?? '', 0)
  if (!source || !loc || !fields.length) return null
  const name = (x: El) => fields[Number(attr(x, 'x'))]
  const config: PivotConfig = emptyPivot()
  config.rows = kids(kid(t, 'rowFields'), 'field').filter((f) => Number(attr(f, 'x')) >= 0).map(name)
  config.cols = kids(kid(t, 'colFields'), 'field').filter((f) => Number(attr(f, 'x')) >= 0).map(name)
  const pfs = kids(kid(t, 'pivotFields'), 'pivotField')
  const cacheFields = kids(kid(cache, 'cacheFields'), 'cacheField')
  const sharedText = (fi: number) => elements(kid(cacheFields[fi] ?? null, 'sharedItems')).map((e) => (e.localName === 'm' ? '(blank)' : (attr(e, 'v') ?? '')))
  for (const pf of kids(kid(t, 'pageFields'), 'pageField')) {
    const fi = Number(attr(pf, 'fld'))
    config.filters.push(fields[fi])
    const item = numAttr(pf, 'item')
    if (item !== null) {
      const x = Number(attr(kids(kid(pfs[fi], 'items'), 'item')[item], 'x'))
      const text = sharedText(fi)[x]
      if (text !== undefined) config.include = { ...config.include, [fields[fi]]: [text] }
    }
  }
  config.values = kids(kid(t, 'dataFields'), 'dataField').map((d) => {
    const agg = (Object.entries(XL_AGG).find(([, v]) => v === (attr(d, 'subtotal') ?? 'sum'))?.[0] ?? 'sum') as Agg
    const v: PivotValue = { field: fields[Number(attr(d, 'fld'))], agg }
    const show = SHOW[attr(d, 'showDataAs') ?? '']
    if (show) v.showAs = show
    const nm = attr(d, 'name')
    if (nm && nm !== `${agg === 'sum' ? 'Sum' : ''} of ${v.field}`) v.name = nm
    return v
  })
  // Default names ("Sum of Sales") aren't kept as custom names.
  for (const v of config.values) if (v.name && /^(Sum|Count|Average|Max|Min|Product|Count Numbers|StdDev|StdDevp|Var|Varp) of /.test(v.name)) delete v.name
  if (attr(t, 'rowGrandTotals') === '0') config.grandRows = false
  if (attr(t, 'colGrandTotals') === '0') config.grandCols = false
  const top = loc.r0 - (config.filters.length ? config.filters.length + 1 : 0)
  const p: PivotTable = { id: newPivotId(), name: attr(t, 'name') ?? 'PivotTable', source, at: { r: Math.max(0, top), c: loc.c0 }, config, area: { r0: Math.max(0, top), c0: loc.c0, r1: loc.r1, c1: loc.c1 }, carry: parts }
  p.carry = { ...parts, sig: pivotSig(p), cacheId: attr(t, 'cacheId') ?? '' }
  return p
}

const itemXml = (v: Scalar) => (v === null || v === '' ? '<m/>' : typeof v === 'number' ? `<n v="${v}"/>` : typeof v === 'boolean' ? `<b v="${v ? 1 : 0}"/>` : v instanceof CellError ? `<e v="${esc(v.code)}"/>` : `<s v="${esc(v)}"/>`)
const key = (v: Scalar) => (v === null || v === '' ? '\u0000blank' : typeof v === 'string' ? 's' + v : 'n' + String(v instanceof CellError ? v.code : v))

/** The cache and table definitions for a PivotTable. `src` is its source data; `loc` the area of its body. */
export function pivotXml(p: PivotTable, src: { header: string[]; records: Scalar[][]; sheet: string; ref: string }, cacheId: number, loc: { r0: number; c0: number; r1: number; c1: number }): { cache: string; table: string } {
  const cfg = p.config
  const axis = new Set([...cfg.rows, ...cfg.cols, ...cfg.filters])
  const shared: Scalar[][] = src.header.map((f, i) => {
    if (!axis.has(f)) return []
    const seen = new Map<string, Scalar>()
    for (const r of src.records) if (!seen.has(key(r[i] ?? null))) seen.set(key(r[i] ?? null), r[i] ?? null)
    return [...seen.values()]
  })
  const cacheFields = src.header
    .map((f, i) => {
      const col = src.records.map((r) => r[i] ?? null)
      const nums = col.filter((v): v is number => typeof v === 'number')
      const hasText = col.some((v) => typeof v === 'string' && v !== '')
      const hasBlank = col.some((v) => v === null || v === '')
      const flags = [!hasText && 'containsSemiMixedTypes="0" containsString="0"', nums.length && 'containsNumber="1"', nums.length && nums.every(Number.isInteger) && 'containsInteger="1"', nums.length && `minValue="${Math.min(...nums)}" maxValue="${Math.max(...nums)}"`, hasBlank && 'containsBlank="1"'].filter(Boolean).join(' ')
      const items = shared[i].length ? `<sharedItems${flags ? ' ' + flags : ''} count="${shared[i].length}">${shared[i].map(itemXml).join('')}</sharedItems>` : `<sharedItems${flags ? ' ' + flags : ''}/>`
      return `<cacheField name="${esc(f)}" numFmtId="0">${items}</cacheField>`
    })
    .join('')
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  const cache = `${head}<pivotCacheDefinition ${NS} refreshOnLoad="1" saveData="0" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="${src.records.length}"><cacheSource type="worksheet"><worksheetSource ref="${src.ref}" sheet="${esc(src.sheet)}"/></cacheSource><cacheFields count="${src.header.length}">${cacheFields}</cacheFields></pivotCacheDefinition>`
  const idx = (f: string) => src.header.indexOf(f)
  const pivotFields = src.header
    .map((f, i) => {
      const ax = cfg.rows.includes(f) ? ' axis="axisRow"' : cfg.cols.includes(f) ? ' axis="axisCol"' : cfg.filters.includes(f) ? ' axis="axisPage"' : ''
      const data = cfg.values.some((v) => v.field === f) ? ' dataField="1"' : ''
      if (!ax) return `<pivotField${data} showAll="0"/>`
      const its = shared[i].map((_, k) => `<item x="${k}"/>`).join('') + '<item t="default"/>'
      return `<pivotField${ax}${data} showAll="0"><items count="${shared[i].length + 1}">${its}</items></pivotField>`
    })
    .join('')
  const fieldList = (tag: string, list: string[], withValues = false) => {
    const xs = list.map((f) => `<field x="${idx(f)}"/>`)
    if (withValues) xs.push('<field x="-2"/>')
    return xs.length ? `<${tag} count="${xs.length}">${xs.join('')}</${tag}>` : ''
  }
  const page = cfg.filters.length
    ? `<pageFields count="${cfg.filters.length}">${cfg.filters
        .map((f) => {
          const inc = cfg.include?.[f]
          const k = inc?.length === 1 ? shared[idx(f)].findIndex((v) => (v === null || v === '' ? '(blank)' : String(v)) === inc[0]) : -1
          return `<pageField fld="${idx(f)}"${k >= 0 ? ` item="${k}"` : ''} hier="-1"/>`
        })
        .join('')}</pageFields>`
    : ''
  const data = cfg.values.length
    ? `<dataFields count="${cfg.values.length}">${cfg.values
        .map((v) => `<dataField name="${esc(v.name ?? `${{ sum: 'Sum', count: 'Count', average: 'Average', max: 'Max', min: 'Min', product: 'Product', countNums: 'Count Numbers', stdDev: 'StdDev', stdDevP: 'StdDevp', var: 'Var', varP: 'Varp' }[v.agg]} of ${v.field}`)}" fld="${idx(v.field)}"${v.agg !== 'sum' ? ` subtotal="${XL_AGG[v.agg]}"` : ''}${v.showAs && v.showAs !== 'normal' ? ` showDataAs="${v.showAs}"` : ''} baseField="0" baseItem="0"/>`)
        .join('')}</dataFields>`
    : ''
  const firstDataCol = Math.max(1, cfg.rows.length)
  const firstDataRow = cfg.cols.length || cfg.values.length > 1 ? 2 : 1
  const table =
    `${head}<pivotTableDefinition ${NS} name="${esc(p.name)}" cacheId="${cacheId}" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0" outline="1" outlineData="1" multipleFieldFilters="0"${cfg.grandRows === false ? ' rowGrandTotals="0"' : ''}${cfg.grandCols === false ? ' colGrandTotals="0"' : ''}>` +
    `<location ref="${areaName(loc)}" firstHeaderRow="1" firstDataRow="${firstDataRow}" firstDataCol="${firstDataCol}"${cfg.filters.length ? ` rowPageCount="${cfg.filters.length}" colPageCount="1"` : ''}/>` +
    `<pivotFields count="${src.header.length}">${pivotFields}</pivotFields>` +
    fieldList('rowFields', cfg.rows) +
    fieldList('colFields', cfg.cols, cfg.values.length > 1) +
    page +
    data +
    `<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>`
  return { cache, table }
}

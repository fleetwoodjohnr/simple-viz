// XLSX / XLSM / XLTX reader. Everything Simple Cell understands goes into the model; everything else is kept
// byte-for-byte (parts, relationships, worksheet elements, style records) and written back on save.

import { Sheet, Workbook, type Cell, type Table } from '../../model/workbook'
import type { BorderSide, Style } from '../../model/styles'
import { parseFormula, type Node } from '../../engine/parser'
import { CellError, ERROR_CODES, MAX_COLS, MAX_ROWS, type Scalar } from '../../engine/values'
import { parseArea, parseCell } from '../../refs'
import { BUILTIN_FORMATS } from '../../numfmt/format'
import { readZip, text } from '../zip'
import { contentTypes, parseRels, REL, resolveTarget, type Rel } from '../opc'
import { attr, boolAttr, deep, kid, kids, numAttr, parseXml, tagAttrs, textOf, topLevel, xmlText, type El } from '../xml'
import { readCondFormat, readDxf } from './condfmt'
import { readValidations } from './validation'
import { readAutoFilter, readFilterColumns } from './filter'
import { notesSig, readComments, readHyperlinks } from './notes'
import { PAGE_ELEMENTS, readPageSetup } from './pagesetup'
import { drawingAnchors, readAnchors, readChart } from './charts'
import { readSparklines } from '../../sparklines'
import { REL_PIVOT_CACHE, REL_PIVOT_TABLE, readPivot } from './pivot'
import { readMacros } from '../macros'
import { readDataTable, readScenarios } from './whatif'
import { Warnings, type ImportResult } from '../types'

export interface XlsxCarry {
  files: Record<string, Uint8Array>
  workbookPath: string
  /** Raw workbook.xml elements we don't regenerate, in order (fileVersion, workbookPr, bookViews, pivotCaches…). */
  workbookElements: { name: string; xml: string }[]
  workbookRels: Rel[]
  overrides: Record<string, string>
  defaults: Record<string, string>
  macro: boolean
  template: boolean
  styles: { dxfs?: string; cellStyleXfs?: string; cellStyles?: string; tableStyles?: string; colors?: string; extLst?: string; fonts: string[]; fills: string[]; borders: string[] }
  /** Sheet id → its package path and preserved parts. */
  sheets: Record<number, SheetCarry>
  tablePaths: Record<string, string>
  /** Our macros' customXml part, when the file had one. */
  macrosPath?: string
  /** Cached formula results from the file, to compare with Simple Cell's own results after loading. */
  cached: { sheet: number; r: number; c: number; v: Scalar }[]
}

export interface SheetCarry {
  path: string
  rels: Rel[]
  /** Worksheet elements kept verbatim, in file order. */
  elements: { name: string; xml: string }[]
  /** Attributes of sheetPr / sheetView we keep (codeName, filterMode, view settings). */
  sheetPr?: string
  sheetView?: Record<string, string>
  sheetViewExtra?: string
  sheetFormatPr?: Record<string, string>
  /** Notes: their comments part, VML drawing, and what they were when read (unchanged notes keep their parts). */
  commentsPath?: string
  vmlPath?: string
  notesSig?: string
  /** The sheet's drawing part and the chart relationships in it that became model charts. */
  drawingPath?: string
  chartRids?: string[]
  hadSparklines?: boolean
}

const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333']

/** Column width in characters (file) → pixels, for Calibri 11 (maximum digit width 7 px). */
export const widthToPx = (w: number) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7)
export const ptToPx = (pt: number) => Math.round((pt * 96) / 72)

// ---------- colours ----------

function applyTint(hex: string, tint: number): string {
  if (!tint) return hex
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let rr: number, gg: number, bb: number
  if (s === 0) rr = gg = bb = l
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    rr = hue(p, q, h + 1 / 3)
    gg = hue(p, q, h)
    bb = hue(p, q, h - 1 / 3)
  }
  const x = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return (x(rr) + x(gg) + x(bb)).toUpperCase()
}

function themeColors(xml: string): string[] {
  if (!xml) return ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72']
  const doc = parseXml(xml)
  const scheme = deep(doc, 'clrScheme')[0]
  const get = (n: string) => {
    const el = kid(scheme, n)
    const c = el && (kid(el, 'srgbClr') ?? kid(el, 'sysClr'))
    return (c && (attr(c, 'lastClr') ?? attr(c, 'val'))) || '000000'
  }
  // SpreadsheetML theme indexes swap dk1/lt1 and dk2/lt2.
  return [get('lt1'), get('dk1'), get('lt2'), get('dk2'), get('accent1'), get('accent2'), get('accent3'), get('accent4'), get('accent5'), get('accent6'), get('hlink'), get('folHlink')]
}

function colorOf(el: El | null, theme: string[], customIndexed?: string[]): string | undefined {
  if (!el) return undefined
  if (boolAttr(el, 'auto')) return undefined
  const rgb = attr(el, 'rgb')
  const tint = numAttr(el, 'tint') ?? 0
  let hex: string | undefined
  if (rgb) hex = rgb.length === 8 ? rgb.slice(2) : rgb
  const th = numAttr(el, 'theme')
  if (th !== null) hex = theme[th]
  const ix = numAttr(el, 'indexed')
  if (ix !== null) {
    if (ix === 64) return undefined // system foreground: automatic
    hex = (customIndexed ?? INDEXED)[ix]
    if (!hex) return undefined
  }
  if (!hex) return undefined
  return '#' + applyTint(hex.toUpperCase(), tint)
}

// ---------- styles ----------

interface StylesResult {
  /** Differential formats (conditional formatting), by index. */
  dxfs: Style[]
  xfToStyle: number[]
  numFmts: Map<number, string>
  carry: XlsxCarry['styles']
}

function readStyles(xml: string, wb: Workbook, theme: string[], w: Warnings): StylesResult {
  const empty: StylesResult = { dxfs: [], xfToStyle: [0], numFmts: new Map(), carry: { fonts: [], fills: [], borders: [] } }
  if (!xml) return empty
  const doc = parseXml(xml)
  const root = doc.documentElement
  const numFmts = new Map<number, string>()
  for (const n of kids(kid(root, 'numFmts'), 'numFmt')) numFmts.set(numAttr(n, 'numFmtId') ?? -1, attr(n, 'formatCode') ?? 'General')
  const customIndexed = kids(kid(kid(root, 'colors'), 'indexedColors'), 'rgbColor').map((c) => (attr(c, 'rgb') ?? 'FF000000').slice(2))
  const indexed = customIndexed.length ? customIndexed : undefined
  const rawTop = topLevel(xml.slice(xml.indexOf('>', xml.indexOf('<styleSheet')) + 1, xml.lastIndexOf('</')))
  const raw = (n: string) => rawTop.find((e) => e.name === n)?.xml
  const fontEls = kids(kid(root, 'fonts'), 'font')
  const fillEls = kids(kid(root, 'fills'), 'fill')
  const borderEls = kids(kid(root, 'borders'), 'border')
  const fontXml = topLevel(innerOf(raw('fonts') ?? '')).map((e) => e.xml)
  const fillXml = topLevel(innerOf(raw('fills') ?? '')).map((e) => e.xml)
  const borderXml = topLevel(innerOf(raw('borders') ?? '')).map((e) => e.xml)
  const font = (i: number): Partial<Style> => {
    const f = fontEls[i]
    if (!f) return {}
    const s: Partial<Style> = {}
    const name = attr(kid(f, 'name'), 'val')
    if (name) s.font = name
    const sz = numAttr(kid(f, 'sz'), 'val')
    if (sz !== null) s.size = sz
    const on = (n: string) => {
      const e = kid(f, n)
      return !!e && attr(e, 'val') !== '0' && attr(e, 'val') !== 'false'
    }
    if (on('b')) s.bold = true
    if (on('i')) s.italic = true
    if (on('strike')) s.strike = true
    const u = kid(f, 'u')
    if (u) {
      const v = attr(u, 'val') ?? 'single'
      if (v !== 'none') s.underline = v as Style['underline']
    }
    const va = attr(kid(f, 'vertAlign'), 'val')
    if (va === 'superscript' || va === 'subscript') s.vertAlign = va
    const c = colorOf(kid(f, 'color'), theme, indexed)
    if (c && c !== '#000000') s.color = c
    return s
  }
  const fill = (i: number): Partial<Style> => {
    const f = fillEls[i]
    const p = kid(f, 'patternFill')
    if (!p) {
      if (kid(f, 'gradientFill')) {
        // Shown with its first colour; the gradient itself is kept for saving.
        const stop = deep(f, 'stop')[0]
        const c = colorOf(kid(stop, 'color'), theme, indexed)
        return c ? { fill: c } : {}
      }
      return {}
    }
    const type = attr(p, 'patternType') ?? 'none'
    if (type === 'none') return {}
    const fg = colorOf(kid(p, 'fgColor'), theme, indexed)
    const bg = colorOf(kid(p, 'bgColor'), theme, indexed)
    if (type === 'solid') return fg ? { fill: fg } : bg ? { fill: bg } : { fill: '#000000' }
    return { pattern: { type, fg, bg }, fill: fg ?? bg }
  }
  const border = (i: number): Partial<Style> => {
    const b = borderEls[i]
    if (!b) return {}
    const s: Partial<Style> = {}
    const side = (n: string): BorderSide | undefined => {
      const e = kid(b, n)
      const st = attr(e, 'style')
      if (!e || !st || st === 'none') return undefined
      return { style: st as BorderSide['style'], color: colorOf(kid(e, 'color'), theme, indexed) }
    }
    s.borderLeft = side('left') ?? side('start')
    s.borderRight = side('right') ?? side('end')
    s.borderTop = side('top')
    s.borderBottom = side('bottom')
    const diag = side('diagonal')
    if (diag && boolAttr(b, 'diagonalDown')) s.borderDiagDown = diag
    if (diag && boolAttr(b, 'diagonalUp')) s.borderDiagUp = diag
    return s
  }
  const xfToStyle: number[] = []
  for (const xf of kids(kid(root, 'cellXfs'), 'xf')) {
    const st: Style = {}
    const fid = numAttr(xf, 'fontId') ?? 0
    const fl = numAttr(xf, 'fillId') ?? 0
    const bd = numAttr(xf, 'borderId') ?? 0
    Object.assign(st, font(fid), fill(fl), border(bd))
    const nf = numAttr(xf, 'numFmtId') ?? 0
    if (nf !== 0) {
      const code = numFmts.get(nf) ?? BUILTIN_FORMATS[nf]
      if (code && code !== 'General') st.numFmt = code
      else if (!code) w.add('info', 'Some cells use a locale-specific built-in number format; they are shown with a general format.')
    }
    const al = kid(xf, 'alignment')
    if (al) {
      const h = attr(al, 'horizontal')
      if (h && h !== 'general') st.hAlign = h as Style['hAlign']
      const v = attr(al, 'vertical')
      if (v && v !== 'bottom') st.vAlign = v as Style['vAlign']
      if (boolAttr(al, 'wrapText')) st.wrap = true
      if (boolAttr(al, 'shrinkToFit')) st.shrink = true
      const ind = numAttr(al, 'indent')
      if (ind) st.indent = ind
      const rot = numAttr(al, 'textRotation')
      if (rot) st.rotation = rot > 90 && rot !== 255 ? 90 - rot : rot
    }
    const pr = kid(xf, 'protection')
    if (pr) {
      if (attr(pr, 'locked') === '0') st.locked = false
      if (boolAttr(pr, 'hidden')) st.hiddenFormula = true
    }
    // Keep the original records so unchanged styles are written back exactly (theme colours, font families…).
    const carry: Record<string, unknown> = { font: fid, fill: fl, border: bd, fontProps: font(fid), fillProps: fill(fl), borderProps: border(bd) }
    const xfId = attr(xf, 'xfId')
    if (xfId && xfId !== '0') carry.xfId = xfId
    if (boolAttr(xf, 'quotePrefix')) carry.quotePrefix = true
    if (boolAttr(xf, 'pivotButton')) carry.pivotButton = true
    st.carry = carry
    xfToStyle.push(wb.styles.intern(st))
  }
  if (!xfToStyle.length) xfToStyle.push(0)
  const dxfs = kids(kid(root, 'dxfs'), 'dxf').map((d) => readDxf(d, (el) => colorOf(el, theme, indexed)))
  return {
    dxfs,
    xfToStyle,
    numFmts,
    carry: { dxfs: raw('dxfs'), cellStyleXfs: raw('cellStyleXfs'), cellStyles: raw('cellStyles'), tableStyles: raw('tableStyles'), colors: raw('colors'), extLst: raw('extLst'), fonts: fontXml, fills: fillXml, borders: borderXml }
  }
}

function innerOf(xml: string): string {
  const s = xml.indexOf('>')
  const e = xml.lastIndexOf('</')
  return s >= 0 && e > s ? xml.slice(s + 1, e) : ''
}

// ---------- workbook ----------

/** keepSpillValues (Simple Viz): keep the values Excel cached inside dynamic-array spill ranges, for readers that never recalculate. */
export function readXlsx(bytes: Uint8Array, opts: { keepSpillValues?: boolean } = {}): ImportResult & { carry: XlsxCarry } {
  const files = readZip(bytes)
  const w = new Warnings()
  const { defaults, overrides } = contentTypes(files)
  const rootRels = parseRels(files, '')
  const officeRel = rootRels.find((r) => r.type === REL.office || r.type.endsWith('/officeDocument'))
  const wbPath = officeRel ? resolveTarget('', officeRel.target) : 'xl/workbook.xml'
  const wbXml = text(files[wbPath])
  if (!wbXml) throw new Error('The file has no workbook part. It may be damaged or not an Excel workbook.')
  const wbDoc = parseXml(wbXml)
  const root = wbDoc.documentElement
  const wbRels = parseRels(files, wbPath)
  const relById = new Map(wbRels.map((r) => [r.id, r]))
  const wb = new Workbook()
  const contentType = overrides[wbPath] ?? ''
  const macro = /macroEnabled/i.test(contentType) || !!wbRels.find((r) => r.type === REL.vba)
  const template = /template/i.test(contentType)
  const wbPr = kid(root, 'workbookPr')
  wb.date1904 = boolAttr(wbPr, 'date1904')
  const calcPr = kid(root, 'calcPr')
  if (calcPr) {
    const mode = attr(calcPr, 'calcMode')
    if (mode === 'manual' || mode === 'autoNoTable') wb.calc.mode = mode
    wb.calc.iterate = boolAttr(calcPr, 'iterate')
    wb.calc.maxIterations = numAttr(calcPr, 'iterateCount') ?? 100
    wb.calc.maxChange = numAttr(calcPr, 'iterateDelta') ?? 0.001
    wb.calc.fullPrecision = attr(calcPr, 'fullPrecision') !== '0'
    if (!wb.calc.fullPrecision) w.add('info', '“Precision as displayed” is set in this workbook; Simple Cell calculates with full precision.')
  }
  const activeTab = numAttr(kid(kid(root, 'bookViews'), 'workbookView'), 'activeTab') ?? 0
  const wbInner = wbXml.slice(wbXml.indexOf('>', wbXml.indexOf('<workbook')) + 1, wbXml.lastIndexOf('</'))
  const wbTop = topLevel(wbInner)
  const workbookElements = wbTop.filter((e) => !['sheets', 'definedNames', 'calcPr'].includes(e.name))
  for (const e of workbookElements) {
    if (e.name === 'pivotCaches') w.add('info', 'PivotTables can be refreshed and edited. When Simple Cell refreshes one it lays it out in tabular form, and its own number formats and styles replace the file’s.')
    if (e.name === 'externalReferences') w.add('info', 'Links to other workbooks are kept; formulas that use them show the values saved in this file.')
  }

  const themeRel = wbRels.find((r) => r.type === REL.theme)
  const theme = themeColors(themeRel ? text(files[resolveTarget(wbPath, themeRel.target)]) : '')
  wb.theme = theme
  const stylesRel = wbRels.find((r) => r.type === REL.styles)
  const styles = readStyles(stylesRel ? text(files[resolveTarget(wbPath, stylesRel.target)]) : '', wb, theme, w)
  const ssRel = wbRels.find((r) => r.type === REL.sharedStrings)
  const shared = readSharedStrings(ssRel ? text(files[resolveTarget(wbPath, ssRel.target)]) : '')

  // Sheets first (formulas refer to them by name), then names, then cells.
  const sheetEls = kids(kid(root, 'sheets'), 'sheet')
  const carry: XlsxCarry = { files, workbookPath: wbPath, workbookElements, workbookRels: wbRels, overrides, defaults, macro, template, styles: styles.carry, sheets: {}, tablePaths: {}, cached: [] }
  const pending: { sheet: Sheet; path: string; xml: string }[] = []
  for (const se of sheetEls) {
    const name = attr(se, 'name') ?? `Sheet${wb.sheets.length + 1}`
    const rid = attr(se, 'id')
    const rel = rid ? relById.get(rid) : undefined
    if (!rel) continue
    if (rel.type === REL.chartsheet || rel.type.endsWith('/chartsheet')) {
      w.add('loss', `The chart sheet “${name}” is kept in the file but not shown (chart sheets arrive with charts).`)
      continue
    }
    const sh = wb.addSheet(name)
    const state = attr(se, 'state')
    if (state === 'hidden' || state === 'veryHidden') sh.hidden = state
    const path = resolveTarget(wbPath, rel.target)
    pending.push({ sheet: sh, path, xml: text(files[path]) })
  }
  if (!wb.sheets.length) wb.addSheet('Sheet1')
  wb.activeSheet = Math.min(Math.max(0, activeTab), wb.sheets.length - 1)
  const sheetId = (n: string) => wb.sheetByName(n)?.id ?? null

  // Tables (needed before formulas with structured references are analysed; parsed now, attached per sheet).
  for (const p of pending) {
    const rels = parseRels(files, p.path)
    for (const r of rels.filter((x) => x.type === REL.table)) {
      const tp = resolveTarget(p.path, r.target)
      const t = readTable(text(files[tp]), p.sheet.id, wb.tables.length + 1)
      if (t) {
        wb.tables.push(t)
        carry.tablePaths[t.name] = tp
      }
    }
  }

  // Defined names
  for (const dn of kids(kid(root, 'definedNames'), 'definedName')) {
    const name = attr(dn, 'name') ?? ''
    const local = numAttr(dn, 'localSheetId')
    const scope = local !== null && wb.sheets[local] ? wb.sheets[local].id : null
    const txt = textOf(dn)
    let ast: Node | undefined
    try {
      ast = parseFormula('=' + txt, { row: 0, col: 0, sheetId })
    } catch {
      ast = undefined
    }
    wb.names.push({ name, scope, text: txt, ast, hidden: boolAttr(dn, 'hidden'), comment: attr(dn, 'comment') ?? undefined })
  }

  for (const p of pending) readSheet(p.sheet, p.path, p.xml, { theme, files, wb, styles, shared, sheetId, w, carry, keepSpill: !!opts.keepSpillValues })

  // JavaScript macros (Simple Cell's customXml part).
  for (const r of wbRels.filter((x) => /\/customXml$/.test(x.type))) {
    const p = resolveTarget(wbPath, r.target)
    const list = files[p] ? readMacros(text(files[p])) : null
    if (list) {
      wb.macros = list
      carry.macrosPath = p
    }
  }
  if (wb.macros.length) w.add('info', `This workbook contains ${wb.macros.length === 1 ? 'a JavaScript macro' : `${wb.macros.length} JavaScript macros`}. Macros never run on their own; you'll be asked before the first run.`)
  if (files['xl/vbaProject.bin'] || wbRels.some((r) => r.type === REL.vba)) w.add('info', 'This workbook contains VBA macros. They are kept unchanged when you save as .xlsm, but Simple Cell does not run them.')
  wb.carry = carry
  return { workbook: wb, warnings: w.list, carry }
}

function readSharedStrings(xml: string): { text: string; rich?: string }[] {
  if (!xml) return []
  const out: { text: string; rich?: string }[] = []
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const inner = m[1] ?? ''
    // Plain <t> or rich runs <r><t>…</t></r>; phonetic runs (rPh) are not part of the text.
    const noPh = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr\b[^>]*\/>/g, '')
    let t = ''
    for (const tm of noPh.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) t += xmlText(tm[1] ?? '')
    t = t.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    out.push(/<r>/.test(inner) ? { text: t, rich: inner } : { text: t })
  }
  return out
}

function readTable(xml: string, sheet: number, id: number): Table | null {
  if (!xml) return null
  const doc = parseXml(xml)
  const t = doc.documentElement
  const ref = attr(t, 'ref')
  const area = ref ? parseArea(ref, sheet) : null
  if (!area) return null
  const cols = kids(kid(t, 'tableColumns'), 'tableColumn').map((c) => ({
    name: attr(c, 'name') ?? '',
    totalsFunction: attr(c, 'totalsRowFunction') ?? undefined,
    totalsLabel: attr(c, 'totalsRowLabel') ?? undefined,
    formula: textOf(kid(c, 'calculatedColumnFormula')) || undefined
  }))
  const style = kid(t, 'tableStyleInfo')
  const af = kid(t, 'autoFilter')
  const table: Table = {
    id: numAttr(t, 'id') ?? id,
    name: attr(t, 'name') ?? `Table${id}`,
    displayName: attr(t, 'displayName') ?? attr(t, 'name') ?? `Table${id}`,
    sheet,
    area,
    headerRow: (numAttr(t, 'headerRowCount') ?? 1) > 0,
    totalsRow: (numAttr(t, 'totalsRowCount') ?? 0) > 0 || boolAttr(t, 'totalsRowShown') && (numAttr(t, 'totalsRowCount') ?? 0) > 0,
    columns: cols,
    style: attr(style, 'name') ?? undefined,
    showRowStripes: boolAttr(style, 'showRowStripes'),
    showColumnStripes: boolAttr(style, 'showColumnStripes'),
    showFirstColumn: boolAttr(style, 'showFirstColumn'),
    showLastColumn: boolAttr(style, 'showLastColumn'),
    autoFilter: !!af,
    filter: af ? readFilterColumns(af).columns : [],
    carry: { xml }
  }
  ;(table.carry as Record<string, unknown>).sig = tableSig(table)
  return table
}

/** What a table's XML is generated from: when this is unchanged, the original XML is written back. */
export function tableSig(t: Table): string {
  const { name, displayName, headerRow, totalsRow, columns, style, showRowStripes, showColumnStripes, showFirstColumn, showLastColumn, autoFilter, filter } = t
  return JSON.stringify({ name, displayName, headerRow, totalsRow, columns, style, showRowStripes, showColumnStripes, showFirstColumn, showLastColumn, autoFilter, filter })
}

// ---------- worksheet ----------

interface SheetCtx {
  theme: string[]
  files: Record<string, Uint8Array>
  wb: Workbook
  styles: StylesResult
  shared: { text: string; rich?: string }[]
  sheetId: (n: string) => number | null
  w: Warnings
  carry: XlsxCarry
  keepSpill?: boolean
}

/** Worksheet elements Simple Cell regenerates; all others are kept verbatim. */
const GENERATED = new Set(['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'mergeCells', 'tableParts'])

function readSheet(sh: Sheet, path: string, xml: string, ctx: SheetCtx) {
  const rels = parseRels(ctx.files, path)
  const start = xml.indexOf('>', xml.search(/<(\w+:)?worksheet\b/)) + 1
  const inner = xml.slice(start, xml.lastIndexOf('</'))
  const top = topLevel(inner)
  const sc: SheetCarry = { path, rels, elements: top.filter((e) => !GENERATED.has(e.name)) }
  ctx.carry.sheets[sh.id] = sc
  // Conditional formats become part of the model; any that can't be read stay as they are.
  sc.elements = sc.elements.filter((e) => {
    if (e.name !== 'conditionalFormatting') return true
    const b = readCondFormat(e.xml, sh.id, ctx.styles.dxfs, (el) => colorOf(el, ctx.theme, undefined), ctx.sheetId)
    if (b) sh.condFormats.push(b)
    return !b
  }).filter((e) => {
    if (e.name !== 'dataValidations') return true
    const list = readValidations(e.xml, sh.id, ctx.sheetId)
    if (list) sh.validations.push(...list)
    return !list
  }).filter((e) => {
    if (e.name !== 'scenarios') return true
    sh.scenarios = readScenarios(e.xml)
    return !sh.scenarios
  }).filter((e) => {
    if (e.name !== 'autoFilter') return true
    sh.autoFilter = readAutoFilter(e.xml, sh.id)
    return !sh.autoFilter
  })
  // Page layout: modelled; the elements are regenerated.
  const fit = /<(?:\w+:)?pageSetUpPr\b[^>]*\bfitToPage="(1|true)"/.test(top.find((e) => e.name === 'sheetPr')?.xml ?? '')
  sh.pageSetup = readPageSetup(sc.elements, fit)
  sc.elements = sc.elements.filter((e) => !PAGE_ELEMENTS.has(e.name))
  // Notes (legacy comments) and hyperlinks.
  const cRel = rels.find((r) => r.type === REL.comments)
  if (cRel) {
    const p = resolveTarget(path, cRel.target)
    if (ctx.files[p]) {
      try {
        sh.notes = readComments(text(ctx.files[p]))
        sc.commentsPath = p
      } catch {
        ctx.w.add('loss', 'Some notes could not be read; they are kept in the file but not shown.')
      }
    }
  }
  const ld = sc.elements.find((e) => e.name === 'legacyDrawing')
  const vRel = ld ? rels.find((r) => r.id === /r:id="([^"]+)"/.exec(ld.xml)?.[1]) : undefined
  if (vRel) sc.vmlPath = resolveTarget(path, vRel.target)
  sc.notesSig = notesSig(sh.notes)
  if (rels.some((r) => /\/threadedComment$/.test(r.type))) ctx.w.add('info', 'Threaded comments are shown as notes. Changing a sheet’s notes turns its threads into notes.')
  sc.elements = sc.elements.filter((e) => {
    if (e.name !== 'hyperlinks') return true
    try {
      sh.links = readHyperlinks(e.xml, rels)
      return false
    } catch {
      return true
    }
  })
  if (!sc.elements.some((e) => e.name === 'hyperlinks')) sc.rels = sc.rels.filter((r) => r.type !== REL.hyperlink)
  // Sparklines (in the worksheet's extension list).
  const ext = sc.elements.find((e) => e.name === 'extLst')
  if (ext && /sparklineGroups/.test(ext.xml)) {
    sh.sparklines = readSparklines(ext.xml)
    sc.hadSparklines = true
  }
  // PivotTables (their output cells are ordinary cells; the definitions become the model).
  for (const r of rels.filter((x) => x.type === REL_PIVOT_TABLE)) {
    const tp = resolveTarget(path, r.target)
    const cr = parseRels(ctx.files, tp).find((x) => x.type === REL_PIVOT_CACHE)
    const cp = cr ? resolveTarget(tp, cr.target) : ''
    let p = null
    try {
      p = ctx.files[tp] && ctx.files[cp] ? readPivot(text(ctx.files[tp]), text(ctx.files[cp]), sh.name, { table: tp, cache: cp }) : null
    } catch {
      p = null
    }
    if (p) sh.pivots.push(p)
    else ctx.w.add('loss', 'Some PivotTables could not be read; they are kept as they are, but Simple Cell can’t refresh or edit them.')
  }
  // Charts in the sheet's drawing.
  let unshown = 0
  const dEl = sc.elements.find((e) => e.name === 'drawing')
  const dRel = dEl ? rels.find((r) => r.id === /r:id="([^"]+)"/.exec(dEl.xml)?.[1]) : undefined
  if (dRel) {
    const dp = resolveTarget(path, dRel.target)
    sc.drawingPath = dp
    sc.chartRids = []
    const dxml = ctx.files[dp] ? text(ctx.files[dp]) : ''
    const drels = parseRels(ctx.files, dp)
    try {
      const found = readAnchors(dxml)
      for (const { rid, anchor } of found) {
        const rel = drels.find((r) => r.id === rid)
        const part = rel ? resolveTarget(dp, rel.target) : ''
        const chart = part && ctx.files[part] ? readChart(text(ctx.files[part]), anchor, { part, drawing: dp, rid }) : null
        if (chart) {
          sh.charts.push(chart)
          sc.chartRids.push(rid)
          if (chart.carry?.note === 'combo') ctx.w.add('info', 'Combination charts are shown with their first chart type; they are saved as they are unless you edit them.')
        }
      }
      unshown = drawingAnchors(dxml).length - sc.chartRids.length
    } catch {
      unshown = 1
    }
  }
  const kinds = new Set(sc.elements.map((e) => e.name))
  if (kinds.has('conditionalFormatting')) ctx.w.add('info', 'Some conditional formats could not be read; they are kept and saved, but not shown.')
  if (sc.elements.some((e) => e.name === 'extLst' && /<x14:cfRule\b(?![^>]*type="dataBar")/.test(e.xml))) ctx.w.add('info', 'Some conditional formats from newer Excel versions are kept and saved, but not shown.')
  if (kinds.has('dataValidations')) ctx.w.add('info', 'Some data validation rules could not be read; they are kept and saved, but not enforced.')
  if (kinds.has('drawing') && unshown > 0) ctx.w.add('loss', 'Pictures, shapes and some charts are kept and saved, but not shown yet.')
  if (kinds.has('sheetProtection')) ctx.w.add('info', 'Sheet protection is kept in the file, but Simple Cell doesn’t enforce it yet.')
  for (const e of top) {
    if (e.name === 'sheetPr') {
      const a = tagAttrs(e.xml.slice(0, e.xml.indexOf('>') + 1))
      const tab = /<(?:\w+:)?tabColor\b[^>]*>/.exec(e.xml)
      if (tab) {
        const d = parseXml(`<x xmlns="x">${tab[0].endsWith('/>') ? tab[0] : tab[0] + '</tabColor>'}</x>`)
        sh.tabColor = colorOf(kid(d.documentElement, 'tabColor'), ctx.theme, undefined) ?? null
      }
      sc.sheetPr = Object.entries(a)
        .filter(([k]) => !k.startsWith('xmlns'))
        .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
        .join(' ')
      const rest = e.xml.replace(/<(?:\w+:)?tabColor\b[^>]*\/>/, '').replace(/^<[^>]*>|<\/[^>]*>$/g, '')
      if (rest.trim() && !e.xml.endsWith('/>')) sc.sheetPr += '\u0000' + rest
    } else if (e.name === 'sheetViews') {
      const view = /<(?:\w+:)?sheetView\b[^>]*>/.exec(e.xml)
      if (view) {
        const a = tagAttrs(view[0])
        sc.sheetView = a
        if (a.showGridLines === '0' || a.showGridLines === 'false') sh.showGridlines = false
        if (a.zoomScale) sh.zoom = Math.min(4, Math.max(0.1, Number(a.zoomScale) / 100))
      }
      const pane = /<(?:\w+:)?pane\b[^>]*>/.exec(e.xml)
      if (pane) {
        const a = tagAttrs(pane[0])
        if (a.state === 'frozen' || a.state === 'frozenSplit') sh.freeze = { rows: Number(a.ySplit ?? 0), cols: Number(a.xSplit ?? 0) }
      }
    } else if (e.name === 'sheetFormatPr') {
      const a = tagAttrs(e.xml)
      sc.sheetFormatPr = a
      if (a.defaultRowHeight) sh.defaultRowHeight = ptToPx(Number(a.defaultRowHeight))
      if (a.defaultColWidth) sh.defaultColWidth = widthToPx(Number(a.defaultColWidth))
      else if (a.baseColWidth) sh.defaultColWidth = widthToPx(Number(a.baseColWidth) + 5 / 7)
    } else if (e.name === 'cols') {
      for (const [tag] of e.xml.matchAll(/<(?:\w+:)?col\b[^>]*>/g)) {
        const a = tagAttrs(tag)
        const min = Number(a.min) - 1
        const max = Math.min(Number(a.max) - 1, MAX_COLS - 1)
        if (max - min > 16383) continue
        const width = a.width !== undefined ? widthToPx(Number(a.width)) : undefined
        const style = a.style !== undefined ? ctx.styles.xfToStyle[Number(a.style)] : undefined
        for (let c = min; c <= max; c++) {
          const info: Record<string, unknown> = {}
          if (width !== undefined && (a.customWidth === '1' || a.customWidth === 'true' || width !== sh.defaultColWidth)) info.width = width
          if (a.hidden === '1' || a.hidden === 'true') info.hidden = true
          if (style) info.style = style
          if (a.outlineLevel) info.outline = Number(a.outlineLevel)
          if (a.collapsed === '1' || a.collapsed === 'true') info.collapsed = true
          if (Object.keys(info).length) sh.cols.set(c, info)
        }
      }
    } else if (e.name === 'mergeCells') {
      for (const [tag] of e.xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*>/g)) {
        const a = parseArea(tagAttrs(tag).ref ?? '', sh.id)
        if (a && (a.r0 !== a.r1 || a.c0 !== a.c1)) sh.merges.push(a)
      }
    } else if (e.name === 'sheetData') readSheetData(sh, e.xml, ctx)
  }
  // Hidden rows from an AutoFilter count as filtered (SUBTOTAL ignores them).
  if (sh.autoFilter || kinds.has('autoFilter')) for (const [r, ri] of sh.rowInfo) if (ri.hidden && (!sh.autoFilter || (r > sh.autoFilter.area.r0 && r <= sh.autoFilter.area.r1))) ri.filtered = true
}

const ERR_SET = new Set<string>(ERROR_CODES)

function readSheetData(sh: Sheet, xml: string, ctx: SheetCtx) {
  const sharedF = new Map<string, { ast: Node; r: number; c: number }>()
  const dynamic: { r0: number; c0: number; r1: number; c1: number }[] = []
  const sheetId = ctx.sheetId
  let unsupportedFormula = 0
  // A small hand-written scanner: worksheets can hold millions of cells, far too many for a DOM.
  const rowRe = /<(?:\w+:)?row\b([^>]*?)(\/?)>/g
  let m: RegExpExecArray | null
  let autoRow = -1
  while ((m = rowRe.exec(xml))) {
    const ra = tagAttrs(m[0])
    const r = ra.r ? Number(ra.r) - 1 : autoRow + 1
    autoRow = r
    if (r >= MAX_ROWS) break
    const info: Record<string, unknown> = {}
    if (ra.ht !== undefined && (ra.customHeight === '1' || ra.customHeight === 'true')) {
      info.height = ptToPx(Number(ra.ht))
      info.custom = true
    }
    if (ra.hidden === '1' || ra.hidden === 'true') info.hidden = true
    if (ra.outlineLevel) info.outline = Number(ra.outlineLevel)
    if (ra.collapsed === '1' || ra.collapsed === 'true') info.collapsed = true
    if ((ra.customFormat === '1' || ra.customFormat === 'true') && ra.s !== undefined) info.style = ctx.styles.xfToStyle[Number(ra.s)]
    if (Object.keys(info).length) sh.rowInfo.set(r, info)
    if (m[2] === '/') continue
    const end = findRowEnd(xml, rowRe.lastIndex)
    const rowXml = xml.slice(rowRe.lastIndex, end)
    rowRe.lastIndex = end
    let autoCol = -1
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(rowXml))) {
      const ca = tagAttrs(`<c${cm[1]}>`)
      let c = autoCol + 1
      if (ca.r) {
        const p = parseCell(ca.r)
        if (p) c = p.c
      }
      autoCol = c
      if (c >= MAX_COLS) continue
      const body = cm[3] ?? ''
      const s = ca.s !== undefined ? ctx.styles.xfToStyle[Number(ca.s)] : undefined
      const cell: Cell = { v: null }
      if (s) cell.s = s
      const t = ca.t ?? 'n'
      const vm = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)
      const raw = vm ? xmlText(vm[1]) : null
      if (t === 's') {
        const ss = raw !== null ? ctx.shared[Number(raw)] : undefined
        if (ss) {
          cell.v = ss.text
          if (ss.rich) cell.rich = ss.rich
        }
      } else if (t === 'inlineStr') {
        let txt = ''
        for (const tm of body.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) txt += xmlText(tm[1])
        cell.v = txt
      } else if (t === 'b') cell.v = raw === '1' || raw === 'true'
      else if (t === 'e') cell.v = raw && ERR_SET.has(raw) ? CellError.of(raw as never) : raw ? CellError.of('#VALUE!') : null
      else if (t === 'str') cell.v = raw ?? ''
      else if (t === 'd') {
        const d = raw ? Date.parse(raw) : NaN
        cell.v = Number.isNaN(d) ? raw : (d - Date.UTC(1899, 11, 30)) / 86400000
      } else if (raw !== null) {
        const n = Number(raw)
        cell.v = Number.isFinite(n) ? n : raw
      }
      // Formula
      const fm = /<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(body)
      if (fm) {
        const fa = tagAttrs(`<f${fm[1]}>`)
        const ftext = fm[2] !== undefined ? xmlText(fm[2]) : ''
        if (fa.t === 'dataTable') {
          // The cell values are the table's results (kept); the table recalculates from its formulas.
          const t = readDataTable(fa)
          if (t) sh.dataTables.push(t)
          else ctx.w.add('loss', 'A data table whose input cell was deleted is kept as values.')
        }
        let ast: Node | undefined
        try {
          if (fa.t === 'shared' && !ftext && fa.si !== undefined) {
            // Children of a shared formula reuse the master's relative syntax tree.
            ast = sharedF.get(fa.si)?.ast
          } else if (ftext) {
            ast = parseFormula('=' + ftext, { row: r, col: c, sheetId })
            if (fa.t === 'shared' && fa.si !== undefined) sharedF.set(fa.si, { ast, r, c })
          }
        } catch {
          ast = undefined
        }
        if (ast) {
          const isDynamic = ca.cm !== undefined && fa.t === 'array'
          if (fa.t === 'array' && fa.ref) {
            const a = parseArea(fa.ref, sh.id)
            if (a && isDynamic) dynamic.push(a)
            cell.f = isDynamic ? { ast } : { ast, array: a ?? undefined }
          } else cell.f = { ast, legacy: true }
          cell.stale = true
          ctx.carry.cached.push({ sheet: sh.id, r, c, v: cell.v })
        } else if (ftext) {
          // Unreadable formula text: keep the cached value, say so.
          unsupportedFormula++
        }
      }
      if (cell.v === null && !cell.f && !cell.s && !cell.rich) continue
      sh.set(r, c, cell)
    }
  }
  // Values Excel wrote inside dynamic-array spill ranges are recomputed by spilling, not constants.
  for (const a of ctx.keepSpill ? [] : dynamic)
    for (let r = a.r0; r <= a.r1; r++)
      for (let c = a.c0; c <= a.c1; c++) {
        if (r === a.r0 && c === a.c0) continue
        const cell = sh.get(r, c)
        if (!cell || cell.f) continue
        if (cell.s) sh.set(r, c, { v: null, s: cell.s })
        else sh.set(r, c, undefined)
      }
  if (unsupportedFormula) ctx.w.add('loss', `${unsupportedFormula} formula(s) could not be read and are kept as values.`)
}

function findRowEnd(xml: string, from: number): number {
  const re = /<\/(?:\w+:)?row>/g
  re.lastIndex = from
  const m = re.exec(xml)
  return m ? m.index + m[0].length : xml.length
}

// XLSX / XLSM / XLTX writer. Regenerates the parts the model owns and writes every carried part back unchanged.
import type { Sheet, Workbook, Cell, Table, DefinedName } from '../../model/workbook'
import type { BorderSide, Style } from '../../model/styles'
import { printFormula } from '../../engine/parser'
import { fileFunctionName } from '../../engine/catalog'
import { CellError, MAX_COLS, MAX_ROWS, numberToText } from '../../engine/values'
import { areaName, cellKey, cellName, colName, fromKey, quoteSheet } from '../../refs'
import { BUILTIN_FORMATS } from '../../numfmt/format'
import { bytes, text, writeZip } from '../zip'
import { contentTypesXml, CT, esc, escText, parseRels, REL, relsPath, relsXml, resolveTarget, unreachable, type Rel } from '../opc'
import { Warnings, type ExportResult } from '../types'
import type { SheetCarry, XlsxCarry } from './read'
import type { CfRule } from '../../condfmt'
import { condFormatsXml, dxfXml } from './condfmt'
import { validationsXml } from './validation'
import { autoFilterXml, filterColumnsXml } from './filter'
import { tableSig } from './read'
import { commentsXml, hyperlinksXml, notesSig, vmlHasShapes, vmlXml } from './notes'
import { pageSetupXml } from './pagesetup'
import { dataTableFormulaXml, scenariosXml } from './whatif'
import { CT_CHART, CT_DRAWING, DRAWING_HEAD, REL_CHART, anchorXml, chartXml, drawingAnchors } from './charts'
import { chartSig } from '../../charts'
import { withSparklines } from '../../sparklines'
import { CT_PIVOT_CACHE, CT_PIVOT_TABLE, REL_PIVOT_CACHE, REL_PIVOT_RECORDS, REL_PIVOT_TABLE, pivotSig, pivotXml } from './pivot'
import type { Scalar } from '../../engine/values'
import { parseArea } from '../../refs'
import { macrosXml } from '../macros'
import { topLevel } from '../xml'

export type XlsxKind = 'xlsx' | 'xlsm' | 'xltx' | 'xltm'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** Order of worksheet elements (CT_Worksheet). */
const ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']

export const pxToWidth = (px: number) => Math.trunc((px / 7) * 256) / 256
const pxToPt = (px: number) => Math.round(((px * 72) / 96) * 100) / 100

// ---------- styles ----------

class StyleWriter {
  fonts: string[] = []
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  borders: string[] = []
  numFmts = new Map<string, number>()
  xfs: string[] = []
  private fontIdx = new Map<string, number>()
  private fillIdx = new Map<string, number>([[this.fills[0], 0], [this.fills[1], 1]])
  private borderIdx = new Map<string, number>()
  private xfIdx = new Map<string, number>()
  /** Style id → cellXfs index */
  map = new Map<number, number>()
  /** Differential formats: the file's (indexes kept: tables and PivotTables refer to them) plus new ones. */
  dxfs: string[] = []
  private dxfIdx = new Map<string, number>()

  constructor(
    private wb: Workbook,
    private carry: XlsxCarry['styles'] | undefined,
    defaultFont: { name: string; size: number }
  ) {
    this.font(`<font><sz val="${defaultFont.size}"/><color theme="1"/><name val="${esc(defaultFont.name)}"/><family val="2"/><scheme val="minor"/></font>`)
    this.border('<border><left/><right/><top/><bottom/><diagonal/></border>')
    // Keep the original first font (the workbook's default) when there is one.
    if (carry?.fonts[0]) {
      this.fonts[0] = carry.fonts[0]
      this.fontIdx.clear()
      this.fontIdx.set(carry.fonts[0], 0)
    }
    this.xf(0)
    const inner = carry?.dxfs?.replace(/^<(?:\w+:)?dxfs\b[^>]*?(?:\/>|>)/, '').replace(/<\/(?:\w+:)?dxfs>$/, '') ?? ''
    this.dxfs = topLevel(inner).map((e) => e.xml)
  }

  /** dxfId for a conditional formatting rule: its original one while its format is unchanged. */
  dxf(r: CfRule): number | undefined {
    if (!r.dxf) return undefined
    if (r.carry?.dxfId !== undefined && r.carry.dxfKey === JSON.stringify(r.dxf) && r.carry.dxfId < this.dxfs.length) return r.carry.dxfId
    const xml = dxfXml(r.dxf, (code) => this.numFmt(code))
    let i = this.dxfIdx.get(xml)
    if (i === undefined) {
      i = this.dxfs.length
      this.dxfs.push(xml)
      this.dxfIdx.set(xml, i)
    }
    return i
  }

  private font(xml: string) {
    let i = this.fontIdx.get(xml)
    if (i === undefined) {
      i = this.fonts.length
      this.fonts.push(xml)
      this.fontIdx.set(xml, i)
    }
    return i
  }
  private fill(xml: string) {
    let i = this.fillIdx.get(xml)
    if (i === undefined) {
      i = this.fills.length
      this.fills.push(xml)
      this.fillIdx.set(xml, i)
    }
    return i
  }
  private border(xml: string) {
    let i = this.borderIdx.get(xml)
    if (i === undefined) {
      i = this.borders.length
      this.borders.push(xml)
      this.borderIdx.set(xml, i)
    }
    return i
  }
  numFmt(code: string | undefined): number {
    if (!code || code === 'General') return 0
    for (const [id, c] of Object.entries(BUILTIN_FORMATS)) if (c === code) return Number(id)
    let id = this.numFmts.get(code)
    if (id === undefined) {
      id = 164 + this.numFmts.size
      this.numFmts.set(code, id)
    }
    return id
  }

  xf(styleId: number): number {
    const cached = this.map.get(styleId)
    if (cached !== undefined) return cached
    const s = this.wb.styles.get(styleId)
    const c = (s.carry ?? {}) as Record<string, unknown>
    const same = (a: unknown, b: Record<string, unknown>) => {
      const x = a as Record<string, unknown> | undefined
      if (!x) return false
      const keys = new Set([...Object.keys(x), ...Object.keys(b)])
      for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(b[k])) return false
      return true
    }
    const fontProps = pick(s, ['font', 'size', 'bold', 'italic', 'underline', 'strike', 'vertAlign', 'color'])
    const fillProps = pick(s, ['fill', 'pattern'])
    const borderProps = pick(s, ['borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderDiagUp', 'borderDiagDown'])
    const carriedFont = typeof c.font === 'number' && same(c.fontProps, fontProps) ? this.carry?.fonts[c.font] : undefined
    const carriedFill = typeof c.fill === 'number' && same(c.fillProps, fillProps) ? this.carry?.fills[c.fill] : undefined
    const carriedBorder = typeof c.border === 'number' && same(c.borderProps, borderProps) ? this.carry?.borders[c.border] : undefined
    const fontId = carriedFont ? this.font(carriedFont) : Object.keys(fontProps).length ? this.font(fontXml(s, this.fonts[0])) : 0
    const fillId = carriedFill ? this.fill(carriedFill) : Object.keys(fillProps).length ? this.fill(fillXml(s)) : 0
    const borderId = carriedBorder ? this.border(carriedBorder) : Object.keys(borderProps).length ? this.border(borderXml(s)) : 0
    const numFmtId = this.numFmt(s.numFmt)
    const align: string[] = []
    if (s.hAlign) align.push(`horizontal="${s.hAlign}"`)
    if (s.vAlign) align.push(`vertical="${s.vAlign}"`)
    if (s.wrap) align.push('wrapText="1"')
    if (s.shrink) align.push('shrinkToFit="1"')
    if (s.indent) align.push(`indent="${s.indent}"`)
    if (s.rotation) align.push(`textRotation="${s.rotation < 0 ? 90 - s.rotation : s.rotation}"`)
    const prot: string[] = []
    if (s.locked === false) prot.push('locked="0"')
    if (s.hiddenFormula) prot.push('hidden="1"')
    const attrs = [`numFmtId="${numFmtId}"`, `fontId="${fontId}"`, `fillId="${fillId}"`, `borderId="${borderId}"`, `xfId="${typeof c.xfId === 'string' && this.carry?.cellStyleXfs ? c.xfId : 0}"`]
    if (numFmtId) attrs.push('applyNumberFormat="1"')
    if (fontId) attrs.push('applyFont="1"')
    if (fillId) attrs.push('applyFill="1"')
    if (borderId) attrs.push('applyBorder="1"')
    if (align.length) attrs.push('applyAlignment="1"')
    if (prot.length) attrs.push('applyProtection="1"')
    if (c.quotePrefix) attrs.push('quotePrefix="1"')
    if (c.pivotButton) attrs.push('pivotButton="1"')
    const xml = `<xf ${attrs.join(' ')}${align.length || prot.length ? `>${align.length ? `<alignment ${align.join(' ')}/>` : ''}${prot.length ? `<protection ${prot.join(' ')}/>` : ''}</xf>` : '/>'}`
    let i = this.xfIdx.get(xml)
    if (i === undefined) {
      i = this.xfs.length
      this.xfs.push(xml)
      this.xfIdx.set(xml, i)
    }
    this.map.set(styleId, i)
    return i
  }

  xml(): string {
    const nf = [...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')
    const c = this.carry
    return (
      HEAD +
      `<styleSheet xmlns="${MAIN_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac">` +
      (nf ? `<numFmts count="${this.numFmts.size}">${nf}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      (c?.cellStyleXfs ?? '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>') +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      (c?.cellStyles ?? '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>') +
      `<dxfs count="${this.dxfs.length}">${this.dxfs.join('')}</dxfs>` +
      (c?.tableStyles ?? '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>') +
      (c?.colors ?? '') +
      (c?.extLst ?? '') +
      '</styleSheet>'
    )
  }
}

function pick(s: Style, keys: (keyof Style)[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of keys) if (s[k] !== undefined) o[k] = s[k]
  return o
}

const rgb = (c: string) => `FF${c.replace('#', '').toUpperCase()}`

function fontXml(s: Style, defaultFont: string): string {
  const name = s.font ?? /<name val="([^"]*)"/.exec(defaultFont)?.[1] ?? 'Calibri'
  const size = s.size ?? Number(/<sz val="([^"]*)"/.exec(defaultFont)?.[1] ?? 11)
  return `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}${s.strike ? '<strike/>' : ''}${s.underline ? (s.underline === 'single' ? '<u/>' : `<u val="${s.underline}"/>`) : ''}${s.vertAlign ? `<vertAlign val="${s.vertAlign}"/>` : ''}<sz val="${size}"/>${s.color ? `<color rgb="${rgb(s.color)}"/>` : '<color theme="1"/>'}<name val="${esc(name)}"/><family val="2"/></font>`
}

function fillXml(s: Style): string {
  if (s.pattern) return `<fill><patternFill patternType="${s.pattern.type}">${s.pattern.fg ? `<fgColor rgb="${rgb(s.pattern.fg)}"/>` : ''}${s.pattern.bg ? `<bgColor rgb="${rgb(s.pattern.bg)}"/>` : ''}</patternFill></fill>`
  if (s.fill) return `<fill><patternFill patternType="solid"><fgColor rgb="${rgb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`
  return '<fill><patternFill patternType="none"/></fill>'
}

function borderXml(s: Style): string {
  const side = (n: string, b?: BorderSide) => (b ? `<${n} style="${b.style}">${b.color ? `<color rgb="${rgb(b.color)}"/>` : '<color indexed="64"/>'}</${n}>` : `<${n}/>`)
  const diag = s.borderDiagDown ?? s.borderDiagUp
  return `<border${s.borderDiagUp ? ' diagonalUp="1"' : ''}${s.borderDiagDown ? ' diagonalDown="1"' : ''}>${side('left', s.borderLeft)}${side('right', s.borderRight)}${side('top', s.borderTop)}${side('bottom', s.borderBottom)}${side('diagonal', diag)}</border>`
}

// ---------- workbook ----------

export function writeXlsx(wb: Workbook, kind: XlsxKind = 'xlsx', defaultFont = { name: 'Calibri', size: 11 }): ExportResult {
  const w = new Warnings()
  const carry = (wb.carry as { xlsx?: XlsxCarry } | null)?.xlsx ?? (isXlsxCarry(wb.carry) ? (wb.carry as XlsxCarry) : undefined)
  const files: Record<string, Uint8Array> = carry ? { ...carry.files } : {}
  const wbPath = carry?.workbookPath ?? 'xl/workbook.xml'
  const dir = wbPath.slice(0, wbPath.lastIndexOf('/') + 1)
  const macro = kind === 'xlsm' || kind === 'xltm'
  const sheetName = (id: number) => wb.sheetById(id)?.name ?? null
  const fname = (n: string) => fileFunctionName(n)

  // Parts we regenerate are removed; everything else stays.
  const oldWbRels = carry?.workbookRels ?? []
  const keepWbRels = oldWbRels.filter((r) => ![REL.worksheet, REL.sharedStrings, REL.styles, REL.calcChain, REL.metadata].includes(r.type) && !(r.type === REL.vba && !macro))
  for (const r of oldWbRels) {
    if (r.external) continue
    const p = resolveTarget(wbPath, r.target)
    if ([REL.sharedStrings, REL.styles, REL.calcChain, REL.metadata].includes(r.type)) delete files[p]
    if (r.type === REL.vba && !macro) {
      delete files[p]
      w.add('loss', 'VBA macros are removed when saving as .xlsx. Save as .xlsm to keep them.')
    }
  }
  if (macro && carry && !oldWbRels.some((r) => r.type === REL.vba)) void 0
  const styles = new StyleWriter(wb, carry?.styles, defaultFont)
  const strings: string[] = []
  const stringIdx = new Map<string, number>()
  const sharedString = (t: string, rich?: unknown) => {
    const key = typeof rich === 'string' ? `\u0001${rich}` : t
    let i = stringIdx.get(key)
    if (i === undefined) {
      i = strings.length
      strings.push(typeof rich === 'string' && richText(rich) === t ? rich : `<t${/^\s|\s$|\n/.test(t) ? ' xml:space="preserve"' : ''}>${esc(t)}</t>`)
      stringIdx.set(key, i)
    }
    return i
  }

  // Sheets
  const usedPaths = new Set(Object.values(carry?.sheets ?? {}).map((s) => s.path))
  let nextSheetFile = 1
  const sheetRelIds: string[] = []
  let ridSeq = 1
  const taken = new Set(keepWbRels.map((r) => r.id))
  const newRid = () => {
    while (taken.has(`rId${ridSeq}`)) ridSeq++
    taken.add(`rId${ridSeq}`)
    return `rId${ridSeq}`
  }
  const wbRels: Rel[] = [...keepWbRels]
  let anyDynamic = false
  // Old sheet parts that no longer belong to a sheet (deleted sheets) are dropped.
  const live = new Set(wb.sheets.map((s) => carry?.sheets[s.id]?.path).filter(Boolean))
  for (const sc of Object.values(carry?.sheets ?? {})) if (!live.has(sc.path)) {
    delete files[sc.path]
    delete files[relsPath(sc.path)]
  }
  let tableFile = 1
  let commentFile = 1
  let drawingFile = 1
  let pivotFile = 1
  const newCaches: string[] = []
  let nextCacheId = 1 + Math.max(0, ...[...(carry?.workbookElements.find((e) => e.name === 'pivotCaches')?.xml ?? '').matchAll(/cacheId="(\d+)"/g)].map((m) => Number(m[1])))
  let chartFile = 1
  let vmlFile = 1
  for (const sh of wb.sheets) {
    const sc = carry?.sheets[sh.id]
    let path = sc?.path
    if (!path) {
      while (usedPaths.has(`${dir}worksheets/sheet${nextSheetFile}.xml`) || files[`${dir}worksheets/sheet${nextSheetFile}.xml`]) nextSheetFile++
      path = `${dir}worksheets/sheet${nextSheetFile}.xml`
      usedPaths.add(path)
    }
    const oldRid = carry ? oldWbRels.find((r) => r.type === REL.worksheet && resolveTarget(wbPath, r.target) === path)?.id : undefined
    const rid = oldRid && !taken.has(oldRid) ? (taken.add(oldRid), oldRid) : newRid()
    sheetRelIds.push(rid)
    wbRels.push({ id: rid, type: REL.worksheet, target: relTarget(wbPath, path) })
    // Tables of this sheet
    const sheetRels: Rel[] = (sc?.rels ?? []).filter((r) => r.type !== REL.table)
    const relTaken = new Set(sheetRels.map((r) => r.id))
    let relSeq = 1
    const sheetRid = () => {
      while (relTaken.has(`rId${relSeq}`)) relSeq++
      relTaken.add(`rId${relSeq}`)
      return `rId${relSeq}`
    }
    const tableParts: string[] = []
    for (const t of wb.tables.filter((x) => x.sheet === sh.id)) {
      let tp = carry?.tablePaths[t.name]
      if (!tp) {
        while (files[`${dir}tables/table${tableFile}.xml`]) tableFile++
        tp = `${dir}tables/table${tableFile}.xml`
        tableFile++
      }
      files[tp] = bytes(tableXml(t, wb))
      const id = sheetRid()
      sheetRels.push({ id, type: REL.table, target: relTarget(path, tp) })
      tableParts.push(`<tablePart r:id="${id}"/>`)
    }
    // Hyperlinks (external addresses are relationships) and notes (a comments part plus VML shapes).
    const extra: Record<string, string> = { ...pageSetupXml(sh.pageSetup) }
    if (sh.sparklines.length || sc?.hadSparklines) extra.extLst = withSparklines(sc?.elements.find((e) => e.name === 'extLst')?.xml, sh.sparklines)
    const links = hyperlinksXml(sh.links, (url) => {
      const id = sheetRid()
      sheetRels.push({ id, type: REL.hyperlink, target: url, external: true })
      return id
    })
    if (links || sc?.elements.some((e) => e.name === 'hyperlinks')) extra.hyperlinks = links
    if ((!sc || sc.notesSig !== notesSig(sh.notes)) && (sh.notes.size || sc?.commentsPath)) {
      let cp = sc?.commentsPath
      const cRel = sheetRels.find((r) => r.type === REL.comments)
      if (sh.notes.size) {
        if (!cp) {
          while (files[`${dir}comments${commentFile}.xml`]) commentFile++
          cp = `${dir}comments${commentFile++}.xml`
        }
        files[cp] = bytes(commentsXml(sh.notes))
        if (!cRel) sheetRels.push({ id: sheetRid(), type: REL.comments, target: relTarget(path, cp) })
      } else {
        if (cp) delete files[cp]
        if (cRel) sheetRels.splice(sheetRels.indexOf(cRel), 1)
      }
      let vp = sc?.vmlPath
      const vml = vmlXml(sh.notes, vp && files[vp] ? text(files[vp]) : undefined)
      const vRel = sheetRels.find((r) => r.type === REL.vml)
      if (vmlHasShapes(vml)) {
        if (!vp) {
          while (files[`${dir}drawings/vmlDrawing${vmlFile}.vml`]) vmlFile++
          vp = `${dir}drawings/vmlDrawing${vmlFile++}.vml`
        }
        files[vp] = bytes(vml)
        let rid = vRel?.id
        if (!rid) {
          rid = sheetRid()
          sheetRels.push({ id: rid, type: REL.vml, target: relTarget(path, vp) })
        }
        extra.legacyDrawing = `<legacyDrawing r:id="${rid}"/>`
      } else {
        if (vp) delete files[vp]
        if (vRel) sheetRels.splice(sheetRels.indexOf(vRel), 1)
        extra.legacyDrawing = ''
      }
      // Threads would no longer match the notes.
      for (const r of sheetRels.filter((x) => /\/threadedComment$/.test(x.type))) sheetRels.splice(sheetRels.indexOf(r), 1)
    }
    // Charts: unchanged ones keep their parts; moved ones get a new anchor; new or edited ones a new chart part.
    {
      const dpOld = sc?.drawingPath
      const mine = (c: (typeof sh.charts)[number]) => !!c.carry?.rid && c.carry.drawing === dpOld
      const needAnchor = sh.charts.filter((c) => !mine(c) || c.carry!.anchorSig !== JSON.stringify(c.anchor))
      const deleted = (sc?.chartRids ?? []).filter((rid) => !sh.charts.some((c) => mine(c) && c.carry!.rid === rid))
      const edited = sh.charts.filter((c) => mine(c) && c.carry!.sig !== chartSig(c))
      if (needAnchor.length || deleted.length || edited.length) {
        let dp = dpOld
        let dxml = dp && files[dp] ? text(files[dp]) : ''
        let drels = dp ? parseRels(files, dp) : []
        if (!dp || !dxml) {
          while (files[`${dir}drawings/drawing${drawingFile}.xml`]) drawingFile++
          dp = `${dir}drawings/drawing${drawingFile++}.xml`
          dxml = DRAWING_HEAD + '</xdr:wsDr>'
          drels = []
        }
        const drop = new Set([...deleted, ...needAnchor.filter(mine).map((c) => c.carry!.rid!)])
        for (const a of drawingAnchors(dxml)) if (a.rid && drop.has(a.rid)) dxml = dxml.replace(a.xml, '')
        drels = drels.filter((r) => !deleted.includes(r.id))
        const taken = new Set(drels.map((r) => r.id))
        let n = drawingAnchors(dxml).length
        for (const c of sh.charts) {
          let rid = mine(c) ? c.carry!.rid! : ''
          let part = mine(c) ? c.carry!.part! : ''
          if (!rid || !part) {
            while (files[`${dir}charts/chart${chartFile}.xml`]) chartFile++
            part = `${dir}charts/chart${chartFile++}.xml`
            let k = 1
            while (taken.has(`rId${k}`)) k++
            rid = `rId${k}`
            taken.add(rid)
            drels.push({ id: rid, type: REL_CHART, target: relTarget(dp, part) })
            files[part] = bytes(chartXml(c))
          } else if (c.carry!.sig !== chartSig(c)) files[part] = bytes(chartXml(c))
          if (needAnchor.includes(c)) {
            n++
            dxml = dxml.replace(/<\/(\w+:)?wsDr>\s*$/, (m) => anchorXml(c.anchor, rid, n, `Chart ${n}`) + m)
          }
        }
        const dRel = sheetRels.find((r) => r.type === REL.drawing)
        if (!drawingAnchors(dxml).length) {
          delete files[dp]
          if (dRel) sheetRels.splice(sheetRels.indexOf(dRel), 1)
          extra.drawing = ''
        } else {
          files[dp] = bytes(dxml)
          files[relsPath(dp)] = bytes(relsXml(drels))
          if (!dRel) {
            const id = sheetRid()
            sheetRels.push({ id, type: REL.drawing, target: relTarget(path, dp) })
            extra.drawing = `<drawing r:id="${id}"/>`
          }
        }
      }
    }
    // PivotTables: unchanged ones keep their parts; new or edited ones get generated cache and table definitions.
    const liveTables = new Set<string>()
    for (const p of sh.pivots) {
      if (p.carry?.table && p.carry.sig === pivotSig(p)) {
        liveTables.add(p.carry.table)
        continue
      }
      const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(p.source)
      const srcName = m ? (m[1]?.replace(/''/g, "'") ?? m[2]) : sh.name
      const srcSheet = wb.sheetByName(srcName)
      const area = srcSheet ? parseArea((m ? m[3] : p.source).replace(/\$/g, ''), srcSheet.id) : null
      if (!srcSheet || !area) {
        w.add('loss', `The PivotTable “${p.name}” uses a source Simple Cell can’t save as a PivotTable; its values are saved.`)
        continue
      }
      const header: string[] = []
      for (let c = area.c0; c <= area.c1; c++) {
        let name = String(srcSheet.get(area.r0, c)?.v ?? '').trim() || `Column${c - area.c0 + 1}`
        for (let k = 2; header.includes(name); k++) name = `${name}${k}`
        header.push(name)
      }
      const records: Scalar[][] = []
      const last = Math.min(area.r1, srcSheet.used().r)
      for (let r = area.r0 + 1; r <= last; r++) {
        const rec: Scalar[] = []
        for (let c = area.c0; c <= area.c1; c++) rec.push(srcSheet.get(r, c)?.v ?? null)
        if (rec.some((v) => v !== null && v !== '')) records.push(rec)
      }
      const out = p.area ?? { r0: p.at.r, c0: p.at.c, r1: p.at.r, c1: p.at.c }
      const loc = { ...out, r0: out.r0 + (p.config.filters.length ? p.config.filters.length + 1 : 0) }
      let tp = p.carry?.table
      let cp = p.carry?.cache
      let cacheId = Number(p.carry?.cacheId) || 0
      if (!tp || !cp) {
        while (files[`${dir}pivotTables/pivotTable${pivotFile}.xml`] || files[`${dir}pivotCache/pivotCacheDefinition${pivotFile}.xml`]) pivotFile++
        tp = `${dir}pivotTables/pivotTable${pivotFile}.xml`
        cp = `${dir}pivotCache/pivotCacheDefinition${pivotFile}.xml`
        pivotFile++
        cacheId = nextCacheId++
        const crid = newRid()
        wbRels.push({ id: crid, type: REL_PIVOT_CACHE, target: relTarget(wbPath, cp) })
        newCaches.push(`<pivotCache cacheId="${cacheId}" r:id="${crid}"/>`)
        files[relsPath(tp)] = bytes(relsXml([{ id: 'rId1', type: REL_PIVOT_CACHE, target: relTarget(tp, cp) }]))
        sheetRels.push({ id: sheetRid(), type: REL_PIVOT_TABLE, target: relTarget(path, tp) })
      } else {
        // The regenerated cache has no records: drop the records part.
        const crels = parseRels(files, cp).filter((r) => r.type !== REL_PIVOT_RECORDS)
        if (crels.length) files[relsPath(cp)] = bytes(relsXml(crels))
        else delete files[relsPath(cp)]
      }
      liveTables.add(tp)
      const x = pivotXml(p, { header, records, sheet: srcSheet.name, ref: areaName(area) }, cacheId, loc)
      files[tp] = bytes(x.table)
      files[cp] = bytes(x.cache)
    }
    // PivotTables deleted in Simple Cell: their parts go (unreachable parts are pruned).
    for (const r of sheetRels.filter((x) => x.type === REL_PIVOT_TABLE)) if (!liveTables.has(resolveTarget(path, r.target))) sheetRels.splice(sheetRels.indexOf(r), 1)
    const { xml, dynamic } = sheetXml(sh, wb, sc, styles, sharedString, sheetName, fname, tableParts, w, extra)
    if (dynamic) anyDynamic = true
    files[path] = bytes(xml)
    if (sheetRels.length) files[relsPath(path)] = bytes(relsXml(sheetRels))
    else delete files[relsPath(path)]
  }

  // JavaScript macros: a customXml part related from the workbook (with its item properties).
  const REL_CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml'
  const REL_PROPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps'
  let mp = carry?.macrosPath
  if (wb.macros.length) {
    if (!mp) {
      let k = 1
      while (files[`customXml/item${k}.xml`]) k++
      mp = `customXml/item${k}.xml`
      const props = `customXml/itemProps${k}.xml`
      files[props] = bytes(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<ds:datastoreItem ds:itemID="{5C1E5C11-0000-4000-8000-0000000000${String(k).padStart(2, '0')}}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="urn:simple-cell:macros:1"/></ds:schemaRefs></ds:datastoreItem>`)
      files[relsPath(mp)] = bytes(relsXml([{ id: 'rId1', type: REL_PROPS, target: `itemProps${k}.xml` }]))
      wbRels.push({ id: newRid(), type: REL_CUSTOM, target: relTarget(wbPath, mp) })
    }
    files[mp] = bytes(macrosXml(wb.macros))
  } else if (mp) {
    const i = wbRels.findIndex((r) => r.type === REL_CUSTOM && resolveTarget(wbPath, r.target) === mp)
    if (i >= 0) wbRels.splice(i, 1)
  }

  // Styles, shared strings, metadata
  const stylesPath = `${dir}styles.xml`
  files[stylesPath] = bytes(styles.xml())
  wbRels.push({ id: newRid(), type: REL.styles, target: relTarget(wbPath, stylesPath) })
  const ssPath = `${dir}sharedStrings.xml`
  if (strings.length) {
    files[ssPath] = bytes(HEAD + `<sst xmlns="${MAIN_NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si>${s}</si>`).join('')}</sst>`)
    wbRels.push({ id: newRid(), type: REL.sharedStrings, target: relTarget(wbPath, ssPath) })
  }
  const metaPath = `${dir}metadata.xml`
  if (anyDynamic) {
    files[metaPath] = bytes(
      HEAD +
        `<metadata xmlns="${MAIN_NS}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`
    )
    wbRels.push({ id: newRid(), type: REL.metadata, target: relTarget(wbPath, metaPath) })
  } else delete files[metaPath]

  // workbook.xml
  files[wbPath] = bytes(workbookXml(wb, carry, sheetRelIds, sheetName, fname, newCaches))
  files[relsPath(wbPath)] = bytes(relsXml(wbRels))

  // Package relationships and document properties
  if (!carry) {
    files['_rels/.rels'] = bytes(relsXml([
      { id: 'rId1', type: REL.office, target: wbPath },
      { id: 'rId2', type: REL.core, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.app, target: 'docProps/app.xml' }
    ]))
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    files['docProps/core.xml'] = bytes(HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`)
  } else if (files['docProps/core.xml']) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    files['docProps/core.xml'] = bytes(text(files['docProps/core.xml']).replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${now}$2`))
  }
  files['docProps/app.xml'] = bytes(HEAD + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Simple Cell</Application><TitlesOfParts><vt:vector size="${wb.sheets.length}" baseType="lpstr">${wb.sheets.map((s) => `<vt:lpstr>${esc(s.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`)
  if (carry && !parseRels(files, '').some((r) => r.type === REL.app)) {
    const rels = parseRels(files, '')
    rels.push({ id: `rId${rels.length + 10}`, type: REL.app, target: 'docProps/app.xml' })
    files['_rels/.rels'] = bytes(relsXml(rels))
  }

  for (const p of unreachable(files)) delete files[p]

  // Content types
  const defaults: Record<string, string> = { rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', ...(carry?.defaults ?? {}) }
  if (macro && files[`${dir}vbaProject.bin`]) defaults.bin = 'application/vnd.ms-office.vbaProject'
  const overrides: Record<string, string> = {}
  for (const [p, t] of Object.entries(carry?.overrides ?? {})) if (files[p]) overrides[p] = t
  overrides[wbPath] = kind === 'xlsm' ? CT.workbookMacro : kind === 'xltx' ? CT.template : kind === 'xltm' ? CT.templateMacro : CT.workbook
  for (const sh of wb.sheets) {
    const p = carry?.sheets[sh.id]?.path
    if (p) overrides[p] = CT.worksheet
  }
  for (const r of wbRels) if (r.type === REL.worksheet) overrides[resolveTarget(wbPath, r.target)] = CT.worksheet
  overrides[stylesPath] = CT.styles
  if (strings.length) overrides[ssPath] = CT.sharedStrings
  else delete overrides[ssPath]
  if (anyDynamic) overrides[metaPath] = CT.metadata
  for (const p of Object.keys(files)) if (/\/tables\/table\d+\.xml$/.test(p)) overrides[p] = CT.table
  for (const p of Object.keys(files)) if (/\/charts\/chart\d+\.xml$/.test(p) && !overrides[p]) overrides[p] = CT_CHART
  for (const p of Object.keys(files)) if (/\/pivotTables\/pivotTable\d+\.xml$/.test(p)) overrides[p] = CT_PIVOT_TABLE
  for (const p of Object.keys(files)) if (/^customXml\/itemProps\d+\.xml$/.test(p)) overrides[p] = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml'
  for (const p of Object.keys(files)) if (/\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(p)) overrides[p] = CT_PIVOT_CACHE
  for (const p of Object.keys(files)) if (/\/drawings\/drawing\d+\.xml$/.test(p) && !overrides[p]) overrides[p] = CT_DRAWING
  for (const p of Object.keys(files)) if (/\/comments\d*\.xml$/.test(p)) overrides[p] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'
  if (Object.keys(files).some((p) => p.endsWith('.vml'))) defaults.vml = 'application/vnd.openxmlformats-officedocument.vmlDrawing'
  overrides['docProps/app.xml'] = CT.app
  if (files['docProps/core.xml']) overrides['docProps/core.xml'] = CT.core
  for (const p of Object.keys(overrides)) if (!files[p]) delete overrides[p]
  files['[Content_Types].xml'] = bytes(contentTypesXml(defaults, overrides))

  return { data: writeZip(files), warnings: w.list }
}

function isXlsxCarry(c: unknown): boolean {
  return !!c && typeof c === 'object' && 'workbookPath' in (c as object) && 'files' in (c as object)
}

function relTarget(from: string, to: string): string {
  const a = from.split('/').slice(0, -1)
  const b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

function richText(rich: string): string {
  let t = ''
  for (const m of rich.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) t += m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  return t
}

function workbookXml(wb: Workbook, carry: XlsxCarry | undefined, rids: string[], sheetName: (id: number) => string | null, fname: (n: string) => string, newCaches: string[] = []): string {
  const els = carry?.workbookElements ?? []
  const raw = (n: string) => els.filter((e) => e.name === n).map((e) => e.xml).join('')
  let wbPr = raw('workbookPr')
  if (!wbPr) wbPr = `<workbookPr${wb.date1904 ? ' date1904="1"' : ''} defaultThemeVersion="164011"/>`
  else wbPr = wbPr.replace(/\sdate1904="[^"]*"/, '').replace(/^<(\w+:)?workbookPr/, wb.date1904 ? '$&' + ' date1904="1"' : '$&')
  let bookViews = raw('bookViews')
  if (!bookViews) bookViews = `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="${wb.activeSheet}"/></bookViews>`
  else bookViews = bookViews.replace(/\sactiveTab="\d+"/, '').replace(/<(\w+:)?workbookView\b/, `$&${wb.activeSheet ? ` activeTab="${wb.activeSheet}"` : ''}`).replace(/\sfirstSheet="\d+"/, '')
  const sheets = wb.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ` state="${s.hidden}"` : ''} r:id="${rids[i]}"/>`).join('')
  // Excel keeps each sheet AutoFilter's range in a hidden name; regenerate them from the model.
  const filterNames: DefinedName[] = wb.sheets.flatMap((s) => (s.autoFilter ? [{ name: '_xlnm._FilterDatabase', scope: s.id, text: `${quoteSheet(s.name)}!${areaName(s.autoFilter.area).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`, hidden: true }] : []))
  const names = [...wb.names.filter((n) => n.name.toLowerCase() !== '_xlnm._filterdatabase'), ...filterNames]
    .map((n) => {
      const local = n.scope !== null ? wb.sheetIndex(n.scope) : -1
      if (n.scope !== null && local < 0) return ''
      const txt = n.ast && !/^_xlnm\./i.test(n.name) ? printFormula(n.ast, { row: 0, col: 0, sheetName, fileNames: fname }) : n.text
      return `<definedName name="${esc(n.name)}"${local >= 0 ? ` localSheetId="${local}"` : ''}${n.hidden ? ' hidden="1"' : ''}${n.comment ? ` comment="${esc(n.comment)}"` : ''}>${esc(txt)}</definedName>`
    })
    .join('')
  const calc = `<calcPr calcId="191029"${wb.calc.mode !== 'auto' ? ` calcMode="${wb.calc.mode}"` : ''}${wb.calc.iterate ? ` iterate="1" iterateCount="${wb.calc.maxIterations}" iterateDelta="${wb.calc.maxChange}"` : ''}${!wb.calc.fullPrecision ? ' fullPrecision="0"' : ''}/>`
  // Elements in CT_Workbook order; the ones we don't model are kept as they were.
  const before = ['fileVersion', 'fileSharing'].map(raw).join('')
  const afterPr = ['workbookProtection'].map(raw).join('')
  const afterSheets = ['functionGroups', 'externalReferences'].map(raw).join('')
  // PivotTables created in Simple Cell add their caches to the file's.
  const caches = newCaches.length ? (raw('pivotCaches') ? raw('pivotCaches').replace(/<\/(\w+:)?pivotCaches>$/, (m) => newCaches.join('') + m) : `<pivotCaches>${newCaches.join('')}</pivotCaches>`) : raw('pivotCaches')
  const afterCalc = ['oleSize', 'customWorkbookViews'].map(raw).join('') + caches + ['smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst'].map(raw).join('')
  const known = new Set(['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst'])
  const other = els.filter((e) => !known.has(e.name)).map((e) => e.xml).join('')
  return (
    HEAD +
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${R_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6" xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" mc:Ignorable="x15 xr xr6 xr10 xr2">` +
    before +
    wbPr +
    afterPr +
    bookViews +
    `<sheets>${sheets}</sheets>` +
    afterSheets +
    (names ? `<definedNames>${names}</definedNames>` : '') +
    calc +
    afterCalc +
    other +
    '</workbook>'
  )
}

function tableXml(t: Table, wb: Workbook): string {
  const ref = areaName(t.area)
  const orig = (t.carry as { xml?: string; sig?: string } | undefined)?.xml
  // A table changed in Simple Cell is written afresh (its extension elements go); an unchanged one as it was.
  if (orig && (t.carry as { sig?: string }).sig === tableSig(t)) {
    // Unchanged tables are written as they were; a moved or resized table gets its new range.
    return orig.replace(/(<(?:\w+:)?table\b[^>]*\sref=")[^"]*(")/, `$1${ref}$2`).replace(/(<(?:\w+:)?autoFilter\b[^>]*\sref=")[^"]*(")/, `$1${areaName({ ...t.area, r1: t.totalsRow ? t.area.r1 - 1 : t.area.r1 })}$2`)
  }
  void wb
  const cols = t.columns.map((c, i) => `<tableColumn id="${i + 1}" name="${esc(c.name)}"${c.totalsFunction ? ` totalsRowFunction="${c.totalsFunction}"` : ''}${c.totalsLabel ? ` totalsRowLabel="${esc(c.totalsLabel)}"` : ''}${c.formula ? `><calculatedColumnFormula>${escText(c.formula)}</calculatedColumnFormula></tableColumn>` : '/>'}`)
  return (
    HEAD +
    `<table xmlns="${MAIN_NS}" id="${t.id}" name="${esc(t.name)}" displayName="${esc(t.displayName)}" ref="${ref}"${t.headerRow ? '' : ' headerRowCount="0"'}${t.totalsRow ? ' totalsRowCount="1"' : ''}>` +
    (t.autoFilter !== false && t.headerRow ? `<autoFilter ref="${areaName({ ...t.area, r1: t.totalsRow ? t.area.r1 - 1 : t.area.r1 })}"${t.filter?.length ? `>${filterColumnsXml(t.filter)}</autoFilter>` : '/>'}` : '') +
    `<tableColumns count="${cols.length}">${cols.join('')}</tableColumns>` +
    `<tableStyleInfo name="${esc(t.style ?? 'TableStyleMedium2')}" showFirstColumn="${t.showFirstColumn ? 1 : 0}" showLastColumn="${t.showLastColumn ? 1 : 0}" showRowStripes="${t.showRowStripes === false ? 0 : 1}" showColumnStripes="${t.showColumnStripes ? 1 : 0}"/>` +
    '</table>'
  )
}

// ---------- worksheet ----------

function sheetXml(
  sh: Sheet,
  wb: Workbook,
  sc: SheetCarry | undefined,
  styles: StyleWriter,
  sharedString: (t: string, rich?: unknown) => number,
  sheetName: (id: number) => string | null,
  fname: (n: string) => string,
  tableParts: string[],
  w: Warnings,
  extra: Record<string, string> = {}
): { xml: string; dynamic: boolean } {
  const parts = new Map<string, string>(Object.entries(extra))
  // sheetPr
  const [prAttrs, prRaw] = (sc?.sheetPr ?? '').split('\u0000')
  const tab = sh.tabColor ? `<tabColor rgb="${rgb(sh.tabColor)}"/>` : ''
  // Fit to page lives in sheetPr/pageSetUpPr (after outlinePr).
  let prInner = (prRaw ?? '').replace(/<(?:\w+:)?pageSetUpPr\b[^>]*\/>/, '')
  if (sh.pageSetup.fitToPage) prInner += '<pageSetUpPr fitToPage="1"/>'
  if (prAttrs || tab || prInner) parts.set('sheetPr', `<sheetPr${prAttrs ? ' ' + prAttrs : ''}>${tab}${prInner}</sheetPr>`)
  // dimension
  const u = sh.used()
  parts.set('dimension', `<dimension ref="${u.r < 0 ? 'A1' : areaName({ r0: 0, c0: 0, r1: Math.max(0, u.r), c1: Math.max(0, u.c) })}"/>`)
  // sheetViews
  const keep = Object.entries(sc?.sheetView ?? {}).filter(([k]) => !['tabSelected', 'showGridLines', 'zoomScale', 'zoomScaleNormal', 'workbookViewId', 'topLeftCell'].includes(k) && !k.startsWith('xmlns'))
  const viewAttrs = [...keep.map(([k, v]) => `${k}="${esc(v)}"`), wb.sheets[wb.activeSheet] === sh ? 'tabSelected="1"' : '', sh.showGridlines ? '' : 'showGridLines="0"', sh.zoom !== 1 ? `zoomScale="${Math.round(sh.zoom * 100)}" zoomScaleNormal="${Math.round(sh.zoom * 100)}"` : '', 'workbookViewId="0"'].filter(Boolean)
  const { rows: fr, cols: fc } = sh.freeze
  const pane = fr || fc ? `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${cellName(fr, fc)}" activePane="${fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : ''
  parts.set('sheetViews', `<sheetViews><sheetView ${viewAttrs.join(' ')}>${pane}</sheetView></sheetViews>`)
  // sheetFormatPr
  const sfp = { ...(sc?.sheetFormatPr ?? {}) }
  for (const k of Object.keys(sfp)) if (k.startsWith('xmlns')) delete sfp[k]
  sfp.defaultRowHeight = String(pxToPt(sh.defaultRowHeight))
  if (sh.defaultColWidth !== 64 || sfp.defaultColWidth) sfp.defaultColWidth = String(pxToWidth(sh.defaultColWidth))
  delete sfp['x14ac:dyDescent']
  // Excel shows outline symbols only up to these levels.
  const maxRow = Math.max(0, ...[...sh.rowInfo.values()].map((i) => i.outline ?? 0))
  const maxCol = Math.max(0, ...[...sh.cols.values()].map((i) => i.outline ?? 0))
  if (maxRow) sfp.outlineLevelRow = String(maxRow)
  else delete sfp.outlineLevelRow
  if (maxCol) sfp.outlineLevelCol = String(maxCol)
  else delete sfp.outlineLevelCol
  parts.set('sheetFormatPr', `<sheetFormatPr ${Object.entries(sfp).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`)
  // cols (consecutive identical columns grouped)
  const colKeys = [...sh.cols.keys()].sort((a, b) => a - b)
  const colEls: string[] = []
  for (let i = 0; i < colKeys.length; ) {
    const c0 = colKeys[i]
    const info = sh.cols.get(c0)!
    const sig = JSON.stringify(info)
    let j = i
    while (j + 1 < colKeys.length && colKeys[j + 1] === colKeys[j] + 1 && JSON.stringify(sh.cols.get(colKeys[j + 1])) === sig) j++
    const width = info.width ?? sh.defaultColWidth
    const attrs = [`min="${c0 + 1}"`, `max="${colKeys[j] + 1}"`, `width="${pxToWidth(width || sh.defaultColWidth)}"`]
    if (info.width !== undefined) attrs.push('customWidth="1"')
    if (info.hidden || info.width === 0) attrs.push('hidden="1"')
    if (info.style) attrs.push(`style="${styles.xf(info.style)}"`)
    if (info.outline) attrs.push(`outlineLevel="${info.outline}"`)
    if (info.collapsed) attrs.push('collapsed="1"')
    colEls.push(`<col ${attrs.join(' ')}/>`)
    i = j + 1
  }
  if (colEls.length) parts.set('cols', `<cols>${colEls.join('')}</cols>`)
  // sheetData
  const spillArea = new Map<number, { r1: number; c1: number }>()
  for (const [r, row] of sh.rows)
    for (const [c, cell] of row) {
      if (cell.spillOf === undefined) continue
      const a = spillArea.get(cell.spillOf)
      if (!a) spillArea.set(cell.spillOf, { r1: r, c1: c })
      else spillArea.set(cell.spillOf, { r1: Math.max(a.r1, r), c1: Math.max(a.c1, c) })
    }
  let dynamic = false
  const rowIdx = [...new Set([...sh.rows.keys(), ...sh.rowInfo.keys()])].sort((a, b) => a - b)
  const rowsXml: string[] = []
  for (const r of rowIdx) {
    if (r >= MAX_ROWS) continue
    const ri = sh.rowInfo.get(r)
    const row = sh.rows.get(r)
    const ra = [`r="${r + 1}"`]
    if (ri?.height !== undefined && !ri.hidden) ra.push(`ht="${pxToPt(ri.height)}"`, 'customHeight="1"')
    if (ri?.hidden || ri?.height === 0) ra.push('hidden="1"')
    if (ri?.style) ra.push(`s="${styles.xf(ri.style)}"`, 'customFormat="1"')
    if (ri?.outline) ra.push(`outlineLevel="${ri.outline}"`)
    if (ri?.collapsed) ra.push('collapsed="1"')
    const cells: string[] = []
    if (row) {
      for (const c of [...row.keys()].sort((a, b) => a - b)) {
        if (c >= MAX_COLS) continue
        const t = sh.dataTables.find((d) => d.area.r0 === r && d.area.c0 === c)
        const x = cellXml(sh, r, c, row.get(c)!, styles, sharedString, sheetName, fname, spillArea, t ? dataTableFormulaXml(t) : '')
        if (x.dynamic) dynamic = true
        if (x.xml) cells.push(x.xml)
      }
    }
    if (!cells.length && !ri) continue
    rowsXml.push(cells.length ? `<row ${ra.join(' ')}>${cells.join('')}</row>` : `<row ${ra.join(' ')}/>`)
  }
  parts.set('sheetData', `<sheetData>${rowsXml.join('')}</sheetData>`)
  if (sh.merges.length) parts.set('mergeCells', `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${areaName(m)}"/>`).join('')}</mergeCells>`)
  if (sh.autoFilter) parts.set('autoFilter', autoFilterXml(sh.autoFilter))
  if (sh.scenarios) parts.set('scenarios', scenariosXml(sh.scenarios))
  if (sh.condFormats.length) parts.set('conditionalFormatting', condFormatsXml(sh.condFormats, (r) => styles.dxf(r), sheetName, fname))
  if (sh.validations.length) parts.set('dataValidations', validationsXml(sh.validations, sheetName, fname))
  if (tableParts.length) parts.set('tableParts', `<tableParts count="${tableParts.length}">${tableParts.join('')}</tableParts>`)
  void w
  // Assemble in schema order, slotting the preserved elements in.
  const preserved = sc?.elements ?? []
  const byName = new Map<string, string[]>()
  let anchor = ''
  const after = new Map<string, string[]>() // unknown elements, after the known one they followed
  for (const e of preserved) {
    if (ORDER.includes(e.name)) {
      const list = byName.get(e.name) ?? []
      list.push(e.xml)
      byName.set(e.name, list)
      anchor = e.name
    } else {
      const list = after.get(anchor) ?? []
      list.push(e.xml)
      after.set(anchor, list)
    }
  }
  let body = (after.get('') ?? []).join('')
  for (const name of ORDER) {
    // Generated elements first; preserved ones of the same kind (conditional formats that couldn't be read) after.
    const gen = parts.get(name) ?? ''
    // Elements regenerated from the model replace the kept ones (an empty string removes them).
    const kept = name in extra ? [] : (byName.get(name) ?? [])
    if (name === 'dataValidations' && gen && kept.length) {
      // Only one <dataValidations> is allowed: the kept rules go inside the generated element.
      const inner = kept.map((x) => x.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '')).join('')
      const merged = gen.replace('</dataValidations>', inner + '</dataValidations>')
      body += merged.replace(/count="\d+"/, `count="${(merged.match(/<(?:\w+:)?dataValidation\b/g) ?? []).length}"`)
    } else body += gen + kept.join('')
    body += (after.get(name) ?? []).join('')
  }
  const rootAttrs = `xmlns="${MAIN_NS}" xmlns:r="${R_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" mc:Ignorable="x14ac xr"`
  return { xml: HEAD + `<worksheet ${rootAttrs}>${body}</worksheet>`, dynamic }
}

function cellXml(
  sh: Sheet,
  r: number,
  c: number,
  cell: Cell,
  styles: StyleWriter,
  sharedString: (t: string, rich?: unknown) => number,
  sheetName: (id: number) => string | null,
  fname: (n: string) => string,
  spillArea: Map<number, { r1: number; c1: number }>,
  dataTable = ''
): { xml: string; dynamic?: boolean } {
  const ref = `${colName(c)}${r + 1}`
  const s = cell.s ? styles.xf(cell.s) : 0
  const sAttr = s ? ` s="${s}"` : ''
  const v = cell.v
  if (dataTable) {
    // A data table's first result cell carries the table; its value (and the others') are the cached results.
    const t = typeof v === 'string' ? ' t="str"' : typeof v === 'boolean' ? ' t="b"' : v instanceof CellError ? ' t="e"' : ''
    const val = v === null ? '' : `<v>${escText(typeof v === 'boolean' ? (v ? '1' : '0') : v instanceof CellError ? v.code : typeof v === 'number' ? numStr(v) : v)}</v>`
    return { xml: `<c r="${ref}"${sAttr}${t}>${dataTable}${val}</c>` }
  }
  if (cell.f) {
    const text = printFormula(cell.f.ast, { row: r, col: c, sheetName, fileNames: fname })
    let fEl: string
    let cm = ''
    let dynamic = false
    if (cell.f.array) fEl = `<f t="array" ref="${areaName(cell.f.array)}">${escText(text)}</f>`
    else {
      const sp = spillArea.get(cellKey(sh.id, r, c))
      if (sp) {
        fEl = `<f t="array" ref="${ref}:${colName(sp.c1)}${sp.r1 + 1}">${escText(text)}</f>`
        cm = ' cm="1"'
        dynamic = true
      } else fEl = `<f>${escText(text)}</f>`
    }
    const t = typeof v === 'string' ? ' t="str"' : typeof v === 'boolean' ? ' t="b"' : v instanceof CellError ? ' t="e"' : ''
    const val = v === null ? '' : `<v>${escText(typeof v === 'boolean' ? (v ? '1' : '0') : v instanceof CellError ? v.code : typeof v === 'number' ? numStr(v) : v)}</v>`
    return { xml: `<c r="${ref}"${sAttr}${t}${cm}>${fEl}${val}</c>`, dynamic }
  }
  if (v === null) return { xml: s ? `<c r="${ref}"${sAttr}/>` : '' }
  if (typeof v === 'number') return { xml: `<c r="${ref}"${sAttr}><v>${numStr(v)}</v></c>` }
  if (typeof v === 'boolean') return { xml: `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>` }
  if (v instanceof CellError) return { xml: `<c r="${ref}"${sAttr} t="e"><v>${esc(v.code)}</v></c>` }
  return { xml: `<c r="${ref}"${sAttr} t="s"><v>${sharedString(v, cell.rich)}</v></c>` }
}

/** Element text: only & < > need escaping (Excel writes quotes as they are). */

/** Shortest text that reads back as the same double. */
function numStr(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const s = String(n)
  return s.includes('e') ? n.toExponential().replace('e+', 'E+').replace('e-', 'E-') : s
}

export { numberToText, fromKey, text }

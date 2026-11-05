// OpenDocument Spreadsheet (.ods) reader.
import { Workbook, type Cell, type Sheet } from '../../model/workbook'
import type { BorderSide, Style } from '../../model/styles'
import { parseFormula, type Node as AstNode } from '../../engine/parser'
import { CellError, ERROR_CODES, MAX_COLS, MAX_ROWS } from '../../engine/values'
import { dateSerial } from '../../numfmt/dates'
import { readZip, text } from '../zip'
import { attr, deep, elements, kid, kids, parseXml, serialize, textOf, type El } from '../xml'
import { Warnings, type ImportResult } from '../types'
import { odfRefToA1, odfToExcel } from './formula'
import { readMacros } from '../macros'

export interface OdsCarry {
  kind: 'ods'
  files: Record<string, Uint8Array>
  /** Spreadsheet-level elements we keep (validations, database ranges, pivot tables…). */
  spreadsheetElements: string[]
  /** Automatic styles of families we don't regenerate (graphics, paragraphs, text) — kept for preserved content. */
  autoStyles: string[]
  /** Per sheet id: table-level elements kept (shapes, conditional formats, forms). */
  sheets: Record<number, { elements: string[]; attrs: Record<string, string> }>
  /** Namespace declarations of the original content.xml root. */
  rootNs: Record<string, string>
}

const UNIT: Record<string, number> = { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, px: 1 }
export function lengthPx(v: string | null | undefined): number | null {
  const m = v ? /^([\d.]+)(in|cm|mm|pt|pc|px)$/.exec(v.trim()) : null
  return m ? Math.round(Number(m[1]) * UNIT[m[2]]) : null
}

// ---------- data styles → Excel format codes ----------

function dataStyleCode(el: El, all: Map<string, El>): string {
  const local = el.localName
  let code = ''
  for (const c of elements(el)) {
    const n = c.localName
    const longStyle = attr(c, 'style') === 'long'
    if (n === 'number') {
      const dec = Number(attr(c, 'decimal-places') ?? attr(c, 'min-decimal-places') ?? 0)
      const minDec = Number(attr(c, 'min-decimal-places') ?? dec)
      const minInt = Number(attr(c, 'min-integer-digits') ?? 1)
      const group = attr(c, 'grouping') === 'true'
      const int = group ? '#,##' + '0'.repeat(Math.max(1, minInt)) : '0'.repeat(minInt) || '#'
      code += int + (dec ? '.' + '0'.repeat(minDec) + '#'.repeat(Math.max(0, dec - minDec)) : '')
    } else if (n === 'scientific-number') {
      const dec = Number(attr(c, 'decimal-places') ?? 2)
      code += '0' + (dec ? '.' + '0'.repeat(dec) : '') + 'E+' + '0'.repeat(Number(attr(c, 'min-exponent-digits') ?? 2))
    } else if (n === 'fraction') {
      const den = attr(c, 'denominator-value')
      const digits = Number(attr(c, 'min-denominator-digits') ?? 1)
      code += `# ${'?'.repeat(Number(attr(c, 'min-numerator-digits') ?? digits))}/${den ?? '?'.repeat(digits)}`
    } else if (n === 'text') code += `"${textOf(c).replace(/"/g, '\\"')}"`.replace(/^"%"$/, '%').replace(/^" "$/, ' ').replace(/^"([-/:.,])"$/, '$1')
    else if (n === 'currency-symbol') code += `"${textOf(c)}"`
    else if (n === 'year') code += longStyle ? 'yyyy' : 'yy'
    else if (n === 'month') code += attr(c, 'textual') === 'true' ? (longStyle ? 'mmmm' : 'mmm') : longStyle ? 'mm' : 'm'
    else if (n === 'day') code += longStyle ? 'dd' : 'd'
    else if (n === 'day-of-week') code += longStyle ? 'dddd' : 'ddd'
    else if (n === 'hours') code += local === 'time-style' && attr(el, 'truncate-on-overflow') === 'false' ? '[h]' : longStyle ? 'hh' : 'h'
    else if (n === 'minutes') code += longStyle ? 'mm' : 'm'
    else if (n === 'seconds') code += (longStyle ? 'ss' : 's') + (Number(attr(c, 'decimal-places') ?? 0) ? '.' + '0'.repeat(Number(attr(c, 'decimal-places'))) : '')
    else if (n === 'am-pm') code += 'AM/PM'
    else if (n === 'text-content') code += '@'
    else if (n === 'boolean') code += '"TRUE";"TRUE";"FALSE"'
  }
  if (local === 'percentage-style' && !code.includes('%')) code += '%'
  if (local === 'text-style' && !code) code = '@'
  // Conditional sections: <style:map style:condition="value()<0" style:apply-style-name="N1N"/>
  const maps = kids(el, 'map')
  if (maps.length) {
    const neg = maps.find((m) => /value\(\)\s*<\s*0/.test(attr(m, 'condition') ?? ''))
    if (neg) {
      const other = all.get(attr(neg, 'apply-style-name') ?? '')
      if (other) return `${dataStyleCode(other, all)};${code}`
    }
    const pos = maps.find((m) => /value\(\)\s*>=\s*0/.test(attr(m, 'condition') ?? ''))
    if (pos) {
      const other = all.get(attr(pos, 'apply-style-name') ?? '')
      if (other) return `${dataStyleCode(other, all)};${code}`
    }
  }
  const color = attr(kid(el, 'text-properties'), 'color')
  if (color && /^#ff0000$/i.test(color)) code = '[Red]' + code
  return code.replace(/""/g, '')
}

// ---------- cell styles ----------

function borderOf(v: string | null): BorderSide | undefined {
  if (!v || v === 'none') return undefined
  const m = /([\d.]+)(pt|mm|cm|in|px)\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\s+(#[0-9a-fA-F]{6})/.exec(v)
  if (!m) return { style: 'thin' }
  const w = Number(m[1]) * (UNIT[m[2]] ?? 1)
  const style = m[3] === 'double' ? 'double' : m[3] === 'dashed' ? 'dashed' : m[3] === 'dotted' ? 'dotted' : w > 2.5 ? 'thick' : w > 1.2 ? 'medium' : 'thin'
  return { style, color: m[4].toLowerCase() === '#000000' ? undefined : m[4] }
}

function cellStyleOf(el: El, parent: Style | undefined, dataStyles: Map<string, string>): Style {
  const s: Style = { ...(parent ?? {}) }
  delete s.carry
  const ds = attr(el, 'data-style-name')
  if (ds && dataStyles.has(ds)) {
    const code = dataStyles.get(ds)!
    if (code && code !== 'General') s.numFmt = code
  }
  const cp = kid(el, 'table-cell-properties')
  if (cp) {
    const bg = attr(cp, 'background-color')
    if (bg && bg !== 'transparent') s.fill = bg
    const all = attr(cp, 'border')
    const b = borderOf(all)
    if (b) s.borderTop = s.borderBottom = s.borderLeft = s.borderRight = b
    for (const [k, side] of [['border-top', 'borderTop'], ['border-bottom', 'borderBottom'], ['border-left', 'borderLeft'], ['border-right', 'borderRight']] as const) {
      const v = attr(cp, k)
      if (v !== null) {
        const bs = borderOf(v)
        if (bs) s[side] = bs
        else delete s[side]
      }
    }
    if (attr(cp, 'wrap-option') === 'wrap') s.wrap = true
    const va = attr(cp, 'vertical-align')
    if (va === 'top' || va === 'middle') s.vAlign = va === 'middle' ? 'center' : 'top'
    const rot = attr(cp, 'rotation-angle')
    if (rot && Number(rot)) s.rotation = Number(rot) > 90 ? Number(rot) - 360 : Number(rot)
    if (attr(cp, 'shrink-to-fit') === 'true') s.shrink = true
    if (attr(cp, 'cell-protect') === 'none') s.locked = false
  }
  const pp = kid(el, 'paragraph-properties')
  if (pp) {
    const ta = attr(pp, 'text-align')
    if (ta === 'center') s.hAlign = 'center'
    else if (ta === 'end' || ta === 'right') s.hAlign = 'right'
    else if (ta === 'start' || ta === 'left') s.hAlign = 'left'
    else if (ta === 'justify') s.hAlign = 'justify'
    const ml = lengthPx(attr(pp, 'margin-left'))
    if (ml) s.indent = Math.round(ml / 9)
  }
  const tp = kid(el, 'text-properties')
  if (tp) {
    if (attr(tp, 'font-weight') === 'bold') s.bold = true
    if (attr(tp, 'font-style') === 'italic') s.italic = true
    const u = attr(tp, 'text-underline-style')
    if (u && u !== 'none') s.underline = attr(tp, 'text-underline-type') === 'double' ? 'double' : 'single'
    const lt = attr(tp, 'text-line-through-style')
    if (lt && lt !== 'none') s.strike = true
    const c = attr(tp, 'color')
    if (c && c.toLowerCase() !== '#000000') s.color = c
    const fs = attr(tp, 'font-size')
    if (fs && /pt$/.test(fs)) s.size = Number(fs.replace('pt', ''))
    const fn = attr(tp, 'font-name') ?? attr(tp, 'font-family')
    if (fn) s.font = fn.replace(/^'|'$/g, '')
    const pos = attr(tp, 'text-position')
    if (pos && /^super/.test(pos)) s.vertAlign = 'superscript'
    if (pos && /^sub/.test(pos)) s.vertAlign = 'subscript'
  }
  return s
}

// ---------- reading ----------

export function readOds(bytes: Uint8Array): ImportResult & { carry: OdsCarry } {
  const files = readZip(bytes)
  const mimetype = text(files.mimetype).trim()
  if (mimetype && mimetype !== 'application/vnd.oasis.opendocument.spreadsheet' && mimetype !== 'application/vnd.oasis.opendocument.spreadsheet-template') throw new Error('This is not an OpenDocument spreadsheet.')
  const contentXml = text(files['content.xml'])
  if (!contentXml) throw new Error('The file has no spreadsheet content. It may be damaged.')
  const w = new Warnings()
  const wb = new Workbook()
  const content = parseXml(contentXml)
  const styles = parseXml(text(files['styles.xml']) || '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>')
  const rootNs: Record<string, string> = {}
  const ra = content.documentElement.attributes
  for (let i = 0; i < ra.length; i++) {
    const a = ra.item(i)!
    if (a.name.startsWith('xmlns:')) rootNs[a.name] = a.value
  }

  // Data styles (number, date, time…) from both style parts.
  const dataEls = new Map<string, El>()
  for (const doc of [styles, content]) {
    for (const container of [...kids(doc.documentElement, 'styles'), ...kids(doc.documentElement, 'automatic-styles')])
      for (const el of elements(container)) if (/-style$/.test(el.localName) && el.namespaceURI?.includes('datastyle')) dataEls.set(attr(el, 'name') ?? '', el)
  }
  const dataStyles = new Map<string, string>()
  for (const [name, el] of dataEls) dataStyles.set(name, dataStyleCode(el, dataEls))

  // Cell styles: common (styles.xml) then automatic (content.xml), with parent inheritance.
  const styleEls = new Map<string, El>()
  for (const container of [...kids(styles.documentElement, 'styles'), ...kids(content.documentElement, 'automatic-styles')]) for (const el of kids(container, 'style')) styleEls.set(attr(el, 'name') ?? '', el)
  const defaultCell = kids(kid(styles.documentElement, 'styles'), 'default-style').find((e) => attr(e, 'family') === 'table-cell')
  const resolved = new Map<string, Style>()
  const resolve = (name: string, depth = 0): Style => {
    const hit = resolved.get(name)
    if (hit) return hit
    const el = styleEls.get(name)
    if (!el || depth > 20) return {}
    const parentName = attr(el, 'parent-style-name')
    const parent = parentName ? resolve(parentName, depth + 1) : defaultCell ? cellStyleOf(defaultCell, undefined, dataStyles) : undefined
    const s = cellStyleOf(el, parent, dataStyles)
    resolved.set(name, s)
    return s
  }
  const styleIds = new Map<string, number>()
  const styleId = (name: string | null): number | undefined => {
    if (!name) return undefined
    let id = styleIds.get(name)
    if (id === undefined) {
      const st = resolve(name)
      // The document default font/size are not cell formatting.
      const clean = { ...st }
      if (clean.font === 'Liberation Sans' || clean.font === 'Arial') delete clean.font
      if (clean.size === 10) delete clean.size
      id = wb.styles.intern(clean)
      styleIds.set(name, id)
    }
    return id || undefined
  }
  const colWidth = (name: string | null) => lengthPx(attr(kid(styleEls.get(name ?? ''), 'table-column-properties'), 'column-width'))
  const rowHeight = (name: string | null) => {
    const p = kid(styleEls.get(name ?? ''), 'table-row-properties')
    return attr(p, 'use-optimal-row-height') === 'true' ? null : lengthPx(attr(p, 'row-height'))
  }

  const spreadsheet = kid(kid(content.documentElement, 'body'), 'spreadsheet')
  const carry: OdsCarry = { kind: 'ods', files, spreadsheetElements: [], autoStyles: [], sheets: {}, rootNs }
  const auto = kid(content.documentElement, 'automatic-styles')
  for (const el of elements(auto)) {
    const fam = attr(el, 'family')
    if (el.localName === 'style' && (fam === 'table-cell' || fam === 'table-column' || fam === 'table-row')) continue
    if (/-style$/.test(el.localName) && el.namespaceURI?.includes('datastyle')) continue
    carry.autoStyles.push(serialize(el))
  }
  const tables = kids(spreadsheet, 'table')
  // Sheets first so formulas can refer to them.
  for (const t of tables) wb.addSheet(attr(t, 'name') ?? `Sheet${wb.sheets.length + 1}`)
  const sheetId = (n: string) => wb.sheetByName(n)?.id ?? null
  for (const el of elements(spreadsheet)) {
    if (el.localName === 'table') continue
    if (el.localName === 'named-expressions') {
      for (const n of elements(el)) {
        const name = attr(n, 'name') ?? ''
        const range = attr(n, 'cell-range-address')
        const expr = attr(n, 'expression')
        const txt = range ? odfToExcel(`[${range}]`).slice(1) : expr ? odfToExcel(expr).slice(1) : ''
        let ast: AstNode | undefined
        try {
          ast = parseFormula('=' + txt, { row: 0, col: 0, sheetId })
        } catch {
          ast = undefined
        }
        if (name) wb.names.push({ name, scope: null, text: txt, ast })
      }
      continue
    }
    if (el.localName === 'calculation-settings') {
      if (attr(kid(el, 'iteration'), 'status') === 'enable') wb.calc.iterate = true
      const nd = attr(kid(el, 'null-date'), 'date-value')
      if (nd === '1904-01-01') wb.date1904 = true
      continue
    }
    carry.spreadsheetElements.push(serialize(el))
    if (el.localName === 'data-pilot-tables') w.add('loss', 'Pivot tables are kept but can’t be refreshed or edited yet.')
    if (el.localName === 'content-validations') w.add('info', 'Data validation rules are kept and saved, but not enforced or editable yet.')
  }
  tables.forEach((t, i) => readTable(t, wb.sheets[i], { styleId, colWidth, rowHeight, sheetId, w, carry, date1904: wb.date1904 }))
  readSettings(text(files['settings.xml']), wb)
  wb.carry = carry
  if (files['SimpleCell/macros.xml']) wb.macros = readMacros(text(files['SimpleCell/macros.xml'])) ?? []
  return { workbook: wb, warnings: w.list, carry }
}

interface TableCtx {
  styleId: (n: string | null) => number | undefined
  colWidth: (n: string | null) => number | null
  rowHeight: (n: string | null) => number | null
  sheetId: (n: string) => number | null
  w: Warnings
  carry: OdsCarry
  date1904: boolean
}

const ERR_SET = new Set<string>(ERROR_CODES)

function readTable(t: El, sh: Sheet, ctx: TableCtx) {
  const kept: string[] = []
  const attrs: Record<string, string> = {}
  const ta = t.attributes
  for (let i = 0; i < ta.length; i++) {
    const a = ta.item(i)!
    if (!['table:name', 'table:style-name'].includes(a.name)) attrs[a.name] = a.value
  }
  if (attr(t, 'display') === 'false') sh.hidden = 'hidden'
  const colDefault: (number | undefined)[] = []
  let col = 0
  let row = 0
  const visitCols = (parent: El) => {
    for (const el of elements(parent)) {
      if (el.localName === 'table-column') {
        const n = Math.min(Number(attr(el, 'number-columns-repeated') ?? 1), MAX_COLS - col)
        const width = ctx.colWidth(attr(el, 'style-name'))
        const hidden = attr(el, 'visibility') === 'collapse' || attr(el, 'visibility') === 'filter'
        const def = ctx.styleId(attr(el, 'default-cell-style-name'))
        if (n < 2000 || width || hidden)
          for (let k = 0; k < n && col + k < MAX_COLS; k++) {
            const info: Record<string, unknown> = {}
            if (width && Math.abs(width - 64) > 1) info.width = width
            if (hidden) info.hidden = true
            if (Object.keys(info).length && n < 2000) sh.cols.set(col + k, info)
            if (def && n < 2000) colDefault[col + k] = def
          }
        col += n
      } else if (['table-columns', 'table-header-columns', 'table-column-group'].includes(el.localName)) visitCols(el)
    }
  }
  const visitRows = (parent: El) => {
    for (const el of elements(parent)) {
      const name = el.localName
      if (name === 'table-row') {
        const n = Math.min(Number(attr(el, 'number-rows-repeated') ?? 1), MAX_ROWS - row)
        const h = ctx.rowHeight(attr(el, 'style-name'))
        const hidden = attr(el, 'visibility') === 'collapse' || attr(el, 'visibility') === 'filter'
        const cells = elements(el)
        const hasContent = cells.some((c) => c.hasAttribute('office:value-type') || c.hasAttribute('table:formula') || elements(c).length)
        // Empty cells with only a style (a fill, a border) count too, unless they are a long repeated run.
        const styled = cells.some((c) => c.hasAttribute('table:style-name') && Number(c.getAttribute('table:number-columns-repeated') ?? 1) <= 256)
        if (hasContent || n < 1000) {
          for (let k = 0; k < n; k++) {
            if (h || hidden) sh.rowInfo.set(row + k, { ...(h ? { height: h, custom: true } : {}), ...(hidden ? { hidden: true, filtered: attr(el, 'visibility') === 'filter' } : {}) })
            if (hasContent || styled) readRow(el, sh, row + k, ctx, colDefault)
          }
        }
        row += n
        if (row >= MAX_ROWS) return
      } else if (['table-rows', 'table-header-rows', 'table-row-group'].includes(name)) visitRows(el)
    }
  }
  for (const el of elements(t)) {
    const n = el.localName
    if (['table-column', 'table-columns', 'table-header-columns', 'table-column-group'].includes(n)) continue
    if (['table-row', 'table-rows', 'table-header-rows', 'table-row-group'].includes(n)) continue
    kept.push(serialize(el))
    if (n === 'shapes') ctx.w.add('loss', 'Charts, pictures and shapes are kept and saved, but not shown yet.')
    if (n === 'conditional-formats') ctx.w.add('info', 'Conditional formatting is kept and saved, but not shown or editable yet.')
  }
  visitCols(t)
  visitRows(t)
  ctx.carry.sheets[sh.id] = { elements: kept, attrs }
}

function cellText(el: El): string {
  const lines: string[] = []
  for (const p of kids(el, 'p')) {
    let s = ''
    const walk = (n: Node) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.nodeValue
        else if (c.nodeType === 1) {
          const e = c as El
          if (e.localName === 's') s += ' '.repeat(Number(attr(e, 'c') ?? 1))
          else if (e.localName === 'tab') s += '\t'
          else if (e.localName === 'line-break') s += '\n'
          else if (e.localName !== 'annotation') walk(e)
        }
      }
    }
    walk(p)
    lines.push(s)
  }
  return lines.join('\n')
}

function readRow(el: El, sh: Sheet, r: number, ctx: TableCtx, colDefault: (number | undefined)[]) {
  let c = 0
  for (const cel of elements(el)) {
    if (cel.localName !== 'table-cell' && cel.localName !== 'covered-table-cell') continue
    const rep = Math.min(Number(attr(cel, 'number-columns-repeated') ?? 1), MAX_COLS - c)
    const covered = cel.localName === 'covered-table-cell'
    const s = ctx.styleId(attr(cel, 'style-name')) ?? colDefault[c]
    const type = attr(cel, 'value-type')
    const formula = attr(cel, 'formula')
    const spanC = Number(attr(cel, 'number-columns-spanned') ?? 1)
    const spanR = Number(attr(cel, 'number-rows-spanned') ?? 1)
    const all = elements(cel).filter((x) => x.localName !== 'p')
    const ann = all.find((x) => x.localName === 'annotation')
    const extras = all.filter((x) => x !== ann)
    const anchor = covered ? undefined : deep(cel, 'a')[0]
    const href = anchor ? attr(anchor, 'href') : null
    if (!covered && (spanC > 1 || spanR > 1)) sh.merges.push({ sheet: sh.id, r0: r, c0: c, r1: r + spanR - 1, c1: c + spanC - 1 })
    if (!covered)
      for (let k = 0; k < Math.min(rep, 256); k++) {
        const key = r * 16384 + c + k
        if (ann) sh.notes.set(key, { author: textOf(kid(ann, 'creator')), text: kids(ann, 'p').map((p) => textOf(p)).join('\n') })
        if (href) sh.links.set(key, href.startsWith('#') ? { location: odfRefToA1(href.slice(1)) } : { url: href })
      }
    const content = covered ? false : type !== null || formula !== null || extras.length > 0
    if (content || s) {
      // Large repeated blocks of empty styled cells are skipped (column default style covers them).
      const n = !content && rep > 256 ? 0 : rep
      for (let k = 0; k < n; k++) {
        const cell: Cell = { v: null }
        if (s) cell.s = s
        if (type === 'float' || type === 'percentage' || type === 'currency') cell.v = Number(attr(cel, 'value') ?? 0)
        else if (type === 'date') {
          const dv = attr(cel, 'date-value') ?? ''
          const m = /^(-?\d+)-(\d+)-(\d+)(?:T(\d+):(\d+):(\d+(?:\.\d+)?))?/.exec(dv)
          cell.v = m ? dateSerial(+m[1], +m[2], +m[3], ctx.date1904) + (m[4] ? (+m[4] * 3600 + +m[5] * 60 + +m[6]) / 86400 : 0) : cellText(cel)
        } else if (type === 'time') {
          const m = /^-?PT(\d+)H(\d+)M(\d+(?:\.\d+)?)S/.exec(attr(cel, 'time-value') ?? '')
          cell.v = m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) / 86400 : 0
        } else if (type === 'boolean') cell.v = attr(cel, 'boolean-value') === 'true'
        else if (type === 'string') cell.v = attr(cel, 'string-value') ?? cellText(cel)
        else if (type === null && formula) {
          const t = cellText(cel)
          cell.v = ERR_SET.has(t) ? CellError.of(t as never) : t || null
        }
        if (formula) {
          try {
            const excel = odfToExcel(formula)
            cell.f = { ast: parseFormula(excel, { row: r, col: c + k, sheetId: ctx.sheetId }), legacy: !/^of:=/.test(formula) && false }
            cell.stale = true
            if (typeof cell.v === 'string' && ERR_SET.has(cell.v)) cell.v = CellError.of(cell.v as never)
          } catch {
            ctx.w.add('loss', 'Some formulas could not be read and are kept as values.')
          }
        }
        if (extras.length) {
          cell.rich = { ods: extras.map((x) => serialize(x)).join('') }
        }
        if (cell.v !== null || cell.f || cell.s || cell.rich) sh.set(r, c + k, cell)
      }
    }
    c += rep
    if (c >= MAX_COLS) break
  }
}

function readSettings(xml: string, wb: Workbook) {
  if (!xml) return
  const doc = parseXml(xml)
  const items = (el: El | null) => {
    const m = new Map<string, string>()
    for (const it of kids(el, 'config-item')) m.set(attr(it, 'name') ?? '', textOf(it))
    return m
  }
  const views = [...doc.getElementsByTagName('config:config-item-map-indexed')].find((e) => attr(e as El, 'name') === 'Views') as El | undefined
  const entry = views ? kid(views, 'config-item-map-entry') : null
  if (!entry) return
  const top = items(entry)
  const active = top.get('ActiveTable')
  if (active) {
    const i = wb.sheets.findIndex((s) => s.name === active)
    if (i >= 0) wb.activeSheet = i
  }
  const tablesMap = kids(entry, 'config-item-map-named').find((e) => attr(e, 'name') === 'Tables')
  for (const t of kids(tablesMap, 'config-item-map-entry')) {
    const sh = wb.sheetByName(attr(t, 'name') ?? '')
    if (!sh) continue
    const m = items(t)
    const fc = m.get('HorizontalSplitMode') === '2' ? Number(m.get('HorizontalSplitPosition') ?? 0) : 0
    const fr = m.get('VerticalSplitMode') === '2' ? Number(m.get('VerticalSplitPosition') ?? 0) : 0
    if (fr || fc) sh.freeze = { rows: fr, cols: fc }
    if (m.get('ShowGrid') === 'false') sh.showGridlines = false
    const z = Number(m.get('ZoomValue') ?? 100)
    if (z && z !== 100) sh.zoom = z / 100
  }
  if (top.get('ShowGrid') === 'false') for (const s of wb.sheets) s.showGridlines = false
}

export { odfRefToA1 }

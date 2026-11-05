// Page layout elements of a worksheet: printOptions, pageMargins, pageSetup, headerFooter, rowBreaks, colBreaks.
import { defaultPageSetup, type PageSetup } from '../../print'
import { esc, escText, unescapeXml } from '../opc'
import { tagAttrs } from '../xml'

export const PAGE_ELEMENTS = new Set(['printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks'])

/** Page setup from the worksheet's elements (by name), and whether sheetPr asks to fit to pages. */
export function readPageSetup(elements: { name: string; xml: string }[], fitToPage: boolean): PageSetup {
  const ps = defaultPageSetup()
  const carry: Record<string, string> = {}
  const get = (n: string) => elements.find((e) => e.name === n)?.xml
  const po = get('printOptions')
  if (po) {
    const a = tagAttrs(po)
    ps.gridlines = a.gridLines === '1' || a.gridLines === 'true'
    ps.headings = a.headings === '1' || a.headings === 'true'
    ps.centerH = a.horizontalCentered === '1' || a.horizontalCentered === 'true'
    ps.centerV = a.verticalCentered === '1' || a.verticalCentered === 'true'
  }
  const pm = get('pageMargins')
  if (pm) {
    const a = tagAttrs(pm)
    for (const k of ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const) if (a[k] !== undefined) ps.margins[k] = Number(a[k])
  }
  const pg = get('pageSetup')
  if (pg) {
    const a = tagAttrs(pg)
    if (a.paperSize) ps.paper = Number(a.paperSize)
    if (a.orientation === 'landscape') ps.orientation = 'landscape'
    if (a.scale) ps.scale = Number(a.scale)
    if (a.fitToWidth !== undefined) ps.fitWidth = Number(a.fitToWidth)
    if (a.fitToHeight !== undefined) ps.fitHeight = Number(a.fitToHeight)
    if (a.pageOrder === 'overThenDown') ps.order = 'overThenDown'
    const rest = Object.entries(a).filter(([k]) => !['paperSize', 'orientation', 'scale', 'fitToWidth', 'fitToHeight', 'pageOrder'].includes(k) && !k.startsWith('xmlns'))
    if (rest.length) carry.pageSetup = rest.map(([k, v]) => `${k}="${esc(v)}"`).join(' ')
  }
  ps.fitToPage = fitToPage
  const hf = get('headerFooter')
  if (hf) {
    const text = (tag: string) => {
      const m = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(hf)
      return m ? unescapeXml(m[1]) : ''
    }
    ps.header = text('oddHeader')
    ps.footer = text('oddFooter')
    const extra = hf.replace(/<(?:\w+:)?(oddHeader|oddFooter)>[\s\S]*?<\/(?:\w+:)?\1>/g, '')
    carry.headerFooter = extra
  }
  const breaks = (n: string) => [...(get(n) ?? '').matchAll(/<(?:\w+:)?brk\b[^>]*>/g)].map((m) => Number(tagAttrs(m[0]).id)).filter((x) => x > 0)
  ps.rowBreaks = breaks('rowBreaks')
  ps.colBreaks = breaks('colBreaks')
  if (Object.keys(carry).length) ps.carry = carry
  return ps
}

/** The page layout elements for a sheet (by name), for the writer to slot into schema order. */
export function pageSetupXml(ps: PageSetup): Record<string, string> {
  const out: Record<string, string> = {}
  const po = [ps.headings && 'headings="1"', ps.gridlines && 'gridLines="1"', ps.centerH && 'horizontalCentered="1"', ps.centerV && 'verticalCentered="1"'].filter(Boolean)
  out.printOptions = po.length ? `<printOptions ${po.join(' ')}/>` : ''
  const m = ps.margins
  out.pageMargins = `<pageMargins left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}" header="${m.header}" footer="${m.footer}"/>`
  const pa = [`paperSize="${ps.paper}"`, ps.scale !== 100 ? `scale="${Math.round(ps.scale)}"` : '', ps.fitToPage ? `fitToWidth="${ps.fitWidth}" fitToHeight="${ps.fitHeight}"` : '', ps.order === 'overThenDown' ? 'pageOrder="overThenDown"' : '', `orientation="${ps.orientation}"`, ps.carry?.pageSetup ?? ''].filter(Boolean)
  out.pageSetup = `<pageSetup ${pa.join(' ')}/>`
  const inner = (ps.header ? `<oddHeader>${escText(ps.header)}</oddHeader>` : '') + (ps.footer ? `<oddFooter>${escText(ps.footer)}</oddFooter>` : '')
  const hfExtra = ps.carry?.headerFooter ?? ''
  const hfOpen = /^<(?:\w+:)?headerFooter\b[^>]*?(?:\/>|>)/.exec(hfExtra)?.[0]?.replace(/\/>$/, '>') ?? '<headerFooter>'
  const hfInner = hfExtra.replace(/^<(?:\w+:)?headerFooter\b[^>]*?(?:\/>|>)/, '').replace(/<\/(?:\w+:)?headerFooter>$/, '')
  out.headerFooter = inner || hfInner ? `${hfOpen}${inner}${hfInner}</headerFooter>` : ''
  const brk = (tag: string, list: number[], max: number) => (list.length ? `<${tag} count="${list.length}" manualBreakCount="${list.length}">${[...list].sort((a, b) => a - b).map((i) => `<brk id="${i}" max="${max}" man="1"/>`).join('')}</${tag}>` : '')
  out.rowBreaks = brk('rowBreaks', ps.rowBreaks, 16383)
  out.colBreaks = brk('colBreaks', ps.colBreaks, 1048575)
  return out
}

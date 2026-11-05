// Sparklines: tiny charts in cells (line, column, win/loss), in groups that share their look (Excel's model).
import { escText } from './formats/opc'
import { cellName, parseCell } from './refs'

export interface SparklineGroup {
  type: 'line' | 'column' | 'stacked'
  color: string
  negColor?: string
  markerColor?: string
  /** Show markers (line), and highlight the high, low, first, last and negative points. */
  markers?: boolean
  high?: boolean
  low?: boolean
  first?: boolean
  last?: boolean
  negative?: boolean
  lineWeight?: number
  /** Each sparkline: the cell it is drawn in and the data it plots (a reference, no "="). */
  items: { r: number; c: number; ref: string }[]
  /** Attributes and child elements of the group we keep but don't model. */
  carry?: string
}

export interface SparkView {
  type: SparklineGroup['type']
  values: (number | null)[]
  color: string
  negColor?: string
  markerColor?: string
  markers?: boolean
  high?: boolean
  low?: boolean
  first?: boolean
  last?: boolean
  negative?: boolean
}

export const SPARK_EXT = '{05C60535-1F16-4fd2-B633-F4F36F0B64E0}'

const colorOf = (xml: string, tag: string) => {
  const m = new RegExp(`<x14:${tag}\\b[^>]*\\brgb="([0-9A-Fa-f]{8})"`).exec(xml)
  return m ? '#' + m[1].slice(2).toUpperCase() : undefined
}

/** <x14:sparklineGroups> inside a worksheet extLst → groups (cells on the sheet itself only). */
export function readSparklines(extLst: string): SparklineGroup[] {
  const out: SparklineGroup[] = []
  for (const g of extLst.matchAll(/<x14:sparklineGroup\b([^>]*)>([\s\S]*?)<\/x14:sparklineGroup>/g)) {
    const attrs = g[1]
    const body = g[2]
    const a = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(attrs)?.[1]
    const on = (n: string) => a(n) === '1' || a(n) === 'true'
    const type = a('type') === 'column' ? 'column' : a('type') === 'stacked' ? 'stacked' : 'line'
    const items: SparklineGroup['items'] = []
    for (const s of body.matchAll(/<x14:sparkline>\s*<xm:f>([^<]*)<\/xm:f>\s*<xm:sqref>([^<]*)<\/xm:sqref>\s*<\/x14:sparkline>/g)) {
      const p = parseCell(s[2].trim())
      if (p) items.push({ r: p.r, c: p.c, ref: s[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'") })
    }
    if (!items.length) continue
    const g2: SparklineGroup = { type, color: colorOf(body, 'colorSeries') ?? '#376092', items }
    const neg = colorOf(body, 'colorNegative')
    if (neg) g2.negColor = neg
    const mk = colorOf(body, 'colorMarkers')
    if (mk) g2.markerColor = mk
    for (const k of ['markers', 'high', 'low', 'first', 'last', 'negative'] as const) if (on(k)) g2[k] = true
    if (a('lineWeight')) g2.lineWeight = Number(a('lineWeight'))
    // Kept as they were: empty-cell handling, axes, other colours.
    const keep = attrs.replace(/\s(type|markers|high|low|first|last|negative|lineWeight)="[^"]*"/g, '').trim()
    if (keep) g2.carry = keep
    out.push(g2)
  }
  return out
}

/** The extLst with the sparkline ext replaced by `groups` (removed when there are none). */
export function withSparklines(extLst: string | undefined, groups: SparklineGroup[]): string {
  const rgb = (c: string) => `FF${c.replace('#', '').toUpperCase()}`
  const xml = groups.length
    ? `<ext uri="${SPARK_EXT}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">${groups
        .map((g) => {
          const at = [g.carry ?? '', g.type !== 'line' ? `type="${g.type}"` : '', g.lineWeight !== undefined ? `lineWeight="${g.lineWeight}"` : '', ...(['markers', 'high', 'low', 'first', 'last', 'negative'] as const).map((k) => (g[k] ? `${k}="1"` : ''))].filter(Boolean).join(' ')
          const colors = `<x14:colorSeries rgb="${rgb(g.color)}"/><x14:colorNegative rgb="${rgb(g.negColor ?? '#C00000')}"/><x14:colorAxis rgb="FF000000"/>${g.markerColor ? ['Markers', 'First', 'Last', 'High', 'Low'].map((k) => `<x14:color${k} rgb="${rgb(g.markerColor!)}"/>`).join('') : ''}`
          return `<x14:sparklineGroup${at ? ' ' + at : ''}>${colors}<x14:sparklines>${g.items.map((i) => `<x14:sparkline><xm:f>${escText(i.ref)}</xm:f><xm:sqref>${cellName(i.r, i.c)}</xm:sqref></x14:sparkline>`).join('')}</x14:sparklines></x14:sparklineGroup>`
        })
        .join('')}</x14:sparklineGroups></ext>`
    : ''
  const without = (extLst ?? '').replace(new RegExp(`<(?:\\w+:)?ext\\b[^>]*uri="${SPARK_EXT.replace(/[{}]/g, '\\$&')}"[\\s\\S]*?<\\/(?:\\w+:)?ext>`), '')
  const inner = without.replace(/^<(?:\w+:)?extLst\b[^>]*>/, '').replace(/<\/(?:\w+:)?extLst>$/, '')
  const all = xml + inner
  return all.trim() ? `<extLst>${all}</extLst>` : ''
}

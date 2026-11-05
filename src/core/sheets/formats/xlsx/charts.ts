// Charts in SpreadsheetML packages: DrawingML chart parts and the drawing anchors that place them.
import type { Chart, ChartAnchor, ChartSeries, ChartType } from '../../charts'
import { chartSig, newChartId } from '../../charts'
import { escText } from '../opc'
import { attr, deep, kid, kids, parseXml, textOf, type El } from '../xml'

export const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart'
export const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
export const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const EMU = 9525

const TYPE_OF: Record<string, ChartType> = { barChart: 'column', bar3DChart: 'column', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area', pieChart: 'pie', pie3DChart: 'pie', ofPieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter' }
const ACCENT: Record<string, string> = { accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47' }

/** A chart part → model (null when its type isn't one Simple Cell draws; it is then kept as it is). */
export function readChart(xml: string, anchor: ChartAnchor, carry: Chart['carry']): Chart | null {
  const doc = parseXml(xml)
  const chartEl = kid(doc.documentElement, 'chart')
  const plot = kid(chartEl, 'plotArea')
  const typeEl = plot ? [...(plot.childNodes as unknown as El[])].find((e) => e.nodeType === 1 && TYPE_OF[e.localName]) : undefined
  if (!typeEl) return null
  let type = TYPE_OF[typeEl.localName]
  if (attr(kid(typeEl, 'barDir'), 'val') === 'bar') type = 'bar'
  const g = attr(kid(typeEl, 'grouping'), 'val')
  const grouping = g === 'stacked' ? 'stacked' : g === 'percentStacked' ? 'percent' : 'clustered'
  const f = (el: El | null) => (el ? textOf(deep(el, 'f')[0]) || undefined : undefined)
  const series: ChartSeries[] = kids(typeEl, 'ser').map((s) => {
    const out: ChartSeries = { val: f(kid(s, type === 'scatter' ? 'yVal' : 'val')) ?? '' }
    const name = kid(s, 'tx')
    if (name) out.name = f(name) ?? (textOf(deep(name, 'v')[0]) ? `"${textOf(deep(name, 'v')[0]).replace(/"/g, '""')}"` : undefined)
    const cat = f(kid(s, type === 'scatter' ? 'xVal' : 'cat'))
    if (cat) out.cat = cat
    const fill = kid(kid(s, 'spPr'), 'solidFill')
    const rgb = attr(kid(fill, 'srgbClr'), 'val')
    const scheme = attr(kid(fill, 'schemeClr'), 'val')
    if (rgb) out.color = '#' + rgb.toUpperCase()
    else if (scheme && ACCENT[scheme]) out.color = ACCENT[scheme]
    return out
  })
  if (!series.length || series.some((s) => !s.val)) return null
  const titleEl = kid(chartEl, 'title')
  const titleText = (el: El | null) => (el ? deep(el, 't').map((t) => textOf(t)).join('') : '')
  const legendPos = attr(kid(kid(chartEl, 'legend'), 'legendPos'), 'val')
  const axes = [...kids(plot, 'catAx'), ...kids(plot, 'valAx'), ...kids(plot, 'dateAx')]
  const axTitle = (pos: string[]) => titleText(kid(axes.find((a) => pos.includes(attr(kid(a, 'axPos'), 'val') ?? '')) ?? null, 'title')) || undefined
  const chart: Chart = {
    id: newChartId(),
    type,
    grouping,
    series,
    legend: !kid(chartEl, 'legend') ? 'none' : legendPos === 'b' ? 'bottom' : legendPos === 't' ? 'top' : legendPos === 'l' ? 'left' : 'right',
    anchor,
    carry
  }
  if (titleEl) chart.title = titleText(titleEl) || (series.length === 1 ? undefined : '')
  else if (attr(kid(chartEl, 'autoTitleDeleted'), 'val') === '1' || series.length > 1) chart.title = ''
  if (deep(typeEl, 'dLbls').some((d) => attr(kid(d, 'showVal'), 'val') === '1')) chart.dataLabels = true
  const xt = axTitle(type === 'bar' ? ['l', 'r'] : ['b', 't'])
  const yt = axTitle(type === 'bar' ? ['b', 't'] : ['l', 'r'])
  if (xt) chart.xTitle = xt
  if (yt) chart.yTitle = yt
  chart.carry = { ...carry, sig: chartSig(chart), anchorSig: JSON.stringify(anchor) }
  if (plot && [...(plot.childNodes as unknown as El[])].filter((e) => e.nodeType === 1 && /Chart$/.test(e.localName)).length > 1) chart.carry.note = 'combo'
  return chart
}

/** The chart anchors in a drawing part: each graphic frame's chart relationship id and its anchor. */
export function readAnchors(xml: string): { rid: string; anchor: ChartAnchor }[] {
  const doc = parseXml(xml)
  const out: { rid: string; anchor: ChartAnchor }[] = []
  for (const a of kids(doc.documentElement, 'twoCellAnchor')) {
    const chart = deep(a, 'chart')[0]
    const rid = chart ? (chart.getAttribute('r:id') ?? attr(chart, 'id')) : null
    if (!rid) continue
    const corner = (el: El | null) => ({ c: Number(textOf(kid(el, 'col')) || 0), dc: Math.round(Number(textOf(kid(el, 'colOff')) || 0) / EMU), r: Number(textOf(kid(el, 'row')) || 0), dr: Math.round(Number(textOf(kid(el, 'rowOff')) || 0) / EMU) })
    const f = corner(kid(a, 'from'))
    const t = corner(kid(a, 'to'))
    out.push({ rid, anchor: { r0: f.r, c0: f.c, dx0: f.dc, dy0: f.dr, r1: t.r, c1: t.c, dx1: t.dc, dy1: t.dr } })
  }
  return out
}

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const rich = (text: string) => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:t>${escText(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/>`
const ref = (tag: 'strRef' | 'numRef', f: string) => `<c:${tag}><c:f>${escText(f)}</c:f></c:${tag}>`

/** A chart part generated from the model. */
export function chartXml(c: Chart): string {
  const g = c.grouping
  const lineGrouping = g === 'stacked' ? 'stacked' : g === 'percent' ? 'percentStacked' : 'standard'
  const ser = c.series
    .map((s, i) => {
      const tx = s.name ? (/^".*"$/.test(s.name.trim()) ? `<c:tx><c:v>${escText(s.name.trim().slice(1, -1).replace(/""/g, '"'))}</c:v></c:tx>` : `<c:tx>${ref('strRef', s.name)}</c:tx>`) : ''
      const color = s.color?.replace('#', '').toUpperCase()
      const spPr = color ? (c.type === 'line' || c.type === 'scatter' ? `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`) : ''
      const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}${spPr}`
      if (c.type === 'scatter') return `<c:ser>${head}<c:marker><c:symbol val="circle"/></c:marker>${s.cat ? `<c:xVal>${ref('numRef', s.cat)}</c:xVal>` : ''}<c:yVal>${ref('numRef', s.val)}</c:yVal><c:smooth val="0"/></c:ser>`
      const cat = s.cat ? `<c:cat>${ref('strRef', s.cat)}</c:cat>` : ''
      const tail = c.type === 'line' ? '<c:smooth val="0"/>' : ''
      return `<c:ser>${head}${c.type === 'column' || c.type === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}${cat}<c:val>${ref('numRef', s.val)}</c:val>${tail}</c:ser>`
    })
    .join('')
  const dLbls = c.dataLabels ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>' : ''
  const axIds = '<c:axId val="500000001"/><c:axId val="500000002"/>'
  const axTitle = (t?: string) => (t ? `<c:title>${rich(t)}</c:title>` : '')
  const catPos = c.type === 'bar' ? 'l' : 'b'
  const valPos = c.type === 'bar' ? 'b' : 'l'
  const catAx = `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="${c.type === 'bar' ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/>${axTitle(c.xTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
  const valAx = (id: string, cross: string, pos: string, title?: string, grid = true) => `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid ? '<c:majorGridlines/>' : ''}${axTitle(title)}<c:numFmt formatCode="${g === 'percent' ? '0%' : 'General'}" sourceLinked="${g === 'percent' ? 0 : 1}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  let plot: string
  switch (c.type) {
    case 'column':
    case 'bar':
      plot = `<c:barChart><c:barDir val="${c.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${g === 'stacked' ? 'stacked' : g === 'percent' ? 'percentStacked' : 'clustered'}"/><c:varyColors val="0"/>${ser}${dLbls}<c:gapWidth val="150"/>${g !== 'clustered' ? '<c:overlap val="100"/>' : ''}${axIds}</c:barChart>${catAx}${valAx('500000002', '500000001', valPos, c.yTitle)}`
      break
    case 'line':
      plot = `<c:lineChart><c:grouping val="${lineGrouping}"/><c:varyColors val="0"/>${ser}${dLbls}<c:marker val="1"/>${axIds}</c:lineChart>${catAx}${valAx('500000002', '500000001', 'l', c.yTitle)}`
      break
    case 'area':
      plot = `<c:areaChart><c:grouping val="${lineGrouping}"/><c:varyColors val="0"/>${ser}${dLbls}${axIds}</c:areaChart>${catAx}${valAx('500000002', '500000001', 'l', c.yTitle)}`
      break
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${ser}${dLbls}<c:firstSliceAng val="0"/></c:pieChart>`
      break
    case 'doughnut':
      plot = `<c:doughnutChart><c:varyColors val="1"/>${ser}${dLbls}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`
      break
    case 'scatter':
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser.replace(/<c:marker>/g, '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker>')}${dLbls}${axIds}</c:scatterChart>${valAx('500000001', '500000002', 'b', c.xTitle, false)}${valAx('500000002', '500000001', 'l', c.yTitle)}`
      break
  }
  const autoTitle = c.title === undefined && c.series.length === 1
  const title = c.title ? `<c:title>${rich(c.title)}</c:title>` : ''
  const legend = c.legend === 'none' ? '' : `<c:legend><c:legendPos val="${{ right: 'r', bottom: 'b', top: 't', left: 'l' }[c.legend]}"/><c:overlay val="0"/></c:legend>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${title}<c:autoTitleDeleted val="${title || autoTitle ? 0 : 1}"/><c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
}

/** A twoCellAnchor holding a chart frame. */
export function anchorXml(a: ChartAnchor, rid: string, n: number, name: string): string {
  const corner = (tag: string, r: number, c: number, dx: number, dy: number) => `<xdr:${tag}><xdr:col>${c}</xdr:col><xdr:colOff>${Math.round(dx * EMU)}</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>${Math.round(dy * EMU)}</xdr:rowOff></xdr:${tag}>`
  return `<xdr:twoCellAnchor editAs="oneCell">${corner('from', a.r0, a.c0, a.dx0, a.dy0)}${corner('to', a.r1, a.c1, a.dx1, a.dy1)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n + 1}" name="${escText(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
}

export const DRAWING_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${NS_A}">`

/** The anchors of a drawing part as raw XML, each with the chart relationship id it shows (if any). */
export function drawingAnchors(xml: string): { xml: string; rid: string | null }[] {
  const body = xml.slice(xml.indexOf('>', xml.indexOf('wsDr')) + 1, xml.lastIndexOf('</'))
  const out: { xml: string; rid: string | null }[] = []
  const re = /<(xdr:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/\1?\2>/g
  for (const m of body.matchAll(re)) {
    const rid = /<(?:\w+:)?chart\b[^>]*\br:id="([^"]+)"/.exec(m[0])?.[1] ?? null
    out.push({ xml: m[0], rid })
  }
  return out
}

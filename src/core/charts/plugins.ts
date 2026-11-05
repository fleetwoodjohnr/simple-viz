// Chart types. Each plugin says which shelves it uses, how well it suits the fields chosen (for recommendations), how
// its data is queried, and how a result becomes an ECharts option (or a React view: table, crosstab, KPI).
// Every data value shown in HTML (tooltips) is escaped: data is untrusted.

import type { Encodings } from '../../shared/charts'
import type { Role } from '../query/compile'
import { type ChartData, type Theme, type Value, col, dims, measures, fmt, esc, pivot, dimmed } from './data'

type Option = Record<string, unknown>

export interface FieldSummary {
  dims: { type: string; role: Role }[]
  measures: number
}

export interface ChartPlugin {
  id: string
  label: string
  /** lucide icon name */
  icon: string
  group: 'basic' | 'more' | 'table'
  /** Shelves shown in the builder, with what they mean for this chart. */
  shelves: Partial<Record<Role, string>>
  /** Query rows instead of aggregates (scatter of records, histogram and box plot inputs). */
  raw?: (enc: Encodings) => boolean
  /** Wraps the compiled query (histogram bins, box-plot statistics). */
  wrap?: (sql: string, d: { bins: number; hasCat: boolean }) => string
  render: 'echarts' | 'table' | 'crosstab' | 'kpi'
  /** 0..1: how well this chart shows these fields. */
  score: (s: FieldSummary) => number
  option?: (d: ChartData, t: Theme) => Option
}

const isDateT = (t: string) => /^(DATE|TIMESTAMP)/.test(t)

// ---------------------------------------------------------------- shared pieces

function base(t: Theme, d: ChartData): Option {
  return {
    backgroundColor: t.bg,
    color: t.palette,
    textStyle: { fontFamily: t.font, color: t.text2 },
    animationDuration: 300,
    title: d.options.title ? { text: d.options.title, subtext: d.options.subtitle, left: 8, top: 4, textStyle: { color: t.text, fontSize: 14, fontWeight: 600 }, subtextStyle: { color: t.text2 } } : undefined,
    aria: { enabled: true, decal: { show: false } }
  }
}

const axisStyle = (t: Theme) => ({ axisLine: { lineStyle: { color: t.axis } }, axisTick: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text2, hideOverlap: true }, splitLine: { lineStyle: { color: t.grid } }, nameTextStyle: { color: t.text2 } })

function legend(d: ChartData, t: Theme, n: number): Option | undefined {
  const pos = d.options.legend ?? 'auto'
  if (pos === 'none' || (pos === 'auto' && n < 2)) return undefined
  const where = pos === 'auto' ? 'top' : pos
  return { type: 'scroll', [where === 'right' ? 'right' : 'left']: where === 'right' ? 4 : 'center', [where === 'bottom' ? 'bottom' : 'top']: where === 'right' ? 'middle' : d.options.title ? 34 : 4, orient: where === 'right' ? 'vertical' : 'horizontal', textStyle: { color: t.text2 }, pageTextStyle: { color: t.text2 } }
}

function grid(d: ChartData, hasLegend: boolean): Option {
  const top = (d.options.title ? 40 : 12) + (hasLegend && (d.options.legend ?? 'auto') !== 'right' && d.options.legend !== 'bottom' ? 28 : 0)
  return { left: 12, right: d.options.legend === 'right' ? 140 : 20, top, bottom: d.options.legend === 'bottom' ? 40 : 12, containLabel: true }
}

/** Tooltip listing every field of the hovered row. */
function rowTooltip(d: ChartData, t: Theme) {
  return {
    trigger: 'item',
    confine: true,
    backgroundColor: t.dark ? '#2a2a30' : '#ffffff',
    borderColor: t.axis,
    textStyle: { color: t.text, fontSize: 12 },
    formatter: (p: { data?: { row?: Value[] } ; marker?: string; seriesName?: string; name?: string; value?: unknown }) => {
      const row = p.data?.row
      if (!row) return `${p.marker ?? ''}${esc(String(p.seriesName ?? ''))}: ${esc(fmt(p.value as Value))}`
      return d.fields.map((f, i) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="opacity:.7">${esc(f.title)}</span><b>${esc(fmt(row[i], f))}</b></div>`).join('')
    }
  }
}

const axisTooltip = (d: ChartData, t: Theme, valueField?: (seriesIndex: number) => ChartData['fields'][number] | undefined) => ({
  trigger: 'axis',
  confine: true,
  axisPointer: { type: 'shadow' },
  backgroundColor: t.dark ? '#2a2a30' : '#ffffff',
  borderColor: t.axis,
  textStyle: { color: t.text, fontSize: 12 },
  formatter: (ps: { axisValueLabel: string; marker: string; seriesName: string; value: Value; seriesIndex: number }[]) =>
    `<div style="font-weight:600;margin-bottom:4px">${esc(ps[0]?.axisValueLabel ?? '')}</div>` +
    ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.marker}${esc(p.seriesName)}</span><b>${esc(fmt(p.value, valueField?.(p.seriesIndex)))}</b></div>`).join('')
})

/** Category axis labels: dates formatted at their grain, other values as text. */
const catLabels = (d: ChartData, key: string | undefined, cats: Value[]) => {
  const f = key ? d.fields.find((x) => x.key === key) : undefined
  return cats.map((c) => fmt(c, f))
}

// ---------------------------------------------------------------- bar, line, area, combo

function cartesian(kind: 'bar' | 'line' | 'area' | 'combo'): ChartPlugin['option'] {
  return (d, t) => {
    const catDim = dims(d, 'x')[0] ?? dims(d, 'y')[0]
    const horizontal = d.options.horizontal ?? (!!dims(d, 'y')[0] && !dims(d, 'x')[0])
    const ms = measures(d).filter((m) => m.role === 'y' || m.role === 'x')
    const colorDim = dims(d, 'color')[0]
    const { cats, series } = pivot(d, catDim?.key ?? null, colorDim?.key ?? null, ms.map((m) => m.key))
    const stack = d.options.stack ?? (kind === 'area' && colorDim ? 'stacked' : 'none')
    const pct = stack === 'percent'
    const lineIdx = new Set(kind === 'combo' ? (d.options.lineSeries ?? [1]) : kind === 'bar' ? [] : series.map((_, i) => i))
    const right = new Set(d.options.rightAxis ?? (kind === 'combo' && ms.length > 1 ? [1] : []))
    const totals = pct ? cats.map((_, ci) => series.reduce((a, s) => a + Math.abs(s.values[ci] ?? 0), 0)) : []
    const lg = legend(d, t, series.length)
    const valueAxis = (i: number) => ({ type: 'value', ...axisStyle(t), position: i ? 'right' : undefined, splitLine: { show: i === 0, lineStyle: { color: t.grid } }, axisLabel: { color: t.text2, formatter: (v: number) => (pct ? `${Math.round(v * 100)}%` : fmt(v, ms[i], 'axis')) }, max: pct ? 1 : undefined })
    const categoryAxis = { type: 'category', data: catLabels(d, catDim?.key, cats), ...axisStyle(t), axisLabel: { color: t.text2, hideOverlap: true }, boundaryGap: kind === 'bar' || kind === 'combo' }
    const hasRight = [...right].some((i) => i < series.length)
    const valueAxes = hasRight ? [valueAxis(0), valueAxis(1)] : valueAxis(0)
    const catRows = new Map<number, Value[]>()
    d.rows.forEach((r) => {
      const ci = cats.findIndex((c) => String(c) === String(catDim ? r[col(d, catDim.key)] : ''))
      if (!catRows.has(ci)) catRows.set(ci, r)
    })
    return {
      ...base(t, d),
      legend: lg,
      grid: grid(d, !!lg),
      tooltip: axisTooltip(d, t, (i) => d.fields.find((f) => f.key === series[i]?.measure)),
      xAxis: horizontal ? valueAxes : categoryAxis,
      yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxes,
      series: series.map((s, si) => {
        const isLine = lineIdx.has(si) && kind !== 'bar'
        const axisIndex = right.has(si) && hasRight ? 1 : 0
        return {
          name: s.name,
          type: isLine ? 'line' : 'bar',
          stack: stack !== 'none' && !(kind === 'combo' && isLine) ? 'total' : undefined,
          areaStyle: kind === 'area' ? { opacity: stack === 'none' ? 0.18 : 0.75 } : undefined,
          smooth: d.options.smooth,
          showSymbol: cats.length <= 40,
          symbol: ['circle', 'rect', 'triangle', 'diamond', 'roundRect', 'pin'][si % 6],
          lineStyle: isLine ? { width: 2, type: si % 3 === 1 ? 'dashed' : si % 3 === 2 ? 'dotted' : 'solid' } : undefined,
          barMaxWidth: 48,
          [horizontal ? 'xAxisIndex' : 'yAxisIndex']: axisIndex,
          label: d.options.labels ? { show: true, position: isLine ? 'top' : stack !== 'none' ? 'inside' : horizontal ? 'right' : 'top', color: t.text2, formatter: (p: { value: number }) => (pct ? `${Math.round(p.value * 100)}%` : fmt(p.value, d.fields.find((f) => f.key === s.measure), 'axis')) } : undefined,
          emphasis: { focus: 'series' },
          data: s.values.map((v, ci) => {
            const row = catRows.get(ci)
            const value = pct && v !== null ? v / (totals[ci] || 1) : v
            return { value, row, itemStyle: row && dimmed(d, row) ? { opacity: 0.25 } : undefined }
          }),
          markLine: si === 0 ? refLines(d, t, s.values) : undefined
        }
      })
    }
  }
}

/** Reference lines: constant, average, median, min, max, or a least-squares trend line. */
function refLines(d: ChartData, t: Theme, values: (number | null)[]): Option | undefined {
  const lines = d.options.refLines ?? []
  if (!lines.length) return undefined
  const nums = values.filter((v): v is number => v !== null)
  const sorted = [...nums].sort((a, b) => a - b)
  const data: unknown[] = []
  for (const l of lines) {
    const label = { formatter: l.label ?? l.kind, color: t.text2 }
    if (l.kind === 'trend') {
      const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null)
      if (pts.length < 2) continue
      const n = pts.length
      const mx = pts.reduce((a, p) => a + p[0], 0) / n
      const my = pts.reduce((a, p) => a + p[1], 0) / n
      const b = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
      const a0 = my - b * mx
      data.push([{ coord: [0, a0], label }, { coord: [values.length - 1, a0 + b * (values.length - 1)] }])
      continue
    }
    const v = l.kind === 'constant' || l.kind === 'param' ? l.value : l.kind === 'average' ? nums.reduce((a, b) => a + b, 0) / (nums.length || 1) : l.kind === 'median' ? sorted[Math.floor((sorted.length - 1) / 2)] : l.kind === 'min' ? sorted[0] : sorted[sorted.length - 1]
    if (v !== undefined) data.push({ yAxis: v, label: { ...label, formatter: `${l.label ?? l.kind} ${fmt(v, undefined, 'axis')}` } })
  }
  return { symbol: 'none', lineStyle: { color: t.text2, type: 'dashed' }, data }
}

// ---------------------------------------------------------------- pie, scatter, heatmap, treemap, histogram, box

const pie: ChartPlugin['option'] = (d, t) => {
  const cat = dims(d)[0]
  const m = measures(d)[0]
  const lg = legend(d, t, d.rows.length)
  return {
    ...base(t, d),
    legend: lg ?? undefined,
    tooltip: { ...rowTooltip(d, t), trigger: 'item' },
    series: [
      {
        type: 'pie',
        radius: d.options.donut ? ['45%', '72%'] : '72%',
        center: ['50%', d.options.title ? '55%' : '52%'],
        itemStyle: { borderColor: t.dark ? '#18181b' : '#ffffff', borderWidth: 1.5, borderRadius: 3 },
        label: { color: t.text2, formatter: (p: { name: string; percent: number }) => `${p.name}\n${p.percent.toFixed(1)}%` },
        data: d.rows.map((r) => ({ name: cat ? fmt(r[col(d, cat.key)], cat) : m?.title ?? '', value: m ? r[col(d, m.key)] : null, row: r, itemStyle: dimmed(d, r) ? { opacity: 0.3 } : undefined }))
      }
    ]
  }
}

const scatter: ChartPlugin['option'] = (d, t) => {
  const mx = measures(d, 'x')[0] ?? measures(d)[0]
  const my = measures(d, 'y')[0] ?? measures(d).find((m) => m !== mx)
  const size = d.fields.find((f) => f.role === 'size')
  const colorDim = dims(d, 'color')[0]
  const groups = new Map<string, Value[][]>()
  for (const r of d.rows) {
    const k = colorDim ? fmt(r[col(d, colorDim.key)], colorDim) : ''
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  const sizes = size ? d.rows.map((r) => Number(r[col(d, size.key)]) || 0) : []
  const smax = Math.max(1, ...sizes.map(Math.abs))
  const lg = legend(d, t, groups.size)
  return {
    ...base(t, d),
    legend: lg,
    grid: grid(d, !!lg),
    tooltip: rowTooltip(d, t),
    xAxis: { type: 'value', name: mx?.title, nameLocation: 'middle', nameGap: 28, scale: true, ...axisStyle(t), axisLabel: { color: t.text2, formatter: (v: number) => fmt(v, mx, 'axis') } },
    yAxis: { type: 'value', name: my?.title, nameLocation: 'middle', nameGap: 44, scale: true, ...axisStyle(t), axisLabel: { color: t.text2, formatter: (v: number) => fmt(v, my, 'axis') } },
    series: [...groups].map(([name, rows], gi) => ({
      name: name || my?.title,
      type: 'scatter',
      symbol: ['circle', 'rect', 'triangle', 'diamond', 'roundRect', 'pin'][gi % 6],
      symbolSize: size ? (v: Value[]) => 6 + 34 * Math.sqrt(Math.abs(Number(v[2]) || 0) / smax) : 8,
      itemStyle: { opacity: 0.75 },
      data: rows.map((r) => ({ value: [r[col(d, mx.key)], my ? r[col(d, my.key)] : 0, size ? r[col(d, size.key)] : 0], row: r, itemStyle: dimmed(d, r) ? { opacity: 0.15 } : undefined })),
      markLine: gi === 0 && (d.options.refLines ?? []).some((l) => l.kind === 'trend') ? scatterTrend(d, mx.key, my?.key, t) : undefined
    }))
  }
}

function scatterTrend(d: ChartData, xk: string, yk: string | undefined, t: Theme) {
  if (!yk) return undefined
  const pts = d.rows.map((r) => [Number(r[col(d, xk)]), Number(r[col(d, yk)])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  if (pts.length < 2) return undefined
  const n = pts.length
  const mx = pts.reduce((a, p) => a + p[0], 0) / n
  const my = pts.reduce((a, p) => a + p[1], 0) / n
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
  const b = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / (sxx || 1)
  const a0 = my - b * mx
  const xs = pts.map((p) => p[0])
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  const ssr = pts.reduce((a, p) => a + (p[1] - (a0 + b * p[0])) ** 2, 0)
  const sst = pts.reduce((a, p) => a + (p[1] - my) ** 2, 0)
  const r2 = sst ? 1 - ssr / sst : 0
  return { symbol: 'none', silent: true, lineStyle: { color: t.accent, width: 2 }, label: { formatter: `R² = ${r2.toFixed(3)}`, color: t.text2 }, data: [[{ coord: [lo, a0 + b * lo] }, { coord: [hi, a0 + b * hi] }]] }
}

const heatmap: ChartPlugin['option'] = (d, t) => {
  const x = dims(d, 'x')[0] ?? dims(d)[0]
  const y = dims(d, 'y')[0] ?? dims(d).find((f) => f !== x)
  const m = measures(d)[0]
  const xs = pivot(d, x?.key ?? null, null, m ? [m.key] : []).cats
  const ys = y ? pivot(d, y.key, null, m ? [m.key] : []).cats : ['']
  const vals = d.rows.map((r) => Number(r[col(d, m.key)])).filter(Number.isFinite)
  return {
    ...base(t, d),
    tooltip: rowTooltip(d, t),
    grid: { ...grid(d, false), bottom: 56 },
    xAxis: { type: 'category', data: catLabels(d, x?.key, xs), ...axisStyle(t), splitArea: { show: false } },
    yAxis: { type: 'category', data: catLabels(d, y?.key, ys), ...axisStyle(t) },
    visualMap: { min: Math.min(...vals, 0), max: Math.max(...vals, 1), calculable: true, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: t.seq }, textStyle: { color: t.text2 }, formatter: (v: number) => fmt(v, m, 'axis') },
    series: [
      {
        type: 'heatmap',
        label: { show: !!d.options.labels, color: t.text, formatter: (p: { value: [number, number, number] }) => fmt(p.value[2], m, 'axis') },
        itemStyle: { borderColor: t.dark ? '#18181b' : '#ffffff', borderWidth: 1 },
        data: d.rows.map((r) => ({ value: [xs.findIndex((c) => String(c) === String(r[col(d, x.key)])), y ? ys.findIndex((c) => String(c) === String(r[col(d, y.key)])) : 0, r[col(d, m.key)]], row: r }))
      }
    ]
  }
}

const treemap: ChartPlugin['option'] = (d, t) => {
  const ds = dims(d)
  const m = measures(d)[0]
  // Nested by the dimensions in shelf order (Region → State → City).
  type Node = { name: string; value?: number; children?: Node[] }
  const root: Node[] = []
  for (const r of d.rows) {
    let level = root
    ds.forEach((f, i) => {
      const name = fmt(r[col(d, f.key)], f)
      let node = level.find((n) => n.name === name)
      if (!node) {
        node = { name, ...(i < ds.length - 1 ? { children: [] } : {}) }
        level.push(node)
      }
      if (i === ds.length - 1) node.value = (node.value ?? 0) + (Number(r[col(d, m.key)]) || 0)
      else level = node.children!
    })
  }
  return {
    ...base(t, d),
    tooltip: { confine: true, formatter: (p: { name: string; value: number; treePathInfo: { name: string }[] }) => `${esc(p.treePathInfo.slice(1).map((x) => x.name).join(' › '))}<br><b>${esc(fmt(p.value, m))}</b>` },
    series: [{ type: 'treemap', roam: false, breadcrumb: { show: ds.length > 1 }, leafDepth: ds.length > 1 ? 1 : undefined, label: { color: '#fff' }, upperLabel: { show: ds.length > 1, color: '#fff' }, itemStyle: { borderColor: t.dark ? '#18181b' : '#ffffff', gapWidth: 2 }, levels: [{ itemStyle: { borderWidth: 0, gapWidth: 3 } }, { colorSaturation: [0.35, 0.6], itemStyle: { gapWidth: 1 } }], data: root }]
  }
}

const histogram: ChartPlugin['option'] = (d, t) => {
  // rows: bin_lo, bin_hi, count
  const f = d.fields[0]
  return {
    ...base(t, d),
    grid: grid(d, false),
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' }, formatter: (ps: { dataIndex: number }[]) => {
      const r = d.rows[ps[0].dataIndex]
      return `${esc(fmt(r[0], f))} – ${esc(fmt(r[1], f))}<br><b>${r[2]}</b> rows`
    } },
    xAxis: { type: 'category', data: d.rows.map((r) => fmt(r[0], f, 'axis')), name: f?.title, nameLocation: 'middle', nameGap: 28, ...axisStyle(t) },
    yAxis: { type: 'value', name: 'Count', ...axisStyle(t) },
    series: [{ type: 'bar', barCategoryGap: '2%', data: d.rows.map((r) => r[2]), itemStyle: { color: t.palette[0] } }]
  }
}

const boxplot: ChartPlugin['option'] = (d, t) => {
  // rows: category, lo, q1, median, q3, hi, outliers[], n
  const valueField = d.fields.find((f) => f.kind === 'measure')
  const cats = d.rows.map((r) => fmt(r[0], d.fields.find((f) => f.kind === 'dim')))
  return {
    ...base(t, d),
    grid: grid(d, false),
    tooltip: { trigger: 'item', confine: true, formatter: (p: { dataIndex: number; seriesType: string; value: number[] }) => {
      if (p.seriesType === 'scatter') return `Outlier: <b>${esc(fmt(p.value[1], valueField))}</b>`
      const r = d.rows[p.dataIndex]
      return `<b>${esc(cats[p.dataIndex])}</b> (n = ${r[7]})<br>` + ['Upper whisker', 'Q3', 'Median', 'Q1', 'Lower whisker'].map((l, i) => `${l}: ${esc(fmt(r[5 - i] as number, valueField))}`).join('<br>')
    } },
    xAxis: { type: 'category', data: cats, ...axisStyle(t) },
    yAxis: { type: 'value', scale: true, ...axisStyle(t), axisLabel: { color: t.text2, formatter: (v: number) => fmt(v, valueField, 'axis') } },
    series: [
      { type: 'boxplot', itemStyle: { color: t.dark ? '#2a2a30' : '#fff', borderColor: t.palette[0], borderWidth: 1.5 }, data: d.rows.map((r) => [r[1], r[2], r[3], r[4], r[5]]) },
      { type: 'scatter', symbolSize: 5, itemStyle: { color: t.palette[1] }, data: d.rows.flatMap((r, i) => ((r[6] as number[] | null) ?? []).map((v) => [i, v])) }
    ]
  }
}

// ---------------------------------------------------------------- registry

const has = (s: FieldSummary) => ({ date: s.dims.some((d) => isDateT(d.type)), cats: s.dims.filter((d) => !isDateT(d.type)).length, n: s.dims.length })

export const PLUGINS: ChartPlugin[] = [
  { id: 'bar', label: 'Bar', icon: 'BarChart3', group: 'basic', render: 'echarts', shelves: { x: 'Categories (or values for horizontal bars)', y: 'Values', color: 'Split into groups or stacks', label: 'Text on bars', tooltip: 'More in the tooltip' }, score: (s) => (s.measures >= 1 && has(s).cats >= 1 ? 0.9 : s.measures >= 1 && s.dims.length === 0 ? 0.6 : s.measures && has(s).date ? 0.55 : 0.2), option: cartesian('bar') },
  { id: 'line', label: 'Line', icon: 'LineChart', group: 'basic', render: 'echarts', shelves: { x: 'Dates or ordered categories', y: 'Values', color: 'One line per value', tooltip: 'More in the tooltip' }, score: (s) => (s.measures >= 1 && has(s).date ? 0.95 : s.measures >= 1 && s.dims.length ? 0.4 : 0.1), option: cartesian('line') },
  { id: 'area', label: 'Area', icon: 'AreaChart', group: 'basic', render: 'echarts', shelves: { x: 'Dates or ordered categories', y: 'Values', color: 'Stacked areas', tooltip: 'More in the tooltip' }, score: (s) => (s.measures >= 1 && has(s).date && s.dims.length >= 2 ? 0.7 : s.measures && has(s).date ? 0.5 : 0.1), option: cartesian('area') },
  { id: 'combo', label: 'Combo (bar + line)', icon: 'ChartColumnIncreasing', group: 'basic', render: 'echarts', shelves: { x: 'Categories or dates', y: 'Two or more values (the second is a line on its own axis)', tooltip: 'More in the tooltip' }, score: (s) => (s.measures >= 2 && s.dims.length >= 1 ? 0.75 : 0.05), option: cartesian('combo') },
  { id: 'pie', label: 'Pie / donut', icon: 'PieChart', group: 'basic', render: 'echarts', shelves: { color: 'Slices', y: 'Value', tooltip: 'More in the tooltip' }, score: (s) => (s.measures === 1 && s.dims.length === 1 && has(s).cats === 1 ? 0.5 : 0.05), option: pie },
  { id: 'scatter', label: 'Scatter / bubble', icon: 'ScatterChart', group: 'basic', render: 'echarts', raw: (enc) => !enc.detail.length && !enc.color && !enc.x.some((f) => !f.agg) && !enc.y.some((f) => !f.agg), shelves: { x: 'Value', y: 'Value', size: 'Bubble size', color: 'Groups', detail: 'One point per value (otherwise one per row)', tooltip: 'More in the tooltip' }, score: (s) => (s.measures >= 2 ? 0.85 : 0.05), option: scatter },
  { id: 'histogram', label: 'Histogram', icon: 'ChartNoAxesColumn', group: 'basic', render: 'echarts', raw: () => true, wrap: (sql, o) => `WITH r AS (${sql}), b AS (SELECT min(m0) lo, max(m0) hi FROM r WHERE m0 IS NOT NULL), w AS (SELECT lo, CASE WHEN hi > lo THEN (hi - lo) / ${o.bins} ELSE 1 END AS step FROM b)\nSELECT lo + i * step AS bin_lo, lo + (i + 1) * step AS bin_hi, count(r.m0) AS n FROM w, range(${o.bins}) t(i) LEFT JOIN r ON r.m0 >= lo + i * step AND (r.m0 < lo + (i + 1) * step OR (i = ${o.bins - 1} AND r.m0 <= lo + (i + 1) * step)) GROUP BY ALL ORDER BY bin_lo`, shelves: { x: 'A number to bin' }, score: (s) => (s.measures === 1 && s.dims.length === 0 ? 0.6 : 0.05), option: histogram },
  { id: 'boxplot', label: 'Box plot', icon: 'SquareSplitVertical', group: 'basic', render: 'echarts', raw: () => true, wrap: (sql, o) => `WITH r AS (SELECT ${o.hasCat ? 'd0' : "'All'"} AS c, m0 AS v FROM (${sql}) WHERE m0 IS NOT NULL), q AS (SELECT c, quantile_cont(v, 0.25) q1, median(v) q2, quantile_cont(v, 0.75) q3, count(*) n FROM r GROUP BY c)\nSELECT q.c, min(v) FILTER (WHERE v >= q1 - 1.5 * (q3 - q1)) lo, any_value(q1) q1, any_value(q2) q2, any_value(q3) q3, max(v) FILTER (WHERE v <= q3 + 1.5 * (q3 - q1)) hi, list(v) FILTER (WHERE v < q1 - 1.5 * (q3 - q1) OR v > q3 + 1.5 * (q3 - q1)) outliers, any_value(n) n FROM r JOIN q USING (c) GROUP BY q.c ORDER BY q.c`, shelves: { x: 'Groups (optional)', y: 'A number' }, score: (s) => (s.measures === 1 && s.dims.length <= 1 ? 0.35 : 0.05), option: boxplot },
  { id: 'heatmap', label: 'Heat map', icon: 'Grid3x3', group: 'basic', render: 'echarts', shelves: { x: 'Columns', y: 'Rows', color: 'Value (color)' }, score: (s) => (s.measures === 1 && s.dims.length === 2 ? 0.7 : 0.05), option: heatmap },
  { id: 'treemap', label: 'Treemap', icon: 'LayoutGrid', group: 'basic', render: 'echarts', shelves: { detail: 'Nested groups (in order)', size: 'Value (area)' }, score: (s) => (s.measures === 1 && has(s).cats >= 1 && !has(s).date ? 0.45 : 0.05), option: treemap },
  { id: 'kpi', label: 'KPI card', icon: 'Gauge', group: 'table', render: 'kpi', shelves: { y: 'Value', tooltip: 'Smaller figures below' }, score: (s) => (s.measures >= 1 && s.dims.length === 0 ? 0.8 : 0.05) },
  { id: 'table', label: 'Table', icon: 'Table2', group: 'table', render: 'table', shelves: { x: 'Columns (any fields)', y: 'More columns' }, score: () => 0.3 },
  { id: 'crosstab', label: 'Crosstab', icon: 'Sheet', group: 'table', render: 'crosstab', shelves: { y: 'Row headers', x: 'Column headers', label: 'Value in cells' }, score: (s) => (s.measures >= 1 && s.dims.length >= 2 ? 0.5 : 0.1) }
]

export const plugin = (id: string) => PLUGINS.find((p) => p.id === id) ?? PLUGINS[0]

/** Chart types ordered by how well they show these fields (the first is the recommendation). */
export function recommend(s: FieldSummary): ChartPlugin[] {
  return [...PLUGINS].sort((a, b) => b.score(s) - a.score(s))
}

export type { Option }

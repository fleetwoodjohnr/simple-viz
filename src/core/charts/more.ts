// More chart types: waterfall, Pareto, funnel, gauge, bullet, radar, sankey, network, sunburst, calendar, candlestick,
// sparklines, Gantt, density and violin, correlation matrix, cohort, maps and custom visuals. Same contract as
// plugins.ts: an option built from the query result; every data value shown in HTML is escaped.

import type { OutField } from '../query/compile'
import { type ChartData, type Theme, type Value, col, dims, measures, fmt, esc, pivot, dimmed } from './data'
import { type Option, base, axisStyle, legend, grid, rowTooltip, catLabels } from './option'
import { normalizeName, MERCATOR } from './geo'

type Build = (d: ChartData, t: Theme) => Option
const num = (v: Value) => (v === null || v === undefined || v === '' ? null : Number(v))
const valueAxis = (t: Theme, f?: OutField, extra: Option = {}) => ({ type: 'value', ...axisStyle(t), axisLabel: { color: t.text2, formatter: (v: number) => fmt(v, f, 'axis') }, ...extra })
const plainTooltip = (t: Theme, formatter: (p: never) => string) => ({ trigger: 'item', confine: true, backgroundColor: t.dark ? '#2a2a30' : '#ffffff', borderColor: t.axis, textStyle: { color: t.text, fontSize: 12 }, formatter })
/** A round number at or above v (gauge and radar scales). */
export const niceMax = (v: number) => {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((k) => Number((k * p).toPrecision(12))).find((k) => k >= v)!
}
const epoch = (v: Value) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(/[T ]\d/.test(v) ? `${v.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z'}` : `${v}T00:00:00Z`) : NaN)

// ---------------------------------------------------------------- waterfall, Pareto

/** Each category adds to (or takes from) a running total, ending with the total. */
export const waterfall: Build = (d, t) => {
  const cat = dims(d, 'x')[0] ?? dims(d)[0]
  const m = measures(d)[0]
  const { cats, series } = pivot(d, cat?.key ?? null, null, m ? [m.key] : [])
  const vals = (series[0]?.values ?? []).map((v) => v ?? 0)
  const start: number[] = []
  let run = 0
  for (const v of vals) {
    start.push(run)
    run += v
  }
  const labels = [...catLabels(d, cat?.key, cats), 'Total']
  const lo = [...vals.map((v, i) => Math.min(start[i], start[i] + v)), Math.min(0, run)]
  const len = [...vals.map((v) => Math.abs(v)), Math.abs(run)]
  const kind = [...vals.map((v) => (v >= 0 ? 'up' : 'down')), 'total']
  const color = { up: t.palette[2], down: t.palette[7], total: t.palette[0] } as Record<string, string>
  return {
    ...base(t, d),
    grid: grid(d, false),
    tooltip: { ...plainTooltip(t, (p: { dataIndex: number }) => `<b>${esc(labels[p.dataIndex])}</b><br>${p.dataIndex < vals.length ? `Change: ${esc(fmt(vals[p.dataIndex], m))}<br>Running total: ${esc(fmt(start[p.dataIndex] + vals[p.dataIndex], m))}` : `Total: ${esc(fmt(run, m))}`}`), trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: labels, ...axisStyle(t) },
    yAxis: valueAxis(t, m),
    series: [
      { type: 'bar', stack: 'w', stackStrategy: 'all', silent: true, itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, data: lo, tooltip: { show: false } },
      { type: 'bar', stack: 'w', stackStrategy: 'all', name: m?.title, barMaxWidth: 48, label: d.options.labels ? { show: true, position: 'top', color: t.text2, formatter: (p: { dataIndex: number }) => fmt(p.dataIndex < vals.length ? vals[p.dataIndex] : run, m, 'axis') } : undefined, data: len.map((v, i) => ({ value: v, itemStyle: { color: color[kind[i]] }, decal: kind[i] === 'down' ? { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4 } : undefined })) }
    ]
  }
}

/** Bars from largest to smallest with the cumulative share as a line (the 80/20 view). */
export const pareto: Build = (d, t) => {
  const cat = dims(d, 'x')[0] ?? dims(d)[0]
  const m = measures(d)[0]
  const { cats, series } = pivot(d, cat?.key ?? null, null, m ? [m.key] : [])
  const pairs = cats.map((c, i) => ({ c, v: series[0]?.values[i] ?? 0 })).sort((a, b) => b.v - a.v)
  const total = pairs.reduce((a, p) => a + p.v, 0) || 1
  let acc = 0
  const cum = pairs.map((p) => (acc += p.v) / total)
  return {
    ...base(t, d),
    grid: grid(d, true),
    legend: { top: d.options.title ? 34 : 4, textStyle: { color: t.text2 } },
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' }, formatter: (ps: { dataIndex: number }[]) => `<b>${esc(catLabels(d, cat?.key, [pairs[ps[0].dataIndex].c])[0])}</b><br>${esc(fmt(pairs[ps[0].dataIndex].v, m))}<br>Cumulative: ${(cum[ps[0].dataIndex] * 100).toFixed(1)}%` },
    xAxis: { type: 'category', data: catLabels(d, cat?.key, pairs.map((p) => p.c)), ...axisStyle(t) },
    yAxis: [valueAxis(t, m), { type: 'value', min: 0, max: 1, ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.text2, formatter: (v: number) => `${Math.round(v * 100)}%` } }],
    series: [
      { type: 'bar', name: m?.title, barMaxWidth: 48, data: pairs.map((p) => p.v) },
      { type: 'line', name: 'Cumulative %', yAxisIndex: 1, symbol: 'circle', data: cum, lineStyle: { color: t.accent }, itemStyle: { color: t.accent }, markLine: { silent: true, symbol: 'none', lineStyle: { color: t.text2, type: 'dashed' }, data: [{ yAxis: 0.8, label: { formatter: '80%', color: t.text2 } }] } }
    ]
  }
}

// ---------------------------------------------------------------- funnel, gauge, bullet

export const funnel: Build = (d, t) => {
  const cat = dims(d)[0]
  const m = measures(d)[0]
  const items = d.rows.map((r) => ({ name: cat ? fmt(r[col(d, cat.key)], cat) : (m?.title ?? ''), value: m ? num(r[col(d, m.key)]) : null, row: r, itemStyle: dimmed(d, r) ? { opacity: 0.3 } : undefined }))
  const first = items.reduce((a, i) => Math.max(a, i.value ?? 0), 0) || 1
  return {
    ...base(t, d),
    legend: legend(d, t, items.length),
    tooltip: plainTooltip(t, (p: { name: string; value: number }) => `<b>${esc(p.name)}</b><br>${esc(fmt(p.value, m))} (${((p.value / first) * 100).toFixed(1)}% of the first stage)`),
    series: [{ type: 'funnel', sort: 'descending', top: d.options.title ? 48 : 16, bottom: 12, left: '10%', width: '80%', gap: 2, label: { show: true, position: 'inside', color: '#fff', formatter: (p: { name: string; value: number }) => `${p.name}\n${fmt(p.value, m, 'axis')}` }, itemStyle: { borderColor: t.dark ? '#18181b' : '#fff', borderWidth: 1 }, data: items }]
  }
}

export const gauge: Build = (d, t) => {
  const m = measures(d)[0]
  const v = m ? num(d.rows[0]?.[col(d, m.key)] ?? null) : null
  const min = d.options.gauge?.min ?? 0
  const max = d.options.gauge?.max ?? niceMax(Math.max(Math.abs(v ?? 0), min + 1))
  return {
    ...base(t, d),
    series: [
      {
        type: 'gauge',
        min,
        max,
        center: ['50%', '58%'],
        radius: '88%',
        progress: { show: true, width: 14, itemStyle: { color: t.accent } },
        axisLine: { lineStyle: { width: 14, color: [[1, t.grid]] } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { color: t.axis } },
        axisLabel: { color: t.text2, distance: 18, formatter: (x: number) => fmt(x, m, 'axis') },
        pointer: { width: 4, itemStyle: { color: t.text2 } },
        anchor: { show: true, size: 10, itemStyle: { color: t.text2 } },
        title: { show: true, offsetCenter: [0, '72%'], color: t.text2, fontSize: 12 },
        detail: { valueAnimation: true, offsetCenter: [0, '40%'], color: t.text, fontSize: 24, fontWeight: 600, formatter: (x: number) => fmt(x, m) },
        data: [{ value: v, name: m?.title ?? '' }]
      }
    ]
  }
}

/** Actual (first value) as a bar against a target (second value) marker, per category. */
export const bullet: Build = (d, t) => {
  const cat = dims(d)[0]
  const [actual, target] = measures(d)
  const labels = d.rows.map((r) => (cat ? fmt(r[col(d, cat.key)], cat) : (actual?.title ?? '')))
  const a = d.rows.map((r) => (actual ? num(r[col(d, actual.key)]) : null))
  const tg = d.rows.map((r) => (target ? num(r[col(d, target.key)]) : null))
  const top = Math.max(...a.map((x) => x ?? 0), ...tg.map((x) => x ?? 0))
  return {
    ...base(t, d),
    grid: grid(d, !!target),
    legend: target ? { top: d.options.title ? 34 : 4, textStyle: { color: t.text2 } } : undefined,
    tooltip: { ...plainTooltip(t, (p: { dataIndex: number }) => `<b>${esc(labels[p.dataIndex])}</b><br>${esc(actual?.title ?? '')}: ${esc(fmt(a[p.dataIndex], actual))}${target ? `<br>${esc(target.title)}: ${esc(fmt(tg[p.dataIndex], target))}${tg[p.dataIndex] ? ` (${(((a[p.dataIndex] ?? 0) / tg[p.dataIndex]!) * 100).toFixed(0)}%)` : ''}` : ''}`), trigger: 'axis', axisPointer: { type: 'shadow' } },
    yAxis: { type: 'category', data: labels, inverse: true, ...axisStyle(t) },
    xAxis: valueAxis(t, actual, { max: niceMax(top) }),
    series: [
      { type: 'bar', name: 'Range', silent: true, barWidth: '70%', barGap: '-100%', itemStyle: { color: t.grid }, data: labels.map(() => niceMax(top)), tooltip: { show: false } },
      { type: 'bar', name: actual?.title, barWidth: '30%', data: a.map((v, i) => ({ value: v, itemStyle: { color: target && tg[i] !== null && (v ?? 0) < tg[i]! ? t.palette[1] : t.palette[0] } })) },
      ...(target ? [{ type: 'scatter', name: target.title, symbol: 'rect', symbolSize: [4, 26], itemStyle: { color: t.text }, z: 5, data: tg }] : [])
    ]
  }
}

// ---------------------------------------------------------------- radar, sankey, network, sunburst

/** One axis per category of the first dimension; one shape per series (color, or each value). */
export const radar: Build = (d, t) => {
  const cat = dims(d, 'x')[0] ?? dims(d)[0]
  const color = dims(d, 'color')[0]
  const ms = measures(d)
  const { cats, series } = pivot(d, cat?.key ?? null, color?.key ?? null, ms.map((m) => m.key))
  const top = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)))
  return {
    ...base(t, d),
    legend: legend(d, t, series.length),
    tooltip: { trigger: 'item', confine: true },
    radar: { indicator: catLabels(d, cat?.key, cats).map((name) => ({ name, max: niceMax(top) })), center: ['50%', '56%'], radius: '66%', axisName: { color: t.text2 }, splitLine: { lineStyle: { color: t.grid } }, splitArea: { show: false }, axisLine: { lineStyle: { color: t.axis } } },
    series: [{ type: 'radar', symbolSize: 4, areaStyle: { opacity: 0.12 }, data: series.map((s) => ({ name: s.name, value: s.values.map((v) => v ?? 0) })) }]
  }
}

/** Flows between the values of consecutive dimensions (source → … → target), sized by the measure. */
export const sankey: Build = (d, t) => {
  const ds = dims(d)
  const m = measures(d)[0]
  const SEP = '\u0001'
  const nodes = new Map<string, { name: string; depth: number }>()
  const links = new Map<string, { source: string; target: string; value: number }>()
  for (const r of d.rows) {
    const v = m ? Number(r[col(d, m.key)]) || 0 : 1
    for (let i = 0; i + 1 < ds.length; i++) {
      // Node ids carry their level: the same value at two levels is two nodes (sankey can't have loops).
      const a = `${i}${SEP}${fmt(r[col(d, ds[i].key)], ds[i])}`
      const b = `${i + 1}${SEP}${fmt(r[col(d, ds[i + 1].key)], ds[i + 1])}`
      nodes.set(a, { name: a, depth: i })
      nodes.set(b, { name: b, depth: i + 1 })
      const k = `${a}${SEP}${SEP}${b}`
      const l = links.get(k) ?? { source: a, target: b, value: 0 }
      l.value += v
      links.set(k, l)
    }
  }
  const label = (id: string) => id.slice(id.indexOf(SEP) + 1)
  return {
    ...base(t, d),
    tooltip: plainTooltip(t, (p: { dataType: string; name: string; data: { source: string; target: string; value: number }; value: number }) => (p.dataType === 'edge' ? `${esc(label(p.data.source))} → ${esc(label(p.data.target))}<br><b>${esc(fmt(p.data.value, m))}</b>` : `<b>${esc(label(p.name))}</b><br>${esc(fmt(p.value, m))}`)),
    series: [{ type: 'sankey', top: d.options.title ? 48 : 16, bottom: 16, left: 16, right: 110, nodeGap: 10, emphasis: { focus: 'adjacency' }, lineStyle: { color: 'gradient', opacity: 0.35 }, label: { color: t.text, formatter: (p: { name: string }) => label(p.name) }, data: [...nodes.values()], links: [...links.values()] }]
  }
}

/** Nodes are the values of the first two dimensions, linked when they appear in the same row. */
export const network: Build = (d, t) => {
  const [a, b] = dims(d)
  const m = measures(d)[0]
  const weight = new Map<string, number>()
  const links = new Map<string, { source: string; target: string; value: number }>()
  for (const r of d.rows) {
    if (!a || !b) break
    const s = fmt(r[col(d, a.key)], a)
    const e = fmt(r[col(d, b.key)], b)
    const v = m ? Number(r[col(d, m.key)]) || 0 : 1
    weight.set(s, (weight.get(s) ?? 0) + v)
    weight.set(e, (weight.get(e) ?? 0) + v)
    const k = s < e ? `${s}\u0001${e}` : `${e}\u0001${s}`
    const l = links.get(k) ?? { source: s, target: e, value: 0 }
    l.value += v
    links.set(k, l)
  }
  const top = Math.max(1, ...weight.values())
  const nodes = [...weight].slice(0, 500).map(([name, w]) => ({ name, value: w, symbolSize: 8 + 32 * Math.sqrt(w / top) }))
  const keep = new Set(nodes.map((n) => n.name))
  return {
    ...base(t, d),
    tooltip: plainTooltip(t, (p: { dataType: string; name: string; value: number; data: { source: string; target: string; value: number } }) => (p.dataType === 'edge' ? `${esc(p.data.source)} — ${esc(p.data.target)}<br><b>${esc(fmt(p.data.value, m))}</b>` : `<b>${esc(p.name)}</b><br>${esc(fmt(p.value, m))}`)),
    series: [{ type: 'graph', layout: 'force', roam: true, draggable: true, force: { repulsion: 120, edgeLength: [40, 140] }, label: { show: nodes.length <= 60, position: 'right', color: t.text2 }, lineStyle: { color: t.axis, opacity: 0.8, width: 1 }, emphasis: { focus: 'adjacency' }, itemStyle: { color: t.palette[0] }, data: nodes, links: [...links.values()].filter((l) => keep.has(l.source) && keep.has(l.target)) }]
  }
}

type Node = { name: string; value?: number; children?: Node[] }
function nest(d: ChartData, ds: OutField[], m: OutField | undefined): Node[] {
  const root: Node[] = []
  for (const r of d.rows) {
    let level = root
    ds.forEach((f, i) => {
      const name = fmt(r[col(d, f.key)], f)
      let node = level.find((n) => n.name === name)
      if (!node) level.push((node = { name, ...(i < ds.length - 1 ? { children: [] } : {}) }))
      if (i === ds.length - 1) node.value = (node.value ?? 0) + (m ? Number(r[col(d, m.key)]) || 0 : 1)
      else level = node.children!
    })
  }
  return root
}

export const sunburst: Build = (d, t) => {
  const ds = dims(d)
  const m = measures(d)[0]
  return {
    ...base(t, d),
    tooltip: plainTooltip(t, (p: { treePathInfo: { name: string }[]; value: number }) => `${esc(p.treePathInfo.slice(1).map((x) => x.name).join(' › '))}<br><b>${esc(fmt(p.value, m))}</b>`),
    series: [{ type: 'sunburst', center: ['50%', '54%'], radius: [0, '88%'], sort: 'desc', itemStyle: { borderColor: t.dark ? '#18181b' : '#fff', borderWidth: 1.5 }, label: { color: '#fff', minAngle: 8 }, emphasis: { focus: 'ancestor' }, data: nest(d, ds, m) }]
  }
}

// ---------------------------------------------------------------- calendar, candlestick, sparklines, Gantt

/** One square per day, colored by the value; a row of weeks per year. */
export const calendar: Build = (d, t) => {
  const day = dims(d).find((f) => /^(DATE|TIMESTAMP)/.test(f.type))
  const m = measures(d)[0]
  const pts = day && m ? d.rows.map((r) => [String(r[col(d, day.key)]).slice(0, 10), num(r[col(d, m.key)])] as [string, number | null]).filter((p) => /^\d{4}-/.test(p[0])) : []
  const years = [...new Set(pts.map((p) => p[0].slice(0, 4)))].sort().slice(-4)
  const vals = pts.map((p) => p[1] ?? 0)
  const top = d.options.title ? 54 : 30
  return {
    ...base(t, d),
    tooltip: plainTooltip(t, (p: { value: [string, number] }) => `${esc(fmt(p.value[0], day))}<br><b>${esc(fmt(p.value[1], m))}</b>`),
    visualMap: { min: Math.min(0, ...vals), max: Math.max(1, ...vals), calculable: true, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: t.seq }, textStyle: { color: t.text2 } },
    calendar: years.map((y, i) => ({ range: y, top: top + i * 150, left: 50, right: 20, cellSize: ['auto', 16], splitLine: { lineStyle: { color: t.axis } }, itemStyle: { borderColor: t.dark ? '#18181b' : '#fff', color: t.dark ? '#232329' : '#f6f6f8' }, yearLabel: { color: t.text2 }, monthLabel: { color: t.text2 }, dayLabel: { color: t.text2, firstDay: 1 } })),
    series: years.map((y, i) => ({ type: 'heatmap', coordinateSystem: 'calendar', calendarIndex: i, data: pts.filter((p) => p[0].startsWith(y)) }))
  }
}

/** Open, close, low and high (the first four values, in that order) per date. */
export const candlestick: Build = (d, t) => {
  const date = dims(d, 'x')[0] ?? dims(d)[0]
  const ms = measures(d).slice(0, 4)
  const labels = catLabels(d, date?.key, d.rows.map((r) => (date ? r[col(d, date.key)] : '')))
  const ohlc = d.rows.map((r) => ms.map((m) => num(r[col(d, m.key)])))
  return {
    ...base(t, d),
    grid: grid(d, false),
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'cross' }, formatter: (ps: { dataIndex: number }[]) => `<b>${esc(labels[ps[0].dataIndex])}</b><br>` + ['Open', 'Close', 'Low', 'High'].map((l, i) => `${l}: ${esc(fmt(ohlc[ps[0].dataIndex][i] ?? null, ms[i]))}`).join('<br>') },
    xAxis: { type: 'category', data: labels, ...axisStyle(t) },
    yAxis: valueAxis(t, ms[0], { scale: true }),
    dataZoom: undefined,
    series: [{ type: 'candlestick', itemStyle: { color: t.palette[2], color0: t.palette[7], borderColor: t.palette[2], borderColor0: t.palette[7] }, data: ohlc.map((v) => (ms.length === 4 ? [v[0], v[1], v[2], v[3]] : [null, null, null, null])) }]
  }
}

/** A small line per series (color), stacked, with its latest value. */
export const sparkline: Build = (d, t) => {
  const x = dims(d, 'x')[0] ?? dims(d)[0]
  const color = dims(d, 'color')[0] ?? dims(d).find((f) => f !== x)
  const m = measures(d)[0]
  const { cats, series } = pivot(d, x?.key ?? null, color?.key ?? null, m ? [m.key] : [])
  const rows = series.slice(0, 24)
  // Positions in % of the chart (ECharts has no calc()): a title band, then equal rows.
  const top = d.options.title ? 12 : 2
  const h = (100 - top - 2) / (rows.length || 1)
  const at = (i: number, dy = 0) => `${top + h * i + dy}%`
  return {
    ...base(t, d),
    tooltip: { trigger: 'axis', confine: true, formatter: (ps: { seriesName: string; dataIndex: number; value: number }[]) => `${esc(catLabels(d, x?.key, [cats[ps[0].dataIndex]])[0])}<br>${ps.map((p) => `${esc(p.seriesName)}: <b>${esc(fmt(p.value, m))}</b>`).join('<br>')}` },
    title: [...(base(t, d).title ? [base(t, d).title as Option] : []), ...rows.map((s, i) => ({ text: s.name, textStyle: { fontSize: 11, fontWeight: 500, color: t.text2 }, left: 8, top: at(i, h * 0.2) })), ...rows.map((s, i) => ({ text: fmt([...s.values].reverse().find((v) => v !== null) ?? null, m, 'axis'), textStyle: { fontSize: 12, fontWeight: 600, color: t.text }, right: 8, top: at(i, h * 0.2) }))],
    grid: rows.map((_, i) => ({ left: 130, right: 70, top: at(i, h * 0.1), height: `${h * 0.8}%` })),
    xAxis: rows.map((_, i) => ({ type: 'category', gridIndex: i, data: catLabels(d, x?.key, cats), show: false, boundaryGap: false })),
    yAxis: rows.map((_, i) => ({ type: 'value', gridIndex: i, show: false, scale: true })),
    series: rows.map((s, i) => ({ type: 'line', name: s.name, xAxisIndex: i, yAxisIndex: i, showSymbol: false, lineStyle: { width: 1.5, color: t.palette[i % t.palette.length] }, areaStyle: { opacity: 0.08, color: t.palette[i % t.palette.length] }, data: s.values }))
  }
}

/** Tasks (a dimension on Rows) as bars from a start date to an end date (two dates on Columns). */
export const gantt: Build = (d, t) => {
  const dates = dims(d, 'x').filter((f) => /^(DATE|TIMESTAMP)/.test(f.type))
  const [startF, endF] = dates
  const task = dims(d, 'y')[0] ?? dims(d).find((f) => !dates.includes(f))
  const color = dims(d, 'color')[0]
  const tasks = [...new Set(d.rows.map((r) => (task ? fmt(r[col(d, task.key)], task) : '')))]
  const groups = color ? [...new Set(d.rows.map((r) => fmt(r[col(d, color.key)], color)))] : ['']
  const items = d.rows
    .map((r) => ({ r, s: startF ? epoch(r[col(d, startF.key)]) : NaN, e: endF ? epoch(r[col(d, endF.key)]) : NaN }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e))
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return {
    ...base(t, d),
    grid: grid(d, groups.length > 1),
    legend: groups.length > 1 ? { top: d.options.title ? 34 : 4, textStyle: { color: t.text2 } } : undefined,
    tooltip: plainTooltip(t, (p: { value: [number, number, number]; dataIndex: number; seriesName: string }) => `<b>${esc(tasks[p.value[0]])}</b>${p.seriesName ? ` · ${esc(p.seriesName)}` : ''}<br>${day(p.value[1])} → ${day(p.value[2])} (${Math.round((p.value[2] - p.value[1]) / 86_400_000)} days)`),
    xAxis: { type: 'time', ...axisStyle(t), min: items.length ? Math.min(...items.map((x) => x.s)) : undefined },
    yAxis: { type: 'category', data: tasks, inverse: true, ...axisStyle(t) },
    series: groups.map((g, gi) => ({
      type: 'custom',
      name: g,
      encode: { x: [1, 2], y: 0 },
      renderItem: (_: unknown, api: { value: (i: number) => number; coord: (v: number[]) => number[]; size: (v: number[]) => number[]; style: () => Option }) => {
        const a = api.coord([api.value(1), api.value(0)])
        const b = api.coord([api.value(2), api.value(0)])
        const h = api.size([0, 1])[1] * 0.6
        return { type: 'rect', shape: { x: a[0], y: a[1] - h / 2, width: Math.max(2, b[0] - a[0]), height: h, r: 3 }, style: { ...api.style(), fill: t.palette[gi % t.palette.length] } }
      },
      data: items.filter((x) => !color || fmt(x.r[col(d, color.key)], color) === g).map((x) => ({ value: [tasks.indexOf(task ? fmt(x.r[col(d, task.key)], task) : ''), x.s, x.e], row: x.r }))
    }))
  }
}

// ---------------------------------------------------------------- density and violin (binned in SQL, smoothed here)

/** Wrapped query: 200 bins per group over every row, with each group's spread for the bandwidth. */
export const densityWrap = (sql: string, o: { hasCat: boolean }) => `WITH r AS (SELECT ${o.hasCat ? 'CAST(d0 AS VARCHAR)' : "'All'"} AS g, CAST(m0 AS DOUBLE) AS v FROM (${sql}) WHERE m0 IS NOT NULL), s AS (SELECT min(v) lo, max(v) hi FROM r), st AS (SELECT g, stddev_samp(v) sd, quantile_cont(v, 0.75) - quantile_cont(v, 0.25) iqr, count(*) cnt FROM r GROUP BY g)
SELECT r.g, least(199, floor((v - lo) / greatest((hi - lo) / 200, 1e-12)))::INTEGER AS b, count(*) AS n, any_value(lo) lo, any_value(hi) hi, any_value(sd) sd, any_value(iqr) iqr, any_value(cnt) cnt FROM r JOIN st USING (g) CROSS JOIN s GROUP BY ALL ORDER BY 1, 2`

/** Gaussian kernel density of each group from its bins (Silverman's bandwidth), at 120 points. */
export function densities(rows: Value[][]) {
  const groups = new Map<string, { b: number; n: number }[]>()
  const info = new Map<string, { sd: number; iqr: number; cnt: number }>()
  let lo = 0
  let hi = 1
  for (const r of rows) {
    const g = String(r[0])
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push({ b: Number(r[1]), n: Number(r[2]) })
    lo = Number(r[3])
    hi = Number(r[4])
    info.set(g, { sd: Number(r[5]) || 0, iqr: Number(r[6]) || 0, cnt: Number(r[7]) })
  }
  const w = (hi - lo) / 200 || 1
  const span = hi - lo || 1
  const out = [...groups].map(([g, bins]) => {
    const { sd, iqr, cnt } = info.get(g)!
    const spread = Math.min(sd || Infinity, iqr ? iqr / 1.34 : Infinity)
    const h = Math.max(0.9 * (Number.isFinite(spread) ? spread : span / 10) * cnt ** -0.2, w)
    const from = lo - 3 * h
    const to = hi + 3 * h
    const xs = Array.from({ length: 120 }, (_, i) => from + ((to - from) * i) / 119)
    const ys = xs.map((x) => bins.reduce((a, bin) => a + bin.n * Math.exp(-0.5 * ((x - (lo + (bin.b + 0.5) * w)) / h) ** 2), 0) / (cnt * h * Math.sqrt(2 * Math.PI)))
    return { g, xs, ys }
  })
  return out
}

export const density: Build = (d, t) => {
  const f = measures(d)[0]
  const ds = densities(d.rows)
  return {
    ...base(t, d),
    grid: grid(d, ds.length > 1),
    legend: legend(d, t, ds.length),
    tooltip: { trigger: 'axis', confine: true, formatter: (ps: { seriesName: string; value: [number, number] }[]) => `${esc(fmt(ps[0]?.value[0], f))}<br>${ps.map((p) => `${esc(p.seriesName)}: ${p.value[1].toPrecision(3)}`).join('<br>')}` },
    xAxis: valueAxis(t, f, { name: f?.title, nameLocation: 'middle', nameGap: 28, scale: true }),
    yAxis: { type: 'value', name: 'Density', ...axisStyle(t), axisLabel: { color: t.text2, formatter: (v: number) => v.toPrecision(2) } },
    series: ds.map((s) => ({ type: 'line', name: s.g, smooth: true, showSymbol: false, areaStyle: { opacity: 0.15 }, data: s.xs.map((x, i) => [x, s.ys[i]]) }))
  }
}

/** A mirrored density per group: where values concentrate, side by side. */
export const violin: Build = (d, t) => {
  const f = measures(d)[0]
  const ds = densities(d.rows)
  const peak = Math.max(...ds.flatMap((s) => s.ys), 1e-300)
  return {
    ...base(t, d),
    grid: grid(d, false),
    tooltip: plainTooltip(t, (p: { dataIndex: number }) => `<b>${esc(ds[p.dataIndex]?.g ?? '')}</b>`),
    xAxis: { type: 'category', data: ds.map((s) => s.g), ...axisStyle(t) },
    yAxis: valueAxis(t, f, { scale: true }),
    series: [
      {
        type: 'custom',
        renderItem: (params: { dataIndex: number }, api: { coord: (v: [number, number]) => number[]; size: (v: [number, number]) => number[] }) => {
          const s = ds[params.dataIndex]
          const band = api.size([1, 0])[0] * 0.45
          const pts = s.xs.map((y, i) => [api.coord([params.dataIndex, y])[0], api.coord([params.dataIndex, y])[1], (s.ys[i] / peak) * band])
          const shape = [...pts.map((p) => [p[0] - p[2], p[1]]), ...[...pts].reverse().map((p) => [p[0] + p[2], p[1]])]
          return { type: 'polygon', shape: { points: shape }, style: { fill: t.palette[params.dataIndex % t.palette.length], opacity: 0.6, stroke: t.palette[params.dataIndex % t.palette.length] } }
        },
        data: ds.map((_, i) => [i, 0])
      }
    ]
  }
}

// ---------------------------------------------------------------- correlation matrix, cohort

/** Wrapped query: Pearson correlation of every pair of the values, over every row. */
export const corrWrap = (sql: string, o: { measures: number }) => {
  const pairs: string[] = []
  for (let i = 0; i < o.measures; i++) for (let j = i + 1; j < o.measures; j++) pairs.push(`SELECT ${i} AS i, ${j} AS j, corr(m${i}, m${j}) AS r, count(*) FILTER (WHERE m${i} IS NOT NULL AND m${j} IS NOT NULL) AS n FROM r`)
  return `WITH r AS (${sql})\n${pairs.length ? pairs.join('\nUNION ALL ') : 'SELECT 0 AS i, 0 AS j, NULL::DOUBLE AS r, 0 AS n WHERE false'}`
}

export const corrMatrix: Build = (d, t) => {
  const ms = measures(d)
  const names = ms.map((m) => m.ref.label ?? m.ref.field)
  const r = new Map(d.rows.map((x) => [`${x[0]},${x[1]}`, { r: num(x[2]), n: Number(x[3]) }]))
  const cell = (i: number, j: number) => (i === j ? { r: 1, n: NaN } : (r.get(`${Math.min(i, j)},${Math.max(i, j)}`) ?? { r: null, n: 0 }))
  const data = names.flatMap((_, i) => names.map((__, j) => [j, i, cell(i, j).r]))
  return {
    ...base(t, d),
    grid: { ...grid(d, false), bottom: 56 },
    tooltip: plainTooltip(t, (p: { value: [number, number, number | null] }) => `${esc(names[p.value[1]])} × ${esc(names[p.value[0]])}<br><b>r = ${p.value[2] === null ? '—' : p.value[2].toFixed(3)}</b>${Number.isFinite(cell(p.value[1], p.value[0]).n) ? ` (n = ${cell(p.value[1], p.value[0]).n})` : ''}`),
    xAxis: { type: 'category', data: names, ...axisStyle(t), axisLabel: { color: t.text2, rotate: names.length > 5 ? 30 : 0 } },
    yAxis: { type: 'category', data: names, inverse: true, ...axisStyle(t) },
    visualMap: { min: -1, max: 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: [t.palette[0], t.dark ? '#2a2a30' : '#f4f4f6', t.palette[1]] }, textStyle: { color: t.text2 } },
    series: [{ type: 'heatmap', label: { show: names.length <= 10, color: t.text, formatter: (p: { value: [number, number, number | null] }) => (p.value[2] === null ? '' : p.value[2].toFixed(2)) }, itemStyle: { borderColor: t.dark ? '#18181b' : '#fff', borderWidth: 1 }, data }]
  }
}

/** Wrapped query: entities (Detail) by the period they first appear (Columns date) and the periods since. */
export const cohortWrap = (sql: string, o: { fields: OutField[] }) => {
  const date = o.fields.find((f) => f.kind === 'dim' && /^(DATE|TIMESTAMP)/.test(f.type))
  const entity = o.fields.find((f) => f.kind === 'dim' && f !== date)
  if (!date || !entity) return `SELECT NULL::DATE AS cohort, 0 AS k, 0 AS n WHERE false`
  const grain = date.ref.grain && date.ref.grain !== 'exact' && date.ref.grain !== 'hour' ? date.ref.grain : 'day'
  return `WITH a AS (SELECT DISTINCT date_trunc('${grain}', ${date.key}) AS p, ${entity.key} AS e FROM (${sql}) WHERE ${date.key} IS NOT NULL AND ${entity.key} IS NOT NULL), f AS (SELECT e, min(p) AS c FROM a GROUP BY e)
SELECT CAST(f.c AS DATE) AS cohort, date_diff('${grain}', f.c, a.p) AS k, count(DISTINCT a.e) AS n FROM a JOIN f USING (e) GROUP BY ALL ORDER BY 1, 2`
}

export const cohort: Build = (d, t) => {
  const date = dims(d).find((f) => /^(DATE|TIMESTAMP)/.test(f.type))
  const cohorts = [...new Set(d.rows.map((r) => String(r[0])))]
  const maxK = Math.max(0, ...d.rows.map((r) => Number(r[1])))
  const size = new Map(d.rows.filter((r) => Number(r[1]) === 0).map((r) => [String(r[0]), Number(r[2])]))
  const data = d.rows.map((r) => [Number(r[1]), cohorts.indexOf(String(r[0])), size.get(String(r[0])) ? Number(r[2]) / size.get(String(r[0]))! : null, Number(r[2])])
  const grainName = date?.ref.grain && date.ref.grain !== 'exact' ? date.ref.grain : 'day'
  return {
    ...base(t, d),
    grid: { ...grid(d, false), bottom: 56 },
    tooltip: plainTooltip(t, (p: { value: [number, number, number | null, number] }) => `Cohort ${esc(fmt(cohorts[p.value[1]], date))}, ${grainName} ${p.value[0]}<br><b>${p.value[2] === null ? '' : `${(p.value[2] * 100).toFixed(1)}%`}</b> (${p.value[3]} of ${size.get(cohorts[p.value[1]]) ?? '?'})`),
    xAxis: { type: 'category', name: `${grainName[0].toUpperCase()}${grainName.slice(1)}s since first`, nameLocation: 'middle', nameGap: 26, data: Array.from({ length: maxK + 1 }, (_, k) => String(k)), ...axisStyle(t) },
    yAxis: { type: 'category', data: cohorts.map((c) => fmt(c, date)), inverse: true, ...axisStyle(t) },
    visualMap: { min: 0, max: 1, dimension: 2, calculable: true, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: t.seq }, textStyle: { color: t.text2 }, formatter: (v: number) => `${Math.round(v * 100)}%` },
    series: [{ type: 'heatmap', label: { show: maxK <= 14 && cohorts.length <= 24, color: t.text, fontSize: 10, formatter: (p: { value: [number, number, number | null] }) => (p.value[2] === null ? '' : `${Math.round(p.value[2] * 100)}%`) }, itemStyle: { borderColor: t.dark ? '#18181b' : '#fff', borderWidth: 1 }, data }]
  }
}

// ---------------------------------------------------------------- maps

/** Areas (countries, states, or a custom map's) colored by the value; values the map doesn't know are listed. */
export const choropleth: Build = (d, t) => {
  // Drawn once the view has loaded the map (an unregistered map would make ECharts throw).
  if (!d.geo) return { ...base(t, d), series: [] }
  const area = dims(d)[0]
  const m = measures(d)[0]
  const lookup = d.geo.lookup
  const unmatched: string[] = []
  const totals = new Map<string, { v: number; row: Value[] }>()
  for (const r of d.rows) {
    const raw = area ? r[col(d, area.key)] : null
    const name = raw === null ? undefined : lookup.get(normalizeName(String(raw)))
    if (!name) {
      if (raw !== null) unmatched.push(String(raw))
      continue
    }
    const prev = totals.get(name)
    totals.set(name, { v: (prev?.v ?? 0) + (m ? Number(r[col(d, m.key)]) || 0 : 1), row: r })
  }
  const vals = [...totals.values()].map((x) => x.v)
  const b = base(t, d)
  return {
    ...b,
    title: unmatched.length ? { ...((b.title as Option) ?? { left: 8, top: 4 }), subtext: `${unmatched.length} value${unmatched.length > 1 ? 's' : ''} not on the map: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '…' : ''}`, subtextStyle: { color: t.text2 } } : b.title,
    tooltip: plainTooltip(t, (p: { name: string; value: number }) => `<b>${esc(p.name)}</b><br>${Number.isFinite(p.value) ? esc(fmt(p.value, m)) : 'No data'}`),
    visualMap: { min: Math.min(0, ...vals), max: Math.max(1, ...vals), calculable: true, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: t.seq }, textStyle: { color: t.text2 }, formatter: (v: number) => fmt(v, m, 'axis') },
    series: [{ type: 'map', map: d.geo.map, roam: true, top: unmatched.length || d.options.title ? 56 : 12, bottom: 48, itemStyle: { areaColor: t.dark ? '#2a2a30' : '#ececf0', borderColor: t.dark ? '#18181b' : '#fff', borderWidth: 0.5 }, emphasis: { label: { show: false }, itemStyle: { areaColor: t.accent } }, select: { disabled: true }, data: [...totals].map(([name, x]) => ({ name, value: x.v, row: x.row, itemStyle: dimmed(d, x.row) ? { opacity: 0.3 } : undefined })) }]
  }
}

/** Points at longitude (Columns) and latitude (Rows) on the map, sized and colored like a scatter plot. */
export const pointMap: Build = (d, t) => {
  if (!d.geo) return { ...base(t, d), series: [] }
  const ms = measures(d)
  // Placed by name (a city, "City, State", a ZIP code on Detail, optionally qualified by a second Detail field) when
  // there's no longitude and latitude.
  const place = dims(d, 'detail')[0]
  const qual = dims(d, 'detail')[1]
  const byName = !!place && !!d.geo.locate && !(measures(d, 'x')[0] && measures(d, 'y')[0])
  const lon = byName ? undefined : (measures(d, 'x')[0] ?? ms[0])
  const lat = byName ? undefined : (measures(d, 'y')[0] ?? ms.find((f) => f !== lon))
  let unknown = 0
  const at = (r: Value[]): [unknown, unknown] | null => {
    if (!byName) return [lon ? r[col(d, lon.key)] : null, lat ? r[col(d, lat.key)] : null]
    const c = d.geo!.locate!(r[col(d, place.key)], qual ? r[col(d, qual.key)] : undefined)
    if (!c) unknown++
    return c
  }
  const size = d.fields.find((f) => f.role === 'size')
  const color = dims(d, 'color')[0]
  const groups = new Map<string, Value[][]>()
  for (const r of d.rows) {
    const k = color ? fmt(r[col(d, color.key)], color) : ''
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  const sizes = size ? d.rows.map((r) => Math.abs(Number(r[col(d, size.key)]) || 0)) : []
  const smax = Math.max(1, ...sizes)
  return {
    ...base(t, d),
    legend: legend(d, t, groups.size),
    tooltip: rowTooltip(d, t),
    // Over background tiles: Web Mercator (the tiles' projection), the areas only outlined.
    geo: { map: d.geo.map, roam: true, top: d.options.title ? 48 : 12, bottom: 12, ...(d.geo.tiles ? { projection: MERCATOR } : {}), itemStyle: d.geo.tiles ? { areaColor: 'transparent', borderColor: 'rgba(0,0,0,0.15)', borderWidth: 0.5 } : { areaColor: t.dark ? '#2a2a30' : '#ececf0', borderColor: t.dark ? '#18181b' : '#fff', borderWidth: 0.5 }, emphasis: { disabled: true }, silent: true },
    series: [...groups].map(([name, rows]) => ({
      type: 'scatter',
      name: name || (byName ? place.title : lat?.title),
      coordinateSystem: 'geo',
      symbolSize: size ? (v: Value[]) => 5 + 25 * Math.sqrt(Math.abs(Number(v[2]) || 0) / smax) : 7,
      itemStyle: { opacity: 0.8 },
      data: rows.flatMap((r) => {
        const c = at(r)
        return c ? [{ value: [c[0], c[1], size ? r[col(d, size.key)] : 0], row: r, itemStyle: dimmed(d, r) ? { opacity: 0.2 } : undefined }] : []
      })
    })),
    // Like Tableau's "unknown" indicator: values no place was found for.
    graphic: [
      ...(unknown ? [{ id: 'unknown', type: 'text', right: 12, bottom: 10, style: { text: `${unknown.toLocaleString()} not found on the map`, fill: t.text2, fontSize: 11 } }] : []),
      // The tile provider's credit, as its terms require.
      ...(d.geo.tiles ? [{ id: 'credit', type: 'text', left: 8, bottom: 6, z: 100, style: { text: d.geo.tiles.attribution || 'Map tiles', fill: t.text2, fontSize: 10, backgroundColor: t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.75)', padding: [2, 4] } }] : [])
    ]
  }
}

// ---------------------------------------------------------------- custom visual (JSON template, no code)

const TOKEN = /^\$(categories|values|series|items|rows)(?::(\w+))?$/
/** Fills a JSON option template with the chart's data. Only data replaces tokens: no code is evaluated. */
export function fillTemplate(template: string, d: ChartData): Option {
  let tpl: unknown
  try {
    tpl = JSON.parse(template)
  } catch (e) {
    throw new Error(`The custom visual isn’t valid JSON: ${(e as Error).message}`)
  }
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw new Error('The custom visual must be a JSON object (an ECharts option).')
  const cat = dims(d)[0]
  const ms = measures(d)
  const { cats, series } = pivot(d, cat?.key ?? null, dims(d)[1]?.key ?? null, ms.map((m) => m.key))
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = TOKEN.exec(v)
      if (!m) return v
      const n = Number(m[2] ?? 0) || 0
      switch (m[1]) {
        case 'categories':
          return catLabels(d, cat?.key, cats)
        case 'values':
          return series[n]?.values ?? []
        case 'series':
          // $series:line, $series:bar… one series of that type per data series (default bar).
          return series.map((s) => ({ type: m[2] && !/^\d+$/.test(m[2]) ? m[2] : 'bar', name: s.name, data: s.values }))
        case 'items':
          return catLabels(d, cat?.key, cats).map((name, i) => ({ name, value: series[n]?.values[i] ?? null }))
        case 'rows':
          return d.rows.map((r) => Object.fromEntries(d.fields.map((f, i) => [f.title, r[i]])))
      }
    }
    if (Array.isArray(v)) return v.map(sub)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = sub(x)
      return out
    }
    return v
  }
  return sub(tpl) as Option
}

export const custom: Build = (d, t) => {
  const opt = fillTemplate(d.options.template ?? DEFAULT_TEMPLATE, d)
  // Tooltips as plain text: a template (or a data value) can't put HTML on the page.
  const tip = (opt.tooltip as Option | undefined) ?? { trigger: 'axis' }
  return { ...base(t, d), ...opt, tooltip: { ...tip, renderMode: 'richText', formatter: undefined } }
}

export const DEFAULT_TEMPLATE = JSON.stringify(
  {
    xAxis: { type: 'category', data: '$categories' },
    yAxis: { type: 'value' },
    tooltip: { trigger: 'axis' },
    series: [{ type: 'line', step: 'middle', data: '$values', areaStyle: { opacity: 0.2 } }]
  },
  null,
  2
)

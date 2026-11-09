import { describe, it, expect } from 'vitest'
import { plugin, recommend, fitTrend, quantile } from '@/core/charts/plugins'
import { LIGHT, pivot, fmt, esc, type ChartData } from '@/core/charts/data'
import type { OutField } from '@/core/query/compile'
import { addPeriods } from '@/core/stats/analyses'

const f = (key: string, field: string, kind: 'dim' | 'measure', role: OutField['role'], type = kind === 'dim' ? 'VARCHAR' : 'DOUBLE', extra: Partial<OutField['ref']> = {}): OutField => ({ key, role, kind, title: kind === 'measure' ? `Sum of ${field}` : field, type, ref: { field, ...(kind === 'measure' ? { agg: 'sum' } : {}), ...extra } })

const data: ChartData = {
  fields: [f('d0', 'region', 'dim', 'x'), f('d1', 'segment', 'dim', 'color'), f('m0', 'revenue', 'measure', 'y')],
  rows: [
    ['East', 'A', 10],
    ['East', 'B', 30],
    ['West', 'A', 20],
    ['West', 'B', null]
  ],
  truncated: false,
  options: {}
}

describe('chart data', () => {
  it('pivots long rows into categories and series in query order', () => {
    const p = pivot(data, 'd0', 'd1', ['m0'])
    expect(p.cats).toEqual(['East', 'West'])
    expect(p.series.map((s) => [s.name, s.values])).toEqual([['A', [10, 20]], ['B', [30, null]]])
  })
  it('formats dates at their grain and numbers compactly on axes', () => {
    expect(fmt('2025-03-01', f('d0', 'order_date', 'dim', 'x', 'DATE', { grain: 'quarter' }))).toBe('Q1 2025')
    expect(fmt('2025-03-01', f('d0', 'order_date', 'dim', 'x', 'DATE', { grain: 'year' }))).toBe('2025')
    expect(fmt(1_234_567, undefined, 'axis')).toMatch(/1\.2M/)
    expect(fmt(0.256, f('m0', 'x', 'measure', 'y', 'DOUBLE', { format: '0.0%' }))).toBe('25.6%')
    expect(fmt(null)).toBe('Null')
  })
  it('escapes data shown in tooltips', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('chart plugins', () => {
  it('stacks to 100%', () => {
    const o = plugin('bar').option!({ ...data, options: { stack: 'percent' } }, LIGHT) as { series: { stack: string; data: { value: number }[] }[] }
    expect(o.series.every((s) => s.stack === 'total')).toBe(true)
    expect(o.series[0].data[0].value).toBeCloseTo(0.25)
    expect(o.series[1].data[0].value).toBeCloseTo(0.75)
  })
  it('puts the second measure of a combo chart on a line and a right axis', () => {
    const d: ChartData = { ...data, fields: [f('d0', 'region', 'dim', 'x'), f('m0', 'revenue', 'measure', 'y'), f('m1', 'margin', 'measure', 'y')], rows: [['East', 10, 0.1], ['West', 20, 0.2]] }
    const o = plugin('combo').option!(d, LIGHT) as { series: { type: string; yAxisIndex: number }[]; yAxis: unknown[] }
    expect(o.series.map((s) => s.type)).toEqual(['bar', 'line'])
    expect(o.series[1].yAxisIndex).toBe(1)
    expect(Array.isArray(o.yAxis) && o.yAxis.length).toBe(2)
  })
  it('tooltips never contain raw HTML from data', () => {
    const d: ChartData = { ...data, rows: [['<img onerror=x>', 'A', 1]] }
    const o = plugin('pie').option!({ ...d, fields: [f('d0', 'region', 'dim', 'color'), f('m0', 'revenue', 'measure', 'y')], rows: [['<img onerror=x>', 1]] }, LIGHT) as { tooltip: { formatter: (p: unknown) => string }; series: { data: unknown[] }[] }
    const html = o.tooltip.formatter({ data: o.series[0].data[0] })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
  it('recommends a line for dates, bars for categories, scatter for two measures, KPI for one number', () => {
    expect(recommend({ dims: [{ type: 'DATE', role: 'x' }], measures: 1 })[0].id).toBe('line')
    expect(recommend({ dims: [{ type: 'VARCHAR', role: 'x' }], measures: 1 })[0].id).toBe('bar')
    expect(recommend({ dims: [], measures: 2 })[0].id).toBe('scatter')
    expect(recommend({ dims: [], measures: 1 })[0].id).toBe('kpi')
  })
})

import { findSlot, align, distribute, tileFilters, toggleMark, dynamicText } from '@/core/dashboard'
import type { Dashboard, DashItem } from '@/shared/dashboards'

describe('dashboard layout', () => {
  const it0 = (id: string, x: number, y: number, w: number, h: number): DashItem => ({ id, kind: 'chart', x, y, w, h })
  it('places new objects in free space, never on top of others', () => {
    const items = [it0('a', 16, 16, 560, 320)]
    const r = findSlot(items, 560, 320, 1366, 768)
    expect(r.x).toBeGreaterThanOrEqual(16 + 560 + 16)
    expect(r.y).toBe(16)
    const full = [it0('a', 0, 0, 1366, 768)]
    expect(findSlot(full, 560, 320, 1366, 768)).toEqual({ x: 16, y: 16, w: 560, h: 320 })
  })
  it('aligns and distributes on the grid', () => {
    const items = [it0('a', 10, 10, 100, 50), it0('b', 200, 40, 100, 80), it0('c', 600, 25, 100, 30)]
    expect(align(items, 'top').map((i) => i.y)).toEqual([10, 10, 10])
    expect(align(items, 'right').map((i) => i.x + i.w)).toEqual([700, 700, 700])
    const dist = distribute(items, 'h')
    expect(dist[1].x - (dist[0].x + dist[0].w)).toBeCloseTo(dist[2].x - (dist[1].x + dist[1].w), -1)
  })
})

describe('dashboard filtering', () => {
  const d: Dashboard = { id: 'd', name: 'D', size: { mode: 'fit', w: 1366, h: 768 }, items: [], actions: [{ id: 'a', kind: 'filter', source: '*', target: '*' }], updatedAt: 0 }
  const fields = (id: string) => new Set(id === 'map' ? ['region', 'sales'] : id === 'kpi' ? ['region', 'profit'] : ['product'])
  it('filter controls reach every chart with the field; clicked marks filter the other charts', () => {
    const sel = { region: { values: ['Virginia'] } }
    expect(tileFilters(d, 'kpi', fields, sel, [])).toEqual([{ id: 'dash:region', field: 'region', op: 'in', values: ['Virginia'] }])
    expect(tileFilters(d, 'other', fields, sel, [])).toEqual([])
    const marks = [{ item: 'map', values: { region: 'Virginia' } }]
    expect(tileFilters(d, 'kpi', fields, {}, marks)).toEqual([{ id: 'mark:map:region', field: 'region', op: 'in', values: ['Virginia'] }])
    expect(tileFilters(d, 'map', fields, {}, marks)).toEqual([]) // the clicked chart is not filtered by itself
  })
  it('clicking the same mark again clears it; dynamic titles show the selection', () => {
    const m = { item: 'map', values: { region: 'Virginia' } }
    expect(toggleMark(toggleMark([], m), m)).toEqual([])
    expect(dynamicText('Sales in {region}', {}, [m])).toBe('Sales in Virginia')
    expect(dynamicText('Sales in {region}', {}, [])).toBe('Sales in All')
  })
})

describe('chart analytics overlays', () => {
  const month = f('d0', 'order_date', 'dim', 'x', 'DATE', { grain: 'month' })
  const series = (n: number, skip = -1): ChartData => ({
    fields: [month, f('m0', 'revenue', 'measure', 'y')],
    rows: Array.from({ length: n }, (_, i) => [addPeriods('2024-01-01', 'month', i), 100 + 3 * i + 10 * Math.sin(i)]).filter((_, i) => i !== skip),
    truncated: false,
    options: { forecast: { periods: 6 } }
  })
  type O = { xAxis: { data: string[] }; series: { id?: string; data: unknown[]; markArea?: { data: { yAxis: number }[][] } }[] }

  it('adds periods, clamping month ends', () => {
    expect(addPeriods('2024-01-31', 'month', 1)).toBe('2024-02-29')
    expect(addPeriods('2024-11-01', 'quarter', 1)).toBe('2025-02-01')
    expect(addPeriods('2024-12-30', 'week', 1)).toBe('2025-01-06')
    expect(addPeriods('2024-02-29', 'year', 1)).toBe('2025-02-28')
  })

  it('forecast extends the date axis and adds a dashed series with its interval', () => {
    const o = plugin('line').option!(series(30), LIGHT) as O
    expect(o.xAxis.data).toHaveLength(36)
    const line = o.series.find((s) => s.id === 'fc-line-0')!
    expect(line.data).toHaveLength(36)
    expect(line.data.slice(30).every((v) => typeof v === 'number')).toBe(true)
    expect(o.series.filter((s) => s.id?.startsWith('fc-band'))).toHaveLength(2)
  })

  it('no forecast when periods are missing, the grain is not a date grain, or the chart is a bar chart', () => {
    expect((plugin('line').option!(series(30, 12), LIGHT) as O).series.some((s) => s.id?.startsWith('fc-'))).toBe(false)
    expect((plugin('bar').option!(series(30), LIGHT) as O).series.some((s) => s.id?.startsWith('fc-'))).toBe(false)
  })

  it('±1 SD band spans mean ± sample standard deviation', () => {
    const d: ChartData = { ...series(4), rows: [['2024-01-01', 1], ['2024-02-01', 2], ['2024-03-01', 3], ['2024-04-01', 4]], options: { refLines: [{ id: 'b', kind: 'band' }] } }
    const area = (plugin('line').option!(d, LIGHT) as O).series[0].markArea!.data[0]
    const sd = Math.sqrt(5 / 3)
    expect(area[0].yAxis).toBeCloseTo(2.5 - sd, 10)
    expect(area[1].yAxis).toBeCloseTo(2.5 + sd, 10)
  })

  it('trend models fit as numpy.polyfit does (exponential and power on ln y, as Tableau)', () => {
    const y = [2.1, 3.9, 6.2, 8.1, 9.8, 12.5, 13.9, 16.2]
    const pts = y.map((v, i) => [i + 1, v] as const)
    const ref = { linear: [9.087499999999999, 0.9980187601477608], log: [10.287301980000446, 0.915299452833642], exp: [Math.exp(2.030542295494273), 0.9236062665133502], power: [Math.exp(2.2071302615927193), 0.9985224931137221], poly: [9.078125, 0.99802743341377] } as const
    for (const [model, [at, r2]] of Object.entries(ref)) {
      const fit = fitTrend(pts, model as keyof typeof ref, 3)!
      expect(fit.predict(4.5)).toBeCloseTo(at, 9)
      expect(fit.r2).toBeCloseTo(r2, 9)
    }
    // Points a model can't take are left out (log of x ≤ 0); too few points: no line.
    expect(fitTrend([[0, 1], [1, 2], [2, 3]], 'log')).not.toBeNull()
    expect(fitTrend([[1, 2]], 'linear')).toBeNull()
  })

  it('percentile line, 95% CI band and quartile box (numpy percentiles, scipy t interval)', () => {
    const vals = [3, 1, 4, 1, 5, 9, 2, 6]
    const sorted = [...vals].sort((a, b) => a - b)
    expect([0.25, 0.5, 0.75, 0.9].map((q) => quantile(sorted, q))).toEqual([1.75, 3.5, 5.25, expect.closeTo(6.9, 12)])
    const d: ChartData = { ...series(8), rows: vals.map((v, i) => [`2024-0${i + 1}-01`, v]), options: { refLines: [{ id: 'p', kind: 'percentile', value: 90 }, { id: 'c', kind: 'ci' }, { id: 'b', kind: 'box' }, { id: 't', kind: 'trend', model: 'poly', degree: 2 }] } }
    const o = plugin('line').option!(d, LIGHT) as O & { series: { markLine?: { data: { yAxis: number }[] } }[] }
    const s0 = o.series[0]
    const lines = s0.markLine!.data.map((l) => l.yAxis)
    expect(lines[0]).toBeCloseTo(6.9, 10) // 90th percentile
    expect(lines.slice(1)).toEqual([3.5, 1, 9]) // box: median and whiskers (no values beyond 1.5 IQR)
    const [ci, box] = s0.markArea!.data
    expect(ci[0].yAxis).toBeCloseTo(1.5773000431592457, 9)
    expect(ci[1].yAxis).toBeCloseTo(6.172699956840754, 9)
    expect([box[0].yAxis, box[1].yAxis]).toEqual([1.75, 5.25])
    expect(o.series.find((s) => s.id === 'trend-0')!.data).toHaveLength(8)
  })
})

describe('reduced motion', () => {
  it('charts animate unless the system asks for reduced motion', () => {
    const d: ChartData = { fields: [f('d0', 'region', 'dim', 'x'), f('m0', 'revenue', 'measure', 'y')], rows: [['East', 1]], truncated: false, options: {} }
    expect((plugin('bar').option!(d, LIGHT) as { animation: boolean }).animation).toBe(true)
    expect((plugin('bar').option!(d, { ...LIGHT, motion: false }) as { animation: boolean }).animation).toBe(false)
    expect((plugin('map').option!({ ...d, geo: { map: 'world', lookup: new Map() } }, { ...LIGHT, motion: false }) as { animation: boolean }).animation).toBe(false)
  })
})

describe('patterns', () => {
  it('series get patterns as well as colors when asked', () => {
    const d: ChartData = { fields: [f('d0', 'region', 'dim', 'x'), f('m0', 'revenue', 'measure', 'y')], rows: [['East', 1]], truncated: false, options: {} }
    type A = { aria: { decal: { show: boolean } } }
    expect((plugin('bar').option!(d, LIGHT) as A).aria.decal.show).toBe(false)
    expect((plugin('pie').option!(d, { ...LIGHT, patterns: true }) as A).aria.decal.show).toBe(true)
    expect((plugin('waterfall').option!(d, LIGHT) as A).aria.decal.show).toBe(false)
  })
})

describe('axis labels', () => {
  it('stay compact with a number format, keeping the currency symbol', () => {
    const money = f('m0', 'revenue', 'measure', 'y', 'DOUBLE', { format: '$#,##0' })
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(1_250_000)
    expect(fmt(1_250_000, money, 'axis')).toBe(`$${compact}`)
    expect(fmt(1_250_000, money)).toBe('$1,250,000')
    expect(fmt(950, money, 'axis')).toBe('$950')
    expect(fmt(0.25, f('m1', 'share', 'measure', 'y', 'DOUBLE', { format: '0%' }), 'axis')).toBe('25%')
  })
})

import { actionUrl } from '@/core/dashboard'

describe('URL actions', () => {
  it('fill {Field} and <Field> with the clicked values, encoded; only web and email addresses', () => {
    expect(actionUrl('https://example.com/?q={region}&s=<Segment>', { Region: 'New York', segment: 'A&B' })).toBe('https://example.com/?q=New%20York&s=A%26B')
    expect(actionUrl('https://example.com/{unknown}', { region: 'x' })).toBe('https://example.com/{unknown}')
    expect(actionUrl('javascript:alert({region})', { region: 'x' })).toBeNull()
    expect(actionUrl('file:///etc/{region}', { region: 'passwd' })).toBeNull()
    expect(actionUrl('{region}', { region: 'javascript:alert(1)' })).toBeNull()
  })
})

import { coerceParam } from '@/shared/charts'

describe('parameters', () => {
  it('values are converted to the parameter type', () => {
    expect(coerceParam({ type: 'number' }, '1500')).toBe(1500)
    expect(coerceParam({ type: 'number' }, 'abc')).toBeNull()
    expect(coerceParam({ type: 'text' }, 42)).toBe('42')
    expect(coerceParam({ type: 'boolean' }, 'true')).toBe(true)
    expect(coerceParam({ type: 'date' }, '2025-03-01T00:00:00')).toBe('2025-03-01')
    expect(coerceParam({ type: 'date' }, 'March')).toBeNull()
    expect(coerceParam({ type: 'number' }, '')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { plugin, recommend } from '@/core/charts/plugins'
import { LIGHT, pivot, fmt, esc, type ChartData } from '@/core/charts/data'
import type { OutField } from '@/core/query/compile'

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

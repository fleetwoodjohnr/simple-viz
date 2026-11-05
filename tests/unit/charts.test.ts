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

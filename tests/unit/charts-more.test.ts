// The M6 chart types: what each option shows, on small hand-made results.
import { describe, it, expect } from 'vitest'
import { plugin } from '@/core/charts/plugins'
import { LIGHT, type ChartData, type Value } from '@/core/charts/data'
import { densities, fillTemplate, niceMax } from '@/core/charts/more'
import { geoLookup, checkGeoJson, normalizeName, placeLocator, type PlaceRow } from '@/core/charts/geo'
import places from '@/core/charts/geo/places.json'
import zips from '@/core/charts/geo/us-zip.json'
import type { OutField } from '@/core/query/compile'
import world from '@/core/charts/geo/world.json'
import usStates from '@/core/charts/geo/us-states.json'

const f = (key: string, field: string, kind: 'dim' | 'measure', role: OutField['role'], type = kind === 'dim' ? 'VARCHAR' : 'DOUBLE', extra: Partial<OutField['ref']> = {}): OutField => ({ key, role, kind, title: kind === 'measure' ? `Sum of ${field}` : field, type, ref: { field, ...(kind === 'measure' ? { agg: 'sum' } : {}), ...extra } })
const data = (fields: OutField[], rows: Value[][], options: ChartData['options'] = {}, extra: Partial<ChartData> = {}): ChartData => ({ fields, rows, truncated: false, options, ...extra })
type O = Record<string, any>
const opt = (id: string, d: ChartData) => plugin(id).option!(d, LIGHT) as O
const cat = f('d0', 'step', 'dim', 'x')
const val = f('m0', 'amount', 'measure', 'y')

describe('more chart types', () => {
  it('waterfall: running total with a final total bar', () => {
    const o = opt('waterfall', data([cat, val], [['Start', 100], ['Costs', -30], ['Sales', 50]]))
    expect(o.xAxis.data).toEqual(['Start', 'Costs', 'Sales', 'Total'])
    expect(o.series[0].data).toEqual([0, 70, 70, 0]) // invisible bases
    expect(o.series[1].data.map((x: O) => x.value)).toEqual([100, 30, 50, 120])
    expect(o.series[0].stackStrategy).toBe('all')
  })

  it('Pareto: largest first and a cumulative share ending at 100%', () => {
    const o = opt('pareto', data([cat, val], [['A', 10], ['B', 60], ['C', 30]]))
    expect(o.xAxis.data).toEqual(['B', 'C', 'A'])
    expect(o.series[1].data).toEqual([0.6, 0.9, 1])
  })

  it('funnel, gauge and bullet', () => {
    expect(opt('funnel', data([cat, val], [['Visit', 100], ['Buy', 20]])).series[0].data.map((x: O) => x.value)).toEqual([100, 20])
    const g = opt('gauge', data([val], [[73]]))
    expect([g.series[0].min, g.series[0].max, g.series[0].data[0].value]).toEqual([0, 80, 73])
    expect(opt('gauge', data([val], [[73]], { gauge: { max: 200 } })).series[0].max).toBe(200)
    expect([niceMax(0.3), niceMax(7), niceMax(1234)]).toEqual([0.3, 8, 1500])
    const b = opt('bullet', data([cat, val, f('m1', 'target', 'measure', 'y')], [['East', 80, 100], ['West', 120, 100]]))
    expect(b.series[1].data.map((x: O) => x.value)).toEqual([80, 120])
    expect(b.series[2].data).toEqual([100, 100])
    // Under target: the second color.
    expect(b.series[1].data[0].itemStyle.color).not.toBe(b.series[1].data[1].itemStyle.color)
  })

  it('radar: one axis per category, one shape per series', () => {
    const o = opt('radar', data([cat, f('d1', 'team', 'dim', 'color'), val], [['Speed', 'A', 3], ['Power', 'A', 5], ['Speed', 'B', 4], ['Power', 'B', 2]]))
    expect(o.radar.indicator.map((i: O) => i.name)).toEqual(['Speed', 'Power'])
    expect(o.series[0].data).toEqual([{ name: 'A', value: [3, 5] }, { name: 'B', value: [4, 2] }])
  })

  it('sankey: flows between consecutive fields; the same value at two levels is two nodes', () => {
    const d = data([f('d0', 'from', 'dim', 'x'), f('d1', 'to', 'dim', 'x'), val], [['A', 'B', 5], ['A', 'C', 3], ['B', 'C', 2]])
    const o = opt('sankey', d)
    expect(o.series[0].data).toHaveLength(4) // A, B (level 0); B, C (level 1)
    expect(o.series[0].links.map((l: O) => l.value)).toEqual([5, 3, 2])
    expect(o.series[0].label.formatter({ name: o.series[0].data[0].name })).toBe('A')
  })

  it('network, sunburst', () => {
    const n = opt('network', data([f('d0', 'a', 'dim', 'x'), f('d1', 'b', 'dim', 'x')], [['x', 'y'], ['y', 'x'], ['y', 'z']]))
    expect(n.series[0].data.map((x: O) => x.name).sort()).toEqual(['x', 'y', 'z'])
    expect(n.series[0].links.map((l: O) => l.value)).toEqual([2, 1]) // x–y counted both ways
    const s = opt('sunburst', data([f('d0', 'region', 'dim', 'x'), f('d1', 'state', 'dim', 'x'), val], [['East', 'NY', 3], ['East', 'VA', 2], ['West', 'CA', 4]]))
    expect(s.series[0].data).toEqual([{ name: 'East', children: [{ name: 'NY', value: 3 }, { name: 'VA', value: 2 }] }, { name: 'West', children: [{ name: 'CA', value: 4 }] }])
  })

  it('calendar, candlestick, sparklines', () => {
    const day = f('d0', 'date', 'dim', 'x', 'DATE', { grain: 'day' })
    const c = opt('calendar', data([day, val], [['2024-12-31', 1], ['2025-01-02', 4]]))
    expect(c.calendar.map((x: O) => x.range)).toEqual(['2024', '2025'])
    expect(c.series[1].data).toEqual([['2025-01-02', 4]])
    const ms = ['open', 'close', 'low', 'high'].map((n, i) => f(`m${i}`, n, 'measure', 'y'))
    const k = opt('candlestick', data([day, ...ms], [['2025-01-02', 10, 12, 9, 13]]))
    expect(k.series[0].data).toEqual([[10, 12, 9, 13]])
    const sp = opt('sparkline', data([f('d0', 'month', 'dim', 'x', 'DATE', { grain: 'month' }), f('d1', 'region', 'dim', 'color'), val], [['2025-01-01', 'East', 1], ['2025-02-01', 'East', 3], ['2025-01-01', 'West', 2], ['2025-02-01', 'West', 1]]))
    expect(sp.grid).toHaveLength(2)
    expect(sp.series.map((x: O) => x.data)).toEqual([[1, 3], [2, 1]])
    expect(JSON.stringify(sp)).not.toContain('calc(')
  })

  it('Gantt: a bar per task from start to end', () => {
    const d = data([f('d0', 'start', 'dim', 'x', 'DATE', { grain: 'exact' }), f('d1', 'end', 'dim', 'x', 'DATE', { grain: 'exact' }), f('d2', 'task', 'dim', 'y')], [['2025-01-01', '2025-01-11', 'Design'], ['2025-01-05', '2025-02-01', 'Build']])
    const o = opt('gantt', d)
    expect(o.yAxis.data).toEqual(['Design', 'Build'])
    expect(o.series[0].data.map((x: O) => x.value)).toEqual([[0, Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 11)], [1, Date.UTC(2025, 0, 5), Date.UTC(2025, 1, 1)]])
  })

  it('density: each curve integrates to about 1', () => {
    // Bins as the wrapped query returns them: group, bin, count, lo, hi, sd, iqr, n.
    const rows: Value[][] = Array.from({ length: 200 }, (_, b) => ['All', b, Math.round(1000 * Math.exp(-0.5 * ((b - 100) / 25) ** 2)), 0, 200, 25, 33.7, 0]).filter((r) => (r[2] as number) > 0)
    const n = rows.reduce((a, r) => a + (r[2] as number), 0)
    rows.forEach((r) => (r[7] = n))
    const [s] = densities(rows)
    const area = s.ys.reduce((a, y, i) => a + (i ? ((y + s.ys[i - 1]) / 2) * (s.xs[i] - s.xs[i - 1]) : 0), 0)
    expect(area).toBeGreaterThan(0.98)
    expect(area).toBeLessThan(1.02)
  })

  it('correlation matrix: symmetric with a diagonal of 1', () => {
    const ms = ['a', 'b', 'c'].map((n, i) => f(`m${i}`, n, 'measure', 'y'))
    const o = opt('corrmatrix', data(ms, [[0, 1, 0.5, 10], [0, 2, -0.2, 10], [1, 2, 0.9, 10]]))
    const at = (i: number, j: number) => o.series[0].data.find((x: number[]) => x[0] === j && x[1] === i)[2]
    expect([at(0, 0), at(1, 1), at(0, 1), at(1, 0), at(2, 1)]).toEqual([1, 1, 0.5, 0.5, 0.9])
  })

  it('cohort: the share of each cohort still active k periods later', () => {
    const o = opt('cohort', data([f('d0', 'date', 'dim', 'x', 'DATE', { grain: 'month' }), f('d1', 'customer', 'dim', 'detail')], [['2025-01-01', 0, 10], ['2025-01-01', 1, 4], ['2025-02-01', 0, 5], ['2025-02-01', 1, 5]]))
    expect(o.series[0].data.map((x: number[]) => x[2])).toEqual([1, 0.4, 1, 1])
    expect(o.xAxis.data).toEqual(['0', '1'])
  })

  it('maps: values match areas by name or code, whatever the case or accents; the rest are listed', () => {
    const lookup = geoLookup(world as never)
    for (const v of ['France', 'FRA', 'fr', 'united states', 'USA', "Côte d'Ivoire"]) expect(lookup.get(normalizeName(v)), v).toBeTruthy()
    const states = geoLookup(usStates as never)
    expect([states.get('va'), states.get(normalizeName('New York'))]).toEqual(['Virginia', 'New York'])
    const o = opt('map', data([f('d0', 'state', 'dim', 'x'), val], [['VA', 5], ['Virginia', 2], ['Atlantis', 1]], {}, { geo: { map: 'us-states', lookup: states } }))
    expect(o.series[0].map).toBe('us-states')
    expect(o.series[0].data.map((x: O) => [x.name, x.value])).toEqual([['Virginia', 7]])
    expect(o.title.subtext).toContain('1 value not on the map: Atlantis')
    const pts = opt('pointmap', data([f('m0', 'lon', 'measure', 'x'), f('m1', 'lat', 'measure', 'y')], [[-77, 38.9]], {}, { geo: { map: 'world', lookup } }))
    expect([pts.geo.map, pts.series[0].coordinateSystem, pts.series[0].data[0].value]).toEqual(['world', 'geo', [-77, 38.9, 0]])
  })

  it('places by name: cities (the most populous, or qualified), "City, State", accents, US ZIP codes', () => {
    const locate = placeLocator((places as unknown as { rows: PlaceRow[] }).rows, zips as unknown as Record<string, [number, number]>)
    expect(locate('Paris')).toEqual([2.331, 48.869])
    expect(locate('Portland')).toEqual([-122.682, 45.522]) // Oregon: the most populous Portland
    expect(locate('Portland, ME')).toEqual([-70.246, 43.672])
    expect(locate('Portland', 'Maine')).toEqual([-70.246, 43.672])
    expect(locate('London', 'GB')).toEqual([-0.119, 51.502])
    expect(locate('London, Ontario')).toEqual([-81.25, 42.97])
    expect(locate('sao paulo')).toEqual(locate('São Paulo'))
    expect(locate('10001')).toEqual([-73.997, 40.751])
    expect(locate('94103-1234')).toEqual([-122.411, 37.773])
    expect([locate('Atlantis'), locate('Springfield', 'Narnia'), locate(null)]).toEqual([null, null, null])
    // On a point map: one point per city, the unknown ones counted.
    const city = f('d0', 'city', 'dim', 'detail')
    const o = opt('pointmap', data([city, f('m0', 'sales', 'measure', 'size')], [['Lyon', 5], ['Paris', 7], ['Atlantis', 1]], {}, { geo: { map: 'world', lookup: new Map(), locate } }))
    expect(o.series[0].data.map((x: O) => x.value)).toEqual([[4.828, 45.772, 5], [2.331, 48.869, 7]])
    expect(o.graphic[0].style.text).toBe('1 not found on the map')
  })

  it('custom GeoJSON is checked before it is kept', () => {
    expect(() => checkGeoJson('nope')).toThrow(/valid JSON/)
    expect(() => checkGeoJson('{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"n":"x"},"geometry":{"type":"Point","coordinates":[0,0]}}]}')).toThrow(/no areas/)
    const ok = checkGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 1, NAME: 'North' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] }))
    expect(ok.nameProps).toEqual(['NAME'])
  })

  it('custom visuals: placeholders become data; nothing else changes; tooltips are plain text', () => {
    const d = data([cat, val], [['A', 1], ['B', 2]])
    const o = fillTemplate('{"xAxis":{"data":"$categories"},"series":"$series:line","extra":{"items":"$items","keep":"$notatoken"},"__proto__":{"polluted":true}}', d) as O
    expect(o.xAxis.data).toEqual(['A', 'B'])
    expect(o.series).toEqual([{ type: 'line', name: 'Sum of amount', data: [1, 2] }])
    expect(o.extra.items).toEqual([{ name: 'A', value: 1 }, { name: 'B', value: 2 }])
    expect(o.extra.keep).toBe('$notatoken')
    expect(({} as O).polluted).toBeUndefined()
    expect(() => fillTemplate('[1]', d)).toThrow(/JSON object/)
    const c = opt('custom', data([cat, val], [['A', 1]], { template: '{"tooltip":{"formatter":"<img src=x onerror=alert(1)>"},"series":[{"type":"bar","data":"$values"}]}' }))
    expect(c.tooltip).toEqual({ renderMode: 'richText', formatter: undefined })
    expect(c.series[0].data).toEqual([1])
  })

  it('small multiples: one panel per value, sharing the value scale', () => {
    const d = data([cat, f('d1', 'region', 'dim', 'facet'), val], [['A', 'East', 1], ['B', 'East', 4], ['A', 'West', 10], ['B', 'West', 2]])
    const o = opt('bar', d)
    expect(o.grid).toHaveLength(2)
    expect(o.title.map((x: O) => x.text)).toEqual(['East', 'West'])
    expect(o.series.map((s: O) => [s.xAxisIndex, s.data.map((x: O) => x.value)])).toEqual([[0, [1, 4]], [1, [10, 2]]])
    expect(o.yAxis.map((a: O) => a.max)).toEqual([10, 10])
    expect(JSON.stringify(o.grid)).not.toContain('calc(')
  })
})

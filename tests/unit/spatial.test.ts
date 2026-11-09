// Custom maps from spatial files: shapefiles written by pyshp and KML/KMZ (tests/fixtures/spatial, made by
// scripts/spatial-ref.py), read into GeoJSON areas.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spatialToGeoJson } from '@/core/charts/spatial'
import { checkGeoJson, type FeatureCollection } from '@/core/charts/geo'

const dir = path.resolve(__dirname, '../fixtures/spatial')
const file = (n: string) => ({ [n]: new Uint8Array(readFileSync(path.join(dir, n))) })
const ref = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as { shapes: { record: Record<string, unknown>; parts: number[]; points: [number, number][] }[]; near: [number, number][][] }
const expected = ref.shapes
const read = (files: Record<string, Uint8Array>) => JSON.parse(spatialToGeoJson(files)) as FeatureCollection
type Poly = [number, number][][]
const polys = (g: { type: string; coordinates: unknown }) => (g.type === 'Polygon' ? [g.coordinates as Poly] : (g.coordinates as Poly[]))
const signed = (r: [number, number][]) => r.reduce((a, [x, y], i) => a + x * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * y, 0)

describe('spatial files', () => {
  it('a zipped shapefile: areas with holes and several parts, attributes from the .dbf (UTF-8)', () => {
    const fc = read(file('areas.zip'))
    expect(fc.features.map((f) => f.properties)).toEqual(expected.map((e) => e.record))
    fc.features.forEach((f, i) => {
      const e = expected[i]
      const rings = e.parts.map((s, k) => e.points.slice(s, e.parts[k + 1] ?? e.points.length))
      const got = polys(f.geometry!).flat()
      // The same rings (wound for GeoJSON: outer counter-clockwise, holes clockwise).
      expect(got.map((r) => [...r].sort().join(';')).sort()).toEqual(rings.map((r) => [...r].sort().join(';')).sort())
      for (const p of polys(f.geometry!)) p.forEach((r, k) => expect(signed(r) > 0).toBe(k === 0))
    })
    expect(fc.features[0].geometry!.type).toBe('Polygon') // North: one area with a hole
    expect((fc.features[0].geometry!.coordinates as Poly)).toHaveLength(2)
    expect(fc.features[1].geometry!.type).toBe('MultiPolygon') // Südfeld: two parts
    expect(checkGeoJson(JSON.stringify(fc)).nameProps).toEqual(['NAME'])
    // The .shp and .dbf picked together give the same areas.
    expect(read({ ...file('areas.shp'), ...file('areas.dbf') }).features.map((f) => f.properties)).toEqual(fc.features.map((f) => f.properties))
  })

  it('KML and KMZ: placemarks with polygons (points dropped), names and extended data', () => {
    for (const n of ['areas.kml', 'areas.kmz']) {
      const fc = read(file(n))
      expect(fc.features.map((f) => f.properties)).toEqual([{ name: 'North', pop: '1200' }, { name: 'Südfeld', pop: '85' }])
      expect(fc.features.map((f) => f.geometry!.type)).toEqual(['Polygon', 'MultiPolygon'])
      expect((fc.features[0].geometry!.coordinates as Poly)[1]).toHaveLength(5) // the hole
    }
  })

  it('converts UTM and Web Mercator shapefiles to longitude/latitude (as pyproj projected them)', () => {
    for (const n of ['utm.zip', 'webmerc.zip']) {
      const fc = read(file(n))
      fc.features.forEach((f, i) => {
        const got = polys(f.geometry!).flat(2) as unknown as [number, number][]
        const want = ref.near[i]
        expect(got.length).toBe(want.length)
        // Every point of the original rings is found, to about a centimetre.
        for (const [x, y] of want) expect(got.some(([gx, gy]) => Math.abs(gx - x) < 1e-7 && Math.abs(gy - y) < 1e-7), `${n} ${x},${y}`).toBe(true)
      })
    }
  })

  it('TopoJSON: arcs decoded and shared between areas', () => {
    const fc = read(file('halves.topojson'))
    expect(fc.features.map((f) => [f.properties!.name, f.geometry!.coordinates])).toEqual([
      ['West', [[[11, 20], [11, 21], [10, 21], [10, 20], [11, 20]]]],
      ['East', [[[11, 20], [12, 20], [12, 21], [11, 21], [11, 20]]]]
    ])
  })

  it('refuses unsupported projections and files with no map, with the reason', () => {
    expect(() => read(file('projected.zip'))).toThrow(/can’t convert \(Lambert_Conformal_Conic_Test\)/)
    expect(() => read({ 'notes.txt': new TextEncoder().encode('hello') })).toThrow(/No map found/)
  })
})

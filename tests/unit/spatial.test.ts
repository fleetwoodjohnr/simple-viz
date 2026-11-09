// Custom maps from spatial files: shapefiles written by pyshp and KML/KMZ (tests/fixtures/spatial, made by
// scripts/spatial-ref.py), read into GeoJSON areas.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spatialToGeoJson } from '@/core/charts/spatial'
import { checkGeoJson, type FeatureCollection } from '@/core/charts/geo'

const dir = path.resolve(__dirname, '../fixtures/spatial')
const file = (n: string) => ({ [n]: new Uint8Array(readFileSync(path.join(dir, n))) })
const expected = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as { record: Record<string, unknown>; parts: number[]; points: [number, number][] }[]
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

  it('refuses projected shapefiles and files with no map, with the reason', () => {
    expect(() => read(file('projected.zip'))).toThrow(/projected coordinate system \(WGS_1984_UTM_Zone_33N\)/)
    expect(() => read({ 'notes.txt': new TextEncoder().encode('hello') })).toThrow(/No map found/)
  })
})

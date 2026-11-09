// Spatial files for custom maps, read into GeoJSON: Esri Shapefiles (.shp with its .dbf attributes, zipped or picked
// together) and KML/KMZ (Google Earth). Only areas are kept (the map fills them); coordinates must be longitude and
// latitude (WGS 84): a projected shapefile is refused with the reason, since reprojecting needs its projection's maths.
import type { FeatureCollection } from './geo'
import { readZip } from '../sheets/formats/zip'
import { parseXml, deep, kid, kids } from '../sheets/formats/xml'

type Feature = FeatureCollection['features'][number]
type Ring = [number, number][]

/** Twice the signed area: negative for clockwise rings (a shapefile's outer rings), positive for holes. */
const area2 = (r: Ring) => r.reduce((a, [x, y], i) => {
  const [x2, y2] = r[(i + 1) % r.length]
  return a + x * y2 - x2 * y
}, 0)

const inside = ([x, y]: [number, number], r: Ring) => {
  let ins = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]
    const [xj, yj] = r[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins
  }
  return ins
}

/** Rings to a (Multi)Polygon: outer rings (clockwise) each with the holes inside them, wound as GeoJSON wants. */
function polygonOf(rings: Ring[]): Feature['geometry'] {
  const outers: Ring[][] = []
  const holes: Ring[] = []
  for (const r of rings) (area2(r) <= 0 ? outers.push([r]) : holes.push(r))
  // Some writers wind every ring the same way: then each ring is an area of its own.
  if (!outers.length) for (const h of holes.splice(0)) outers.push([h])
  for (const h of holes) (outers.find((o) => inside(h[0], o[0])) ?? outers[0]).push(h)
  const polys = outers.map((p) => p.map((r, i) => ((i === 0) === area2(r) < 0 ? [...r].reverse() : r)))
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }
}

/** dBASE attributes: one object per record (text trimmed, numbers as numbers). */
export function readDbf(b: Uint8Array, encoding = 'utf-8'): Record<string, string | number | boolean | null>[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const n = v.getUint32(4, true)
  const headerLen = v.getUint16(8, true)
  const recLen = v.getUint16(10, true)
  let dec: TextDecoder
  try {
    dec = new TextDecoder(encoding, { fatal: encoding === 'utf-8' })
  } catch {
    dec = new TextDecoder('utf-8')
  }
  const latin = new TextDecoder('windows-1252')
  const str = (s: Uint8Array) => {
    try {
      return dec.decode(s)
    } catch {
      return latin.decode(s)
    }
  }
  const fields: { name: string; type: string; len: number; at: number }[] = []
  let at = 1
  for (let o = 32; o + 32 <= headerLen && b[o] !== 0x0d; o += 32) {
    const raw = b.subarray(o, o + 11)
    const name = latin.decode(raw.subarray(0, raw.indexOf(0) < 0 ? 11 : raw.indexOf(0))).trim()
    const len = b[o + 16]
    fields.push({ name, type: String.fromCharCode(b[o + 11]), len, at })
    at += len
  }
  const out: Record<string, string | number | boolean | null>[] = []
  for (let i = 0; i < n; i++) {
    const r = headerLen + i * recLen
    if (r + recLen > b.length) break
    if (b[r] === 0x2a) continue // deleted
    const row: Record<string, string | number | boolean | null> = {}
    for (const f of fields) {
      const text = str(b.subarray(r + f.at, r + f.at + f.len)).replace(/\0/g, '').trim()
      row[f.name] = !text ? null : f.type === 'N' || f.type === 'F' ? (Number.isFinite(Number(text)) ? Number(text) : null) : f.type === 'L' ? /^[TtYy]/.test(text) : text
    }
    out.push(row)
  }
  return out
}

/** A shapefile's polygons (shape types 5, 15, 25) with their dBASE attributes as properties. */
export function readShapefile(shp: Uint8Array, dbf?: Uint8Array, prj?: string, cpg?: string): FeatureCollection {
  if (prj && /^\s*PROJCS/i.test(prj)) throw new Error(`The shapefile uses a projected coordinate system (${/PROJCS\["([^"]+)"/i.exec(prj)?.[1] ?? 'not longitude/latitude'}). Save it as WGS 84 (EPSG:4326) first, e.g. in QGIS or mapshaper.`)
  const v = new DataView(shp.buffer, shp.byteOffset, shp.byteLength)
  if (shp.length < 100 || v.getInt32(0, false) !== 9994) throw new Error('This isn’t a shapefile (.shp).')
  const attrs = dbf ? readDbf(dbf, cpg?.trim().toLowerCase().replace(/^utf8$/, 'utf-8') || 'utf-8') : []
  const features: Feature[] = []
  let o = 100
  let idx = 0
  while (o + 12 <= shp.length) {
    const len = v.getInt32(o + 4, false) * 2
    const c = o + 8
    const type = c + 4 <= shp.length ? v.getInt32(c, true) : 0
    if ((type === 5 || type === 15 || type === 25) && c + 44 <= shp.length) {
      const parts = v.getInt32(c + 36, true)
      const points = v.getInt32(c + 40, true)
      const p0 = c + 44
      const xy = p0 + 4 * parts
      if (parts > 0 && points > 0 && xy + 16 * points <= shp.length) {
        const starts = Array.from({ length: parts }, (_, i) => v.getInt32(p0 + 4 * i, true))
        const rings: Ring[] = starts.map((s, i) => {
          const e = i + 1 < parts ? starts[i + 1] : points
          return Array.from({ length: Math.max(0, e - s) }, (_, k) => [v.getFloat64(xy + 16 * (s + k), true), v.getFloat64(xy + 16 * (s + k) + 8, true)] as [number, number])
        })
        if (rings.some((r) => r.some(([x, y]) => Math.abs(x) > 180.000001 || Math.abs(y) > 90.000001))) throw new Error('The shapefile’s coordinates aren’t longitude and latitude. Save it as WGS 84 (EPSG:4326) first, e.g. in QGIS or mapshaper.')
        features.push({ type: 'Feature', properties: attrs[idx] ?? {}, geometry: polygonOf(rings.filter((r) => r.length >= 4)) })
      }
    }
    idx++
    o = c + len
  }
  return { type: 'FeatureCollection', features }
}

/** KML: each Placemark's polygons (in MultiGeometry too), named by <name> and with its ExtendedData as properties. */
export function readKml(text: string): FeatureCollection {
  const doc = parseXml(text)
  const ring = (el: Element | null): Ring =>
    (kid(el, 'coordinates')?.textContent ?? '')
      .trim()
      .split(/\s+/)
      .map((t) => t.split(',').map(Number))
      .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [p[0], p[1]] as [number, number])
  const features: Feature[] = []
  for (const pm of deep(doc.documentElement, 'Placemark')) {
    const polys = deep(pm, 'Polygon').map((pg) => [ring(kid(kid(pg, 'outerBoundaryIs'), 'LinearRing')), ...kids(pg, 'innerBoundaryIs').map((ib) => ring(kid(ib, 'LinearRing')))].filter((r) => r.length >= 4))
    const ok = polys.filter((p) => p.length)
    if (!ok.length) continue
    const props: Record<string, string> = {}
    const name = kid(pm, 'name')?.textContent?.trim()
    if (name) props.name = name
    for (const d of deep(pm, 'Data')) {
      const k = d.getAttribute('name')
      if (k) props[k] = kid(d, 'value')?.textContent?.trim() ?? ''
    }
    for (const d of deep(pm, 'SimpleData')) {
      const k = d.getAttribute('name')
      if (k) props[k] = d.textContent?.trim() ?? ''
    }
    // KML winds outer rings counter-clockwise, as GeoJSON does.
    features.push({ type: 'Feature', properties: props, geometry: ok.length === 1 ? { type: 'Polygon', coordinates: ok[0] } : { type: 'MultiPolygon', coordinates: ok } })
  }
  return { type: 'FeatureCollection', features }
}

/**
 * Any supported spatial file (or a shapefile's parts picked together) as GeoJSON text, ready for the GeoJSON checks.
 * `files`: name → bytes.
 */
export function spatialToGeoJson(files: Record<string, Uint8Array>): string {
  let all = files
  const names = Object.keys(files)
  const one = names.length === 1 ? names[0].toLowerCase() : ''
  if (one.endsWith('.zip') || one.endsWith('.kmz')) all = readZip(files[names[0]])
  const find = (ext: string) => Object.entries(all).find(([n]) => n.toLowerCase().endsWith(ext) && !n.split('/').pop()!.startsWith('._'))?.[1]
  const dec = new TextDecoder()
  const json = find('.geojson') ?? find('.json')
  if (json) return dec.decode(json)
  const kml = find('.kml')
  if (kml) return JSON.stringify(readKml(dec.decode(kml)))
  const shp = find('.shp')
  if (shp) {
    const prj = find('.prj')
    const cpg = find('.cpg')
    return JSON.stringify(readShapefile(shp, find('.dbf'), prj && dec.decode(prj), cpg && dec.decode(cpg)))
  }
  throw new Error('No map found: choose a GeoJSON, KML or KMZ file, a zipped shapefile, or a .shp with its .dbf.')
}

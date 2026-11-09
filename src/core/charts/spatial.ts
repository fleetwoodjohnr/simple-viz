// Spatial files for custom maps, read into GeoJSON: Esri Shapefiles (.shp with its .dbf attributes, zipped or picked
// together), KML/KMZ (Google Earth) and TopoJSON. Only areas are kept (the map fills them). Shapefiles in longitude and
// latitude are read as they are; ones in Web Mercator or Transverse Mercator (UTM and most national grids) are
// converted using their .prj; other projections are refused with the reason.
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

type Inverse = (x: number, y: number) => [number, number]

const deg = 180 / Math.PI
/**
 * The inverse of a .prj's projection, to longitude/latitude: Web Mercator (spherical) or Transverse Mercator (Snyder's
 * series, accurate to millimetres within a zone), with false easting/northing and linear units. Null: not projected.
 */
export function inverseProjection(prj: string): Inverse | null {
  if (!/^\s*PROJCS/i.test(prj)) return null
  const name = /PROJCS\["([^"]+)"/i.exec(prj)?.[1] ?? 'unknown'
  const projection = /PROJECTION\["([^"]+)"/i.exec(prj)?.[1] ?? ''
  const param = (n: string, d = 0) => Number(new RegExp(`PARAMETER\\["${n}",\\s*(-?[\\d.eE+-]+)`, 'i').exec(prj)?.[1] ?? d)
  // The last UNIT is the projected (linear) one.
  const units = [...prj.matchAll(/UNIT\["[^"]*",\s*([\d.eE+-]+)/gi)]
  const unit = units.length > 1 ? Number(units[units.length - 1][1]) : 1
  const fe = param('False_Easting')
  const fn = param('False_Northing')
  if (/Mercator_Auxiliary_Sphere|Pseudo.?Mercator|Web_Mercator/i.test(projection + name)) {
    const R = 6378137
    return (x, y) => [((x * unit - fe) / R) * deg, (2 * Math.atan(Math.exp((y * unit - fn) / R)) - Math.PI / 2) * deg]
  }
  if (/Transverse_Mercator/i.test(projection) && !/South_Orientated/i.test(projection)) {
    const sph = /SPHEROID\["[^"]*",\s*([\d.eE+-]+),\s*([\d.eE+-]+)/i.exec(prj)
    const a = Number(sph?.[1] ?? 6378137)
    const invf = Number(sph?.[2] ?? 298.257223563)
    const f = invf ? 1 / invf : 0
    const e2 = 2 * f - f * f
    const ep2 = e2 / (1 - e2)
    const k0 = param('Scale_Factor', 1)
    const lon0 = param('Central_Meridian') / deg
    const lat0 = param('Latitude_Of_Origin') / deg
    const m = (p: number) => a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * p - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * p) + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * p) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * p))
    const M0 = m(lat0)
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
    return (x, y) => {
      const M = M0 + (y * unit - fn) / k0
      const mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256))
      const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
      const s = Math.sin(p1)
      const c = Math.cos(p1)
      const C1 = ep2 * c * c
      const T1 = Math.tan(p1) ** 2
      const N1 = a / Math.sqrt(1 - e2 * s * s)
      const R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5
      const D = (x * unit - fe) / (N1 * k0)
      const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720)
      const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / c
      return [lon * deg, lat * deg]
    }
  }
  throw new Error(`The shapefile uses a projection Simple Viz can’t convert (${name}). Save it as WGS 84 (EPSG:4326) first, e.g. in QGIS or mapshaper.`)
}

/** A shapefile's polygons (shape types 5, 15, 25) with their dBASE attributes as properties. */
export function readShapefile(shp: Uint8Array, dbf?: Uint8Array, prj?: string, cpg?: string): FeatureCollection {
  const inverse = prj ? inverseProjection(prj) : null
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
          return Array.from({ length: Math.max(0, e - s) }, (_, k) => {
            const px = v.getFloat64(xy + 16 * (s + k), true)
            const py = v.getFloat64(xy + 16 * (s + k) + 8, true)
            return inverse ? inverse(px, py) : ([px, py] as [number, number])
          })
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
  const json = find('.geojson') ?? find('.topojson') ?? find('.json')
  if (json) {
    const text = dec.decode(json)
    return /"type"\s*:\s*"Topology"/.test(text.slice(0, 2000)) ? JSON.stringify(topoToGeo(JSON.parse(text))) : text
  }
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

type Topology = { type: 'Topology'; arcs: number[][][]; transform?: { scale: [number, number]; translate: [number, number] }; objects: Record<string, { type: string; geometries?: TopoGeom[] } & TopoGeom> }
type TopoGeom = { type: string; arcs?: unknown; properties?: Record<string, unknown> }

/** TopoJSON to GeoJSON: arcs decoded (delta-encoded and scaled when quantized), polygons stitched from their arcs. */
export function topoToGeo(t: Topology): FeatureCollection {
  if (t?.type !== 'Topology' || !Array.isArray(t.arcs) || !t.objects) throw new Error('This isn’t a valid TopoJSON file.')
  const arcs = t.arcs.map((arc) => {
    if (!t.transform) return arc.map((p) => [p[0], p[1]] as [number, number])
    let x = 0
    let y = 0
    return arc.map((p) => ((x += p[0]), (y += p[1]), [x * t.transform!.scale[0] + t.transform!.translate[0], y * t.transform!.scale[1] + t.transform!.translate[1]] as [number, number]))
  })
  const ring = (ids: number[]): Ring => {
    const out: Ring = []
    for (const i of ids) {
      const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i]
      if (!a) throw new Error('The TopoJSON file refers to an arc it doesn’t have.')
      out.push(...(out.length ? a.slice(1) : a))
    }
    return out
  }
  const features: Feature[] = []
  for (const obj of Object.values(t.objects)) {
    for (const g of obj.type === 'GeometryCollection' ? (obj.geometries ?? []) : [obj]) {
      const geometry = g.type === 'Polygon' ? { type: 'Polygon', coordinates: (g.arcs as number[][]).map(ring) } : g.type === 'MultiPolygon' ? { type: 'MultiPolygon', coordinates: (g.arcs as number[][][]).map((p) => p.map(ring)) } : null
      if (geometry) features.push({ type: 'Feature', properties: g.properties ?? {}, geometry })
    }
  }
  return { type: 'FeatureCollection', features }
}

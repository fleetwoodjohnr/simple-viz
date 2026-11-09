// Maps: matching data values (country names, ISO codes, US state names or postal codes, or a custom map's area names)
// to map areas. The bundled maps come from Natural Earth (scripts/gen-geo.ts); custom GeoJSON lives in the project.

export interface FeatureCollection {
  type: 'FeatureCollection'
  features: { type: 'Feature'; properties: Record<string, unknown> | null; geometry: { type: string; coordinates: unknown } | null }[]
}

export const BUILTIN_MAPS = [
  { id: 'world', label: 'World (countries)' },
  { id: 'us-states', label: 'United States (states)' }
] as const

/** Case, accents and punctuation don't matter: "Côte d'Ivoire" = "cote d ivoire". */
export const normalizeName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Every name and code of every area → the area's name (what ECharts matches on). */
export function geoLookup(fc: FeatureCollection, nameProp = 'name'): Map<string, string> {
  const m = new Map<string, string>()
  for (const f of fc.features) {
    const name = f.properties?.[nameProp]
    if (typeof name !== 'string' || !name) continue
    const aliases = Array.isArray(f.properties?.aliases) ? (f.properties!.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : []
    for (const a of [name, ...aliases]) if (!m.has(normalizeName(a))) m.set(normalizeName(a), name)
  }
  return m
}

/** A GeoJSON file's checks before it is kept in a project: a FeatureCollection of (multi)polygons with a name. */
export function checkGeoJson(text: string): { fc: FeatureCollection; nameProps: string[] } {
  let fc: FeatureCollection
  try {
    fc = JSON.parse(text)
  } catch {
    throw new Error('This file isn’t valid JSON.')
  }
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features) || !fc.features.length) throw new Error('A GeoJSON FeatureCollection with at least one area is needed.')
  const areas = fc.features.filter((f) => f?.geometry && /Polygon$/.test(f.geometry.type))
  if (!areas.length) throw new Error('The file has no areas (Polygon or MultiPolygon). Points and lines can’t be filled.')
  // Text properties every area has: candidates for the area name.
  const keys = Object.keys(areas[0].properties ?? {}).filter((k) => areas.every((f) => typeof f.properties?.[k] === 'string'))
  if (!keys.length) throw new Error('The areas have no text property to name them by.')
  return { fc: { type: 'FeatureCollection', features: areas }, nameProps: [...keys].sort((a, b) => Number(/name/i.test(b)) - Number(/name/i.test(a))) }
}

// ---------------------------------------------------------------- places (point maps by name)

/** [name, ascii name or 0, state/province, ISO country code, country, longitude, latitude, population] */
export type PlaceRow = [string, string | 0, string, string, string, number, number, number]

const US_STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico' }

export type Locate = (value: unknown, qualifier?: unknown) => [number, number] | null

/** A postal code as stored for its country: UK outward codes (SW1A), Canadian forward sortation areas (K1A), Dutch 4 digits. */
export function postcodeKey(cc: string, code: string): string {
  const c = code.trim().toUpperCase().replace(/\s+/g, ' ')
  if (cc === 'GB') return c.includes(' ') ? c.split(' ')[0] : c.length >= 5 ? c.slice(0, -3) : c
  if (cc === 'CA') return c.replace(/\s/g, '').slice(0, 3)
  if (cc === 'NL') return c.replace(/\D/g, '').slice(0, 4)
  return c.replace(/\s/g, '')
}

/**
 * Finds places by name: a city ("Lyon"), qualified by a state, province or country ("Portland, Oregon", "Portland,
 * ME", "Paris, France", or the qualifier as a second field), or a postal code: US ZIP codes ("10001", "10001-1234"),
 * UK and Canadian codes by their form ("SW1A 1AA", "K1A 0B1"), and the codes of other countries with the country
 * ("75001, France", or a country field). Several places with the same name: the qualified one, else the most populous.
 */
export function placeLocator(places: PlaceRow[], zips?: Record<string, [number, number]>, postcodes?: Record<string, Record<string, [number, number]>>): Locate {
  const byName = new Map<string, PlaceRow[]>()
  for (const p of places)
    for (const n of new Set([normalizeName(p[0]), p[1] ? normalizeName(p[1]) : ''])) {
      if (!n) continue
      if (!byName.has(n)) byName.set(n, [])
      byName.get(n)!.push(p)
    }
  for (const list of byName.values()) list.sort((a, b) => b[7] - a[7])
  // Country names (and codes) → ISO code, for postal codes.
  const countries = new Map<string, string>()
  for (const p of places) if (p[3] && p[4]) countries.set(normalizeName(p[4]), p[3])
  for (const [k, v] of Object.entries({ uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', usa: 'US', 'united states of america': 'US', deutschland: 'DE', espana: 'ES', italia: 'IT', nederland: 'NL', 'the netherlands': 'NL', schweiz: 'CH', suisse: 'CH', osterreich: 'AT', belgique: 'BE', belgie: 'BE', bharat: 'IN' })) countries.set(k, v)
  const country = (q: string) => (/^[A-Za-z]{2}$/.test(q.trim()) && (q.trim().toUpperCase() === 'US' || postcodes?.[q.trim().toUpperCase()]) ? q.trim().toUpperCase() : countries.get(normalizeName(q)))
  const post = (cc: string, code: string): [number, number] | null => (cc === 'US' ? (zips?.[code.trim().slice(0, 5)] ?? null) : (postcodes?.[cc]?.[postcodeKey(cc, code)] ?? null))
  const fits = (p: PlaceRow, q: string) => {
    const n = normalizeName(q)
    const state = US_STATES[q.trim().toUpperCase()]
    return [p[2], p[3], p[4]].some((x) => normalizeName(x) === n) || (!!state && p[3] === 'US' && normalizeName(p[2]) === normalizeName(state))
  }
  return (value, qualifier) => {
    if (value === null || value === undefined) return null
    let text = String(value).trim()
    let q = qualifier === null || qualifier === undefined ? '' : String(qualifier).trim()
    const comma = text.lastIndexOf(',')
    if (!q && comma > 0) {
      q = text.slice(comma + 1).trim()
      text = text.slice(0, comma).trim()
    }
    // A postal code: with its country, or recognised by its form (US, UK, Canada).
    if (/\d/.test(text)) {
      const cc = q ? country(q) : undefined
      if (cc) return post(cc, text)
      if (!q) {
        if (/^\d{5}(-\d{4})?$/.test(text)) return post('US', text)
        if (/^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i.test(text)) return post('GB', text)
        if (/^[A-Z]\d[A-Z](\s*\d[A-Z]\d)?$/i.test(text)) return post('CA', text)
      }
    }
    const list = byName.get(normalizeName(text))
    if (!list) return null
    const hit = q ? list.find((p) => fits(p, q)) : list[0]
    return hit ? [hit[5], hit[6]] : null
  }
}

// ---------------------------------------------------------------- background map tiles (Web Mercator)

const MAX_LAT = 85.05112878
/** Longitude/latitude → the Web Mercator square [0, 1]² that map tiles cut up (y down). */
export const mercator = (lon: number, lat: number): [number, number] => {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2]
}
export const unmercator = (x: number, y: number): [number, number] => [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI]

/** ECharts geo projection matching the tiles. */
export const MERCATOR = { project: (p: number[]) => mercator(p[0], p[1]), unproject: (p: number[]) => unmercator(p[0], p[1]) }

/**
 * The tiles covering a view: the zoom level whose 256 px tiles best fit the world's width on screen, and the tiles
 * inside the view's Mercator bounds (at most `max`; fewer, coarser tiles beyond that).
 */
export function tilesFor(view: { x0: number; y0: number; x1: number; y1: number }, worldPx: number, max = 64): { z: number; tiles: { x: number; y: number }[] } {
  let z = Math.max(0, Math.min(19, Math.round(Math.log2(Math.max(1, worldPx) / 256))))
  for (;;) {
    const n = 2 ** z
    const clamp = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v * n)))
    const [tx0, tx1, ty0, ty1] = [clamp(Math.min(view.x0, view.x1)), clamp(Math.max(view.x0, view.x1)), clamp(Math.min(view.y0, view.y1)), clamp(Math.max(view.y0, view.y1))]
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= max || z === 0) {
      const tiles: { x: number; y: number }[] = []
      for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) tiles.push({ x, y })
      return { z, tiles }
    }
    z--
  }
}

/** A tile server address: https (or http on this computer), with {z}, {x} and {y}. */
export function validTileTemplate(t: string): boolean {
  if (!/\{z\}/.test(t) || !/\{x\}/.test(t) || !/\{y\}/.test(t)) return false
  try {
    const u = new URL(t.replace(/\{[zxys]\}/g, '0'))
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}

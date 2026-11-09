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

/**
 * Finds places by name: a city ("Lyon"), qualified by a state, province or country ("Portland, Oregon", "Portland,
 * ME", "Paris, France", or the qualifier as a second field), or a US ZIP code ("10001", "10001-1234"). Several places
 * with the same name: the qualified one, else the most populous.
 */
export function placeLocator(places: PlaceRow[], zips?: Record<string, [number, number]>): Locate {
  const byName = new Map<string, PlaceRow[]>()
  for (const p of places)
    for (const n of new Set([normalizeName(p[0]), p[1] ? normalizeName(p[1]) : ''])) {
      if (!n) continue
      if (!byName.has(n)) byName.set(n, [])
      byName.get(n)!.push(p)
    }
  for (const list of byName.values()) list.sort((a, b) => b[7] - a[7])
  const fits = (p: PlaceRow, q: string) => {
    const n = normalizeName(q)
    const state = US_STATES[q.trim().toUpperCase()]
    return [p[2], p[3], p[4]].some((x) => normalizeName(x) === n) || (!!state && p[3] === 'US' && normalizeName(p[2]) === normalizeName(state))
  }
  return (value, qualifier) => {
    if (value === null || value === undefined) return null
    let text = String(value).trim()
    const zip = /^(\d{5})(-\d{4})?$/.exec(text)
    if (zip) return zips?.[zip[1]] ?? null
    let q = qualifier === null || qualifier === undefined ? '' : String(qualifier).trim()
    const comma = text.lastIndexOf(',')
    if (!q && comma > 0) {
      q = text.slice(comma + 1).trim()
      text = text.slice(0, comma).trim()
    }
    const list = byName.get(normalizeName(text))
    if (!list) return null
    const hit = q ? list.find((p) => fits(p, q)) : list[0]
    return hit ? [hit[5], hit[6]] : null
  }
}

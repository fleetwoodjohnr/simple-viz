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

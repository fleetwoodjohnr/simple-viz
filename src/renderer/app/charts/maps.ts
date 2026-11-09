// Loads and registers the maps map charts draw on: the bundled ones (loaded on first use) and the project's own.
import * as echarts from 'echarts/core'
import { geoLookup, normalizeName, placeLocator, type FeatureCollection, type Locate, type PlaceRow } from '@/core/charts/geo'
import type { CustomMap } from '@/shared/project'
import type { ChartData, Value } from '@/core/charts/data'

const BUILTIN: Record<string, () => Promise<{ default: unknown }>> = {
  world: () => import('@/core/charts/geo/world.json'),
  'us-states': () => import('@/core/charts/geo/us-states.json')
}
const loaded = new Map<string, Promise<Map<string, string>>>()

function load(id: string, custom: CustomMap[]): Promise<Map<string, string>> | null {
  const c = custom.find((m) => m.id === id)
  if (!c && !BUILTIN[id]) return null
  if (!loaded.has(id)) {
    loaded.set(
      id,
      (async () => {
        const fc = (c ? c.geojson : (await BUILTIN[id]()).default) as FeatureCollection
        echarts.registerMap(id, fc as never)
        return geoLookup(fc)
      })()
    )
  }
  return loaded.get(id)!
}

/** The chart's map (or, when none is chosen, the one whose areas match most of the values) and its lookup. */
export async function resolveMap(chosen: string | undefined, values: Value[], custom: CustomMap[]): Promise<ChartData['geo']> {
  const ids = chosen ? [chosen] : ['world', 'us-states', ...custom.map((m) => m.id)]
  const sample = [...new Set(values.filter((v) => v !== null).map((v) => normalizeName(String(v))))].slice(0, 300)
  let best: ChartData['geo'] & { hits: number } = { map: 'world', lookup: new Map(), hits: -1 }
  for (const id of ids) {
    const lookup = await load(id, custom)
    if (!lookup) continue
    const hits = sample.filter((v) => lookup.has(v)).length
    if (hits > best.hits) best = { map: id, lookup, hits }
  }
  if (best.hits < 0) best = { map: 'world', lookup: (await load('world', custom))!, hits: 0 }
  return { map: best.map, lookup: best.lookup }
}

let places: Promise<PlaceRow[]> | null = null
let zips: Promise<Record<string, [number, number]>> | null = null
/** Finds places by name for point maps (loaded on first use; ZIP codes only when the values look like them). */
export async function placeLocate(values: Value[]): Promise<Locate> {
  places ??= import('@/core/charts/geo/places.json').then((m) => (m.default as unknown as { rows: PlaceRow[] }).rows)
  const wantZips = values.some((v) => /^\d{5}(-\d{4})?$/.test(String(v ?? '').trim()))
  if (wantZips) zips ??= import('@/core/charts/geo/us-zip.json').then((m) => m.default as unknown as Record<string, [number, number]>)
  return placeLocator(await places, wantZips ? await zips! : undefined)
}

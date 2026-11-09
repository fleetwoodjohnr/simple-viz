// Background map tiles, fetched here (not in the window, whose content policy allows no network): only from the tile
// server set in Settings (off by default), only tile coordinates, only images up to 2 MB, kept in memory for reuse.
import { app, net } from 'electron'
import { validTileTemplate } from '../core/charts/geo'
import * as store from './store'

const cache = new Map<string, { type: string; data: Uint8Array }>()
const MAX_CACHED = 600

export async function fetchTile(z: unknown, x: unknown, y: unknown): Promise<{ type: string; data: Uint8Array } | null> {
  const ok = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max
  if (!ok(z, 19) || !ok(x, 2 ** (z as number) - 1) || !ok(y, 2 ** (z as number) - 1)) throw new Error('Invalid tile')
  const template = (await store.getSettings()).mapTiles
  if (!template || !validTileTemplate(template)) return null
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', 'abc'[(x + y) % 3])
  const hit = cache.get(url)
  if (hit) {
    cache.delete(url)
    cache.set(url, hit)
    return hit
  }
  const res = await net.fetch(url, { headers: { 'User-Agent': `SimpleViz/${app.getVersion()} (+https://github.com/fleetwoodjohnr/simple-viz)` }, signal: AbortSignal.timeout(15_000) })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !/^image\/(png|jpeg|webp)/.test(type)) return null
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.byteLength > 2 * 1024 ** 2) return null
  const tile = { type: type.split(';')[0], data }
  cache.set(url, tile)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return tile
}

/** Settings changed: tiles from another server mustn't be reused. */
export const clearTiles = () => cache.clear()

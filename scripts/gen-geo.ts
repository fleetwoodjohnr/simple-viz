// Builds the bundled maps (npm run geo) from Natural Earth 1:110m (public domain, naturalearthdata.com), pinned by
// SHA-256: src/core/charts/geo/world.json (countries) and us-states.json. Each feature keeps its display name and the
// other names and codes a data value may use (ISO 3166 alpha-2/alpha-3, postal codes); coordinates are rounded.
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson'
const SOURCES = {
  world: { file: 'ne_110m_admin_0_countries.geojson', sha256: '6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f' },
  'us-states': { file: 'ne_110m_admin_1_states_provinces.geojson', sha256: '0067dec6a2c4f9c7a644bf7a9a46163d8d881595953326d0c67d89934190aefe' }
}
type Props = Record<string, string | number | null>
type Geometry = { type: string; coordinates: unknown }

const round = (c: unknown): unknown => (typeof c === 'number' ? Math.round(c * 100) / 100 : Array.isArray(c) ? c.map(round) : c)
const codes = (...v: (string | number | null | undefined)[]) => [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== '-99' && x.trim() !== ''))]

const out = path.resolve(import.meta.dirname, '..', 'src', 'core', 'charts', 'geo')
mkdirSync(out, { recursive: true })
for (const [id, s] of Object.entries(SOURCES)) {
  const bytes = new Uint8Array(await (await fetch(`${BASE}/${s.file}`)).arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== s.sha256) throw new Error(`${s.file}: SHA-256 ${sha}, expected ${s.sha256}`)
  const src = JSON.parse(new TextDecoder().decode(bytes)) as { features: { properties: Props; geometry: Geometry }[] }
  const features = src.features.map((f) => {
    const p = f.properties
    const name = String(id === 'world' ? p.NAME : p.name)
    const aliases = id === 'world' ? codes(p.NAME_LONG as string, p.ADMIN as string, p.NAME_EN as string, p.FORMAL_EN as string, p.ISO_A2_EH as string, p.ISO_A2 as string, p.ISO_A3_EH as string, p.ISO_A3 as string, p.ADM0_A3 as string) : codes(p.postal as string, p.iso_3166_2 as string, p.name_en as string)
    return { type: 'Feature', properties: { name, aliases: aliases.filter((a) => a !== name) }, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } }
  })
  writeFileSync(path.join(out, `${id}.json`), JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`${id}: ${features.length} areas`)
}

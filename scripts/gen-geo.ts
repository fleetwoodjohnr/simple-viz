// Builds the bundled maps (npm run geo) from Natural Earth 1:110m (public domain, naturalearthdata.com), pinned by
// SHA-256: src/core/charts/geo/world.json (countries) and us-states.json. Each feature keeps its display name and the
// other names and codes a data value may use (ISO 3166 alpha-2/alpha-3, postal codes); coordinates are rounded.
// Also the places point maps can find by name: Natural Earth's 7,342 populated places (places.json) and the US Census
// Bureau's 2020 ZIP code tabulation area centroids (us-zip.json; public domain), both pinned by SHA-256.
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'

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

async function pinned(url: string, sha256: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== sha256) throw new Error(`${url}: SHA-256 ${sha}, expected ${sha256}`)
  return bytes
}
const r3 = (v: number) => Math.round(v * 1000) / 1000

// Places: [name, ascii name (0 when the same), state/province, ISO country code, country, longitude, latitude, population]
const places = JSON.parse(new TextDecoder().decode(await pinned(`${BASE}/ne_10m_populated_places_simple.geojson`, 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f'))) as { features: { properties: Props }[] }
const rows = places.features.map(({ properties: p }) => [String(p.name), p.nameascii && p.nameascii !== p.name ? String(p.nameascii) : 0, String(p.adm1name ?? ''), String(p.iso_a2 ?? ''), String(p.adm0name ?? ''), r3(Number(p.longitude)), r3(Number(p.latitude)), Number(p.pop_max) || 0])
writeFileSync(path.join(out, 'places.json'), JSON.stringify({ rows }))
console.log(`places: ${rows.length}`)

// US ZIP codes: ZCTA → [longitude, latitude] of its internal point.
const zips = unzipSync(await pinned('https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip', '335402fb16b41303a3760f8956d2af005bbd6919b8dc6f4a96048af0005957a6'))
const text = new TextDecoder().decode(Object.values(zips)[0])
const zip: Record<string, [number, number]> = {}
for (const line of text.split('\n').slice(1)) {
  const c = line.trim().split('\t')
  if (c.length >= 7) zip[c[0]] = [r3(Number(c[6])), r3(Number(c[5]))]
}
writeFileSync(path.join(out, 'us-zip.json'), JSON.stringify(zip))
console.log(`US ZIP codes: ${Object.keys(zip).length}`)

// Postal codes outside the US: GeoNames (CC BY 4.0, geonames.org), each code at the mean of its places. GB: outward
// codes (SW1A); CA: forward sortation areas (K1A); the rest as written. GeoNames updates these files: when a hash no
// longer matches, check the new file and update the hash here.
const POSTCODES: Record<string, string> = {
  DE: '8be0dbbdca8d370bcbbbb20e46ed207d8bfc9a542619fb4cd3143eb6d5cd6dc7',
  FR: 'ac59301e4754ecf3663b30cc36509b3093e07464be83714bbf31be32f14f6d23',
  GB: 'e1e0c9f6e234d77b77bfe27ca567fdc81818d01b306f4a7508b5c3bc466723f7',
  CA: '5f6237799474d75fa53c9294ab6c469e8ce7f680034fca4b219aeeb1fdad1917',
  AU: 'd48d428de4fd3bcacbab8b5cffaa4ffa8ea36b43e3799ac7c0f67928d0942327',
  ES: '597bd501cc8d9abf254bfa08c8475b941ba619cd4e7c548a2cd580d1b641a23a',
  IT: '6d1b1af41e0506c48feba5378a92e406af7335439773ead1be0b24cd831e7d7e',
  NL: '51351c517d5b41012eb31eac520913238fcb5a7742265aed9d3c1d565cf1c841',
  CH: 'f462d719848ea1bfe33c29a617c10e1de838c52bf67df66c7a0cd8f113952ada',
  AT: 'ec00a43b7df6e6af8c995de5e650088698c713192de5946e5cc50c3efadec0f6',
  BE: 'd16187e42a12ac980d914e5c7b22e3cb00d9518a6f202f4618064149e8cdd1c5',
  IN: 'a06a825c9ebb7648736a32c12c7662f6e38722a361cf376d437e5cb11344d095'
}
const postcodes: Record<string, Record<string, [number, number]>> = {}
for (const [cc, sha] of Object.entries(POSTCODES)) {
  const files = unzipSync(await pinned(`https://download.geonames.org/export/zip/${cc}.zip`, sha))
  const text = new TextDecoder().decode(files[`${cc}.txt`])
  const sums = new Map<string, [number, number, number]>()
  for (const line of text.split('\n')) {
    const c = line.split('\t')
    if (c.length < 11 || !c[1] || /CEDEX/i.test(c[1])) continue
    const lat = Number(c[9])
    const lon = Number(c[10])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const key = c[1].trim().toUpperCase()
    const s = sums.get(key) ?? [0, 0, 0]
    sums.set(key, [s[0] + lon, s[1] + lat, s[2] + 1])
  }
  postcodes[cc] = Object.fromEntries([...sums].map(([k, [x, y, n]]) => [k, [r3(x / n), r3(y / n)]]))
}
writeFileSync(path.join(out, 'postcodes.json'), JSON.stringify(postcodes))
console.log(`postcodes: ${Object.entries(postcodes).map(([cc, m]) => `${cc} ${Object.keys(m).length}`).join(', ')}`)

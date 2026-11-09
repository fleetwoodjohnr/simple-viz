// The .sviz project file: a ZIP package (opened with the same zip-bomb limits as workbooks) holding
//   mimetype            application/vnd.simple-viz.project (first, uncompressed: identifies the file)
//   project.json        the Project (src/shared/project.ts), versioned by schemaVersion
//   thumbnail.png       optional, for the start screen
//   extracts/*.parquet  optional, a portable package's embedded data (see docs/PROJECT_FORMAT.md)
// Never credentials.

import { readZip, writeZip, text, bytes, PackageError } from '../sheets/formats/zip'
import { PROJECT_SCHEMA_VERSION, DEFAULT_REFRESH, type Project, type Source } from '../../shared/project'

export const MIMETYPE = 'application/vnd.simple-viz.project'

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20)
}

export function newProject(title = 'Untitled project'): Project {
  return { schemaVersion: PROJECT_SCHEMA_VERSION, id: newId(), title, createdAt: Date.now(), sources: [], datasets: [], queries: [], charts: [], models: [], hierarchies: [], calcs: [], params: [], dashboards: [], maps: [], stories: [] }
}

export function packProject(p: Project, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return writeZip({ mimetype: bytes(MIMETYPE), 'project.json': bytes(JSON.stringify(p, null, 1)), ...extra })
}

export function unpackProject(data: Uint8Array): { project: Project; files: Record<string, Uint8Array> } {
  const files = readZip(data)
  if (text(files.mimetype) !== MIMETYPE || !files['project.json']) throw new PackageError('This is not a Simple Viz project.')
  let raw: unknown
  try {
    raw = JSON.parse(text(files['project.json']))
  } catch {
    throw new PackageError('The project file is damaged (project.json is not valid JSON).')
  }
  return { project: migrate(raw), files }
}

/** Steps from each older schema version to the next. Add one per incompatible change; never edit old steps. */
const MIGRATIONS: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 → 2: example shape — return { ...p, schemaVersion: 2, newField: default }
}

/** Upgrades an older project to the current schema and checks its shape. */
export function migrate(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new PackageError('The project file is damaged.')
  let p = raw as Record<string, unknown>
  const v = Number(p.schemaVersion)
  if (!Number.isInteger(v) || v < 1) throw new PackageError('The project file is damaged (unknown version).')
  if (v > PROJECT_SCHEMA_VERSION) throw new PackageError('This project was made with a newer version of Simple Viz. Update Simple Viz to open it.')
  for (let s = v; s < PROJECT_SCHEMA_VERSION; s++) p = MIGRATIONS[s](p)
  return normalize(p)
}

const arr = (v: unknown) => (Array.isArray(v) ? v : [])
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)

function normalize(p: Record<string, unknown>): Project {
  const sources = arr(p.sources).map((s: Source) => ({ ...s, tables: arr(s.tables), refresh: { ...DEFAULT_REFRESH, ...(s.refresh ?? {}) } })) as Source[]
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: str(p.id) || newId(),
    title: str(p.title, 'Untitled project'),
    createdAt: Number(p.createdAt) || Date.now(),
    sources,
    datasets: arr(p.datasets).filter((d) => d && typeof d.name === 'string' && typeof d.sql === 'string'),
    queries: arr(p.queries).filter((q) => q && typeof q.sql === 'string'),
    charts: arr(p.charts).filter((c) => c && typeof c.id === 'string' && typeof c.dataset === 'string').map((c) => ({ filters: [], options: {}, ...c, enc: { x: [], y: [], detail: [], tooltip: [], ...(c.enc ?? {}) } })),
    models: arr(p.models).filter((m) => m && typeof m.name === 'string').map((m) => ({ ...m, tables: arr(m.tables), relationships: arr(m.relationships) })),
    hierarchies: arr(p.hierarchies).filter((h) => h && typeof h.name === 'string' && Array.isArray(h.levels)),
    calcs: arr(p.calcs).filter((c) => c && typeof c.name === 'string' && typeof c.formula === 'string'),
    params: arr(p.params).filter((x) => x && typeof x.name === 'string'),
    dashboards: arr(p.dashboards).filter((d) => d && typeof d.id === 'string').map((d) => ({ size: { mode: 'fit', w: 1366, h: 768 }, actions: [], ...d, items: arr(d.items) })),
    stories: arr(p.stories).filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string').map((s) => ({ ...s, points: arr(s.points).filter((x) => x && typeof x.dashboard === 'string').map((x) => ({ id: str(x.id) || newId(), dashboard: x.dashboard, caption: str(x.caption), ...(x.selections && typeof x.selections === 'object' ? { selections: x.selections } : {}), ...(Array.isArray(x.marks) ? { marks: x.marks.filter((m: { item?: unknown; values?: unknown }) => m && typeof m.item === 'string' && m.values && typeof m.values === 'object') } : {}) })) })),
    maps: arr(p.maps).filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.nameProp === 'string' && m.geojson?.type === 'FeatureCollection' && Array.isArray(m.geojson.features))
  }
}

import { app } from 'electron'
import { promises as fs, constants as fsc } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { DEFAULT_SETTINGS, type RecentFile, type RecoveryEntry, type Settings } from '../shared/ipc-types'

/**
 * Atomic write: write a sibling temp file, fsync it, then rename over the target.
 * A crash mid-write leaves either the old file or the new one, never a torn file.
 */
export async function atomicWrite(target: string, data: Uint8Array | string): Promise<void> {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  let mode: number | undefined
  try {
    mode = (await fs.stat(target)).mode
  } catch {
    /* new file */
  }
  try {
    const fh = await fs.open(tmp, fsc.O_CREAT | fsc.O_WRONLY | fsc.O_TRUNC, mode ?? 0o644)
    try {
      await fh.writeFile(data)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await replace(tmp, target)
  } catch (err) {
    // A failed write (disk full, permissions…) leaves the original untouched and no temp file behind.
    await fs.rm(tmp, { force: true })
    throw err
  }
  // Persist the rename itself (POSIX); not supported for directories on Windows.
  if (process.platform !== 'win32') {
    const d = await fs.open(dir, 'r').catch(() => null)
    await d?.sync().catch(() => {})
    await d?.close()
  }
}

/** Windows refuses to replace a file that something else (antivirus, the search indexer, another save) has open for a moment: retry for ~3 s. */
async function replace(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait += 10) {
    try {
      return await fs.rename(from, to)
    } catch (e) {
      if (process.platform !== 'win32' || wait > 250 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

const userFile = (name: string) => path.join(app.getPath('userData'), name)

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

// ---------- settings ----------
let settingsCache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (!settingsCache) settingsCache = { ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(userFile('settings.json'), {})) }
  return settingsCache
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next: Settings = { ...current }
  // Only accept known keys with the same primitive/object type as the default.
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!(key in patch)) continue
    const value = patch[key]
    const expected = DEFAULT_SETTINGS[key]
    if (Array.isArray(expected) ? Array.isArray(value) : typeof value === typeof expected) {
      ;(next as unknown as Record<string, unknown>)[key] = value
    }
  }
  settingsCache = next
  await atomicWrite(userFile('settings.json'), JSON.stringify(next, null, 2))
  return next
}

// ---------- recents ----------
const MAX_RECENTS = 40

export async function listRecents(): Promise<RecentFile[]> {
  return readJson<RecentFile[]>(userFile('recents.json'), [])
}

async function saveRecents(list: RecentFile[]): Promise<RecentFile[]> {
  // Pinned entries never fall off the list.
  const pinned = list.filter((r) => r.pinned)
  const rest = list.filter((r) => !r.pinned).slice(0, Math.max(0, MAX_RECENTS - pinned.length))
  const next = [...pinned, ...rest].sort((a, b) => b.openedAt - a.openedAt)
  await atomicWrite(userFile('recents.json'), JSON.stringify(next))
  return next
}

export async function addRecent(entry: RecentFile): Promise<RecentFile[]> {
  const list = await listRecents()
  const prev = list.find((r) => r.path === entry.path)
  return saveRecents([{ ...prev, ...entry }, ...list.filter((r) => r.path !== entry.path)])
}

export async function updateRecent(p: string, patch: Partial<RecentFile>): Promise<RecentFile[]> {
  const list = await listRecents()
  return saveRecents(list.map((r) => (r.path === p ? { ...r, ...patch, path: r.path } : r)))
}

export async function removeRecent(p: string): Promise<RecentFile[]> {
  return saveRecents((await listRecents()).filter((r) => r.path !== p))
}

// ---------- recovery ----------
const recoveryDir = () => userFile('recovery')
const validId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id)

export async function writeRecovery(id: string, payload: string): Promise<void> {
  if (!validId(id)) throw new Error('Invalid recovery id')
  await fs.mkdir(recoveryDir(), { recursive: true })
  await atomicWrite(path.join(recoveryDir(), `${id}.json`), JSON.stringify({ id, savedAt: Date.now(), payload }))
}

export async function listRecovery(): Promise<RecoveryEntry[]> {
  let names: string[] = []
  try {
    names = await fs.readdir(recoveryDir())
  } catch {
    return []
  }
  const out: RecoveryEntry[] = []
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    const e = await readJson<RecoveryEntry | null>(path.join(recoveryDir(), n), null)
    if (e && typeof e.payload === 'string') out.push(e)
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

export async function removeRecovery(id: string): Promise<void> {
  if (!validId(id)) return
  await fs.rm(path.join(recoveryDir(), `${id}.json`), { force: true })
}

// ---------- version history ----------
// One gzip'd editor-JSON snapshot per save, in userData/history/<sha1(document path)>/<savedAt>.json.gz.
const MAX_VERSIONS = 100 // ponytail: fixed cap per document; add a setting if people want more
const historyDir = (docPath: string) => userFile(path.join('history', crypto.createHash('sha1').update(docPath).digest('hex')))

export interface VersionInfo {
  id: string
  savedAt: number
  bytes: number
}

export async function listVersions(docPath: string): Promise<VersionInfo[]> {
  let names: string[] = []
  try {
    names = await fs.readdir(historyDir(docPath))
  } catch {
    return []
  }
  const out: VersionInfo[] = []
  for (const n of names) {
    const m = /^(\d{13})\.json\.gz$/.exec(n)
    if (m) out.push({ id: m[1], savedAt: Number(m[1]), bytes: (await fs.stat(path.join(historyDir(docPath), n))).size })
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

export async function readVersion(docPath: string, id: string): Promise<string> {
  if (!/^\d{13}$/.test(id)) throw new Error('Invalid version id')
  return zlib.gunzipSync(await fs.readFile(path.join(historyDir(docPath), `${id}.json.gz`))).toString('utf8')
}

/** Store a version unless it equals the latest one. Automatic saves add one at most every `minGapMs`. */
export async function addVersion(docPath: string, json: string, minGapMs = 0): Promise<boolean> {
  const list = await listVersions(docPath)
  const latest = list[0]
  if (latest && Date.now() - latest.savedAt < minGapMs) return false
  if (latest && (await readVersion(docPath, latest.id)) === json) return false
  await fs.mkdir(historyDir(docPath), { recursive: true })
  await atomicWrite(path.join(historyDir(docPath), `${Date.now()}.json.gz`), zlib.gzipSync(json))
  for (const old of list.slice(MAX_VERSIONS - 1)) await fs.rm(path.join(historyDir(docPath), `${old.id}.json.gz`), { force: true })
  return true
}

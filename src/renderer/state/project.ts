// The open project's lifecycle: new, open, save, close, autosave, crash recovery, undo/redo, and keeping the engine
// configured with its sources and datasets. Every change to the project goes through edit().

import { get, set, toast } from './store'
import { describe, holdRequestsUntil, onEngineConnected } from './engine'
import { newProject as blankProject, newId, packProject, unpackProject } from '@/core/project/sviz'
import { DEFAULT_REFRESH, FILE_FORMATS, PROJECT_EXTENSION, toAlias, type Dataset, type FileSource, type Project, type Source } from '@/shared/project'
import type { OpenedFile, RecoveryEntry } from '@/shared/ipc-types'
import type { SourceStatus } from '@/shared/engine-protocol'

const api = () => window.simpleViz

// ---------------------------------------------------------------- undo history

const past: Project[] = []
const future: Project[] = []
const MAX_UNDO = 200

export const canUndo = () => past.length > 0
export const canRedo = () => future.length > 0

/** Applies a change to the project. `engine`: the change affects sources or datasets, so the engine is reconfigured. */
export function edit(fn: (p: Project) => Project, opts: { engine?: boolean; undoable?: boolean } = {}) {
  const p = get().project
  if (!p) return
  const next = fn(p)
  if (next === p) return
  if (opts.undoable !== false) {
    past.push(p)
    if (past.length > MAX_UNDO) past.shift()
    future.length = 0
  }
  set({ project: next, dirty: true, status: 'unsaved' })
  scheduleBackground()
  if (opts.engine || engineInputsChanged(p, next)) void configureEngine()
}

function engineInputsChanged(a: Project, b: Project) {
  return a.sources !== b.sources || a.datasets !== b.datasets
}

export function undo() {
  const p = get().project
  const prev = past.pop()
  if (!p || !prev) return
  future.push(p)
  set({ project: prev, dirty: true, status: 'unsaved' })
  scheduleBackground()
  if (engineInputsChanged(p, prev)) void configureEngine()
}

export function redo() {
  const p = get().project
  const next = future.pop()
  if (!p || !next) return
  past.push(p)
  set({ project: next, dirty: true, status: 'unsaved' })
  scheduleBackground()
  if (engineInputsChanged(p, next)) void configureEngine()
}

// ---------------------------------------------------------------- engine

let configuring: Promise<void> | null = null
let requested = 0
let applied = 0
const waiters: { n: number; resolve: () => void }[] = []

/**
 * Boots the engine with the project's sources and datasets (main asks before reading sources it doesn't know).
 * Changes made while a configuration is being applied are applied right after it. Queries sent meanwhile wait until
 * the configuration that includes the latest change is in place, so a dataset is queryable as soon as it is saved.
 */
export async function configureEngine(): Promise<void> {
  const n = ++requested
  holdRequestsUntil(new Promise<void>((resolve) => waiters.push({ n, resolve })))
  if (configuring) return configuring
  configuring = (async () => {
    while (applied < requested) {
      const target = requested
      const p = get().project
      try {
        if (p) {
          const { problems } = await api().engineConfigure({ id: p.id, sources: p.sources, datasets: p.datasets })
          set({ engineProblems: problems })
          problems.forEach((m) => toast(m, 'error'))
        }
      } catch (e) {
        toast(`The data engine couldn’t start: ${(e as Error).message}`, 'error')
      }
      applied = target
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].n <= applied) waiters.splice(i, 1)[0].resolve()
      await refreshDescribe()
    }
  })()
  try {
    await configuring
  } finally {
    configuring = null
  }
  void api().watchFiles(watchedPaths())
}

/** Reloads the relation list (names, columns, dataset errors) from the engine. */
export async function refreshDescribe() {
  if (!get().project) return
  try {
    const d = await describe()
    set({ relations: d.relations, datasetErrors: d.datasetErrors, deps: d.deps, sources: Object.fromEntries(d.statuses.map((s) => [s.id, s])) })
  } catch {
    /* engine restarting: the next status event describes again */
  }
}

let describeTimer: ReturnType<typeof setTimeout> | undefined
export function onEngineStatus(list: SourceStatus[]) {
  const before = get().sources
  const changed = list.some((s) => s.state === 'ok' && s.changed && before[s.id]?.state !== 'ok')
  const done = list.some((s) => s.state !== 'checking' && before[s.id]?.state === 'checking')
  set({ sources: { ...before, ...Object.fromEntries(list.map((s) => [s.id, s])) } })
  if (changed || done) {
    clearTimeout(describeTimer)
    describeTimer = setTimeout(async () => {
      await refreshDescribe()
      if (changed) set((s) => ({ dataVersion: s.dataVersion + 1 }))
    }, 50)
  }
}

onEngineConnected(() => void refreshDescribe())

/** Asks for a database password again (refused login, or no keychain to remember it), then reconnects. */
export async function enterPassword(sourceId: string) {
  const src = get().project?.sources.find((s) => s.id === sourceId)
  if (!src) return
  const { askText } = await import('../app/Dialogs')
  const pw = await askText(`Password for ${src.name}`, `Password for ${'user' in src && src.user ? src.user : 'the database user'}`, '', true)
  if (pw === null) return
  await api().credentialSet(sourceId, pw)
  await configureEngine()
  await refreshSources([sourceId], true)
}

export async function refreshSources(ids?: string[], force = false) {
  if (!get().project) return
  try {
    await api().engineRefresh(ids, force)
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

const watchedPaths = () => (get().project?.sources ?? []).filter((s) => s.path && s.refresh.watch).map((s) => s.path!)

export function onFileChanged(file: string) {
  const ids = (get().project?.sources ?? []).filter((s) => s.path === file && s.refresh.watch).map((s) => s.id)
  if (ids.length) void refreshSources(ids)
}

let lastFocusRefresh = 0
export function onWindowFocus() {
  if (Date.now() - lastFocusRefresh < 10_000) return
  lastFocusRefresh = Date.now()
  const ids = (get().project?.sources ?? []).filter((s) => s.refresh.onFocus).map((s) => s.id)
  if (ids.length) void refreshSources(ids)
}

let periodic: ReturnType<typeof setInterval> | undefined
function schedulePeriodic() {
  clearInterval(periodic)
  periodic = setInterval(() => {
    const now = Date.now()
    const due = (get().project?.sources ?? []).filter((s) => s.refresh.everyMin > 0 && now - (get().sources[s.id]?.refreshedAt ?? 0) >= s.refresh.everyMin * 60_000)
    if (due.length) void refreshSources(due.map((s) => s.id))
  }, 30_000)
}

// ---------------------------------------------------------------- lifecycle

function load(project: Project, path: string | null, dirty = false) {
  past.length = 0
  future.length = 0
  set({ project, path, dirty, status: dirty ? 'unsaved' : 'saved', workspace: project.sources.length ? 'data' : 'data', relations: [], sources: {}, datasetErrors: {}, engineProblems: [] })
  schedulePeriodic()
  void configureEngine()
}

/** Runs `then` once the current project is saved or discarded (asks when there are unsaved changes). */
function whenClosed(then: 'close' | 'quit' | 'new' | { open: string }): boolean {
  if (get().project && get().dirty) {
    set({ dialog: { kind: 'confirm-close', then } })
    return false
  }
  return true
}

export function newProject() {
  if (!whenClosed('new')) return
  load(blankProject(), null)
}

export async function openFiles(files: OpenedFile[]) {
  const projects = files.filter((f) => f.name.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`))
  const data = files.filter((f) => !projects.includes(f))
  if (projects[0]) await openProject(projects[0])
  if (data.length) {
    if (!get().project) load(blankProject(titleFrom(data[0].name)), null, true)
    await addFiles(data.map((f) => f.path))
  }
}

const titleFrom = (name: string) => name.replace(/\.[^.]+$/, '')

async function openProject(file: OpenedFile) {
  if (!whenClosed({ open: file.path })) return
  try {
    const { project } = unpackProject(file.data)
    load(project, file.path)
    set({ recents: await api().recentAdd({ path: file.path, name: file.name, openedAt: Date.now() }) })
  } catch (e) {
    set({ dialog: { kind: 'message', title: `Couldn’t open ${file.name}`, body: (e as Error).message } })
  }
}

export async function openDialog() {
  const files = await api().openDialog({ name: 'Simple Viz projects', extensions: [PROJECT_EXTENSION] })
  if (files.length) await openFiles(files)
}

export async function openPath(path: string) {
  try {
    await openFiles([await api().readFile(path)])
  } catch {
    toast('That project was moved or deleted.', 'error')
    set({ recents: await api().recentRemove(path) })
  }
}

export async function continueAfterClose(then: 'close' | 'quit' | 'new' | { open: string }) {
  closeNow()
  if (then === 'quit') api().confirmClose()
  else if (then === 'new') load(blankProject(), null)
  else if (typeof then === 'object') await openPath(then.open)
}

export function closeNow() {
  const p = get().project
  if (p) void api().recoveryRemove(p.id)
  past.length = 0
  future.length = 0
  clearInterval(periodic)
  set({ project: null, path: null, dirty: false, status: 'saved', workspace: 'home', relations: [], sources: {} })
  void api().watchFiles([])
}

export function closeProject() {
  if (whenClosed('close')) closeNow()
}

export function requestQuit() {
  if (whenClosed('quit')) api().confirmClose()
}

export async function save(as = false): Promise<boolean> {
  const s = get()
  const p = s.project
  if (!p) return false
  let path = s.path
  let project = p
  if (!path || as) {
    path = await api().saveDialog(`${p.title}.${PROJECT_EXTENSION}`, [PROJECT_EXTENSION])
    if (!path) return false
    const title = titleFrom(path.split(/[\\/]/).pop()!)
    // Save As makes a separate project: its own id, so its cache doesn't collide with the original's.
    project = { ...p, title, id: as && s.path ? newId() : p.id }
  }
  set({ status: 'saving' })
  try {
    await api().writeFile(path, packProject(project))
    const changedId = project.id !== p.id
    set({ project, path, dirty: false, status: 'saved', saveError: undefined })
    void api().recoveryRemove(p.id)
    set({ recents: await api().recentAdd({ path, name: path.split(/[\\/]/).pop()!, openedAt: Date.now() }) })
    if (changedId) void configureEngine()
    return true
  } catch (e) {
    set({ status: 'error', saveError: (e as Error).message })
    toast(`Couldn’t save: ${(e as Error).message}`, 'error')
    return false
  }
}

let recoveryTimer: ReturnType<typeof setTimeout> | undefined
let autosaveTimer: ReturnType<typeof setTimeout> | undefined

function scheduleBackground() {
  const { settings } = get()
  clearTimeout(recoveryTimer)
  recoveryTimer = setTimeout(() => {
    const { project, path, dirty } = get()
    if (project && dirty) void api().recoveryWrite(project.id, JSON.stringify({ title: project.title, path, project }))
  }, settings.recoveryIntervalSec * 1000)
  clearTimeout(autosaveTimer)
  if (settings.autosave && get().path)
    autosaveTimer = setTimeout(() => {
      if (get().dirty && get().path) void save()
    }, settings.autosaveIntervalSec * 1000)
}

export async function restoreRecovery(r: RecoveryEntry) {
  try {
    const { path, project } = JSON.parse(r.payload) as { path: string | null; project: Project }
    if (!whenClosed('close')) return
    load(project, path, true)
    set({ recovery: get().recovery.filter((x) => x.id !== r.id) })
  } catch {
    toast('That recovered project is damaged.', 'error')
  }
}

export async function discardRecovery(id: string) {
  await api().recoveryRemove(id)
  set({ recovery: get().recovery.filter((x) => x.id !== id) })
}

// ---------------------------------------------------------------- sources and datasets

/** Every name SQL can use in this project (source tables and datasets), lower case. */
export function usedNames(p: Project = get().project!): Set<string> {
  return new Set([...p.sources.flatMap((s) => s.tables.map((t) => t.alias.toLowerCase())), ...p.datasets.map((d) => d.name.toLowerCase())])
}

export function uniqueAlias(base: string, taken: Set<string>): string {
  let a = toAlias(base).slice(0, 56)
  if (!taken.has(a)) return a
  for (let i = 2; ; i++) if (!taken.has(`${a}_${i}`)) return `${a}_${i}`
}

const SHEET_FORMATS = new Set(['xlsx', 'ods', 'xml2003'])

/** Adds data files: flat files directly, spreadsheets through the sheet picker (all sheets if there is one). */
export async function addFiles(paths: string[]) {
  if (!get().project) load(blankProject(), null, true)
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop()!
    const ext = name.split('.').pop()!.toLowerCase()
    if (['sqlite', 'sqlite3', 'db', 'duckdb'].includes(ext)) {
      await addDatabaseFile(path, ext === 'duckdb' ? 'duckdb' : 'sqlite')
      continue
    }
    const format = FILE_FORMATS[ext]
    if (!format) {
      toast(`${name}: this kind of file can’t be added as data.`, 'error')
      continue
    }
    if (SHEET_FORMATS.has(format)) {
      try {
        const tables = await api().sheetTables(path)
        const sheets = tables.filter((t) => t.kind === 'sheet')
        if (tables.length === 1 || (sheets.length === 1 && tables.every((t) => t.kind === 'sheet'))) addSource(fileSource(path, format, [tables[0].ref]))
        else set({ dialog: { kind: 'sheet-picker', path } })
      } catch (e) {
        toast(`${name}: ${(e as Error).message}`, 'error')
      }
      continue
    }
    addSource(fileSource(path, format, [undefined]))
  }
  set({ workspace: 'data' })
}

export function fileSource(path: string, format: FileSource['format'], refs: (string | undefined)[]): FileSource {
  const name = path.split(/[\\/]/).pop()!
  const base = titleFrom(name)
  const taken = usedNames()
  const tables = refs.map((ref) => {
    // A sheet is named after itself (Transactions → transactions); the file name is added only to avoid a clash.
    const alias = ref ? (taken.has(toAlias(ref)) ? uniqueAlias(`${base}_${ref}`, taken) : uniqueAlias(ref, taken)) : uniqueAlias(base, taken)
    taken.add(alias)
    return { alias, ref }
  })
  return { id: newId(), kind: 'file', name, format, path, tables, refresh: { ...DEFAULT_REFRESH } }
}

async function addDatabaseFile(path: string, kind: 'sqlite' | 'duckdb') {
  const id = newId()
  const draft: Source = { id, kind, name: path.split(/[\\/]/).pop()!, path, tables: [], mode: 'extract', timeoutSec: get().settings.refreshTimeoutSec, refresh: { ...DEFAULT_REFRESH } }
  try {
    const names = await api().connectionTables({ source: draft })
    const taken = usedNames()
    const tables = names.map((n) => {
      const alias = uniqueAlias(n.split('.').pop()!, taken)
      taken.add(alias)
      return { alias, ref: n }
    })
    addSource({ ...draft, tables })
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

export function addSource(src: Source) {
  edit((p) => ({ ...p, sources: [...p.sources, src] }))
  toast(`Added ${src.name}: ${src.tables.map((t) => t.alias).join(', ')}`, 'success')
}

export function updateSource(id: string, patch: Partial<Source>) {
  edit((p) => ({ ...p, sources: p.sources.map((s) => (s.id === id ? ({ ...s, ...patch } as Source) : s)) }))
}

export function removeSource(id: string) {
  edit((p) => ({ ...p, sources: p.sources.filter((s) => s.id !== id) }))
  void api().credentialSet(id, null)
}

export function saveDataset(d: Omit<Dataset, 'id'> & { id?: string }): Dataset {
  const ds: Dataset = { id: d.id ?? newId(), name: d.name, sql: d.sql, description: d.description }
  edit((p) => ({ ...p, datasets: p.datasets.some((x) => x.id === ds.id) ? p.datasets.map((x) => (x.id === ds.id ? ds : x)) : [...p.datasets, ds] }))
  return ds
}

export function removeDataset(id: string) {
  edit((p) => ({ ...p, datasets: p.datasets.filter((d) => d.id !== id) }))
}

import { isSafeExternalUrl } from '../shared/urls'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import type { ConnectionDraft, OpenedFile, RecentFile, Settings } from '../shared/ipc-types'
import type { EngineConfig, ResolvedSource } from '../shared/engine-protocol'
import { packProject, migrate } from '../core/project/sviz'
import { DATA_EXTENSIONS, FILE_FORMATS, PROJECT_EXTENSION, SERVER, isServer, isRemotePath, isSheetFormat, type Project, type Source } from '../shared/project'
import * as store from './store'
import * as creds from './credentials'
import { EngineHost } from './engine-host'
import { watchFiles } from './watch'
import { checkForUpdates, installIfRequested, scheduleUpdateCheck } from './updater'
import { fetchTile, clearTiles } from './tiles'
import { validTileTemplate } from '../core/charts/geo'
import icon from '../../resources/icon.png?asset'

const isMac = process.platform === 'darwin'
const OPEN_EXTENSIONS = [PROJECT_EXTENSION, ...DATA_EXTENSIONS]
const MAX_FILE_BYTES = 512 * 1024 * 1024

let mainWindow: BrowserWindow | null = null
let allowClose = false
const pendingOpen: string[] = []

// Paths the user granted through a dialog, recents, argv, drag-and-drop, or by approving a project's sources.
// The renderer can only read/write these, and the engine reads only these.
const granted = new Set<string>()

const isAbs = (p: unknown): p is string => typeof p === 'string' && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p)
const isBytes = (d: unknown): d is Uint8Array => d instanceof Uint8Array
const extOf = (p: string) => path.extname(p).slice(1).toLowerCase()
const isName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)

function grant(p: string) {
  granted.add(path.resolve(p))
}

function assertGranted(p: unknown): string {
  if (!isAbs(p)) throw new Error('Invalid path')
  const r = path.resolve(p)
  if (!granted.has(r)) throw new Error('Access to this file was not granted')
  return r
}

async function readOpened(p: string): Promise<OpenedFile> {
  const st = await fs.stat(p)
  if (!st.isFile()) throw new Error('Not a file')
  if (st.size > MAX_FILE_BYTES) throw new Error('File is too large')
  const data = new Uint8Array(await fs.readFile(p))
  return { path: p, name: path.basename(p), data, mtime: st.mtimeMs }
}

function filesFromArgv(argv: string[]): string[] {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && isAbs(path.resolve(a)) && OPEN_EXTENSIONS.includes(extOf(a)))
}

/** Project files arrive with their bytes; data files only as granted paths (the engine reads them). */
async function sendOpenFiles(paths: string[]) {
  if (!mainWindow) {
    pendingOpen.push(...paths)
    return
  }
  const files: OpenedFile[] = []
  for (const p of paths) {
    try {
      const r = path.resolve(p)
      grant(r)
      if (extOf(r) === PROJECT_EXTENSION) files.push(await readOpened(r))
      else files.push({ path: r, name: path.basename(r), data: new Uint8Array(), mtime: (await fs.stat(r)).mtimeMs })
    } catch {
      /* unreadable file: skip */
    }
  }
  if (files.length) mainWindow.webContents.send('app:open-files', files)
}

// ---------- engine ----------

const engine = new EngineHost(
  () => mainWindow?.webContents ?? null,
  (s) => mainWindow?.webContents.send('engine:status', s)
)

function extensionsDir(): string | null {
  const os = ({ darwin: 'mac', win32: 'win' } as Record<string, string>)[process.platform] ?? process.platform
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'duckdb-ext') : path.join(app.getAppPath(), 'resources', 'duckdb-ext', `${os}-${process.arch}`)
  return existsSync(dir) ? dir : null
}

/**
 * The example project: its workbook, customer list and project template are copied into the user's data folder (a
 * fresh copy each time), the template's ${EXAMPLES} paths point there, and the project is written as a .sviz.
 */
async function openExample(): Promise<string> {
  const from = app.isPackaged ? path.join(process.resourcesPath, 'examples') : path.join(app.getAppPath(), 'resources', 'examples')
  const to = path.join(app.getPath('userData'), 'examples')
  await fs.mkdir(to, { recursive: true })
  for (const f of ['Sales.xlsx', 'customers.csv']) await fs.copyFile(path.join(from, f), path.join(to, f))
  const template = (await fs.readFile(path.join(from, 'example.json'), 'utf8')).replaceAll('${EXAMPLES}', to.replaceAll('\\', '\\\\'))
  const file = path.join(to, 'Sales example.sviz')
  await store.atomicWrite(file, packProject(migrate(JSON.parse(template))))
  for (const f of ['Sales.xlsx', 'customers.csv', 'Sales example.sviz']) grant(path.join(to, f))
  await addTrust(['Sales.xlsx', 'customers.csv'].map((f) => `file:${path.resolve(to, f)}`))
  return file
}

// Sources the user approved: file paths, and database servers as kind:user@host:port/database.
const trustFile = () => path.join(app.getPath('userData'), 'trusted-sources.json')
let trusted: Set<string> | null = null
async function trust(): Promise<Set<string>> {
  if (!trusted) trusted = new Set(await fs.readFile(trustFile(), 'utf8').then((t) => JSON.parse(t) as string[]).catch(() => []))
  return trusted
}
async function addTrust(keys: string[]) {
  const t = await trust()
  keys.forEach((k) => t.add(k))
  await store.atomicWrite(trustFile(), JSON.stringify([...t]))
}
const sourceKey = (s: Source) =>
  s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'sqlserver'
    ? `${s.kind}:${s.user ?? ''}@${s.host ?? ''}:${s.port ?? SERVER[s.kind].port}/${s.database ?? ''}`
    : s.kind === 'file' && isRemotePath(s.path)
      ? `url:${s.remote?.provider ?? 'http'}:${s.remote?.endpoint ?? ''}:${s.remote?.keyId ?? ''}:${s.path}`
      : `file:${path.resolve(s.path ?? '')}`
/** A storage address from a project file: plain characters only (it becomes an SQL literal and an allow-list entry). */
const safeAddress = (v: unknown, max = 2048) => typeof v === 'string' && v.length <= max && !/[\s'"\\\u0000-\u001f]/.test(v)

function checkSource(x: unknown): Source {
  const s = x as Source & Record<string, unknown>
  if (!s || typeof s !== 'object' || !isId(s.id) || !['file', 'postgres', 'mysql', 'sqlserver', 'sqlite', 'duckdb'].includes(s.kind)) throw new Error('Invalid source')
  if (!Array.isArray(s.tables) || s.tables.length > 500) throw new Error('Invalid source tables')
  for (const t of s.tables) if (!t || !isName(t.alias) || (t.ref !== undefined && (typeof t.ref !== 'string' || t.ref.length > 500))) throw new Error(`Invalid table name “${String(t?.alias)}”`)
  if (s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'sqlserver') {
    if (typeof s.host !== 'string' || s.host.length > 255 || /[\s'"\\]/.test(s.host)) throw new Error('Invalid host')
    if (s.port !== undefined && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) throw new Error('Invalid port')
  } else if (s.kind === 'file' && isRemotePath(s.path)) {
    if (!safeAddress(s.path)) throw new Error('Invalid address')
    const r = s.remote
    if (r && (typeof r !== 'object' || !['http', 's3', 'azure'].includes(r.provider) || ![r.region, r.endpoint, r.keyId].every((v) => v === undefined || safeAddress(v, 512)) || (r.urlStyle !== undefined && !['vhost', 'path'].includes(r.urlStyle)))) throw new Error('Invalid storage settings')
  } else if (!isAbs(s.path)) throw new Error('Invalid path')
  if (s.kind === 'file' && !Object.values(FILE_FORMATS).includes(s.format)) throw new Error('Invalid format')
  return s
}

/** A portable project's packaged data, if it was opened from a package (written by project:store-packaged). */
async function packagedFiles(projectId: string): Promise<Record<string, string>> {
  const dir = path.join(app.getPath('userData'), 'cache', 'packaged', projectId)
  try {
    return Object.fromEntries((await fs.readdir(dir)).filter((f) => f.endsWith('.parquet')).map((f) => [f.slice(0, -8), path.join(dir, f)]))
  } catch {
    return {}
  }
}

async function resolveSource(s: Source, settings: Settings): Promise<ResolvedSource> {
  const base: ResolvedSource = { id: s.id, kind: s.kind, tables: s.tables, mode: 'extract', timeoutSec: settings.refreshTimeoutSec, onOpen: s.refresh?.onOpen !== false }
  if (s.kind === 'file' && isRemotePath(s.path)) {
    const r = s.remote ?? { provider: 'http' as const }
    return { ...base, format: s.format, path: s.path, header: s.header, remote: { provider: r.provider, region: r.region, endpoint: r.endpoint, urlStyle: r.urlStyle, useSsl: r.useSsl, keyId: r.keyId }, password: r.hasSecret ? await creds.getPassword(s.id) : undefined }
  }
  if (s.kind === 'file') return { ...base, format: s.format, path: path.resolve(s.path), header: s.header }
  return {
    ...base,
    mode: s.mode === 'live' && s.kind !== 'sqlserver' ? 'live' : 'extract',
    timeoutSec: Math.max(5, Math.min(3600, Number(s.timeoutSec) || settings.refreshTimeoutSec)),
    path: s.path ? path.resolve(s.path) : undefined,
    host: s.host,
    port: s.port,
    database: s.database,
    user: s.user,
    sslmode: s.sslmode,
    password: isServer(s.kind) ? await creds.getPassword(s.id) : undefined
  }
}

/**
 * Starts the engine for a project. Sources the user has not approved before (a project from someone else, a moved
 * file) need approval in a native dialog: a project file must not be able to read arbitrary files or reach servers.
 */
async function configureEngine(p: Pick<Project, 'id' | 'sources' | 'datasets'>): Promise<{ problems: string[] }> {
  if (!p || !isId(p.id) || !Array.isArray(p.sources) || !Array.isArray(p.datasets)) throw new Error('Invalid project')
  const sources = p.sources.map(checkSource)
  for (const d of p.datasets) if (!isName(d?.name) || typeof d.sql !== 'string' || d.sql.length > 1_000_000) throw new Error(`Invalid dataset “${String(d?.name)}”`)
  const t = await trust()
  const isOk = (s: Source) => (s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'sqlserver' || isRemotePath(s.path) ? t.has(sourceKey(s)) : granted.has(path.resolve(s.path!)) || t.has(sourceKey(s)))
  const unknown = sources.filter((s) => !isOk(s))
  const problems: string[] = []
  let allowed = sources
  if (unknown.length && mainWindow) {
    const list = unknown.map((s) => (s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'sqlserver' ? `• ${SERVER[s.kind].label} ${s.user ? `${s.user}@` : ''}${s.host}:${s.port ?? SERVER[s.kind].port}/${s.database ?? ''}` : `• ${s.path}${s.kind === 'file' && s.remote?.endpoint ? ` (through ${s.remote.endpoint})` : ''}`)).join('\n')
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      message: 'Allow this project to read these data sources?',
      detail: `${list}\n\nOnly allow sources you expect this project to use. Simple Viz only reads them; it never changes them.`,
      buttons: ['Allow', 'Don’t allow'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) {
      unknown.forEach((s) => s.path && !isRemotePath(s.path) && grant(s.path))
      await addTrust(unknown.map(sourceKey))
    } else {
      allowed = sources.filter(isOk)
      problems.push(...unknown.map((s) => `“${s.name}” was not allowed, so its data isn’t loaded.`))
    }
  }
  const settings = await store.getSettings()
  const config: EngineConfig = {
    projectId: p.id,
    cacheDir: path.join(app.getPath('userData'), 'cache'),
    packaged: await packagedFiles(p.id),
    extensionsDir: extensionsDir(),
    sources: await Promise.all(allowed.map((s) => resolveSource(s, settings))),
    datasets: p.datasets.map((d) => ({ name: d.name, sql: d.sql }))
  }
  await engine.boot(config)
  return { problems }
}

// ---------- window ----------

function createWindow(settings: Settings) {
  nativeTheme.themeSource = settings.theme
  allowClose = false
  const dark = nativeTheme.shouldUseDarkColors
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Simple Viz',
    // Linux window managers take the window's own icon (macOS and Windows use the app bundle's).
    ...(process.platform === 'linux' ? { icon } : {}),
    backgroundColor: dark ? '#121214' : '#f7f7f8',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: dark ? '#d4d4d8' : '#3f3f46', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    if (allowClose) return
    e.preventDefault()
    mainWindow?.webContents.send('app:close-request')
  })
  mainWindow.on('focus', () => mainWindow?.webContents.send('app:focus'))
  // A crashed renderer reloads; the app then offers the recovery snapshots (written every few seconds).
  const crashes: number[] = []
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    crashes.push(Date.now())
    while (crashes.length && Date.now() - crashes[0] > 60_000) crashes.shift()
    if (crashes.length <= 3) mainWindow?.reload()
    else void dialog.showMessageBox({ type: 'error', message: 'Simple Viz keeps crashing.', detail: 'Your recent changes are kept in recovery snapshots. Restart the app to restore them.' })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomFactor(settings.uiScale || 1)
    // Every (re)load of the page gets a fresh port to the engine.
    void engine.start().then(() => engine.connectRenderer())
    if (pendingOpen.length) void sendOpenFiles(pendingOpen.splice(0))
  })
}

function buildMenu() {
  const send = (id: string) => () => mainWindow?.webContents.send('app:menu-command', id)
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void checkForUpdates(mainWindow, true) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: send('tools.settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', click: send('file.new') },
        { label: 'Open…', click: send('file.open') },
        { type: 'separator' },
        { label: 'Save', click: send('file.save') },
        { label: 'Save As…', click: send('file.saveAs') },
        { label: 'Save a Portable Copy (with Data)…', click: send('file.savePortable') },
        { type: 'separator' },
        { label: 'Add Data…', click: send('data.add') },
        { label: 'Refresh All', click: send('data.refresh') },
        { type: 'separator' },
        { label: 'Export PDF…', click: send('file.exportPdf') },
        { type: 'separator' },
        { label: 'Close Project', accelerator: 'CmdOrCtrl+W', click: send('file.close') }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function hardenSessions() {
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  session.defaultSession.setSpellCheckerEnabled(false)
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return
      ev.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

function handle<A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => Promise<R> | R) {
  ipcMain.handle(channel, (e, ...args) => {
    if (e.sender !== mainWindow?.webContents) throw new Error('Unknown sender')
    return fn(e, ...(args as A))
  })
}

const checkFilter = (filter: unknown) => {
  const f = filter as { name?: unknown; extensions?: unknown } | undefined
  return f && typeof f.name === 'string' && Array.isArray(f.extensions) && f.extensions.every((x) => typeof x === 'string' && /^[a-z0-9*]{1,8}$/.test(x)) ? { name: f.name.slice(0, 60), extensions: f.extensions as string[] } : null
}

function registerIpc() {
  handle('files:open-dialog', async (_e, filter?: unknown, multi?: unknown) => {
    const custom = checkFilter(filter)
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [custom ?? { name: 'Simple Viz projects', extensions: [PROJECT_EXTENSION] }, { name: 'All files', extensions: ['*'] }]
    })
    const out: OpenedFile[] = []
    for (const p of res.filePaths) {
      grant(p)
      out.push(await readOpened(p))
    }
    return out
  })

  handle('files:pick', async (_e, filter: unknown, multi?: unknown) => {
    const f = checkFilter(filter)
    if (!f) throw new Error('Invalid filter')
    const res = await dialog.showOpenDialog(mainWindow!, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [f, { name: 'All files', extensions: ['*'] }] })
    res.filePaths.forEach(grant)
    // Picking a file is approval to read it, also in later sessions.
    await addTrust(res.filePaths.map((p) => `file:${path.resolve(p)}`))
    return res.filePaths
  })

  handle('files:read', async (_e, p: unknown) => readOpened(assertGranted(p)))
  handle('files:exists', async (_e, p: unknown) => isAbs(p) && existsSync(p))

  handle('files:save-dialog', async (_e, defaultName: unknown, extensions: unknown) => {
    if (typeof defaultName !== 'string' || !Array.isArray(extensions) || !extensions.every((x) => typeof x === 'string' && /^[a-z0-9]{1,8}$/.test(x))) throw new Error('Invalid arguments')
    const res = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultName.replace(/[\\/:*?"<>|]/g, '_'),
      filters: extensions.map((x) => ({ name: x.toUpperCase(), extensions: [x] }))
    })
    if (res.canceled || !res.filePath) return null
    grant(res.filePath)
    return res.filePath
  })

  handle('files:write', async (_e, p: unknown, data: unknown) => {
    const target = assertGranted(p)
    if (!isBytes(data)) throw new Error('Invalid data')
    await store.atomicWrite(target, data)
    return { mtime: (await fs.stat(target)).mtimeMs }
  })

  handle('files:grant-dropped', async (_e, p: unknown) => {
    if (!isAbs(p) || !OPEN_EXTENSIONS.includes(extOf(p))) return false
    grant(p)
    await addTrust([`file:${path.resolve(p)}`])
    return true
  })

  handle('files:watch', (_e, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every(isAbs)) throw new Error('Invalid paths')
    watchFiles(
      paths.filter((p) => granted.has(path.resolve(p))),
      (file) => mainWindow?.webContents.send('app:file-changed', file)
    )
  })

  handle('recent:list', async () => {
    const list = await store.listRecents()
    list.forEach((r) => grant(r.path))
    return list
  })
  handle('recent:add', (_e, entry: RecentFile) => {
    if (!entry || !isAbs(entry.path) || typeof entry.name !== 'string') throw new Error('Invalid entry')
    assertGranted(entry.path)
    return store.addRecent({ path: entry.path, name: entry.name, openedAt: Date.now(), thumbnail: typeof entry.thumbnail === 'string' && entry.thumbnail.startsWith('data:image/') ? entry.thumbnail : undefined })
  })
  handle('recent:update', (_e, p: unknown, patch: Partial<RecentFile>) => {
    if (!isAbs(p) || typeof patch !== 'object' || !patch) throw new Error('Invalid arguments')
    const safe: Partial<RecentFile> = {}
    if (typeof patch.pinned === 'boolean') safe.pinned = patch.pinned
    if (typeof patch.favorite === 'boolean') safe.favorite = patch.favorite
    if (typeof patch.thumbnail === 'string' && patch.thumbnail.startsWith('data:image/')) safe.thumbnail = patch.thumbnail
    if (typeof patch.openedAt === 'number') safe.openedAt = patch.openedAt
    return store.updateRecent(p, safe)
  })
  handle('recent:remove', (_e, p: unknown) => {
    if (!isAbs(p)) throw new Error('Invalid path')
    return store.removeRecent(p)
  })

  handle('recovery:write', (_e, id: unknown, payload: unknown) => {
    if (typeof id !== 'string' || typeof payload !== 'string') throw new Error('Invalid arguments')
    return store.writeRecovery(id, payload)
  })
  handle('recovery:list', () => store.listRecovery())
  handle('recovery:remove', (_e, id: unknown) => (typeof id === 'string' ? store.removeRecovery(id) : undefined))

  handle('settings:get', () => store.getSettings())
  handle('maps:tile', (_e, z: unknown, x: unknown, y: unknown) => fetchTile(z, x, y))
  handle('settings:set', async (_e, patch: Partial<Settings>) => {
    if (typeof patch !== 'object' || !patch) throw new Error('Invalid settings')
    if (patch.theme !== undefined && !['system', 'light', 'dark'].includes(patch.theme)) throw new Error('Invalid theme')
    if (patch.mapTiles !== undefined && (typeof patch.mapTiles !== 'string' || (patch.mapTiles !== '' && !validTileTemplate(patch.mapTiles)))) throw new Error('A tile server address starts with https:// and has {z}, {x} and {y} in it.')
    if (patch.mapTilesAttribution !== undefined && (typeof patch.mapTilesAttribution !== 'string' || patch.mapTilesAttribution.length > 300)) throw new Error('Invalid attribution')
    if (patch.mapTiles !== undefined) clearTiles()
    const next = await store.setSettings(patch)
    if (patch.theme) nativeTheme.themeSource = next.theme
    if (patch.uiScale) mainWindow?.webContents.setZoomFactor(next.uiScale)
    return next
  })

  handle('engine:configure', (_e, p: unknown) => configureEngine(p as Project))
  handle('engine:refresh', (_e, ids: unknown, force: unknown) => {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(isId))) throw new Error('Invalid sources')
    return engine.request({ op: 'refresh', sourceIds: ids as string[] | undefined, force: !!force })
  })
  handle('examples:open', () => openExample())
  handle('project:package', async (_e, tables: unknown) => {
    if (!Array.isArray(tables) || tables.length > 2000 || !tables.every((t) => t && isId(t.sourceId) && isName(t.alias) && (t.ref === undefined || (typeof t.ref === 'string' && t.ref.length <= 500)))) throw new Error('Invalid tables')
    const staged = await engine.request<Record<string, string>>({ op: 'package', tables })
    const out: Record<string, Uint8Array> = {}
    for (const [key, file] of Object.entries(staged)) {
      out[key] = new Uint8Array(await fs.readFile(file))
      await fs.rm(file, { force: true })
    }
    return out
  })
  handle('project:store-packaged', async (_e, id: unknown, files: unknown) => {
    if (!isId(id) || !files || typeof files !== 'object') throw new Error('Invalid package')
    const entries = Object.entries(files as Record<string, unknown>)
    if (entries.length > 2000 || !entries.every(([k, v]) => /^[A-Za-z0-9_-]{1,200}$/.test(k) && v instanceof Uint8Array)) throw new Error('Invalid package')
    const dir = path.join(app.getPath('userData'), 'cache', 'packaged', id)
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    for (const [k, v] of entries) await fs.writeFile(path.join(dir, `${k}.parquet`), v as Uint8Array)
  })
  handle('engine:export', async (_e, sql: unknown, format: unknown, target: unknown) => {
    if (typeof sql !== 'string' || (format !== 'csv' && format !== 'parquet')) throw new Error('Invalid export')
    const dest = assertGranted(target)
    const staged = await engine.request<string>({ op: 'export', sql, format, file: `${Date.now()}-${path.basename(dest)}` })
    await fs.copyFile(staged, dest)
    await fs.rm(staged, { force: true })
  })
  handle('connection:tables', async (_e, draft: ConnectionDraft) => {
    const s = checkSource(draft?.source)
    if (s.path && !isRemotePath(s.path)) assertGranted(s.path)
    const settings = await store.getSettings()
    const resolved = await resolveSource(s, settings)
    if (typeof draft.password === 'string') resolved.password = draft.password
    const tables = await engine.request<string[]>({ op: 'tables', source: resolved })
    // The user typed this connection and it worked: it may be used without asking again.
    await addTrust([sourceKey(s)])
    return tables
  })
  handle('credential:set', (_e, id: unknown, password: unknown) => {
    if (!isId(id) || (password !== null && typeof password !== 'string')) throw new Error('Invalid arguments')
    return creds.setPassword(id, password as string | null)
  })
  handle('credential:status', () => creds.backend())
  handle('sheet:tables', (_e, p: unknown) => {
    const file = assertGranted(p)
    const format = FILE_FORMATS[extOf(file)]
    if (!isSheetFormat(format)) throw new Error('Not a spreadsheet')
    return engine.request({ op: 'sheets', path: file, format })
  })

  handle('pdf:export', async (e) => {
    // Page size, orientation and margins come from the printed page's @page rule.
    const buf = await e.sender.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, generateTaggedPDF: true })
    return new Uint8Array(buf)
  })
  handle('print', (e) => new Promise<boolean>((resolve) => e.sender.print({ printBackground: true }, (ok) => resolve(ok))))
  handle('capture-page', async (e, rect: { x: number; y: number; width: number; height: number }, width?: unknown) => {
    const r = Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Math.max(0, Math.round(Number((rect as never)[k]) || 0))]))
    const img = await e.sender.capturePage(r as never)
    if (img.isEmpty()) return null
    const w = typeof width === 'number' && width > 0 && width <= 8192 ? Math.round(width) : 256
    return new Uint8Array(img.resize({ width: w, quality: 'best' }).toPNG())
  })

  handle('window:minimize', () => mainWindow?.minimize())
  handle('window:toggle-maximize', () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()))
  handle('window:close', () => mainWindow?.close())
  handle('window:fullscreen', (_e, on: unknown) => mainWindow?.setFullScreen(!!on))
  handle('window:titlebar-colors', (_e, c: { color: string; symbolColor: string }) => {
    if (isMac || !c || typeof c.color !== 'string' || typeof c.symbolColor !== 'string') return
    try {
      mainWindow?.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: 44 })
    } catch {
      /* platform without overlay support */
    }
  })
  handle('shell:open-external', async (_e, url: unknown) => {
    if (!isSafeExternalUrl(url)) throw new Error('Blocked URL')
    await shell.openExternal(url)
  })
  handle('shell:show-in-folder', (_e, p: unknown) => {
    if (isAbs(p) && granted.has(path.resolve(p))) shell.showItemInFolder(p)
  })
  handle('update:check', () => checkForUpdates(mainWindow, true))
  handle('app:version', () => app.getVersion())
  handle('app:confirm-close', () => {
    allowClose = true
    mainWindow?.close()
  })
}

// ---------- lifecycle ----------
if (process.env.SIMPLE_VIZ_USER_DATA) app.setPath('userData', process.env.SIMPLE_VIZ_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    void sendOpenFiles(filesFromArgv(argv))
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.on('open-file', (e, p) => {
    e.preventDefault()
    void sendOpenFiles([p])
  })

  app.whenReady().then(async () => {
    app.setName('Simple Viz')
    hardenSessions()
    registerIpc()
    buildMenu()
    pendingOpen.push(...filesFromArgv(process.argv))
    void engine.start()
    createWindow(await store.getSettings())
    scheduleUpdateCheck(() => mainWindow)
    app.on('activate', async () => {
      if (!mainWindow) createWindow(await store.getSettings())
    })
  })

  app.on('window-all-closed', () => {
    if (installIfRequested()) return
    engine.stop()
    if (!isMac) app.quit()
  })
}

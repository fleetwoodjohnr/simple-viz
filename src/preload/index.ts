import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OpenedFile, SimpleVizApi } from '../shared/ipc-types'
import type { SourceStatus } from '../shared/engine-protocol'

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void) => {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// The engine port is a MessagePort, which contextBridge can't pass: post it into the page's own window instead.
// The page only accepts it from its own window (event.source === window) with this exact message.
ipcRenderer.on('engine:port', (e) => window.postMessage('simple-viz:engine-port', '*', e.ports))

const api: SimpleVizApi = {
  platform: process.platform,
  openDialog: (filter, multi) => ipcRenderer.invoke('files:open-dialog', filter, multi),
  pickFiles: (filter, multi) => ipcRenderer.invoke('files:pick', filter, multi),
  readFile: (p) => ipcRenderer.invoke('files:read', p),
  saveDialog: (name, exts) => ipcRenderer.invoke('files:save-dialog', name, exts),
  writeFile: (p, data) => ipcRenderer.invoke('files:write', p, data),
  openExample: () => ipcRenderer.invoke('examples:open'),
  packageData: (tables) => ipcRenderer.invoke('project:package', tables),
  storePackagedData: (id, files) => ipcRenderer.invoke('project:store-packaged', id, files),
  grantDroppedFile: (file) => {
    const p = webUtils.getPathForFile(file)
    if (!p) return null
    void ipcRenderer.invoke('files:grant-dropped', p)
    return p
  },
  fileExists: (p) => ipcRenderer.invoke('files:exists', p),
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentAdd: (entry) => ipcRenderer.invoke('recent:add', entry),
  recentUpdate: (p, patch) => ipcRenderer.invoke('recent:update', p, patch),
  recentRemove: (p) => ipcRenderer.invoke('recent:remove', p),
  recoveryWrite: (id, payload) => ipcRenderer.invoke('recovery:write', id, payload),
  recoveryList: () => ipcRenderer.invoke('recovery:list'),
  recoveryRemove: (id) => ipcRenderer.invoke('recovery:remove', id),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  engineConfigure: (project) => ipcRenderer.invoke('engine:configure', project),
  engineRefresh: (ids, force) => ipcRenderer.invoke('engine:refresh', ids, force),
  engineExport: (sql, format, p) => ipcRenderer.invoke('engine:export', sql, format, p),
  onEngineStatus: (cb) => on<[SourceStatus[]]>('engine:status', cb),
  onEngineRestart: (cb) => on('engine:restart', cb),
  connectionTables: (draft) => ipcRenderer.invoke('connection:tables', draft),
  credentialSet: (id, password) => ipcRenderer.invoke('credential:set', id, password),
  credentialStatus: () => ipcRenderer.invoke('credential:status'),
  sheetTables: (p) => ipcRenderer.invoke('sheet:tables', p),
  exportPdf: (opts) => ipcRenderer.invoke('pdf:export', opts),
  print: () => ipcRenderer.invoke('print'),
  capturePage: (rect, width) => ipcRenderer.invoke('capture-page', rect, width),
  windowMinimize: () => void ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => void ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => void ipcRenderer.invoke('window:close'),
  setFullScreen: (on) => void ipcRenderer.invoke('window:fullscreen', on),
  setTitleBarColors: (c) => void ipcRenderer.invoke('window:titlebar-colors', c),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showInFolder: (p) => void ipcRenderer.invoke('shell:show-in-folder', p),
  onOpenFiles: (cb) => on<[OpenedFile[]]>('app:open-files', cb),
  onCloseRequest: (cb) => on('app:close-request', cb),
  onMenuCommand: (cb) => on<[string]>('app:menu-command', cb),
  onFocus: (cb) => on('app:focus', cb),
  onFileChanged: (cb) => on<[string]>('app:file-changed', cb),
  watchFiles: (paths) => ipcRenderer.invoke('files:watch', paths),
  confirmClose: () => void ipcRenderer.invoke('app:confirm-close'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  appVersion: () => ipcRenderer.invoke('app:version')
}

contextBridge.exposeInMainWorld('simpleViz', api)

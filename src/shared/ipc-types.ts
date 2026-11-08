// Contract between the main process and the renderer. The preload script exposes `window.simpleViz` implementing
// `SimpleVizApi`; main validates every argument. Engine queries do not go through here: the renderer gets a
// MessagePort straight to the engine (see engine-protocol.ts).

import type { Project, Source } from './project'
import type { EngineConfig, SourceStatus } from './engine-protocol'

export interface OpenedFile {
  path: string
  name: string
  data: Uint8Array
  mtime: number
}

export interface RecentFile {
  path: string
  name: string
  openedAt: number
  pinned?: boolean
  favorite?: boolean
  thumbnail?: string
}

export interface RecoveryEntry {
  id: string
  savedAt: number
  /** JSON produced by the renderer ({ title, path, project }). */
  payload: string
}

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemeSetting
  accent: string
  autosave: boolean
  autosaveIntervalSec: number
  recoveryIntervalSec: number
  reduceMotion: boolean
  /** Charts add patterns to their colors (series can be told apart without color). */
  chartPatterns: boolean
  uiScale: number
  shortcuts: Record<string, string>
  /** Rows shown in data previews and the first page of query results. */
  previewRows: number
  /** Seconds before a refresh of one source gives up (per-source settings may raise it). */
  refreshTimeoutSec: number
  /** Ask GitHub for a newer version at startup (at most daily). */
  updateCheck: boolean
  /** When the automatic update check last ran (ms since epoch). */
  lastUpdateCheck: number
  /** Left navigation collapsed to icons. */
  navCollapsed: boolean
  /** Width of the side panels (fields, schema), in px. */
  panelWidth: number
  onboarded: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  accent: '#c2410c',
  autosave: true,
  autosaveIntervalSec: 30,
  recoveryIntervalSec: 5,
  reduceMotion: false,
  chartPatterns: false,
  uiScale: 1,
  shortcuts: {},
  previewRows: 1000,
  refreshTimeoutSec: 60,
  updateCheck: true,
  lastUpdateCheck: 0,
  navCollapsed: false,
  panelWidth: 260,
  onboarded: false
}

/** What the connection dialog sends to test a database or list its tables. The password goes to the keychain. */
export interface ConnectionDraft {
  source: Source
  password?: string
}

export interface SimpleVizApi {
  platform: 'darwin' | 'win32' | 'linux' | string
  /** Native open dialog; `filter` replaces the default filter. */
  openDialog(filter?: { name: string; extensions: string[] }, multi?: boolean): Promise<OpenedFile[]>
  /** Like openDialog, but only grants and returns paths (for data files, which the engine reads itself). */
  pickFiles(filter: { name: string; extensions: string[] }, multi?: boolean): Promise<string[]>
  readFile(path: string): Promise<OpenedFile>
  saveDialog(defaultName: string, extensions: string[]): Promise<string | null>
  writeFile(path: string, data: Uint8Array): Promise<{ mtime: number }>
  /** Resolve a dropped File to its path and grant access to it. */
  grantDroppedFile(file: File): string | null
  fileExists(path: string): Promise<boolean>

  recentList(): Promise<RecentFile[]>
  recentAdd(entry: RecentFile): Promise<RecentFile[]>
  recentUpdate(path: string, patch: Partial<RecentFile>): Promise<RecentFile[]>
  recentRemove(path: string): Promise<RecentFile[]>

  recoveryWrite(id: string, payload: string): Promise<void>
  recoveryList(): Promise<RecoveryEntry[]>
  recoveryRemove(id: string): Promise<void>

  settingsGet(): Promise<Settings>
  settingsSet(patch: Partial<Settings>): Promise<Settings>

  /** Start (or restart) the engine for a project. Main resolves paths and credentials. */
  engineConfigure(project: Pick<Project, 'id' | 'sources' | 'datasets'>): Promise<{ problems: string[] }>
  engineRefresh(sourceIds?: string[], force?: boolean): Promise<SourceStatus[]>
  /** Run a query and write its result to a granted path (CSV or Parquet). */
  engineExport(sql: string, format: 'csv' | 'parquet', path: string): Promise<void>
  onEngineStatus(cb: (s: SourceStatus[]) => void): () => void
  /** The engine was restarted (crash or new configuration): the old port is gone, a new one follows. */
  onEngineRestart(cb: () => void): () => void
  /** Tables offered by a database, for the connection dialog. */
  connectionTables(draft: ConnectionDraft): Promise<string[]>
  /** Store or delete (null) the password of a source in the OS keychain. */
  credentialSet(sourceId: string, password: string | null): Promise<void>
  credentialStatus(): Promise<{ backend: string; secure: boolean }>
  /** Sheets, tables and named ranges in a spreadsheet file (granted path). */
  sheetTables(path: string): Promise<{ ref: string; kind: 'sheet' | 'table' | 'name'; rows: number; columns: number }[]>

  exportPdf(options: { landscape?: boolean }): Promise<Uint8Array>
  print(): Promise<boolean>
  /** A PNG of part of the window (`width`: output width in px), or null when nothing could be captured. */
  capturePage(rect: { x: number; y: number; width: number; height: number }, width?: number): Promise<Uint8Array | null>

  windowMinimize(): void
  windowToggleMaximize(): void
  windowClose(): void
  setFullScreen(on: boolean): void
  setTitleBarColors(colors: { color: string; symbolColor: string }): void
  openExternal(url: string): Promise<void>
  /** Folder of the file in the system file manager. */
  showInFolder(path: string): void

  onOpenFiles(cb: (files: OpenedFile[]) => void): () => void
  onCloseRequest(cb: () => void): () => void
  onMenuCommand(cb: (id: string) => void): () => void
  onFocus(cb: () => void): () => void
  onFileChanged(cb: (path: string) => void): () => void
  /** Files the open project reads; main watches them and reports changes. */
  watchFiles(paths: string[]): Promise<void>
  confirmClose(): void
  checkForUpdates(): Promise<void>
  appVersion(): Promise<string>
}

export type { EngineConfig }

// Central command registry. Buttons, menus, the command palette and keyboard shortcuts all dispatch through here;
// users can rebind any shortcut (Settings → Keyboard). The registry machinery is Simple Cell's.

import { get, set, toast, updateSettings, type Workspace } from '../state/store'
import * as P from '../state/project'
import { SHORTCUTS } from './shortcuts'
import { DATA_EXTENSIONS } from '@/shared/project'

export interface Command {
  id: string
  label: string
  /** Category shown in the command palette and shortcut list. */
  group: string
  /** Runs even while focus is in a text field, the SQL editor or a dialog. */
  global?: boolean
  /** Needs an open project. */
  needsProject?: boolean
  run: () => unknown
  keywords?: string
}

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

const commands = new Map<string, Command>()
export const def = (c: Omit<Command, 'group'> & { group?: string }) => commands.set(c.id, { group: c.id.split('.')[0], ...c })

export const getCommand = (id: string) => commands.get(id)
export const allCommands = () => [...commands.values()]

export async function runCommand(id: string) {
  const cmd = commands.get(id)
  if (!cmd) return
  if (cmd.needsProject && !get().project) return
  try {
    const r = cmd.run()
    if (r instanceof Promise) await r.catch((e: Error) => toast(e.message, 'error'))
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

// ---------- shortcuts ----------

export function shortcutFor(id: string): string | undefined {
  return shortcutsFor(id)[0]
}

export function shortcutsFor(id: string): string[] {
  const o = get().settings.shortcuts[id]
  if (o !== undefined) return o ? [o] : []
  const d = SHORTCUTS.find((s) => s.command === id)
  return d ? (isMac ? (d.mac ?? d.win) : d.win) : []
}

export function formatShortcut(s: string | undefined): string {
  if (!s) return ''
  return s
    .split(' ')
    .map((chord) =>
      chord
        .split('-')
        .map((k) => {
          if (k === 'Mod') return isMac ? '⌘' : 'Ctrl'
          if (k === 'Shift') return isMac ? '⇧' : 'Shift'
          if (k === 'Alt') return isMac ? '⌥' : 'Alt'
          if (k === 'Ctrl') return isMac ? '⌃' : 'Ctrl'
          if (k === 'Enter') return isMac ? '↩' : 'Enter'
          if (k === 'Space') return 'Space'
          if (k === 'Minus') return '-'
          if (k === 'Plus') return '+'
          return k.length === 1 ? k.toUpperCase() : k
        })
        .join(isMac ? '' : '+')
    )
    .join(', ')
}

/** Normalize a keyboard event to the registry's key format (Mod-Shift-l, Alt-1, F5). */
export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = []
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (mod) parts.push('Mod')
  if (isMac && e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  let key = e.key
  const PUNCT: Record<string, string> = { Semicolon: ';', Quote: "'", Backquote: '`', Equal: '=', Minus: 'Minus', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']' }
  if ((mod || e.altKey) && /^(Key[A-Z]|Digit\d)$/.test(e.code)) key = e.code.replace(/^(Key|Digit)/, '').toLowerCase()
  else if ((mod || e.altKey) && PUNCT[e.code]) key = PUNCT[e.code]
  else if (key === ' ') key = 'Space'
  else if (key === '+') key = 'Plus'
  else if (key === '-') key = 'Minus'
  else if (key.length === 1) key = key.toLowerCase()
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('-')
}

/** Keydown handler installed at window level (capture), so registry shortcuts win. */
export function handleKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  const combo = eventToShortcut(e)
  const target = e.target as HTMLElement | null
  const inField = !!target?.closest('input, textarea, select, .cm-editor, [role=dialog], [role=menu], [contenteditable=true]')
  for (const c of commands.values()) {
    if (!shortcutsFor(c.id).includes(combo)) continue
    if (inField && !c.global) return
    if (c.needsProject && !get().project) return
    e.preventDefault()
    e.stopPropagation()
    void runCommand(c.id)
    return
  }
}

// ---------- definitions ----------

const go = (workspace: Workspace) => () => set({ workspace })

def({ id: 'file.new', label: 'New project', global: true, run: () => P.newProject() })
def({ id: 'file.open', label: 'Open project…', global: true, run: () => P.openDialog() })
def({ id: 'file.save', label: 'Save', global: true, needsProject: true, run: () => P.save() })
def({ id: 'file.saveAs', label: 'Save as…', global: true, needsProject: true, run: () => P.save(true) })
def({ id: 'file.savePortable', label: 'Save a portable copy (with data)…', keywords: 'package export share offline', needsProject: true, run: () => P.savePortable() })
def({ id: 'file.close', label: 'Close project', global: true, needsProject: true, run: () => P.closeProject() })
def({ id: 'edit.undo', label: 'Undo', needsProject: true, run: () => P.undo() })
def({ id: 'edit.redo', label: 'Redo', needsProject: true, run: () => P.redo() })

def({ id: 'nav.home', label: 'Go to Home', group: 'go', global: true, run: go('home') })
def({ id: 'nav.data', label: 'Go to Data', group: 'go', global: true, needsProject: true, run: go('data') })
def({ id: 'nav.sql', label: 'Go to SQL editor', group: 'go', global: true, needsProject: true, run: go('sql') })
def({ id: 'nav.charts', label: 'Go to Charts', group: 'go', global: true, needsProject: true, run: go('charts') })
def({ id: 'nav.dashboards', label: 'Go to Dashboards', group: 'go', global: true, needsProject: true, run: go('dashboards') })
def({ id: 'nav.analytics', label: 'Go to Analytics', group: 'go', global: true, needsProject: true, run: go('analytics') })

def({ id: 'data.add', label: 'Add data file…', keywords: 'import excel csv parquet json sqlite duckdb', run: () => pickDataFiles() })
def({ id: 'data.connect', label: 'Connect to PostgreSQL…', keywords: 'database server postgres', run: () => set({ dialog: { kind: 'connect-db', kind2: 'postgres' } }) })
def({ id: 'data.remote', label: 'Add a file from the web or cloud storage…', keywords: 'url http s3 azure bucket blob cloud', run: () => set({ dialog: { kind: 'connect-remote' } }) })
def({ id: 'data.connect-sqlserver', label: 'Connect to SQL Server…', keywords: 'database server mssql microsoft azure sql', run: () => set({ dialog: { kind: 'connect-db', kind2: 'sqlserver' } }) })
def({ id: 'data.connect-oracle', label: 'Connect to Oracle…', keywords: 'database server oracle autonomous', run: () => set({ dialog: { kind: 'connect-db', kind2: 'oracle' } }) })
def({ id: 'data.connect-redshift', label: 'Connect to Amazon Redshift…', keywords: 'database warehouse aws amazon redshift', run: () => set({ dialog: { kind: 'connect-db', kind2: 'redshift' } }) })
def({ id: 'data.connect-clickhouse', label: 'Connect to ClickHouse…', keywords: 'database server olap clickhouse cloud', run: () => set({ dialog: { kind: 'connect-db', kind2: 'clickhouse' } }) })
def({ id: 'data.connect-bigquery', label: 'Connect to BigQuery…', keywords: 'database warehouse google cloud gcp bigquery', run: () => set({ dialog: { kind: 'connect-db', kind2: 'bigquery' } }) })
def({ id: 'data.connect-snowflake', label: 'Connect to Snowflake…', keywords: 'database warehouse cloud snowflake', run: () => set({ dialog: { kind: 'connect-db', kind2: 'snowflake' } }) })
def({ id: 'data.connect-databricks', label: 'Connect to Databricks…', keywords: 'database warehouse lakehouse spark databricks', run: () => set({ dialog: { kind: 'connect-db', kind2: 'databricks' } }) })
def({ id: 'data.connect-trino', label: 'Connect to Trino or Presto…', keywords: 'database query engine trino presto starburst athena', run: () => set({ dialog: { kind: 'connect-db', kind2: 'trino' } }) })
def({ id: 'data.connect-athena', label: 'Connect to Amazon Athena…', keywords: 'database warehouse aws amazon athena s3 glue', run: () => set({ dialog: { kind: 'connect-db', kind2: 'athena' } }) })
def({ id: 'data.connect-hana', label: 'Connect to SAP HANA…', keywords: 'database sap hana odbc', run: () => set({ dialog: { kind: 'connect-db', kind2: 'hana' } }) })
def({ id: 'data.connect-teradata', label: 'Connect to Teradata…', keywords: 'database warehouse teradata vantage odbc', run: () => set({ dialog: { kind: 'connect-db', kind2: 'teradata' } }) })
def({ id: 'data.connect-odbc', label: 'Connect through ODBC…', keywords: 'database other odbc dsn driver jdbc db2 access vertica', run: () => set({ dialog: { kind: 'connect-db', kind2: 'odbc' } }) })
def({ id: 'data.gsheets', label: 'Add a Google Sheets spreadsheet…', keywords: 'google sheets spreadsheet drive gsheet', run: () => set({ dialog: { kind: 'connect-remote', provider: 'gsheets' } }) })
def({ id: 'data.connect-mysql', label: 'Connect to MySQL or MariaDB…', keywords: 'database server mysql mariadb', run: () => set({ dialog: { kind: 'connect-db', kind2: 'mysql' } }) })
def({ id: 'data.refresh', label: 'Refresh all data', needsProject: true, keywords: 'reload update', run: () => P.refreshSources(undefined, true) })

def({ id: 'view.theme', label: 'Toggle dark mode', global: true, run: () => updateSettings({ theme: get().dark ? 'light' : 'dark' }) })
def({ id: 'view.navCollapse', label: 'Collapse navigation', run: () => updateSettings({ navCollapsed: !get().settings.navCollapsed }) })

def({ id: 'tools.palette', label: 'Command palette', global: true, run: () => set({ dialog: { kind: 'palette' } }) })
def({ id: 'tools.settings', label: 'Settings', global: true, run: () => set({ dialog: { kind: 'settings' } }) })
def({ id: 'tools.shortcuts', label: 'Keyboard shortcuts', global: true, run: () => set({ dialog: { kind: 'shortcuts' } }) })
def({ id: 'tools.about', label: 'About Simple Viz', run: () => set({ dialog: { kind: 'about' } }) })
def({ id: 'tools.checkUpdates', label: 'Check for updates', run: () => window.simpleViz.checkForUpdates() })

export async function pickDataFiles() {
  const paths = await window.simpleViz.pickFiles({ name: 'Data files', extensions: DATA_EXTENSIONS }, true)
  if (paths.length) await P.addFiles(paths)
}

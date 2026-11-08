import { create } from 'zustand'
import { DEFAULT_SETTINGS, type RecentFile, type RecoveryEntry, type Settings } from '@/shared/ipc-types'
import type { Project, ServerKind } from '@/shared/project'
import type { RelationInfo, SourceStatus } from '@/shared/engine-protocol'

export type Workspace = 'home' | 'data' | 'sql' | 'charts' | 'dashboards' | 'analytics'
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error'

export type Dialog =
  | { kind: 'settings'; section?: string }
  | { kind: 'confirm-close'; then: 'close' | 'quit' | 'new' | { open: string } }
  | { kind: 'shortcuts' }
  | { kind: 'about' }
  | { kind: 'palette' }
  | { kind: 'add-data' }
  | { kind: 'connect-db'; kind2: ServerKind }
  | { kind: 'sheet-picker'; path: string; sourceId?: string }
  | { kind: 'relink'; sourceId: string }
  | { kind: 'message'; title: string; body: string }
  | { kind: 'prompt'; title: string; label: string; value: string; secret?: boolean; resolve: (v: string | null) => void }

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

export interface AppState {
  ready: boolean
  settings: Settings
  recents: RecentFile[]
  recovery: RecoveryEntry[]
  workspace: Workspace
  dialog: Dialog | null
  toasts: Toast[]
  dark: boolean
  /** The open project (one per window), or null on the start screen with nothing open. */
  project: Project | null
  path: string | null
  dirty: boolean
  status: SaveStatus
  saveError?: string
  /** Relations the engine exposes to SQL, with columns (refreshed after each boot and refresh). */
  relations: RelationInfo[]
  datasetErrors: Record<string, string>
  deps: Record<string, string[]>
  sources: Record<string, SourceStatus>
  /** Bumped whenever source data changed, so charts and previews re-query. */
  dataVersion: number
  engineProblems: string[]
  /** A relation to show in the Data workspace (from search or a link). */
  focusRelation: string | null
}

export const useApp = create<AppState>(() => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  recents: [],
  recovery: [],
  workspace: 'home',
  dialog: null,
  toasts: [],
  dark: false,
  project: null,
  path: null,
  dirty: false,
  status: 'saved',
  relations: [],
  datasetErrors: {},
  deps: {},
  sources: {},
  dataVersion: 0,
  engineProblems: [],
  focusRelation: null
}))

export const set = useApp.setState
export const get = useApp.getState

let toastSeq = 0
export function toast(message: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500)
}

export async function updateSettings(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }))
  const next = await window.simpleViz.settingsSet(patch)
  set({ settings: next })
}

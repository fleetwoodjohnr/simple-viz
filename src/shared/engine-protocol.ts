// Messages between the renderer / main process and the engine (a utility process running DuckDB).
// The renderer's port carries only RendererRequest; sources, paths and credentials arrive from main alone.

import type { DbKind, FileFormat } from './project'

export interface ColumnInfo {
  name: string
  /** DuckDB type name: INTEGER, DOUBLE, VARCHAR, DATE, TIMESTAMP, DECIMAL(18,2)… */
  type: string
}

/** A rectangular slice of a result. Values are JSON-safe: numbers, strings (also dates and big integers), booleans, null. */
export interface ResultPage {
  columns: ColumnInfo[]
  rows: (string | number | boolean | null)[][]
  offset: number
}

export interface QueryResult extends ResultPage {
  /** Handle for paging through the full result (editor queries); absent for small direct results. */
  resultId?: string
  rowCount: number
  ms: number
}

export interface RelationInfo {
  name: string
  kind: 'extract' | 'live' | 'dataset'
  columns: ColumnInfo[]
  /** Source id (extracts and live tables). */
  source?: string
}

export type RendererRequest =
  | { op: 'query'; sql: string; params?: Record<string, string | number | boolean | null>; /** keep the result for paging */ keep?: boolean; limit?: number }
  | { op: 'page'; resultId: string; offset: number; limit: number }
  | { op: 'release'; resultId: string }
  | { op: 'cancel'; target: number }
  | { op: 'describe' }
  | { op: 'explain'; sql: string }
  | { op: 'validate'; sql: string }

export type EngineRequest = RendererRequest & { id: number }

export interface EngineResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

/** A source with everything resolved by main: absolute granted paths and the password from the OS keychain. */
export interface ResolvedSource {
  id: string
  kind: 'file' | DbKind
  format?: FileFormat
  path?: string
  header?: boolean
  tables: { alias: string; ref?: string; types?: Record<string, string> }[]
  mode: 'extract' | 'live'
  timeoutSec: number
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  sslmode?: string
}

export interface EngineConfig {
  projectId: string
  /** userData/cache: holds <projectId>.duckdb, spill files, and export staging. */
  cacheDir: string
  /** Bundled DuckDB extensions for this platform (null in tests that don't need them). */
  extensionsDir: string | null
  sources: ResolvedSource[]
  datasets: { name: string; sql: string }[]
}

export interface SourceStatus {
  id: string
  state: 'ok' | 'stale' | 'error' | 'checking'
  /** ms since epoch of the last successful refresh. */
  refreshedAt: number | null
  changed?: boolean
  rows?: number
  error?: string
}

/** main → engine */
export type ControlRequest =
  | { op: 'boot'; config: EngineConfig }
  | { op: 'refresh'; sourceIds?: string[]; force?: boolean }
  | { op: 'export'; sql: string; format: 'csv' | 'parquet'; file: string }
  | { op: 'tables'; source: ResolvedSource }
  | { op: 'sheets'; path: string; format: FileFormat }

export type ControlMessage = ControlRequest & { id: number }

/** engine → main, unsolicited */
export type EngineEvent = { event: 'status'; sources: SourceStatus[] } | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string }

const OPS = new Set(['query', 'page', 'release', 'cancel', 'describe', 'explain', 'validate'])
const isStr = (v: unknown, max = 1_000_000): v is string => typeof v === 'string' && v.length <= max
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Validates a request arriving on the renderer port. Throws on anything malformed. */
export function checkRendererRequest(m: unknown): EngineRequest {
  const r = m as Record<string, unknown>
  if (!r || typeof r !== 'object' || !isInt(r.id) || !OPS.has(r.op as string)) throw new Error('Malformed engine request')
  switch (r.op) {
    case 'query':
      if (!isStr(r.sql)) throw new Error('Malformed query')
      if (r.limit !== undefined && !isInt(r.limit)) throw new Error('Malformed limit')
      if (r.params !== undefined) {
        if (typeof r.params !== 'object' || r.params === null) throw new Error('Malformed params')
        for (const [k, v] of Object.entries(r.params)) if (!/^[A-Za-z_]\w{0,62}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v) && v !== null) throw new Error('Malformed params')
      }
      break
    case 'page':
      if (!isStr(r.resultId, 64) || !isInt(r.offset) || !isInt(r.limit)) throw new Error('Malformed page request')
      break
    case 'release':
      if (!isStr(r.resultId, 64)) throw new Error('Malformed release')
      break
    case 'cancel':
      if (!isInt(r.target)) throw new Error('Malformed cancel')
      break
    case 'explain':
    case 'validate':
      if (!isStr(r.sql)) throw new Error('Malformed SQL')
      break
  }
  return r as unknown as EngineRequest
}

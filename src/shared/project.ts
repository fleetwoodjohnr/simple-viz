// The Simple Viz project model: what a .sviz file stores (as project.json). Pure data, no credentials, ever.
import type { CalcField, Chart, Parameter } from './charts'

// Bump PROJECT_SCHEMA_VERSION and add a step to src/core/project/migrate.ts for every incompatible change.

export const PROJECT_SCHEMA_VERSION = 1

export type FileFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'xlsx' | 'ods' | 'xml2003'
export type DbKind = 'postgres' | 'sqlite' | 'duckdb'

/** One relation a source exposes to SQL under `alias` (a sheet, named table, cell range, or database table). */
export interface SourceTable {
  alias: string
  /** Spreadsheets: sheet name, named table, or `Sheet!A1:D99` range. Databases: `schema.table`. Flat files: unused. */
  ref?: string
  /** User corrections to inferred column types: column name → DuckDB type (applied with TRY_CAST). */
  types?: Record<string, string>
}

export interface RefreshPolicy {
  onOpen: boolean
  /** Watch the file and refresh when it changes (file sources). */
  watch: boolean
  onFocus: boolean
  /** Minutes between automatic refreshes; 0 = off. */
  everyMin: number
}

export const DEFAULT_REFRESH: RefreshPolicy = { onOpen: true, watch: true, onFocus: true, everyMin: 0 }

interface SourceBase {
  id: string
  name: string
  tables: SourceTable[]
  refresh: RefreshPolicy
}

export interface FileSource extends SourceBase {
  kind: 'file'
  format: FileFormat
  path: string
  /** CSV/TSV: first row holds column names (default true). Spreadsheets: same, per table. */
  header?: boolean
}

export interface DbSource extends SourceBase {
  kind: DbKind
  /** sqlite / duckdb: the database file. */
  path?: string
  /** postgres */
  host?: string
  port?: number
  database?: string
  user?: string
  sslmode?: 'disable' | 'prefer' | 'require' | 'verify-full'
  /** extract: copy into the local cache (fast, offline). live: query the server each time (read-only). */
  mode: 'extract' | 'live'
  timeoutSec: number
}

export type Source = FileSource | DbSource

/** A saved SQL query exposed as a reusable relation (a view), e.g. a join with calculated columns. */
export interface Dataset {
  id: string
  name: string
  sql: string
  description?: string
}

export interface Project {
  schemaVersion: number
  id: string
  title: string
  createdAt: number
  sources: Source[]
  datasets: Dataset[]
  /** Saved SQL editor queries (not exposed as relations). */
  queries: { id: string; name: string; sql: string }[]
  charts: Chart[]
  calcs: CalcField[]
  params: Parameter[]
  dashboards: unknown[]
}

export const FILE_FORMATS: Record<string, FileFormat> = {
  csv: 'csv',
  txt: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  parquet: 'parquet',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  xltm: 'xlsx',
  ods: 'ods',
  xml: 'xml2003'
}

/** Extensions the app opens as data sources, plus its own project files. */
export const DATA_EXTENSIONS = [...Object.keys(FILE_FORMATS), 'sqlite', 'sqlite3', 'db', 'duckdb']
export const PROJECT_EXTENSION = 'sviz'

/** A SQL identifier made from any name: `Sales Transactions 2024` → `sales_transactions_2024`. */
export function toAlias(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return !base ? 'data' : /^\d/.test(base) ? `t_${base}` : base
}

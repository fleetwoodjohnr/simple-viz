// The Simple Viz project model: what a .sviz file stores (as project.json). Pure data, no credentials, ever.
import type { CalcField, Chart, Parameter } from './charts'
import type { Dashboard, Selections } from './dashboards'
import type { FeatureCollection } from '../core/charts/geo'

// Bump PROJECT_SCHEMA_VERSION and add a step to src/core/project/migrate.ts for every incompatible change.

export const PROJECT_SCHEMA_VERSION = 1

export type FileFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'arrow' | 'xlsx' | 'xls' | 'xlsb' | 'ods' | 'xml2003'
export type DbKind = 'postgres' | 'mysql' | 'sqlserver' | 'oracle' | 'redshift' | 'clickhouse' | 'trino' | 'bigquery' | 'snowflake' | 'databricks' | 'sqlite' | 'duckdb'
/** Database servers (host, port, user, password), as opposed to database files. */
export type ServerKind = 'postgres' | 'mysql' | 'sqlserver' | 'oracle' | 'redshift' | 'clickhouse' | 'trino' | 'bigquery' | 'snowflake' | 'databricks'
export const isServer = (k: string): k is ServerKind => Object.hasOwn(SERVER, k)
export const SERVER: Record<ServerKind, { label: string; port: number; database: string }> = {
  postgres: { label: 'PostgreSQL', port: 5432, database: 'postgres' },
  mysql: { label: 'MySQL / MariaDB', port: 3306, database: '' },
  /** Extract only: tables are copied into the cache (DuckDB can't attach SQL Server). */
  sqlserver: { label: 'SQL Server', port: 1433, database: 'master' },
  /** Extract only, through node-oracledb in thin mode; the database is the service name. */
  oracle: { label: 'Oracle', port: 1521, database: 'FREEPDB1' },
  /** Extract only, through node-postgres (Redshift lacks what DuckDB's postgres extension needs). */
  redshift: { label: 'Amazon Redshift', port: 5439, database: 'dev' },
  /** Extract only, over ClickHouse's HTTP interface (8443 with TLS, 8123 without). */
  clickhouse: { label: 'ClickHouse', port: 8443, database: 'default' },
  /** Extract only, over Trino's REST protocol (Presto too); the database is catalog or catalog.schema. */
  trino: { label: 'Trino / Presto', port: 8443, database: '' },
  /** Extract only, over the BigQuery REST API; the database is the Google Cloud project (or project.dataset), the
   *  password a service-account key (JSON) or an access token. */
  bigquery: { label: 'BigQuery', port: 443, database: '' },
  /** Extract only, over the Snowflake SQL API; host is the account address, database DB or DB.SCHEMA, the password a
   *  key-pair private key (PEM) or an OAuth token. */
  snowflake: { label: 'Snowflake', port: 443, database: '' },
  /** Extract only, over the Databricks SQL Statement Execution API; user is the SQL warehouse ID, database
   *  catalog.schema, the password a personal access token. */
  databricks: { label: 'Databricks', port: 443, database: '' }
}
/** Servers read by their own drivers and copied into the cache (DuckDB can't attach them): no live mode. */
export const extractOnly = (k: string) => ['sqlserver', 'oracle', 'redshift', 'clickhouse', 'trino', 'bigquery', 'snowflake', 'databricks'].includes(k)

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

/** A file on the web or in cloud storage, read by DuckDB's httpfs or azure extension. */
export interface RemoteOptions {
  provider: 'http' | 's3' | 'azure'
  /** S3: region, and for S3-compatible services (MinIO, Cloudflare R2, Google Cloud Storage…) the endpoint host. */
  region?: string
  endpoint?: string
  urlStyle?: 'vhost' | 'path'
  useSsl?: boolean
  /** S3 access key id. The secret key (S3), connection string (Azure) or bearer token (web) is in the keychain. */
  keyId?: string
  hasSecret?: boolean
}

/** http(s)://, s3://, az:// and other storage URLs (not local paths). */
export const isRemotePath = (p: string | undefined) => !!p && /^(https?|s3|s3a|s3n|r2|gcs|gs|az|azure|abfss):\/\//i.test(p)

export interface FileSource extends SourceBase {
  kind: 'file'
  format: FileFormat
  /** A local path, or a URL (see isRemotePath) with `remote` set. */
  path: string
  remote?: RemoteOptions
  /** CSV/TSV: first row holds column names (default true). Spreadsheets: same, per table. */
  header?: boolean
  /** A password-protected workbook: its password is in the system keychain (never in the project). */
  encrypted?: boolean
}

export interface DbSource extends SourceBase {
  kind: DbKind
  /** sqlite / duckdb: the database file. */
  path?: string
  /** postgres, mysql */
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
/** A source on a database server (host, port, user…). */
export const isServerSource = (s: Source): s is DbSource & { kind: ServerKind } => isServer(s.kind)

/** A saved SQL query exposed as a reusable relation (a view), e.g. a join with calculated columns. */
export interface Dataset {
  id: string
  name: string
  /** The query. For a visual transform, generated from `steps` (and kept in step). */
  sql: string
  description?: string
  /** Visual transform: the relation it starts from and its steps (src/core/transform.ts). */
  input?: string
  steps?: TransformStep[]
}

export type TransformStep =
  | { id: string; kind: 'select'; columns: string[] }
  | { id: string; kind: 'rename'; from: string; to: string }
  | { id: string; kind: 'filter'; column: string; op: '=' | '<>' | '>' | '>=' | '<' | '<=' | 'contains' | 'starts' | 'null' | 'not_null' | 'in'; value?: string }
  | { id: string; kind: 'calc'; name: string; expr: string }
  | { id: string; kind: 'cast'; column: string; type: string }
  | { id: string; kind: 'fill'; column: string; value: string }
  | { id: string; kind: 'text'; column: string; fn: 'trim' | 'upper' | 'lower' | 'title' }
  | { id: string; kind: 'split'; column: string; sep: string; into: string[] }
  | { id: string; kind: 'dedupe'; columns: string[] }
  | { id: string; kind: 'sort'; column: string; dir: 'asc' | 'desc' }
  | { id: string; kind: 'group'; by: string[]; aggs: { column: string; fn: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct' | 'median'; as: string }[] }
  | { id: string; kind: 'join'; with: string; type: 'left' | 'inner' | 'right' | 'full'; on: { left: string; right: string }[] }
  | { id: string; kind: 'union'; with: string }
  | { id: string; kind: 'pivot'; column: string; value: string; fn: 'sum' | 'avg' | 'count' | 'min' | 'max'; values: string[] }
  | { id: string; kind: 'unpivot'; columns: string[]; name: string; value: string }
  | { id: string; kind: 'sql'; sql: string }

/** Tables related by fields (Tableau's logical layer): charts can use fields from all of them. */
export interface Model {
  id: string
  name: string
  /** name: the table as the model calls it (fields are name.column); source: the data it reads, when the same table
   *  plays several roles (order dates and ship dates from one dates table). */
  tables: { name: string; source?: string; x: number; y: number }[]
  relationships: Relationship[]
}

export interface Story {
  id: string
  name: string
  /** Each point: a dashboard, its caption, and the filter choices it shows (captured with "Keep these filters"). */
  points: { id: string; dashboard: string; caption: string; selections?: Selections }[]
}

/** The data a model table reads. */
export const tableSource = (t: { name: string; source?: string }) => t.source ?? t.name

export interface Relationship {
  id: string
  left: string
  leftField: string
  right: string
  rightField: string
}

/** A named drill path (Region → State → City), reusable across charts. */
export interface Hierarchy {
  id: string
  name: string
  dataset: string
  levels: import('./charts').FieldRef[]
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
  models: Model[]
  hierarchies: Hierarchy[]
  calcs: CalcField[]
  params: Parameter[]
  dashboards: Dashboard[]
  /** Custom maps (GeoJSON areas) for map charts, kept in the project so it stays portable. */
  maps?: CustomMap[]
  /** Stories: dashboards in order, each with a caption (Tableau's story points). */
  stories?: Story[]
}

export interface CustomMap {
  id: string
  name: string
  /** The property naming each area (matched against the chart's values). */
  nameProp: string
  geojson: FeatureCollection
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
  arrow: 'arrow',
  feather: 'arrow',
  ipc: 'arrow',
  arrows: 'arrow',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  xltm: 'xlsx',
  xls: 'xls',
  xlsb: 'xlsb',
  ods: 'ods',
  xml: 'xml2003'
}

/** Extensions the app opens as data sources, plus its own project files. */
/** Formats with several sheets or tables to pick from (and ordinary XML, whose record element is picked). */
export const isSheetFormat = (f: string | undefined) => f === 'xlsx' || f === 'xls' || f === 'xlsb' || f === 'ods' || f === 'xml2003'

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

// ClickHouse (its HTTP interface), Trino / Presto (its REST protocol), BigQuery, Snowflake and Databricks (their REST
// APIs): tables are copied into the cache (extract only; DuckDB can't attach them). Only the catalog query and SELECT * of a chosen table are ever sent, with names
// quoted; user SQL runs in DuckDB over the copy. ClickHouse requests also carry readonly=1, so the server refuses
// anything else.
import { dateValue, timestampValue, type DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { ident } from './sql'

export type Duck = 'BOOLEAN' | 'BIGINT' | 'DOUBLE' | 'DATE' | 'TIMESTAMP' | 'VARCHAR'

const base = (s: ResolvedSource, port: number) => `${s.sslmode === 'disable' ? 'http' : 'https'}://${s.host ?? 'localhost'}:${Number(s.port) || port}`
const timeout = (s: ResolvedSource) => AbortSignal.timeout(Math.max(5, s.timeoutSec) * 6000)

// ---------------------------------------------------------------- ClickHouse

const chQuote = (n: string) => '`' + n.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'

/** A ClickHouse type as a DuckDB one (Nullable and LowCardinality unwrapped; 64-bit unsigned and wider as DOUBLE). */
export function clickhouseType(t: string): Duck {
  const u = t.replace(/^(Nullable|LowCardinality)\((.*)\)$/, '$2').replace(/^(Nullable|LowCardinality)\((.*)\)$/, '$2')
  if (u === 'Bool') return 'BOOLEAN'
  if (/^U?Int(8|16|32)$/.test(u) || u === 'Int64') return 'BIGINT'
  if (/^(UInt64|U?Int(128|256)|Float(32|64)|Decimal)/.test(u)) return 'DOUBLE'
  if (/^Date(32)?$/.test(u)) return 'DATE'
  if (/^DateTime/.test(u)) return 'TIMESTAMP'
  return 'VARCHAR'
}

async function clickhouse(s: ResolvedSource, sql: string): Promise<Response> {
  const res = await fetch(`${base(s, 8443)}/?readonly=1&database=${encodeURIComponent(s.database || 'default')}`, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': s.user || 'default', 'X-ClickHouse-Key': s.password ?? '', 'Content-Type': 'text/plain' },
    body: sql,
    signal: timeout(s)
  })
  if (!res.ok) throw new Error(`ClickHouse: ${(await res.text()).trim().split('\n')[0].slice(0, 300)}`)
  return res
}

/** Response lines as they arrive (a large table never sits in memory as one string). */
async function* lines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) yield line
    }
    if (done) break
  }
  if (buf.trim()) yield buf
}

export async function clickhouseTables(s: ResolvedSource): Promise<string[]> {
  const res = await clickhouse(s, "SELECT database, name FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary ORDER BY 1, 2 FORMAT JSONCompactEachRow")
  const out: string[] = []
  for await (const l of lines(res)) {
    const [db, name] = JSON.parse(l) as string[]
    out.push(`${db}.${name}`)
  }
  return out
}

// ---------------------------------------------------------------- Trino

const trQuote = (n: string) => `"${n.replace(/"/g, '""')}"`

export function trinoType(t: string): Duck {
  const u = t.toLowerCase()
  if (u === 'boolean') return 'BOOLEAN'
  if (['tinyint', 'smallint', 'integer', 'bigint'].includes(u)) return 'BIGINT'
  if (u === 'real' || u === 'double' || u.startsWith('decimal')) return 'DOUBLE'
  if (u === 'date') return 'DATE'
  if (u.startsWith('timestamp')) return 'TIMESTAMP'
  return 'VARCHAR'
}

/** Runs a statement, following nextUri until done; yields the columns once, then pages of rows. */
async function* trino(s: ResolvedSource, sql: string): AsyncGenerator<{ columns?: { name: string; type: string }[]; data?: unknown[][] }> {
  const [catalog, schema] = (s.database ?? '').split('.')
  const headers: Record<string, string> = { 'X-Trino-User': s.user || 'simpleviz', 'X-Trino-Source': 'SimpleViz', 'Content-Type': 'text/plain' }
  if (catalog) headers['X-Trino-Catalog'] = catalog
  if (schema) headers['X-Trino-Schema'] = schema
  // Trino accepts passwords only over https.
  if (s.password && s.sslmode !== 'disable') headers.Authorization = `Basic ${Buffer.from(`${s.user ?? ''}:${s.password}`).toString('base64')}`
  const origin = new URL(base(s, 8443)).origin
  let res = await fetch(`${origin}/v1/statement`, { method: 'POST', headers, body: sql, signal: timeout(s) })
  for (;;) {
    if (!res.ok) throw new Error(`Trino: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    const page = (await res.json()) as { columns?: { name: string; type: string }[]; data?: unknown[][]; nextUri?: string; error?: { message: string } }
    if (page.error) throw new Error(`Trino: ${page.error.message}`)
    yield page
    if (!page.nextUri) return
    // Follow only the server's own pages (never another host it names).
    const next = new URL(page.nextUri)
    if (next.origin !== origin) throw new Error('Trino: the server pointed to another address.')
    res = await fetch(next, { headers, signal: timeout(s) })
  }
}

export async function trinoTables(s: ResolvedSource): Promise<string[]> {
  const [catalog, schema] = (s.database ?? '').split('.')
  if (!catalog) throw new Error('Enter a catalog (for example hive or tpch), or catalog.schema.')
  const out: string[] = []
  for await (const p of trino(s, `SELECT table_schema, table_name FROM ${trQuote(catalog)}.information_schema.tables WHERE table_schema <> 'information_schema'${schema ? ` AND table_schema = '${schema.replace(/'/g, "''")}'` : ''} ORDER BY 1, 2`)) for (const r of p.data ?? []) out.push(`${r[0]}.${r[1]}`)
  return out
}

// ---------------------------------------------------------------- BigQuery

export function bigqueryType(t: string): Duck {
  const u = t.toUpperCase()
  if (u === 'BOOLEAN' || u === 'BOOL') return 'BOOLEAN'
  if (u === 'INTEGER' || u === 'INT64') return 'BIGINT'
  if (['FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL', 'BIGDECIMAL'].includes(u)) return 'DOUBLE'
  if (u === 'DATE') return 'DATE'
  if (u === 'TIMESTAMP' || u === 'DATETIME') return 'TIMESTAMP'
  return 'VARCHAR'
}

const tokens = new Map<string, { token: string; until: number }>()
/**
 * The Authorization header: a service-account key (JSON) is exchanged for a read-only access token (a JWT signed with
 * its key, sent to its https token address); any other password is used as an access token; none: no header (a local
 * emulator).
 */
async function bigqueryAuth(s: ResolvedSource): Promise<Record<string, string>> {
  const secret = (s.password ?? '').trim()
  if (!secret) return {}
  if (!secret.startsWith('{')) return { Authorization: `Bearer ${secret}` }
  const hit = tokens.get(secret)
  if (hit && hit.until > Date.now()) return { Authorization: `Bearer ${hit.token}` }
  let key: { client_email?: string; private_key?: string; token_uri?: string }
  try {
    key = JSON.parse(secret)
  } catch {
    throw new Error('BigQuery: the key isn’t valid JSON. Paste the service account’s key file (or an access token).')
  }
  const aud = key.token_uri ?? 'https://oauth2.googleapis.com/token'
  if (!key.client_email || !key.private_key || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(aud)) throw new Error('BigQuery: the key needs client_email, private_key and an https token_uri.')
  const { createSign } = await import('node:crypto')
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/bigquery.readonly', aud, iat: now, exp: now + 3600 })}`
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url')}`
  const res = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }), signal: timeout(s) })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string }
  if (!res.ok || !body.access_token) throw new Error(`BigQuery: authentication failed (${body.error_description ?? res.status}).`)
  tokens.set(secret, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000 })
  return { Authorization: `Bearer ${body.access_token}` }
}

async function bigquery<T>(s: ResolvedSource, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base(s, 443)}/bigquery/v2/${path}`, { method: body ? 'POST' : 'GET', headers: { ...(await bigqueryAuth(s)), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: timeout(s) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } }
  if (!res.ok || json.error) throw new Error(`BigQuery: ${json.error?.message ?? `HTTP ${res.status}`}`)
  return json
}

const bqProject = (s: ResolvedSource) => {
  const [project, dataset] = (s.database ?? '').split('.')
  if (!project) throw new Error('Enter the Google Cloud project (or project.dataset).')
  return { project: encodeURIComponent(project), dataset }
}

export async function bigqueryTables(s: ResolvedSource): Promise<string[]> {
  const { project, dataset } = bqProject(s)
  const pages = async <T>(path: string, key: string): Promise<T[]> => {
    const out: T[] = []
    let token = ''
    do {
      const r = await bigquery<Record<string, unknown> & { nextPageToken?: string }>(s, `${path}${token ? `${path.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(token)}` : ''}`)
      out.push(...((r[key] as T[]) ?? []))
      token = r.nextPageToken ?? ''
    } while (token)
    return out
  }
  const datasets = dataset ? [dataset] : (await pages<{ datasetReference: { datasetId: string } }>(`projects/${project}/datasets`, 'datasets')).map((d) => d.datasetReference.datasetId)
  const out: string[] = []
  for (const d of datasets) for (const t of await pages<{ tableReference: { tableId: string } }>(`projects/${project}/datasets/${encodeURIComponent(d)}/tables`, 'tables')) out.push(`${d}.${t.tableReference.tableId}`)
  return out.sort()
}

type BqPage = { jobComplete?: boolean; schema?: { fields: { name: string; type: string; mode?: string }[] }; rows?: { f: { v: unknown }[] }[]; pageToken?: string; jobReference?: { jobId: string; location?: string } }

/** Rows per result page (smaller in tests, to exercise paging). */
const bqPage = () => Number(process.env.SV_BQ_PAGE) || 20_000

/** A table's rows: a query job, then its result pages. */
async function* bigqueryRows(s: ResolvedSource, table: string): AsyncGenerator<BqPage> {
  const { project } = bqProject(s)
  let page = await bigquery<BqPage>(s, `projects/${project}/queries`, { query: `SELECT * FROM \`${table.replace(/`/g, '')}\``, useLegacySql: false, maxResults: bqPage(), timeoutMs: 60_000 })
  const job = page.jobReference
  for (;;) {
    while (!page.jobComplete && job) page = await bigquery<BqPage>(s, `projects/${project}/queries/${encodeURIComponent(job.jobId)}?maxResults=${bqPage()}${job.location ? `&location=${encodeURIComponent(job.location)}` : ''}`)
    yield page
    if (!page.pageToken || !job) return
    page = await bigquery<BqPage>(s, `projects/${project}/queries/${encodeURIComponent(job.jobId)}?maxResults=${bqPage()}&pageToken=${encodeURIComponent(page.pageToken)}${job.location ? `&location=${encodeURIComponent(job.location)}` : ''}`)
  }
}

/** BigQuery cell values as the staging appender reads them (TIMESTAMP comes as seconds since 1970). */
function bigqueryValue(v: unknown, type: string, mode?: string): unknown {
  if (v === null || v === undefined) return null
  if (mode === 'REPEATED' || type === 'RECORD' || type === 'STRUCT') return JSON.stringify(v)
  if (type === 'TIMESTAMP') return new Date(Number(v) * 1000).toISOString().replace('T', ' ').replace('Z', '')
  return v
}

// ---------------------------------------------------------------- Snowflake (SQL API v2)

export function snowflakeType(t: { type: string; scale?: number | null }): Duck {
  const u = t.type.toLowerCase()
  if (u === 'fixed') return t.scale ? 'DOUBLE' : 'BIGINT'
  if (u === 'real') return 'DOUBLE'
  if (u === 'boolean') return 'BOOLEAN'
  if (u === 'date') return 'DATE'
  if (u.startsWith('timestamp')) return 'TIMESTAMP'
  return 'VARCHAR'
}

/**
 * Snowflake's Authorization: a private key (PEM) signs a key-pair JWT (issuer ACCOUNT.USER.SHA256:fingerprint of the
 * public key); any other password is an OAuth token.
 */
async function snowflakeAuth(s: ResolvedSource): Promise<Record<string, string>> {
  const secret = (s.password ?? '').trim()
  if (!secret) throw new Error('Snowflake: enter a key-pair private key (PEM) or an OAuth token.')
  if (!secret.includes('PRIVATE KEY')) return { Authorization: `Bearer ${secret}`, 'X-Snowflake-Authorization-Token-Type': 'OAUTH' }
  const { createPrivateKey, createPublicKey, createHash, createSign } = await import('node:crypto')
  const key = createPrivateKey(secret)
  const fp = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('base64')
  const account = (s.host ?? '').split('.')[0].toUpperCase()
  const user = (s.user ?? '').toUpperCase()
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: `${account}.${user}.SHA256:${fp}`, sub: `${account}.${user}`, iat: now, exp: now + 3600 })}`
  return { Authorization: `Bearer ${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' }
}

type SfPage = { resultSetMetaData?: { rowType: { name: string; type: string; scale?: number | null }[]; partitionInfo?: unknown[] }; data?: (string | null)[][]; statementHandle?: string; message?: string; code?: string }

async function snowflake(s: ResolvedSource, path: string, body?: unknown): Promise<SfPage> {
  const headers = { ...(await snowflakeAuth(s)), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'SimpleViz' }
  let res = await fetch(`${base(s, 443)}/api/v2/statements${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: timeout(s) })
  let json = (await res.json().catch(() => ({}))) as SfPage
  // 202: still running; ask again by its handle.
  for (let i = 0; res.status === 202 && json.statementHandle && i < 600; i++) {
    await new Promise((r) => setTimeout(r, 500))
    res = await fetch(`${base(s, 443)}/api/v2/statements/${encodeURIComponent(json.statementHandle)}`, { headers, signal: timeout(s) })
    json = (await res.json().catch(() => ({}))) as SfPage
  }
  if (!res.ok) throw new Error(`Snowflake: ${json.message ?? `HTTP ${res.status}`}`)
  return json
}

const sfDb = (s: ResolvedSource) => {
  const [database, schema] = (s.database ?? '').split('.')
  if (!database) throw new Error('Enter the Snowflake database (or DATABASE.SCHEMA).')
  return { database, schema }
}

/** Runs a statement; yields the first page, then each further partition. */
async function* snowflakeRows(s: ResolvedSource, sql: string): AsyncGenerator<SfPage> {
  const { database, schema } = sfDb(s)
  const first = await snowflake(s, '', { statement: sql, timeout: Math.max(5, s.timeoutSec) * 6, database, ...(schema ? { schema } : {}) })
  yield first
  const parts = first.resultSetMetaData?.partitionInfo?.length ?? 1
  for (let p = 1; p < parts && first.statementHandle; p++) yield { ...(await snowflake(s, `/${encodeURIComponent(first.statementHandle)}?partition=${p}`)), resultSetMetaData: first.resultSetMetaData }
}

export async function snowflakeTables(s: ResolvedSource): Promise<string[]> {
  const { schema } = sfDb(s)
  const out: string[] = []
  for await (const p of snowflakeRows(s, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA'${schema ? ` AND table_schema = '${schema.replace(/'/g, "''").toUpperCase()}'` : ''} ORDER BY 1, 2`)) for (const r of p.data ?? []) out.push(`${r[0]}.${r[1]}`)
  return out
}

/** Snowflake JSON values as the staging appender reads them: dates are days since 1970, timestamps seconds. */
function snowflakeValue(v: string | null, t: { type: string }): unknown {
  if (v === null) return null
  const u = t.type.toLowerCase()
  if (u === 'date') return new Date(Number(v) * 86_400_000).toISOString().slice(0, 10)
  if (u.startsWith('timestamp')) return new Date(Number(v.split(' ')[0]) * 1000).toISOString().replace('T', ' ').replace('Z', '')
  return v
}

// ---------------------------------------------------------------- Databricks (SQL Statement Execution API)

export function databricksType(t: string): Duck {
  const u = t.toUpperCase()
  if (['TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'LONG', 'SHORT', 'BYTE'].includes(u)) return 'BIGINT'
  if (['FLOAT', 'DOUBLE', 'DECIMAL'].includes(u)) return 'DOUBLE'
  if (u === 'BOOLEAN') return 'BOOLEAN'
  if (u === 'DATE') return 'DATE'
  if (u.startsWith('TIMESTAMP')) return 'TIMESTAMP'
  return 'VARCHAR'
}

type DbxPage = { statement_id?: string; status?: { state: string; error?: { message: string } }; manifest?: { schema?: { columns: { name: string; type_name: string }[] } }; result?: { data_array?: (string | null)[][]; next_chunk_internal_link?: string }; data_array?: (string | null)[][]; next_chunk_internal_link?: string; message?: string }

async function* databricksRows(s: ResolvedSource, sql: string): AsyncGenerator<{ columns?: { name: string; type_name: string }[]; data: (string | null)[][] }> {
  if (!s.user) throw new Error('Enter the SQL warehouse ID (in the User field).')
  const [catalog, schema] = (s.database ?? '').split('.')
  const headers = { Authorization: `Bearer ${s.password ?? ''}`, 'Content-Type': 'application/json' }
  const origin = new URL(base(s, 443)).origin
  const get = async (path: string) => {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw new Error('Databricks: the server pointed to another address.')
    const res = await fetch(url, { headers, signal: timeout(s) })
    const json = (await res.json().catch(() => ({}))) as DbxPage
    if (!res.ok) throw new Error(`Databricks: ${json.message ?? `HTTP ${res.status}`}`)
    return json
  }
  let res = await fetch(`${origin}/api/2.0/sql/statements`, { method: 'POST', headers, body: JSON.stringify({ statement: sql, warehouse_id: s.user, ...(catalog ? { catalog } : {}), ...(schema ? { schema } : {}), wait_timeout: '30s', on_wait_timeout: 'CONTINUE', disposition: 'INLINE', format: 'JSON_ARRAY' }), signal: timeout(s) })
  let page = (await res.json().catch(() => ({}))) as DbxPage
  if (!res.ok) throw new Error(`Databricks: ${page.message ?? `HTTP ${res.status}`}`)
  for (let i = 0; page.status && ['PENDING', 'RUNNING'].includes(page.status.state) && i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    page = await get(`/api/2.0/sql/statements/${encodeURIComponent(page.statement_id ?? '')}`)
  }
  if (page.status?.state !== 'SUCCEEDED') throw new Error(`Databricks: ${page.status?.error?.message ?? `the statement ${page.status?.state?.toLowerCase() ?? 'failed'}`}`)
  yield { columns: page.manifest?.schema?.columns, data: page.result?.data_array ?? [] }
  // Further chunks, by the server's own links.
  let next = page.result?.next_chunk_internal_link
  while (next) {
    const chunk = await get(next)
    yield { data: chunk.data_array ?? [] }
    next = chunk.next_chunk_internal_link
  }
}

export async function databricksTables(s: ResolvedSource): Promise<string[]> {
  const [catalog, schema] = (s.database ?? '').split('.')
  if (!catalog) throw new Error('Enter the catalog (or catalog.schema).')
  const out: string[] = []
  for await (const p of databricksRows(s, `SELECT table_schema, table_name FROM ${trQuote(catalog).replace(/"/g, '`')}.information_schema.tables WHERE table_schema <> 'information_schema'${schema ? ` AND table_schema = '${schema.replace(/'/g, "''")}'` : ''} ORDER BY 1, 2`)) for (const r of p.data) out.push(`${r[0]}.${r[1]}`)
  return out
}

// ---------------------------------------------------------------- staging

let seq = 0
/** Copies one table (`schema.table`, ClickHouse `database.table`) into a staging table; the caller copies it into the cache. */
export async function stageWarehouse(duck: DuckDBConnection, s: ResolvedSource, ref: string) {
  const dot = ref.indexOf('.')
  const [schema, table] = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : [s.kind === 'clickhouse' ? s.database || 'default' : '', ref]
  const stage = `__stage_wh_${process.pid}_${++seq}`
  const q = `memory.main.${ident(stage)}`
  let app: Appender | null = null
  let types: Duck[] = []
  const start = async (names: string[], t: Duck[]) => {
    types = t
    await duck.run(`CREATE TABLE ${q} (${names.map((n, i) => `${ident(n || `column${i + 1}`)} ${t[i]}`).join(', ')})`)
    app = (await duck.createAppender(stage, 'main', 'memory')) as unknown as Appender
  }
  try {
    if (s.kind === 'clickhouse') {
      const res = await clickhouse(s, `SELECT * FROM ${chQuote(schema)}.${chQuote(table)} FORMAT JSONCompactEachRowWithNamesAndTypes`)
      let names: string[] | null = null
      for await (const l of lines(res)) {
        const row = JSON.parse(l) as unknown[]
        if (!names) names = row as string[]
        else if (!app) await start(names, (row as string[]).map(clickhouseType))
        else append(row)
      }
    } else if (s.kind === 'snowflake') {
      const { database } = sfDb(s)
      const q2 = (n: string) => `"${n.replace(/"/g, '""')}"`
      let types: { type: string }[] = []
      for await (const p of snowflakeRows(s, `SELECT * FROM ${q2(database)}.${q2(schema || sfDb(s).schema || 'PUBLIC')}.${q2(table)}`)) {
        const rt = p.resultSetMetaData?.rowType ?? []
        if (!app && rt.length) {
          types = rt
          await start(rt.map((c) => c.name), rt.map(snowflakeType))
        }
        for (const r of p.data ?? []) append(r.map((v, i) => snowflakeValue(v, types[i] ?? { type: 'text' })))
      }
    } else if (s.kind === 'databricks') {
      const [catalog] = (s.database ?? '').split('.')
      const bq2 = (n: string) => '`' + n.replace(/`/g, '``') + '`'
      for await (const p of databricksRows(s, `SELECT * FROM ${[catalog, schema, table].filter(Boolean).map(bq2).join('.')}`)) {
        if (!app && p.columns?.length) await start(p.columns.map((c) => c.name), p.columns.map((c) => databricksType(c.type_name)))
        for (const r of p.data) append(r)
      }
    } else if (s.kind === 'bigquery') {
      const { project, dataset } = bqProject(s)
      const full = [decodeURIComponent(project), dot > 0 ? schema : dataset || schema, table].filter(Boolean).join('.')
      for await (const p of bigqueryRows(s, full)) {
        const fields = p.schema?.fields ?? []
        if (!app && fields.length) await start(fields.map((f) => f.name), fields.map((f) => (f.mode === 'REPEATED' ? 'VARCHAR' : bigqueryType(f.type))))
        for (const r of p.rows ?? []) append(r.f.map((c, i) => bigqueryValue(c.v, fields[i]?.type ?? '', fields[i]?.mode)))
      }
    } else {
      const [catalog] = (s.database ?? '').split('.')
      const from = [catalog, schema, table].filter(Boolean).map(trQuote).join('.')
      for await (const p of trino(s, `SELECT * FROM ${from}`)) {
        if (p.columns && !app) await start(p.columns.map((c) => c.name), p.columns.map((c) => trinoType(c.type)))
        for (const r of p.data ?? []) append(r)
      }
    }
    if (!app) throw new Error(`“${ref}” returned no columns.`)
    ;(app as Appender).flushSync()
  } finally {
    ;(app as Appender | null)?.closeSync()
  }
  return { select: `SELECT * FROM ${q}`, cleanup: async () => void (await duck.run(`DROP TABLE IF EXISTS ${q}`).catch(() => {})) }

  function append(values: unknown[]) {
    appendValues(app!, types, values)
  }
}

/** One row into a staging appender, each value converted to its column's DuckDB type. */
function appendValues(a: Appender, types: Duck[], values: unknown[]) {
  values.forEach((v, i) => {
    if (v === null || v === undefined) return a.appendNull()
    switch (types[i]) {
      case 'BOOLEAN':
        return a.appendBoolean(v === true || v === 1 || v === 'true' || v === 't')
      case 'BIGINT':
        return a.appendBigInt(BigInt(v as string | number))
      case 'DOUBLE':
        return a.appendDouble(Number(v))
      case 'DATE': {
        const [y, m, d] = String(v).slice(0, 10).split('-').map(Number)
        return a.appendDate(dateValue(Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)))
      }
      case 'TIMESTAMP': {
        // "2024-01-31 12:34:56.789" (any zone suffix dropped: shown as the server wrote it)
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(String(v))
        if (!m) return a.appendNull()
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        return a.appendTimestamp(timestampValue(BigInt(ms) * 1000n + BigInt((m[7] ?? '').padEnd(6, '0') || 0)))
      }
      default:
        return a.appendVarchar(typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
  })
  a.endRow()
}

/**
 * Stages pages of rows from any reader: the first page's columns create the staging table. Used by drivers that
 * produce rows (Redshift); the caller copies the staging table into the cache.
 */
export async function stageRows(duck: DuckDBConnection, ref: string, pages: () => AsyncGenerator<{ columns: { name: string; type: Duck }[]; rows: unknown[][] }>) {
  const stage = `__stage_wh_${process.pid}_${++seq}`
  const q = `memory.main.${ident(stage)}`
  let app: Appender | null = null
  let types: Duck[] = []
  try {
    for await (const p of pages()) {
      if (!app) {
        types = p.columns.map((c) => c.type)
        await duck.run(`CREATE TABLE ${q} (${p.columns.map((c, i) => `${ident(c.name || `column${i + 1}`)} ${c.type}`).join(', ')})`)
        app = (await duck.createAppender(stage, 'main', 'memory')) as unknown as Appender
      }
      for (const r of p.rows) appendValues(app, types, r)
    }
    if (!app) throw new Error(`“${ref}” returned no columns.`)
    ;(app as Appender).flushSync()
  } finally {
    ;(app as Appender | null)?.closeSync()
  }
  return { select: `SELECT * FROM ${q}`, cleanup: async () => void (await duck.run(`DROP TABLE IF EXISTS ${q}`).catch(() => {})) }
}

type Appender = { appendNull(): void; appendBoolean(v: boolean): void; appendBigInt(v: bigint): void; appendDouble(v: number): void; appendDate(v: unknown): void; appendTimestamp(v: unknown): void; appendVarchar(v: string): void; endRow(): void; flushSync(): void; closeSync(): void }

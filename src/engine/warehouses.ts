// ClickHouse (its HTTP interface), Trino / Presto (its REST protocol) and BigQuery (its REST API): tables are copied
// into the cache (extract only; DuckDB can't attach them). Only the catalog query and SELECT * of a chosen table are ever sent, with names
// quoted; user SQL runs in DuckDB over the copy. ClickHouse requests also carry readonly=1, so the server refuses
// anything else.
import { dateValue, timestampValue, type DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { ident } from './sql'

type Duck = 'BOOLEAN' | 'BIGINT' | 'DOUBLE' | 'DATE' | 'TIMESTAMP' | 'VARCHAR'

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
    const a = app!
    values.forEach((v, i) => {
      if (v === null || v === undefined) return a.appendNull()
      switch (types[i]) {
        case 'BOOLEAN':
          return a.appendBoolean(v === true || v === 1 || v === 'true')
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
}

type Appender = { appendNull(): void; appendBoolean(v: boolean): void; appendBigInt(v: bigint): void; appendDouble(v: number): void; appendDate(v: unknown): void; appendTimestamp(v: unknown): void; appendVarchar(v: string): void; endRow(): void; flushSync(): void; closeSync(): void }

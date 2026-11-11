// Amazon Athena over its API (JSON 1.1 over https, requests signed with Signature Version 4): a table is copied into
// the cache (extract only). Only a catalog query and SELECT * of a chosen table are sent, names quoted; user SQL runs
// in DuckDB over the copy. Sign-in is an access key ID and its secret access key (no session tokens or SSO profiles).
import { createHash, createHmac } from 'node:crypto'
import type { DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { stageRows, type Duck } from './warehouses'

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
const sha = (data: string) => createHash('sha256').update(data).digest('hex')

/** Signature Version 4: the Authorization header of a request (`headers` are the signed ones besides host and date). */
export function sigv4(o: { method: string; host: string; path: string; query?: string; headers?: Record<string, string>; body: string; region: string; service: string; keyId: string; secret: string; amzDate: string }): string {
  const headers: Record<string, string> = { host: o.host, 'x-amz-date': o.amzDate }
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v.trim()
  const names = Object.keys(headers).sort()
  const canonical = [o.method, o.path, o.query ?? '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), sha(o.body)].join('\n')
  const day = o.amzDate.slice(0, 8)
  const scope = `${day}/${o.region}/${o.service}/aws4_request`
  const key = [o.region, o.service, 'aws4_request'].reduce<Buffer>((k, part) => hmac(k, part), hmac(`AWS4${o.secret}`, day))
  const signature = hmac(key, ['AWS4-HMAC-SHA256', o.amzDate, scope, sha(canonical)].join('\n')).toString('hex')
  return `AWS4-HMAC-SHA256 Credential=${o.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
}

/** The endpoint of a source: a region (us-east-1) or an endpoint's host name; the region signs the request. */
export function athenaEndpoint(s: ResolvedSource): { url: string; host: string; region: string } {
  const h = (s.host ?? '').trim() || 'us-east-1'
  const name = h.includes('.') || h === 'localhost' ? h : `athena.${h}.amazonaws.com`
  const port = Number(s.port) || 443
  const plain = s.sslmode === 'disable'
  const host = port === (plain ? 80 : 443) ? name : `${name}:${port}`
  return { url: `${plain ? 'http' : 'https'}://${host}/`, host, region: /^athena(?:-fips)?\.([a-z0-9-]+)\./.exec(name)?.[1] ?? 'us-east-1' }
}

const deadline = (s: ResolvedSource) => Math.max(5, s.timeoutSec) * 6000

async function call<T>(s: ResolvedSource, op: string, body: unknown): Promise<T> {
  if (!s.user || !s.password) throw new Error('Athena: authentication failed (enter an access key ID and its secret access key).')
  const { url, host, region } = athenaEndpoint(s)
  const text = JSON.stringify(body)
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const headers = { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AmazonAthena.${op}` }
  const Authorization = sigv4({ method: 'POST', host, path: '/', headers, body: text, region, service: 'athena', keyId: s.user, secret: s.password, amzDate })
  const res = await fetch(url, { method: 'POST', headers: { ...headers, 'X-Amz-Date': amzDate, Authorization }, body: text, signal: AbortSignal.timeout(deadline(s)) })
  const raw = await res.text()
  let json = {} as T & { __type?: string; message?: string; Message?: string }
  try {
    json = JSON.parse(raw)
  } catch {
    // an error that isn't JSON (a proxy's page, an emulator's XML): its code is looked for in the text
  }
  if (!res.ok) {
    const type = json.__type ?? raw.slice(0, 2000)
    const message = json.message ?? json.Message ?? `HTTP ${res.status}`
    throw new Error(/UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|IncompleteSignature|InvalidClientTokenId|MissingAuthenticationToken|ExpiredToken/.test(type) ? `Athena: authentication failed (${message})` : `Athena: ${message}`)
  }
  return json
}

type Results = { ResultSet: { Rows?: { Data?: { VarCharValue?: string }[] }[]; ResultSetMetadata?: { ColumnInfo?: { Name: string; Type: string }[] } }; NextToken?: string }

/** `catalog.database`, `database`, or nothing (every database of the default catalog). */
const context = (s: ResolvedSource) => {
  const d = (s.database ?? '').trim()
  const dot = d.indexOf('.')
  return dot >= 0 ? { catalog: d.slice(0, dot), database: d.slice(dot + 1) } : { catalog: '', database: d }
}

/** Runs one statement and yields its result pages (the first row of the first page is the header: dropped). */
async function* athena(s: ResolvedSource, sql: string): AsyncGenerator<{ columns: { Name: string; Type: string }[]; rows: (string | null)[][] }> {
  const { catalog, database } = context(s)
  const { QueryExecutionId: id } = await call<{ QueryExecutionId: string }>(s, 'StartQueryExecution', {
    QueryString: sql,
    ...(catalog || database ? { QueryExecutionContext: { ...(catalog ? { Catalog: catalog } : {}), ...(database ? { Database: database } : {}) } } : {}),
    WorkGroup: s.workgroup || 'primary',
    ...(s.output ? { ResultConfiguration: { OutputLocation: s.output } } : {})
  })
  const end = Date.now() + deadline(s)
  for (let wait = 200; ; wait = Math.min(2000, wait * 1.5)) {
    const { State, StateChangeReason } = (await call<{ QueryExecution: { Status: { State: string; StateChangeReason?: string } } }>(s, 'GetQueryExecution', { QueryExecutionId: id })).QueryExecution.Status
    if (State === 'SUCCEEDED') break
    if (State === 'FAILED' || State === 'CANCELLED') throw new Error(`Athena: ${StateChangeReason ?? `the query was ${State.toLowerCase()}`}`)
    if (Date.now() > end) {
      // Not left running (and billed) on the service.
      await call(s, 'StopQueryExecution', { QueryExecutionId: id }).catch(() => {})
      throw new Error('Athena: the query timed out.')
    }
    await new Promise((r) => setTimeout(r, wait))
  }
  let token: string | undefined
  let first = true
  do {
    const page = await call<Results>(s, 'GetQueryResults', { QueryExecutionId: id, MaxResults: 1000, ...(token ? { NextToken: token } : {}) })
    const rows = (page.ResultSet.Rows ?? []).map((r) => (r.Data ?? []).map((d) => d.VarCharValue ?? null))
    yield { columns: page.ResultSet.ResultSetMetadata?.ColumnInfo ?? [], rows: first ? rows.slice(1) : rows }
    first = false
    token = page.NextToken
  } while (token)
}

export function athenaType(t: string): Duck {
  const u = t.toLowerCase()
  if (u === 'boolean') return 'BOOLEAN'
  if (['tinyint', 'smallint', 'integer', 'int', 'bigint'].includes(u)) return 'BIGINT'
  if (['float', 'real', 'double'].includes(u) || u.startsWith('decimal')) return 'DOUBLE'
  if (u === 'date') return 'DATE'
  if (u.startsWith('timestamp')) return 'TIMESTAMP'
  return 'VARCHAR'
}

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`

export async function athenaTables(s: ResolvedSource): Promise<string[]> {
  const { database } = context(s)
  const out: string[] = []
  for await (const p of athena(s, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema <> 'information_schema'${database ? ` AND table_schema = '${database.replace(/'/g, "''")}'` : ''} ORDER BY 1, 2`)) for (const [schema, table] of p.rows) out.push(`${schema}.${table}`)
  return out
}

export function stageAthena(duck: DuckDBConnection, s: ResolvedSource, ref: string) {
  const dot = ref.indexOf('.')
  const parts = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : [ref]
  return stageRows(duck, ref, async function* () {
    for await (const p of athena(s, `SELECT * FROM ${parts.map(quote).join('.')}`)) yield { columns: p.columns.map((c) => ({ name: c.Name, type: athenaType(c.Type) })), rows: p.rows }
  })
}

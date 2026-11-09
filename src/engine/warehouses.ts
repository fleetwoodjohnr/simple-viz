// ClickHouse (its HTTP interface) and Trino / Presto (its REST protocol): tables are copied into the cache (extract
// only; DuckDB can't attach them). Only the catalog query and SELECT * of a chosen table are ever sent, with names
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

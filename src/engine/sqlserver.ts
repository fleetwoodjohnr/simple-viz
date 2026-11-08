// Microsoft SQL Server (and Azure SQL) through tedious, the standard Node driver: tables are copied into the cache
// (extract only — DuckDB can't attach SQL Server, so there is no live mode). Read-only intent; nothing but SELECT and
// the catalog query is ever sent.
import { Connection, Request } from 'tedious'

type ColumnMetaData = { colName: string; type: { name: string } }
import { dateValue, timestampValue, type DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { ident } from './sql'

function connect(s: ResolvedSource): Promise<Connection> {
  const ms = Math.max(5, s.timeoutSec) * 1000
  const encrypt = s.sslmode !== 'disable'
  const conn = new Connection({
    server: s.host ?? 'localhost',
    authentication: { type: 'default', options: { userName: s.user ?? '', password: s.password ?? '' } },
    options: {
      port: Number(s.port) || 1433,
      database: s.database || undefined,
      encrypt,
      // "Prefer" and "Require" encrypt without checking the certificate (like PostgreSQL's modes); "Verify" checks it.
      trustServerCertificate: s.sslmode !== 'verify-full',
      readOnlyIntent: true,
      connectTimeout: ms,
      requestTimeout: ms * 6,
      appName: 'SimpleViz',
      rowCollectionOnRequestCompletion: false
    }
  })
  return new Promise((resolve, reject) => {
    conn.on('connect', (err) => (err ? reject(err) : resolve(conn)))
    conn.connect()
  })
}

const quote = (name: string) => `[${name.replace(/]/g, ']]')}]`

/** The tables and views the login can read, as schema.table. */
export async function sqlServerTables(s: ResolvedSource): Promise<string[]> {
  const conn = await connect(s)
  try {
    const out: string[] = []
    await new Promise<void>((resolve, reject) => {
      const req = new Request("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY 1, 2", (err) => (err ? reject(err) : resolve()))
      req.on('row', (cols) => out.push(`${cols[0].value}.${cols[1].value}`))
      conn.execSql(req)
    })
    return out
  } finally {
    conn.close()
  }
}

/** DuckDB column type for a SQL Server column (tedious names nullable columns with an N: IntN, BitN, DecimalN…). */
function duckType(m: ColumnMetaData): string {
  const t = m.type.name.toLowerCase().replace(/n$/, '')
  if (t === 'bit') return 'BOOLEAN'
  if (['tinyint', 'smallint', 'int', 'bigint'].includes(t)) return 'BIGINT'
  if (['float', 'real', 'decimal', 'numeric', 'money', 'smallmoney'].includes(t)) return 'DOUBLE'
  if (t === 'date') return 'DATE'
  if (['datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'].includes(t)) return 'TIMESTAMP'
  return 'VARCHAR'
}

let seq = 0
/** Streams one table (`schema.table`) into a staging table; the caller copies it into the cache. */
export async function stageSqlServer(duck: DuckDBConnection, s: ResolvedSource, ref: string) {
  const dot = ref.indexOf('.')
  const [schema, table] = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : ['dbo', ref]
  const conn = await connect(s)
  const stage = `__stage_ms_${process.pid}_${++seq}`
  const q = `memory.main.${ident(stage)}`
  let app: Awaited<ReturnType<DuckDBConnection['createAppender']>> | null = null
  let types: string[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const req = new Request(`SELECT * FROM ${quote(schema)}.${quote(table)}`, (err) => (err ? reject(err) : resolve()))
      // Rows wait (the request is paused) until the staging table and its appender exist.
      req.on('columnMetadata', (cols) => {
        req.pause()
        const list = Array.isArray(cols) ? cols : Object.values(cols)
        types = (list as ColumnMetaData[]).map(duckType)
        const names = (list as ColumnMetaData[]).map((c, i) => c.colName || `column${i + 1}`)
        duck
          .run(`CREATE TABLE ${q} (${names.map((n, i) => `${ident(n)} ${types[i]}`).join(', ')})`)
          .then(() => duck.createAppender(stage, 'main', 'memory'))
          .then(
            (a) => {
              app = a
              req.resume()
            },
            (e) => {
              reject(e)
              conn.cancel()
            }
          )
      })
      req.on('row', (cols: { value: unknown }[]) => append(cols.map((c) => c.value)))
      conn.execSql(req)
    })
    if (!app) throw new Error(`“${ref}” returned no columns.`)
    ;(app as { flushSync(): void }).flushSync()
  } finally {
    ;(app as { closeSync(): void } | null)?.closeSync()
    conn.close()
  }
  return { select: `SELECT * FROM ${q}`, cleanup: async () => void (await duck.run(`DROP TABLE IF EXISTS ${q}`).catch(() => {})) }

  function append(values: unknown[]) {
    const a = app as unknown as { appendNull(): void; appendBoolean(v: boolean): void; appendBigInt(v: bigint): void; appendDouble(v: number): void; appendDate(v: unknown): void; appendTimestamp(v: unknown): void; appendVarchar(v: string): void; endRow(): void }
    values.forEach((v, i) => {
      if (v === null || v === undefined) return a.appendNull()
      switch (types[i]) {
        case 'BOOLEAN':
          return a.appendBoolean(!!v)
        case 'BIGINT':
          return a.appendBigInt(BigInt(v as number | string))
        case 'DOUBLE':
          return a.appendDouble(Number(v))
        case 'DATE':
          return a.appendDate(dateValue(Math.floor((v as Date).getTime() / 86_400_000)))
        case 'TIMESTAMP':
          return a.appendTimestamp(timestampValue(BigInt((v as Date).getTime()) * 1000n))
        default:
          return a.appendVarchar(v instanceof Uint8Array || Buffer.isBuffer(v) ? Buffer.from(v as Uint8Array).toString('hex') : typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
    })
    a.endRow()
  }
}

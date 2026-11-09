// Amazon Redshift through node-postgres: Redshift speaks PostgreSQL's protocol but lacks what DuckDB's postgres
// extension relies on (binary COPY, ctid), so tables are copied into the cache (extract only), read in a read-only
// transaction through a server-side cursor, 10,000 rows at a time. Only the catalog query and SELECT * are sent.
import pg from 'pg'
import type { DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { stageRows, type Duck } from './warehouses'

async function connect(s: ResolvedSource) {
  const client = new pg.Client({
    host: s.host ?? 'localhost',
    port: Number(s.port) || 5439,
    user: s.user,
    password: s.password,
    database: s.database || 'dev',
    ssl: s.sslmode === 'disable' ? false : { rejectUnauthorized: s.sslmode === 'verify-full' },
    connectionTimeoutMillis: Math.max(5, s.timeoutSec) * 1000,
    statement_timeout: Math.max(5, s.timeoutSec) * 6000,
    application_name: 'SimpleViz',
    // Every value as the server's text: no time-zone shifts, no precision lost.
    types: { getTypeParser: () => (v: string) => v } as never
  })
  await client.connect()
  return client
}

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`

/** A PostgreSQL type (by OID) as a DuckDB one. */
export function redshiftType(oid: number): Duck {
  if (oid === 16) return 'BOOLEAN'
  if (oid === 20 || oid === 21 || oid === 23) return 'BIGINT'
  if (oid === 700 || oid === 701 || oid === 1700) return 'DOUBLE'
  if (oid === 1082) return 'DATE'
  if (oid === 1114 || oid === 1184) return 'TIMESTAMP'
  return 'VARCHAR'
}

export async function redshiftTables(s: ResolvedSource): Promise<string[]> {
  const c = await connect(s)
  try {
    const r = await c.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_%' ORDER BY 1, 2")
    return r.rows.map((x: Record<string, string>) => `${x.table_schema}.${x.table_name}`)
  } finally {
    await c.end()
  }
}

export async function stageRedshift(duck: DuckDBConnection, s: ResolvedSource, ref: string) {
  const dot = ref.indexOf('.')
  const [schema, table] = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : ['public', ref]
  const c = await connect(s)
  try {
    await c.query('BEGIN READ ONLY')
    await c.query(`DECLARE sv_cursor NO SCROLL CURSOR FOR SELECT * FROM ${quote(schema)}.${quote(table)}`)
    return await stageRows(duck, ref, async function* () {
      for (;;) {
        const r = await c.query({ text: 'FETCH 10000 FROM sv_cursor', rowMode: 'array' })
        yield { columns: r.fields.map((f) => ({ name: f.name, type: redshiftType(f.dataTypeID) })), rows: r.rows as unknown[][] }
        if (r.rows.length < 10000) return
      }
    })
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end()
  }
}

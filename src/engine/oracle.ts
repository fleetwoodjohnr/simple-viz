// Oracle Database through node-oracledb in thin mode (pure JavaScript, no Oracle Client): tables are copied into the
// cache (extract only), read in a read-only transaction, 10,000 rows per fetch. Values arrive as text in fixed formats
// (dates formatted by the server, numbers in the session's fixed format), so nothing shifts with time zones or loses
// precision. Only the catalog query and SELECTs of a chosen table are sent.
import oracledb from 'oracledb'
import type { DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { stageRows, type Duck } from './warehouses'

async function connect(s: ResolvedSource) {
  const service = s.database || 'FREEPDB1'
  const c = await oracledb.getConnection({ user: s.user, password: s.password, connectString: `${s.sslmode === 'disable' ? '' : 'tcps://'}${s.host ?? 'localhost'}:${Number(s.port) || 1521}/${service}`, connectTimeout: Math.max(5, s.timeoutSec) })
  c.callTimeout = Math.max(5, s.timeoutSec) * 6000
  await c.execute("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6' NLS_NUMERIC_CHARACTERS = '.,'")
  return c
}

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`

/** An Oracle column as a DuckDB type (an Oracle DATE holds a time too). */
export function oracleType(m: { dbTypeName?: string; precision?: number; scale?: number }): Duck {
  const t = (m.dbTypeName ?? '').toUpperCase()
  if (t === 'NUMBER') return m.scale === 0 && (m.precision ?? 0) > 0 && (m.precision ?? 0) <= 18 ? 'BIGINT' : 'DOUBLE'
  if (t === 'BINARY_FLOAT' || t === 'BINARY_DOUBLE' || t === 'FLOAT') return 'DOUBLE'
  if (t === 'BOOLEAN') return 'BOOLEAN'
  if (t === 'DATE' || t.startsWith('TIMESTAMP')) return 'TIMESTAMP'
  return 'VARCHAR'
}

export async function oracleTables(s: ResolvedSource): Promise<string[]> {
  const c = await connect(s)
  try {
    const r = await c.execute<string[]>(
      `SELECT owner, table_name FROM all_tables t WHERE NOT EXISTS (SELECT 1 FROM all_users u WHERE u.username = t.owner AND u.oracle_maintained = 'Y')
       UNION ALL SELECT owner, view_name FROM all_views v WHERE NOT EXISTS (SELECT 1 FROM all_users u WHERE u.username = v.owner AND u.oracle_maintained = 'Y') ORDER BY 1, 2`,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    )
    return (r.rows ?? []).map((x) => `${x[0]}.${x[1]}`)
  } finally {
    await c.close()
  }
}

export async function stageOracle(duck: DuckDBConnection, s: ResolvedSource, ref: string) {
  try {
    return await stageOnce(duck, s, ref)
  } catch (e) {
    // ORA-01466: a table recreated within the last second can't be read by a read-only transaction yet.
    if (!/ORA-01466/.test(String((e as Error).message))) throw e
    await new Promise((r) => setTimeout(r, 1500))
    return stageOnce(duck, s, ref)
  }
}

async function stageOnce(duck: DuckDBConnection, s: ResolvedSource, ref: string) {
  const dot = ref.indexOf('.')
  const [owner, table] = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : [(s.user ?? '').toUpperCase(), ref]
  const c = await connect(s)
  try {
    await c.execute('SET TRANSACTION READ ONLY')
    const from = `${quote(owner)}.${quote(table)}`
    // Dates and timestamps as text in a fixed format, by the server (the thin driver would format them in this
    // computer's time zone).
    const meta = (await c.execute(`SELECT * FROM ${from} WHERE 1 = 0`)).metaData ?? []
    const list = meta.map((m) => {
      const t = (m.dbTypeName ?? '').toUpperCase()
      return t === 'DATE' ? `TO_CHAR(${quote(m.name)}, 'YYYY-MM-DD HH24:MI:SS') AS ${quote(m.name)}` : t.startsWith('TIMESTAMP') ? `TO_CHAR(${quote(m.name)}, 'YYYY-MM-DD HH24:MI:SS.FF6') AS ${quote(m.name)}` : quote(m.name)
    })
    const r = await c.execute(`SELECT ${list.join(', ')} FROM ${from}`, [], {
      resultSet: true,
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      fetchArraySize: 10_000,
      // Every value as text in the session's fixed formats (LOBs too).
      fetchTypeHandler: (m) => (m.dbType === oracledb.DB_TYPE_BLOB || m.dbType === oracledb.DB_TYPE_RAW ? { type: oracledb.BUFFER } : { type: oracledb.STRING })
    })
    const rs = r.resultSet!
    const columns = meta.map((m) => ({ name: m.name, type: oracleType(m as { dbTypeName?: string; precision?: number; scale?: number }) }))
    try {
      return await stageRows(duck, ref, async function* () {
        for (;;) {
          const rows = (await rs.getRows(10_000)) as unknown[][]
          yield { columns, rows: rows.map((row) => row.map((v) => (Buffer.isBuffer(v) ? v.toString('hex') : v))) }
          if (rows.length < 10_000) return
        }
      })
    } finally {
      await rs.close()
    }
  } finally {
    await c.rollback().catch(() => {})
    await c.close()
  }
}

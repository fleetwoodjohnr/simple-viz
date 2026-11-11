// Databases reached through an ODBC driver installed on this computer: any database with a driver (a data source name
// or a connection string), SAP HANA and Teradata (their vendors' drivers). Extract only.
//
// DuckDB's odbc_scanner extension does the reading, in an instance of its own that lives for one read: its functions
// (odbc_connect, odbc_copy…) never exist in the instance that runs user SQL. Only a catalog query and SELECT * of a
// chosen table are sent. A table travels to the cache as a Parquet file in the cache's tmp folder.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { odbcProblem } from '../shared/project'
import { lit } from './sql'

const VENDOR: Record<string, { driver: RegExp; label: string; install: string }> = {
  hana: { driver: /hdbodbc|hana/i, label: 'SAP HANA', install: 'the SAP HANA client (its ODBC driver is called HDBODBC)' },
  teradata: { driver: /teradata/i, label: 'Teradata', install: 'the Teradata ODBC driver (part of Teradata Tools and Utilities)' }
}

/** ODBC's braces around a value. */
const brace = (v: string) => `{${v.replace(/}/g, '}}')}}`
/** Braces only where a value needs them: not every driver takes them off a plain one (psqlodbc keeps them on a user name). */
const val = (v: string) => (/[;{}]|^\s|\s$/.test(v) ? brace(v) : v)

/** The connection string for a source; `drivers` are the ODBC drivers installed on this computer. */
export function odbcConnString(s: ResolvedSource, drivers: string[]): string {
  let conn: string
  if (s.kind === 'odbc') {
    const c = (s.database ?? '').trim()
    const problem = odbcProblem(c)
    if (problem) throw new Error(problem)
    conn = c.includes('=') ? c.replace(/[;\s]+$/, '') : `DSN=${c}`
  } else {
    const v = VENDOR[s.kind]
    const driver = drivers.find((d) => v.driver.test(d))
    if (!driver) throw new Error(`No ODBC driver for ${v.label} is installed on this computer. Install ${v.install}, then connect again.`)
    const host = s.host ?? 'localhost'
    const tls = s.sslmode === 'require' || s.sslmode === 'verify-full'
    conn =
      s.kind === 'hana'
        ? [`Driver=${brace(driver)}`, `ServerNode=${val(`${host}:${Number(s.port) || 30015}`)}`, ...(s.database ? [`DatabaseName=${val(s.database)}`] : []), ...(tls ? ['encrypt=true', `sslValidateCertificate=${s.sslmode === 'verify-full'}`] : [])].join(';')
        : [`Driver=${brace(driver)}`, `DBCName=${val(host)}`, ...(Number(s.port) ? [`TDMSTPortNumber=${Number(s.port)}`] : []), ...(s.database ? [`Database=${val(s.database)}`] : []), ...(tls ? [`SSLMode=${s.sslmode === 'verify-full' ? 'Verify-Full' : 'Require'}`] : [])].join(';')
  }
  return `${conn}${s.user ? `;UID=${val(s.user)}` : ''}${s.password ? `;PWD=${val(s.password)}` : ''}`
}

/** Runs `f` on an open ODBC connection (`handle`) in a short-lived DuckDB instance. */
async function session<T>(s: ResolvedSource, extensionsDir: string | null | undefined, f: (c: DuckDBConnection, handle: string) => Promise<T>): Promise<T> {
  if (!extensionsDir) throw new Error('The ODBC extension is not bundled with this build.')
  const inst = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false', allow_community_extensions: 'false' })
  const c = await inst.connect()
  // ponytail: stops between driver calls only; a driver stuck inside one call is bounded by its own login/query timeout.
  const timer = setTimeout(() => c.interrupt(), Math.max(5, s.timeoutSec) * 6000)
  let handle: string | null = null
  try {
    try {
      await c.run(`LOAD ${lit(path.join(extensionsDir, 'odbc_scanner.duckdb_extension'))}`)
    } catch (e) {
      throw new Error(`ODBC isn’t set up on this computer: ${String((e as Error).message).split('\n')[0].slice(0, 200)} On Linux install unixODBC (the unixodbc package); on macOS, “brew install unixodbc”.`)
    }
    const drivers = (await c.runAndReadAll('SELECT * FROM odbc_list_drivers()')).getRows().map((r) => String(r[0]))
    const p = await c.prepare('SELECT odbc_connect($1)')
    p.bindVarchar(1, odbcConnString(s, drivers))
    handle = String((await p.runAndReadAll()).getRows()[0][0])
    return await f(c, handle)
  } catch (e) {
    // A driver may quote the connection string in its message: the password never leaves this function.
    const m = String((e as Error).message ?? e)
    throw new Error(s.password ? m.split(s.password).join('***') : m)
  } finally {
    clearTimeout(timer)
    if (handle) await c.run(`SELECT odbc_close(${handle})`).catch(() => {})
    c.closeSync()
    inst.closeSync()
  }
}

// ponytail: the driver's own catalog call (SQLTables) isn't exposed by the extension, so the catalogs of the usual
// databases are tried in turn; a database with none of them gets no list (its tables are typed by name).
const CATALOGS = {
  standard: "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'INFORMATION_SCHEMA', 'pg_catalog', 'sys', 'mysql', 'performance_schema') ORDER BY 1, 2",
  hana: "SELECT SCHEMA_NAME, TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME NOT LIKE '%SYS%' UNION ALL SELECT SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME NOT LIKE '%SYS%' ORDER BY 1, 2",
  teradata:
    "SELECT DatabaseName, TableName FROM DBC.TablesV WHERE TableKind IN ('T', 'O', 'V') AND DatabaseName NOT IN ('DBC', 'SYSLIB', 'SYSUDTLIB', 'SYSBAR', 'SYSJDBC', 'SYSSPATIAL', 'SystemFe', 'Sys_Calendar', 'TD_SYSFNLIB', 'TD_SYSXML', 'TD_SERVER_DB', 'TDStats', 'TDQCD', 'TDMaps', 'SQLJ', 'dbcmngr', 'tdwm', 'LockLogShredder') ORDER BY 1, 2"
}

export async function odbcTables(s: ResolvedSource, extensionsDir: string | null): Promise<string[]> {
  return session(s, extensionsDir, async (c, h) => {
    const list = async (sql: string) => (await c.runAndReadAll(`SELECT * FROM odbc_query(${h}, ${lit(sql)})`)).getRows().map(([schema, table]) => `${String(schema).trim()}.${String(table).trim()}`)
    if (s.kind !== 'odbc') return list(CATALOGS[s.kind as 'hana' | 'teradata'])
    for (const sql of Object.values(CATALOGS)) {
      try {
        return await list(sql)
      } catch {
        // not this database's catalog
      }
    }
    return []
  })
}

// ponytail: the driver isn't asked for its quote character: standard quotes first, then MySQL's and Access's.
const QUOTES = [['"', '"'], ['`', '`'], ['[', ']']]
let seq = 0

/** Copies one table (`schema.table` or `table`) into a Parquet file in `tmp`; the caller copies it into the cache. */
export async function stageOdbc(s: ResolvedSource, ref: string, extensionsDir: string | null | undefined, tmp: string) {
  const file = path.join(tmp, `odbc-${process.pid}-${++seq}.parquet`)
  const dot = ref.indexOf('.')
  const parts = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : [ref]
  await session(s, extensionsDir, async (c, h) => {
    let first: unknown
    for (const [open, close] of QUOTES) {
      try {
        return void (await c.run(`COPY (SELECT * FROM odbc_query(${h}, ${lit(`SELECT * FROM ${parts.map((p) => open + p.replaceAll(close, close + close) + close).join('.')}`)})) TO ${lit(file)} (FORMAT parquet)`))
      } catch (e) {
        first ??= e
        if (/INTERRUPT/i.test(String((e as Error).message))) break
      }
    }
    throw first
  })
  return { select: `SELECT * FROM read_parquet(${lit(file)})`, cleanup: () => fs.rm(file, { force: true }) }
}

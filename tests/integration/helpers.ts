// Shared setup for integration tests: a real engine on temp folders, and PostgreSQL (CI service or a podman container).
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { Engine } from '../../src/engine/engine'
import type { EngineConfig, ResolvedSource } from '../../src/shared/engine-protocol'

// The repository root (tests run from it; also loaded by Playwright, which compiles to CommonJS).
export const root = process.cwd()
export const fixture = (name: string) => path.join(root, 'tests', 'fixtures', name)
export const expected = () => JSON.parse(readFileSync(fixture('expected.json'), 'utf8'))
const osName = ({ darwin: 'mac', win32: 'win' } as Record<string, string>)[process.platform] ?? process.platform
export const extensionsDir = path.join(root, 'resources', 'duckdb-ext', `${osName}-${process.arch}`)
export const tmp = (prefix = 'sv-') => mkdtempSync(path.join(os.tmpdir(), prefix))

export function fileSource(id: string, file: string, format: ResolvedSource['format'], tables: ResolvedSource['tables']): ResolvedSource {
  return { id, kind: 'file', format, path: file, tables, mode: 'extract', timeoutSec: 30 }
}

export async function bootEngine(sources: ResolvedSource[], datasets: EngineConfig['datasets'] = [], cacheDir = tmp(), projectId = 'p1'): Promise<{ engine: Engine; config: EngineConfig }> {
  const engine = new Engine()
  const config: EngineConfig = { projectId, cacheDir, extensionsDir: existsSync(extensionsDir) ? extensionsDir : null, sources, datasets }
  await engine.boot(config)
  await engine.refresh()
  return { engine, config }
}

let qid = 0
export async function rows(engine: Engine, sql: string) {
  const r = await engine.query(++qid, sql, { limit: 100_000 })
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))
}

// ---------------------------------------------------------------- PostgreSQL

export interface Pg {
  /** podman container name (absent for a CI service). */
  name?: string
  host: string
  port: number
  user: string
  password: string
  database: string
  stop(): void
  restart(): void
}

const hasPodman = () => {
  try {
    execFileSync('podman', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** PostgreSQL to test against: SV_PG_HOST (CI service) or a throwaway podman container; null when neither exists. */
export async function startPostgres(): Promise<Pg | null> {
  if (process.env.SV_PG_HOST) {
    const pg = { host: process.env.SV_PG_HOST, port: Number(process.env.SV_PG_PORT ?? 5432), user: process.env.SV_PG_USER ?? 'postgres', password: process.env.SV_PG_PASSWORD ?? 'postgres', database: process.env.SV_PG_DATABASE ?? 'postgres', stop() {}, restart() {} }
    await seed(pg)
    return pg
  }
  if (!hasPodman() || process.env.SV_NO_PODMAN) return null
  const name = `sv-pg-${process.pid}-${Date.now()}`
  const port = 20000 + Math.floor(Math.random() * 20000)
  execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_PASSWORD=sv-secret', 'docker.io/library/postgres:17-alpine'], { stdio: 'ignore' })
  const pg: Pg = {
    name,
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'sv-secret',
    database: 'postgres',
    stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }),
    restart: () => void execFileSync('podman', ['restart', name], { stdio: 'ignore' })
  }
  await waitFor(pg)
  await seed(pg)
  return pg
}

export async function waitFor(pg: Pg, ms = 60_000) {
  const t0 = Date.now()
  for (;;) {
    try {
      await pgExec(pg, 'SELECT 1')
      return
    } catch (e) {
      if (Date.now() - t0 > ms) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/** Runs SQL on the server through DuckDB's postgres extension (no psql needed). */
export async function pgExec(pg: Pg, sql: string) {
  const i = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
  const c = await i.connect()
  try {
    await c.run(`LOAD '${path.join(extensionsDir, 'postgres_scanner.duckdb_extension').replace(/'/g, "''")}'`)
    await c.run(`ATTACH 'host=${pg.host} port=${pg.port} user=${pg.user} password=${pg.password} dbname=${pg.database} connect_timeout=3' AS pg (TYPE postgres)`)
    await c.run(`CALL postgres_execute('pg', '${sql.replace(/'/g, "''")}')`)
  } finally {
    c.closeSync()
    i.closeSync()
  }
}

async function seed(pg: Pg) {
  // postgres_execute runs one command at a time.
  for (const stmt of readFileSync(fixture('customers.sql'), 'utf8').split(/;\n/).filter((x) => x.trim())) await pgExec(pg, stmt)
}

export function pgSource(pg: Pg, mode: 'extract' | 'live', tables = [{ alias: 'customers', ref: 'public.customers' }]): ResolvedSource {
  return { id: `pg${mode}`, kind: 'postgres', host: pg.host, port: pg.port, user: pg.user, password: pg.password, database: pg.database, sslmode: 'disable', mode, timeoutSec: 10, tables }
}

// ---------------------------------------------------------------- MySQL / MariaDB

export type My = Omit<Pg, 'restart'>

/** Runs SQL on the server through DuckDB's mysql extension (no client needed). */
export async function myExec(my: My, sql: string) {
  const i = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
  const c = await i.connect()
  try {
    await c.run(`LOAD '${path.join(extensionsDir, 'mysql_scanner.duckdb_extension').replace(/'/g, "''")}'`)
    await c.run(`CREATE TEMPORARY SECRET s (TYPE mysql, HOST '${my.host}', PORT ${my.port}, USER '${my.user}', PASSWORD '${my.password}', DATABASE '${my.database}')`)
    await c.run(`ATTACH '' AS my (TYPE mysql, SECRET s)`)
    await c.run(`CALL mysql_execute('my', '${sql.replace(/'/g, "''")}')`)
  } finally {
    c.closeSync()
    i.closeSync()
  }
}

/** MariaDB to test against: SV_MY_HOST, or a throwaway podman container; null when neither exists. */
export async function startMysql(): Promise<My | null> {
  let my: My
  if (process.env.SV_MY_HOST) my = { host: process.env.SV_MY_HOST, port: Number(process.env.SV_MY_PORT ?? 3306), user: process.env.SV_MY_USER ?? 'root', password: process.env.SV_MY_PASSWORD ?? '', database: process.env.SV_MY_DATABASE ?? 'shop', stop() {} }
  else {
    if (!hasPodman() || process.env.SV_NO_PODMAN || !existsSync(path.join(extensionsDir, 'mysql_scanner.duckdb_extension'))) return null
    const name = `sv-my-${process.pid}-${Date.now()}`
    const port = 20000 + Math.floor(Math.random() * 20000)
    execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:3306`, '-e', 'MARIADB_ROOT_PASSWORD=sv-secret', '-e', 'MARIADB_DATABASE=shop', 'docker.io/library/mariadb:11'], { stdio: 'ignore' })
    my = { name, host: '127.0.0.1', port, user: 'root', password: 'sv-secret', database: 'shop', stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
  }
  const t0 = Date.now()
  for (;;) {
    try {
      await myExec(my, 'SELECT 1')
      break
    } catch (e) {
      if (Date.now() - t0 > 90_000) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  await myExec(my, 'DROP TABLE IF EXISTS customers')
  await myExec(my, 'CREATE TABLE customers (customer_id INT PRIMARY KEY, customer_name VARCHAR(100) NOT NULL, region VARCHAR(40) NOT NULL, segment VARCHAR(40) NOT NULL)')
  const rows = readFileSync(fixture('customers.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  await myExec(my, `INSERT INTO customers VALUES ${rows.map((r) => `(${r[0]}, '${r[1]}', '${r[2]}', '${r[3]}')`).join(', ')}`)
  return my
}

export function mySource(my: My, mode: 'extract' | 'live', password = my.password): ResolvedSource {
  return { id: `my${mode}`, kind: 'mysql', host: my.host, port: my.port, user: my.user, password, database: my.database, sslmode: 'disable', mode, timeoutSec: 10, tables: [{ alias: 'my_customers', ref: 'customers' }] }
}

// ---------------------------------------------------------------- SQL Server

export type Ms = Omit<Pg, 'restart'>

/** Runs one batch on SQL Server with tedious. */
export async function msExec(ms: Ms, sql: string, database = ms.database) {
  const { Connection, Request } = await import('tedious')
  const conn = new Connection({ server: ms.host, authentication: { type: 'default', options: { userName: ms.user, password: ms.password } }, options: { port: ms.port, database, encrypt: true, trustServerCertificate: true, connectTimeout: 5000 } })
  await new Promise<void>((resolve, reject) => {
    conn.on('connect', (err) => (err ? reject(err) : resolve()))
    conn.connect()
  })
  try {
    await new Promise<void>((resolve, reject) => conn.execSql(new Request(sql, (err) => (err ? reject(err) : resolve()))))
  } finally {
    conn.close()
  }
}

/** SQL Server 2022 to test against: SV_MS_HOST, or a throwaway podman container (x64 only); null when neither. */
export async function startSqlServer(): Promise<Ms | null> {
  let ms: Ms
  if (process.env.SV_MS_HOST) ms = { host: process.env.SV_MS_HOST, port: Number(process.env.SV_MS_PORT ?? 1433), user: process.env.SV_MS_USER ?? 'sa', password: process.env.SV_MS_PASSWORD ?? '', database: 'shop', stop() {} }
  else {
    if (!hasPodman() || process.env.SV_NO_PODMAN || process.arch !== 'x64') return null
    const name = `sv-ms-${process.pid}-${Date.now()}`
    const port = 20000 + Math.floor(Math.random() * 20000)
    execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:1433`, '-e', 'ACCEPT_EULA=Y', '-e', 'MSSQL_SA_PASSWORD=Sv-Secret-2026!', 'mcr.microsoft.com/mssql/server:2022-latest'], { stdio: 'ignore' })
    ms = { name, host: '127.0.0.1', port, user: 'sa', password: 'Sv-Secret-2026!', database: 'shop', stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
  }
  const t0 = Date.now()
  for (;;) {
    try {
      await msExec(ms, "IF DB_ID('shop') IS NULL CREATE DATABASE shop", 'master')
      break
    } catch (e) {
      if (Date.now() - t0 > 180_000) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  const rows = readFileSync(fixture('customers.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  await msExec(ms, `IF OBJECT_ID('dbo.customers') IS NOT NULL DROP TABLE dbo.customers;
    CREATE TABLE dbo.customers (customer_id INT PRIMARY KEY, customer_name NVARCHAR(100) NOT NULL, region NVARCHAR(40) NOT NULL, segment NVARCHAR(40) NOT NULL, since DATE NULL, score DECIMAL(6,2) NULL, vip BIT NULL);
    INSERT INTO dbo.customers VALUES ${rows.map((r, i) => `(${r[0]}, N'${r[1]}', N'${r[2]}', N'${r[3]}', ${i % 5 ? `DATEADD(day, ${i}, '2024-01-01')` : 'NULL'}, ${i % 7 ? (i * 1.25).toFixed(2) : 'NULL'}, ${i % 3 === 0 ? 1 : 0})`).join(', ')};`)
  return ms
}

export function msSource(ms: Ms, password = ms.password): ResolvedSource {
  return { id: 'ms1', kind: 'sqlserver', host: ms.host, port: ms.port, user: ms.user, password, database: ms.database, sslmode: 'require', mode: 'extract', timeoutSec: 15, tables: [{ alias: 'ms_customers', ref: 'dbo.customers' }] }
}

// ---------------------------------------------------------------- ClickHouse, Trino

export type Wh = Omit<Pg, 'restart'>

/** Runs SQL on ClickHouse over HTTP (writes allowed: this is the test's own setup). */
export async function chExec(ch: Wh, sql: string, body?: string) {
  const url = `http://${ch.host}:${ch.port}/?query=${encodeURIComponent(sql)}`
  const res = await fetch(url, { method: 'POST', headers: { 'X-ClickHouse-User': ch.user, 'X-ClickHouse-Key': ch.password }, body: body ?? '' })
  if (!res.ok) throw new Error(await res.text())
  return res.text()
}

/** ClickHouse to test against: SV_CH_HOST, or a throwaway podman container; null when neither. Seeded with customers. */
export async function startClickHouse(): Promise<Wh | null> {
  let ch: Wh
  if (process.env.SV_CH_HOST) ch = { host: process.env.SV_CH_HOST, port: Number(process.env.SV_CH_PORT ?? 8123), user: process.env.SV_CH_USER ?? 'default', password: process.env.SV_CH_PASSWORD ?? '', database: 'shop', stop() {} }
  else {
    if (!hasPodman() || process.env.SV_NO_PODMAN) return null
    const name = `sv-ch-${process.pid}-${Date.now()}`
    const port = 20000 + Math.floor(Math.random() * 20000)
    execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8123`, '-e', 'CLICKHOUSE_USER=sv', '-e', 'CLICKHOUSE_PASSWORD=sv-secret', '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1', 'docker.io/clickhouse/clickhouse-server:24.8'], { stdio: 'ignore' })
    ch = { name, host: '127.0.0.1', port, user: 'sv', password: 'sv-secret', database: 'shop', stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
  }
  const t0 = Date.now()
  for (;;) {
    try {
      await chExec(ch, 'CREATE DATABASE IF NOT EXISTS shop')
      break
    } catch (e) {
      if (Date.now() - t0 > 120_000) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  await chExec(ch, 'DROP TABLE IF EXISTS shop.customers')
  await chExec(ch, 'CREATE TABLE shop.customers (customer_id UInt32, customer_name String, region LowCardinality(String), segment String, since Nullable(Date), score Nullable(Decimal(6, 2)), vip Bool, seen DateTime64(3), big UInt64) ENGINE = MergeTree ORDER BY customer_id')
  const rows = readFileSync(fixture('customers.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  const csv = rows.map((r, i) => [r[0], r[1], r[2], r[3], i % 5 ? new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10) : '\\N', i % 7 ? (i * 1.25).toFixed(2) : '\\N', i % 3 === 0 ? 'true' : 'false', `2024-03-0${(i % 9) + 1} 10:20:30.${String(i % 1000).padStart(3, '0')}`, String(2n ** 63n + BigInt(i))].join(',')).join('\n')
  await chExec(ch, 'INSERT INTO shop.customers FORMAT CSV', csv)
  return ch
}

/** Trino to test against: SV_TRINO_HOST, or a throwaway podman container (its built-in TPC-H catalog); null when neither. */
export async function startTrino(): Promise<Wh | null> {
  let tr: Wh
  if (process.env.SV_TRINO_HOST) tr = { host: process.env.SV_TRINO_HOST, port: Number(process.env.SV_TRINO_PORT ?? 8080), user: 'sv', password: '', database: 'tpch.tiny', stop() {} }
  else {
    if (!hasPodman() || process.env.SV_NO_PODMAN) return null
    const name = `sv-trino-${process.pid}-${Date.now()}`
    const port = 20000 + Math.floor(Math.random() * 20000)
    execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8080`, 'docker.io/trinodb/trino:470'], { stdio: 'ignore' })
    tr = { name, host: '127.0.0.1', port, user: 'sv', password: '', database: 'tpch.tiny', stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
  }
  // Ready when a query runs (the server answers before its worker has registered).
  const t0 = Date.now()
  for (;;) {
    try {
      let page = (await (await fetch(`http://${tr.host}:${tr.port}/v1/statement`, { method: 'POST', headers: { 'X-Trino-User': 'sv' }, body: 'SELECT count(*) FROM tpch.tiny.nation' })).json()) as { nextUri?: string; error?: { message: string } }
      while (page.nextUri && !page.error) page = (await (await fetch(page.nextUri)).json()) as typeof page
      if (!page.error) break
      if (Date.now() - t0 > 240_000) throw new Error(page.error.message)
    } catch (e) {
      if (Date.now() - t0 > 240_000) throw e
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return tr
}

export const whSource = (w: Wh, kind: 'clickhouse' | 'trino' | 'bigquery', tables: ResolvedSource['tables'], password = w.password): ResolvedSource => ({ id: `${kind}1`, kind, host: w.host, port: w.port, user: w.user, password, database: w.database, sslmode: 'disable', mode: 'extract', timeoutSec: 30, tables })

/**
 * The BigQuery emulator (goccy/bigquery-emulator, which serves the BigQuery REST API) in podman: project "sv",
 * dataset "shop" with customers, and 2,500 numbers (several result pages at the tests' page size). Null without podman.
 */
export async function startBigQuery(): Promise<Wh | null> {
  if (!hasPodman() || process.env.SV_NO_PODMAN) return null
  const dir = tmp('sv-bq-')
  const rows = readFileSync(fixture('customers.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  const yaml = [
    'projects:',
    '- id: sv',
    '  datasets:',
    '  - id: shop',
    '    tables:',
    '    - id: customers',
    '      columns:',
    ...[['customer_id', 'INTEGER'], ['customer_name', 'STRING'], ['region', 'STRING'], ['segment', 'STRING'], ['since', 'DATE'], ['score', 'FLOAT'], ['vip', 'BOOLEAN'], ['seen', 'TIMESTAMP']].flatMap(([n, t]) => [`      - name: ${n}`, `        type: ${t}`]),
    '      data:',
    ...rows.flatMap((r, i) => [`      - customer_id: ${r[0]}`, `        customer_name: "${r[1]}"`, `        region: "${r[2]}"`, `        segment: "${r[3]}"`, `        since: ${i % 5 ? `"${new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10)}"` : 'null'}`, `        score: ${i % 7 ? i * 1.25 : 'null'}`, `        vip: ${i % 3 === 0}`, `        seen: "2024-03-0${(i % 9) + 1}T10:20:30Z"`]),
    '    - id: numbers',
    '      columns:',
    '      - name: n',
    '        type: INTEGER',
    '      data:',
    ...Array.from({ length: 2_500 }, (_, i) => `      - n: ${i + 1}`)
  ].join('\n')
  writeFileSync(path.join(dir, 'data.yaml'), yaml + '\n')
  const name = `sv-bq-${process.pid}-${Date.now()}`
  const port = 20000 + Math.floor(Math.random() * 20000)
  execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:9050`, '-v', `${dir}:/work:Z`, 'ghcr.io/goccy/bigquery-emulator:0.6.6', '--project=sv', '--data-from-yaml=/work/data.yaml'], { stdio: 'ignore' })
  const bq: Wh = { name, host: '127.0.0.1', port, user: '', password: '', database: 'sv', stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
  const t0 = Date.now()
  for (;;) {
    try {
      const res = await fetch(`http://${bq.host}:${port}/bigquery/v2/projects/sv/datasets`)
      if (res.ok) break
    } catch {
      // not yet listening
    }
    if (Date.now() - t0 > 120_000) throw new Error('The BigQuery emulator did not start')
    await new Promise((r) => setTimeout(r, 1000))
  }
  return bq
}

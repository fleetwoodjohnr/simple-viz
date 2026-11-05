// Shared setup for integration tests: a real engine on temp folders, and PostgreSQL (CI service or a podman container).
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
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

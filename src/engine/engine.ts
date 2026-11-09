// The analytical engine: one DuckDB instance per open project, locked down so that SQL from users and project files
// can only read the project's own data. See docs/SECURITY.md for the threat model.
//
// Boot order matters. Everything that needs file or network access (extensions, the cache database, database
// attachments, secrets) happens first, from SQL this file writes; then the file-system allowlist is set and frozen
// (enable_external_access=false, lock_configuration=true). Changing the source list means booting a new instance.

import { DuckDBInstance, StatementType, type DuckDBConnection, type DuckDBResultReader } from '@duckdb/node-api'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ColumnInfo, EngineConfig, QueryResult, RelationInfo, ResolvedSource, ResultPage, SourceStatus } from '../shared/engine-protocol'
import { SERVER, isServer, isRemotePath } from '../shared/project'
import type { SheetFormat } from '../core/sheets/rows'
import { gateProblems, collectRefs, SAFE_TABLE_FUNCTIONS } from '../core/sql/ast'
import { explainError } from '../core/errors'
import { numberFromText } from '../core/profile'
import { MACROS } from '../core/calc/macros'
import { extractName, ident, isSafeType, lit, trimStatement } from './sql'
import { extractSelect, sourceStat, readBytes, fileTables, type Memo, type Stat } from './ingest'
import { sqlServerTables } from './sqlserver'

type Value = string | number | boolean | null

const MAX_RESULTS = 8
const DEFAULT_LIMIT = 1000

interface ResultEntry {
  table: string
  columns: ColumnInfo[]
  rowCount: number
}

interface Meta {
  size: number | null
  mtime: number | null
  fingerprint: string
  refreshedAt: number
  rows: number
}

export class GateError extends Error {}

export class Engine {
  private instance: DuckDBInstance | null = null
  private control: DuckDBConnection | null = null
  private config: EngineConfig | null = null
  private relations = new Map<string, RelationInfo>()
  private datasetErrors = new Map<string, string>()
  private running = new Map<number, DuckDBConnection>()
  /** Connections doing refresh work, interrupted when the engine closes. */
  private busy = new Set<DuckDBConnection>()
  private results = new Map<string, ResultEntry>()
  private resultSeq = 0
  private status = new Map<string, SourceStatus>()
  private attachFailed = new Set<string>()
  private refreshing: Promise<SourceStatus[]> | null = null
  private refreshAgain: { ids?: string[]; force?: boolean } | null = null
  private version = ''
  onStatus: (s: SourceStatus[]) => void = () => {}
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void = () => {}

  get booted() {
    return !!this.instance
  }

  // Renderer requests wait for the current (re)boot: a project's first boot, or a reboot after its sources changed.
  private bootDone!: () => void
  private bootWait: Promise<void> = new Promise((r) => (this.bootDone = r))
  whenReady(): Promise<void> {
    return this.bootWait
  }

  // ---------------------------------------------------------------- boot

  async boot(config: EngineConfig): Promise<void> {
    let done = this.bootDone
    if (this.instance) this.bootWait = new Promise((r) => (done = this.bootDone = r))
    try {
      await this.bootInner(config)
    } finally {
      done()
    }
  }

  /** Bumped by every boot; work started under an older generation is abandoned quietly (no errors recorded). */
  private gen = 0
  private openedProject: string | null = null

  /**
   * Sources to refresh right after a boot. Opening a project: those set to refresh on open (and any never extracted).
   * Reconfiguring the open project (a source or dataset added): only sources with tables not extracted yet.
   */
  bootRefreshIds(): string[] {
    const cfg = this.config!
    const first = this.openedProject !== cfg.projectId
    this.openedProject = cfg.projectId
    const missing = (s: ResolvedSource) => s.tables.some((t) => !this.metaCache.has(extractName(s.id, t.ref)))
    // Sources in error are retried on every boot (a fixed password, path or host takes effect at once).
    return cfg.sources.filter((s) => (first && s.onOpen !== false) || this.status.get(s.id)?.state === 'error' || (s.mode === 'extract' || s.kind === 'file' ? missing(s) : first)).map((s) => s.id)
  }

  private async bootInner(config: EngineConfig): Promise<void> {
    this.gen++
    this.refreshAgain = null
    // Another project: forget the previous one's source states.
    if (this.config?.projectId !== config.projectId) this.status.clear()
    for (const id of [...this.status.keys()]) if (!config.sources.some((s) => s.id === id)) this.status.delete(id)
    // A refresh of the previous configuration stops at its next step (its connections are interrupted); close waits.
    await this.close()
    this.config = config
    this.attachFailed.clear()
    const cacheDir = path.resolve(config.cacheDir)
    const tmp = path.join(cacheDir, 'tmp')
    const out = path.join(cacheDir, 'out')
    mkdirSync(tmp, { recursive: true })
    mkdirSync(out, { recursive: true })

    const memoryLimit = config.memoryLimit && /^\d{1,6}(MB|GB)$/.test(config.memoryLimit) ? config.memoryLimit : `${Math.max(1, Math.floor((os.totalmem() * 0.4) / 2 ** 30))}GB`
    const instance = await DuckDBInstance.create(':memory:', {
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_community_extensions: 'false',
      memory_limit: memoryLimit,
      temp_directory: tmp
    })
    this.instance = instance
    const c = await instance.connect()
    this.control = c
    this.version = String((await c.runAndReadAll('SELECT version()')).getRows()[0][0])

    // 1. Extensions, from the app's own resources (never downloaded).
    const kinds = new Set(config.sources.map((s) => s.kind))
    const exts = [...(kinds.has('postgres') ? ['postgres_scanner'] : []), ...(kinds.has('mysql') ? ['mysql_scanner'] : []), ...(kinds.has('sqlite') ? ['sqlite_scanner'] : [])]
    for (const e of [...exts, ...remoteExtensions(config.sources)]) {
      if (!config.extensionsDir) throw new Error(`The ${e} extension is not bundled with this build.`)
      await c.run(`LOAD ${lit(path.join(config.extensionsDir, `${e}.duckdb_extension`))}`)
    }
    // Secrets live only in memory: never DuckDB's own secret folder (~/.duckdb), which the lockdown would refuse
    // anyway. Initialised now, once, rather than lazily by the first remote read (after lockdown, possibly twice).
    await c.run('SET allow_persistent_secrets = false')
    await c.run('FROM duckdb_secrets()')
    for (const s of config.sources) if (isRemotePath(s.path)) await remoteSecret(c, s)

    // 2. The cache: extracts of every source table, also the last-known-good copy when a refresh fails.
    const cacheFile = path.join(cacheDir, `${config.projectId.replace(/[^A-Za-z0-9_-]/g, '')}.duckdb`)
    try {
      await c.run(`ATTACH ${lit(cacheFile)} AS cache`)
    } catch (e) {
      // Another window has this project open (DuckDB locks the file): work from a private, empty cache.
      this.onLog('warn', `Cache in use, using a temporary one: ${(e as Error).message}`)
      await c.run(`ATTACH ${lit(path.join(tmp, `${config.projectId}-${process.pid}-${Date.now()}.duckdb`))} AS cache`)
    }
    await c.run('CREATE TABLE IF NOT EXISTS cache.main.__meta (key VARCHAR PRIMARY KEY, size BIGINT, mtime DOUBLE, fingerprint VARCHAR, refreshed_at BIGINT, rows BIGINT)')
    await c.run('CREATE SCHEMA IF NOT EXISTS memory.results')
    for (const m of MACROS) await c.run(m.sql)

    // 3. Databases: credentials go into temporary secrets, never into connection strings or files.
    let pgTimeout = 0
    for (const s of config.sources) {
      if (isServer(s.kind)) {
        if (s.kind === 'postgres') pgTimeout = Math.max(pgTimeout, s.timeoutSec * 1000)
        try {
          await this.attachServer(c, s)
        } catch (e) {
          this.attachFailed.add(s.id)
          this.setStatus(s.id, { state: 'error', error: explainError(e, s), auth: isAuthError(e) })
        }
      } else if (s.kind === 'sqlite' && s.path) {
        await c.run(`ATTACH ${lit(s.path)} AS ${ident(`db_${s.id}`)} (TYPE sqlite, READ_ONLY)`).catch((e) => {
          this.attachFailed.add(s.id)
          this.setStatus(s.id, { state: 'error', error: explainError(e, { path: s.path }) })
        })
      }
    }
    if (pgTimeout) await c.run(`SET pg_statement_timeout_millis = ${Math.round(pgTimeout)}`).catch(() => {})

    // 4. Lock down: user SQL may touch only the project's files and the cache directory, and can change no setting.
    // A DuckDB database file is opened together with its write-ahead log.
    // A remote file is allowed by its exact URL: no other address can be read.
    const files = config.sources.filter((s) => s.path).flatMap((s) => (isRemotePath(s.path) ? [s.path!] : s.kind === 'duckdb' ? [path.resolve(s.path!), `${path.resolve(s.path!)}.wal`] : [path.resolve(s.path!)]))
    await c.run(`SET allowed_directories = [${[cacheDir + path.sep].map(lit).join(', ')}]`)
    if (files.length) await c.run(`SET allowed_paths = [${files.map(lit).join(', ')}]`)
    await c.run('SET enable_external_access = false')
    await c.run('SET lock_configuration = true')

    await this.loadMeta()
    await this.seedPackaged(c, config)
    await this.syncViews()
  }

  /** Tables of a portable project with no cached copy yet start from the data packaged with it. */
  private async seedPackaged(c: DuckDBConnection, config: EngineConfig) {
    const cacheDir = path.resolve(config.cacheDir) + path.sep
    for (const s of config.sources)
      for (const t of s.tables) {
        const file = config.packaged?.[`${s.id}__${t.alias}`]
        const name = extractName(s.id, t.ref)
        if (!file || this.metaCache.has(name) || !path.resolve(file).startsWith(cacheDir)) continue
        try {
          await c.run(`CREATE OR REPLACE TABLE cache.main.${ident(name)} AS SELECT * FROM read_parquet(${lit(path.resolve(file))})`)
          const [n, fp] = (await c.runAndReadAll(`SELECT count(*)::BIGINT, coalesce(sum(hash(t)), 0)::VARCHAR FROM cache.main.${ident(name)} t`)).getRows()[0]
          const meta: Meta = { size: null, mtime: null, fingerprint: `${this.version}:${String(n)}:${String(fp)}`, refreshedAt: Date.now(), rows: Number(n) }
          await c.run(`INSERT OR REPLACE INTO cache.main.__meta VALUES (${lit(name)}, NULL, NULL, ${lit(meta.fingerprint)}, ${meta.refreshedAt}, ${meta.rows})`)
          this.metaCache.set(name, meta)
        } catch (e) {
          this.onLog('warn', `Packaged data for ${t.alias} couldn’t be read: ${(e as Error).message}`)
        }
      }
  }

  /** Each table's cached copy as Parquet in the staging folder (for a portable package). */
  async packageTables(tables: { sourceId: string; ref?: string; alias: string }[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const dir = path.join(path.resolve(this.config!.cacheDir), 'out')
    for (const t of tables) {
      const name = extractName(t.sourceId, t.ref)
      if (!this.metaCache.has(name)) continue
      const key = `${t.sourceId}__${t.alias}`
      if (!/^[A-Za-z0-9_-]+$/.test(key)) continue
      const file = path.join(dir, `pkg-${process.pid}-${Date.now()}-${key}.parquet`)
      await this.conn().run(`COPY (SELECT * FROM cache.main.${ident(name)}) TO ${lit(file)} (FORMAT parquet, COMPRESSION zstd)`)
      out[key] = file
    }
    return out
  }

  private async attachServer(c: DuckDBConnection, s: ResolvedSource) {
    // SQL Server isn't attached: each refresh reads it with its own driver (extract only).
    if (s.kind === 'sqlserver') return
    return s.kind === 'mysql' ? this.attachMysql(c, s) : this.attachPostgres(c, s)
  }

  /** MySQL / MariaDB: the same pattern, a temporary secret and a read-only attachment. */
  private async attachMysql(c: DuckDBConnection, s: ResolvedSource) {
    const secret = ident(`my_${s.id}`)
    const ssl = { disable: 'disabled', prefer: 'preferred', require: 'required', 'verify-full': 'verify_identity' }[s.sslmode ?? 'prefer'] ?? 'preferred'
    const parts = [`TYPE mysql`, `HOST ${lit(s.host ?? 'localhost')}`, `PORT ${Number(s.port) || 3306}`, `USER ${lit(s.user ?? '')}`, `SSL_MODE ${lit(ssl)}`]
    if (s.database) parts.push(`DATABASE ${lit(s.database)}`)
    if (s.password) parts.push(`PASSWORD ${lit(s.password)}`)
    await c.run(`CREATE OR REPLACE TEMPORARY SECRET ${secret} (${parts.join(', ')})`)
    await c.run(`ATTACH '' AS ${ident(`db_${s.id}`)} (TYPE mysql, SECRET ${secret}, READ_ONLY)`)
  }

  private async attachPostgres(c: DuckDBConnection, s: ResolvedSource) {
    const secret = ident(`pg_${s.id}`)
    const parts = [`TYPE postgres`, `HOST ${lit(s.host ?? 'localhost')}`, `PORT ${Number(s.port) || 5432}`, `DATABASE ${lit(s.database ?? 'postgres')}`, `USER ${lit(s.user ?? '')}`]
    if (s.password) parts.push(`PASSWORD ${lit(s.password)}`)
    await c.run(`CREATE OR REPLACE TEMPORARY SECRET ${secret} (${parts.join(', ')})`)
    // libpq options that secrets don't carry. No password here: duckdb_databases() shows this string.
    const conn = [`connect_timeout=${Math.max(1, Math.round(s.timeoutSec))}`, `sslmode=${s.sslmode ?? 'prefer'}`, `application_name=SimpleViz`].join(' ')
    await c.run(`ATTACH ${lit(conn)} AS ${ident(`db_${s.id}`)} (TYPE postgres, SECRET ${secret}, READ_ONLY)`)
  }

  /** Engine work a reboot must wait for (renderer requests, exports). */
  private inflight = new Set<Promise<unknown>>()
  work<T>(f: () => Promise<T>): Promise<T> {
    const p = f()
    this.inflight.add(p)
    p.then(() => this.inflight.delete(p), () => this.inflight.delete(p))
    return p
  }

  async close() {
    // Interrupted work ends asynchronously. Closing the instance under it aborts the whole process (DuckDB's binding
    // throws a Napi::Error from a native callback, which nothing can catch), so wait for it, interrupting again
    // anything that started in the meantime.
    do {
      for (const conn of [...this.running.values(), ...this.busy]) conn.interrupt()
      await Promise.race([Promise.allSettled([...this.inflight, this.refreshing]), new Promise((r) => setTimeout(r, 50))])
    } while (this.inflight.size || this.refreshing)
    this.running.clear()
    this.busy.clear()
    this.results.clear()
    this.relations.clear()
    this.control?.closeSync()
    this.control = null
    this.instance?.closeSync()
    this.instance = null
  }

  private conn(): DuckDBConnection {
    if (!this.control) throw new Error('The engine is not running.')
    return this.control
  }

  private async connect(): Promise<DuckDBConnection> {
    if (!this.instance) throw new Error('The engine is not running.')
    return this.instance.connect()
  }

  // ---------------------------------------------------------------- relations

  /** Recreates every alias view (over extracts or live tables) and every dataset view, in dependency order. */
  private async syncViews() {
    const c = this.conn()
    const cfg = this.config!
    // Built aside and swapped in at the end: queries running meanwhile keep seeing the previous list.
    const next = new Map<string, RelationInfo>()
    // Which extracts exist comes from the cache's own metadata: catalog functions like duckdb_tables() would also
    // query every attached database, and fail while one is unreachable.
    const existing = new Set(this.metaCache.keys())
    for (const s of cfg.sources) {
      for (const t of s.tables) {
        let from: string | null = null
        let kind: RelationInfo['kind'] = 'extract'
        if (s.mode === 'live' && s.kind !== 'file' && s.kind !== 'duckdb' && !this.attachFailed.has(s.id)) {
          const [schema, table] = splitRef(t.ref, s)
          from = `${ident(`db_${s.id}`)}.${schema ? `${ident(schema)}.` : ''}${ident(table)}`
          kind = 'live'
        } else {
          const name = extractName(s.id, t.ref)
          if (existing.has(name)) from = `cache.main.${ident(name)}`
        }
        if (!from) continue
        const casts = Object.entries(t.types ?? {}).map(([col, ty]) => [col, castExpr(col, ty)]).filter((x): x is [string, string] => !!x[1])
        const select = casts.length ? `SELECT * REPLACE (${casts.map(([col, e]) => `${e} AS ${ident(col)}`).join(', ')}) FROM ${from}` : `SELECT * FROM ${from}`
        try {
          await c.run(`CREATE OR REPLACE VIEW memory.main.${ident(t.alias)} AS ${select}`)
          next.set(t.alias.toLowerCase(), { name: t.alias, kind, columns: [], source: s.id })
        } catch (e) {
          this.setStatus(s.id, { state: 'error', error: explainError(e, s) })
        }
      }
    }
    const errors = await this.syncDatasets(next)
    await this.describeColumns(next, errors)
    this.relations = next
    this.datasetErrors = errors
  }

  private async syncDatasets(next: Map<string, RelationInfo>): Promise<Map<string, string>> {
    const c = this.conn()
    const errors = new Map<string, string>()
    // Views bind when created, so a dataset can only be created after those it reads: retry until no progress.
    let pending = [...this.config!.datasets]
    for (let pass = 0; pending.length && pass <= this.config!.datasets.length; pass++) {
      const retry: typeof pending = []
      for (const d of pending) {
        try {
          const sql = await this.gate(d.sql, d.name, next)
          await c.run(`CREATE OR REPLACE VIEW memory.main.${ident(d.name)} AS (\n${sql}\n)`)
          next.set(d.name.toLowerCase(), { name: d.name, kind: 'dataset', columns: [] })
          errors.delete(d.name)
        } catch (e) {
          errors.set(d.name, e instanceof GateError ? e.message : explainError(e))
          retry.push(d)
        }
      }
      if (retry.length === pending.length) break
      pending = retry
    }
    for (const d of pending) await c.run(`DROP VIEW IF EXISTS memory.main.${ident(d.name)}`).catch(() => {})
    return errors
  }

  /** Column names and types of every relation, from preparing a SELECT on each (live tables ask their server). */
  private async describeColumns(next: Map<string, RelationInfo>, errors: Map<string, string>) {
    const c = this.conn()
    for (const [key, r] of next) {
      try {
        const p = await c.prepare(`SELECT * FROM memory.main.${ident(r.name)}`)
        r.columns = Array.from({ length: p.columnCount }, (_, i) => ({ name: p.columnName(i), type: p.columnType(i).toString() }))
      } catch (e) {
        next.delete(key)
        if (r.source) this.setStatus(r.source, { state: 'error', error: explainError(e, this.config!.sources.find((s) => s.id === r.source)) })
        else errors.set(r.name, explainError(e))
      }
    }
  }

  describe(): { relations: RelationInfo[]; datasetErrors: Record<string, string>; deps: Record<string, string[]> } {
    return { relations: [...this.relations.values()], datasetErrors: Object.fromEntries(this.datasetErrors), deps: this.deps }
  }

  private deps: Record<string, string[]> = {}

  // ---------------------------------------------------------------- the gate

  /**
   * Checks that `sql` is one SELECT reading only the project's relations, and returns it ready to run. Everything
   * user-written goes through here: editor queries, dataset definitions, compiled chart queries.
   */
  async gate(sql: string, datasetName?: string, relationMap: Map<string, RelationInfo> = this.relations): Promise<string> {
    const text = trimStatement(sql)
    const c = this.conn()
    let ex
    try {
      ex = await c.extractStatements(text)
    } catch (e) {
      throw new GateError(explainError(e))
    }
    if (ex.count === 0) throw new GateError('There is no query to run.')
    if (ex.count > 1) throw new GateError('Run one statement at a time.')
    const r = await c.runAndReadAll(`SELECT json_serialize_sql(${lit(text)})`)
    const json = JSON.parse(String(r.getRows()[0][0])) as { error: boolean; error_message?: string; statements?: unknown }
    if (json.error) {
      if (/Only SELECT statements/i.test(json.error_message ?? '')) throw new GateError('Only queries that read data (SELECT) can run in Simple Viz. Your data sources are never changed.')
      throw new GateError(explainError(json.error_message))
    }
    const relations = new Set(relationMap.keys())
    if (datasetName) relations.delete(datasetName.toLowerCase())
    const problems = gateProblems(json.statements, { relations, tableFunctions: SAFE_TABLE_FUNCTIONS })
    if (problems.length) throw new GateError(problems.join(' '))
    const p = await ex.prepare(0).catch((e) => {
      throw new GateError(explainError(e))
    })
    if (p.statementType !== StatementType.SELECT) throw new GateError('Only queries that read data (SELECT) can run in Simple Viz.')
    if (datasetName) this.deps[datasetName] = [...new Set(collectRefs(json.statements).tables.map((t) => t.name.toLowerCase()))]
    return text
  }

  // ---------------------------------------------------------------- queries

  async query(id: number, sql: string, opts: { params?: Record<string, Value>; keep?: boolean; limit?: number } = {}): Promise<QueryResult> {
    const text = await this.gate(sql)
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, 100_000)
    const conn = await this.connect()
    this.running.set(id, conn)
    const t0 = performance.now()
    try {
      if (opts.keep) {
        const table = `r${++this.resultSeq}`
        const p = await conn.prepare(`CREATE TABLE memory.results.${table} AS (\n${text}\n)`)
        bindParams(p, opts.params)
        await p.run()
        const ms = performance.now() - t0
        const rowCount = Number((await conn.runAndReadAll(`SELECT count(*) FROM memory.results.${table}`)).getRows()[0][0])
        const first = await readPage(conn, `SELECT * FROM memory.results.${table} LIMIT ${limit}`)
        this.results.set(table, { table, columns: first.columns, rowCount })
        await this.trimResults(conn)
        return { ...first, resultId: table, rowCount, ms }
      }
      const p = await conn.prepare(text)
      bindParams(p, opts.params)
      const reader = await p.runAndReadUntil(limit + 1)
      const page = toPage(reader, 0, limit)
      return { ...page, rowCount: reader.currentRowCount > limit ? limit + 1 : page.rows.length, ms: performance.now() - t0 }
    } catch (e) {
      throw new Error(explainError(e))
    } finally {
      this.running.delete(id)
      conn.closeSync()
    }
  }

  private async trimResults(conn: DuckDBConnection) {
    while (this.results.size > MAX_RESULTS) {
      const oldest = this.results.keys().next().value!
      await this.release(oldest, conn)
    }
  }

  async page(resultId: string, offset: number, limit: number): Promise<ResultPage> {
    const r = this.results.get(resultId)
    if (!r) throw new Error('That result is no longer available. Run the query again.')
    return readPage(this.conn(), `SELECT * FROM memory.results.${r.table} LIMIT ${Math.min(limit, 10_000)} OFFSET ${offset}`, offset)
  }

  async release(resultId: string, conn = this.conn()) {
    if (!this.results.delete(resultId)) return
    await conn.run(`DROP TABLE IF EXISTS memory.results.${ident(resultId)}`)
  }

  /** Runs SQL without the gate. For the sandbox tests only (they check the DuckDB lockdown on its own); no port reaches it. */
  async _ungated(sql: string) {
    return (await this.conn().runAndReadAll(sql)).getRowsJson()
  }

  cancel(id: number) {
    this.running.get(id)?.interrupt()
  }

  async explain(sql: string): Promise<string> {
    const text = await this.gate(sql)
    const rows = (await this.conn().runAndReadAll(`EXPLAIN ${text}`)).getRows()
    return rows.map((r) => String(r[1] ?? r[0])).join('\n')
  }

  /** Copies a query's result to a file in the cache's export staging folder; main moves it where the user chose. */
  async exportTo(sql: string, format: 'csv' | 'parquet', file: string): Promise<string> {
    const text = await this.gate(sql)
    const target = path.join(path.resolve(this.config!.cacheDir), 'out', path.basename(file))
    await this.conn().run(`COPY (\n${text}\n) TO ${lit(target)} (FORMAT ${format}${format === 'csv' ? ', HEADER' : ''})`)
    return target
  }

  // ---------------------------------------------------------------- refresh

  private metaCache = new Map<string, Meta>()

  private async loadMeta() {
    this.metaCache.clear()
    const rows = (await this.conn().runAndReadAll('SELECT key, size, mtime, fingerprint, refreshed_at, rows FROM cache.main.__meta')).getRows()
    for (const [key, size, mtime, fp, at, n] of rows) this.metaCache.set(String(key), { size: size === null ? null : Number(size), mtime: mtime === null ? null : Number(mtime), fingerprint: String(fp), refreshedAt: Number(at), rows: Number(n) })
    for (const s of this.config!.sources) {
      const metas = s.tables.map((t) => this.metaCache.get(extractName(s.id, t.ref)))
      const at = metas.every(Boolean) ? Math.min(...metas.map((m) => m!.refreshedAt)) : null
      const prev = this.status.get(s.id)
      // A reboot of the same project keeps each source's state; a new one starts from the cache, marked stale.
      if (!prev) this.status.set(s.id, { id: s.id, state: 'stale', refreshedAt: at, rows: metas.reduce((n, m) => n + (m?.rows ?? 0), 0) })
      else prev.refreshedAt ??= at
    }
  }

  statuses(): SourceStatus[] {
    return [...this.status.values()]
  }

  private setStatus(id: string, patch: Partial<SourceStatus>) {
    const prev = this.status.get(id) ?? { id, state: 'stale' as const, refreshedAt: null }
    this.status.set(id, { ...prev, ...patch, id })
  }

  /**
   * Brings extracts up to date. Single-flight: a call while a refresh runs waits for it, then runs once more.
   * A source that fails keeps its last good extract and is marked with the error.
   */
  async refresh(ids?: string[], force = false): Promise<SourceStatus[]> {
    // Wait for any boot in progress, including one that starts while we wait.
    for (let w = this.bootWait; ; w = this.bootWait) {
      await w
      if (w === this.bootWait) break
    }
    if (this.refreshing) {
      const prev = this.refreshAgain
      // Queue one more round covering what was asked for (undefined ids: every source).
      const all = !ids || (prev !== null && !prev.ids)
      this.refreshAgain = { ids: all ? undefined : [...new Set([...(prev?.ids ?? []), ...ids!])], force: force || !!prev?.force }
      await this.refreshing.catch(() => {})
      if (this.refreshing) return this.refreshing
    }
    if (this.attachFailed.size && (!ids || ids.some((i) => this.attachFailed.has(i)))) {
      // A database that was down at boot can only be attached by a new instance (the configuration is locked).
      await this.boot(this.config!)
    }
    const run = this.refreshOnce(ids, force)
    this.refreshing = run
    try {
      return await run
    } finally {
      this.refreshing = null
      const again = this.refreshAgain
      this.refreshAgain = null
      if (again) void this.refresh(again.ids, again.force)
    }
  }

  private async refreshOnce(ids: string[] | undefined, force: boolean): Promise<SourceStatus[]> {
    const cfg = this.config!
    const gen = this.gen
    // A database that could not be attached keeps its error (and its last good extract) until the next boot.
    const targets = cfg.sources.filter((s) => (!ids || ids.includes(s.id)) && !this.attachFailed.has(s.id))
    for (const s of targets) this.setStatus(s.id, { state: 'checking' })
    this.onStatus(this.statuses())
    let anyChanged = false
    // A source with new data is reported as still checking until the views over it are rebuilt (after every source):
    // the page describes the relations when a source turns ok, and must not do so before they include it.
    const held = new Set<string>()
    const emit = () => this.onStatus(this.statuses().map((x) => (held.has(x.id) ? { ...x, state: 'checking' as const } : x)))
    // At most two sources extract at a time, so a slow database doesn't hold up local files.
    const queue = [...targets]
    const worker = async () => {
      for (let s = queue.shift(); s && gen === this.gen; s = queue.shift()) {
        const changed = await this.refreshSource(s, force, gen)
        if (changed) held.add(s.id)
        anyChanged ||= changed
        emit()
      }
    }
    await Promise.all([worker(), worker()])
    if (gen !== this.gen) return this.statuses()
    if (anyChanged) {
      await this.syncViews()
      this.onStatus(this.statuses())
    }
    return this.statuses()
  }

  private async refreshSource(s: ResolvedSource, force: boolean, gen = this.gen): Promise<boolean> {
    if (this.attachFailed.has(s.id)) return false
    let stat: Stat | null = null
    try {
      stat = await sourceStat(s)
      // A file whose size and modification time are unchanged since the last refresh is not read again.
      const metas = s.tables.map((t) => this.metaCache.get(extractName(s.id, t.ref)))
      if (!force && stat && metas.every((m) => m && m.size === stat!.size && m.mtime === stat!.mtime)) {
        this.setStatus(s.id, { state: 'ok', changed: false, error: undefined })
        return false
      }
      if (s.mode === 'live' && s.kind !== 'file' && s.kind !== 'duckdb') {
        this.setStatus(s.id, { state: 'ok', changed: true, refreshedAt: Date.now(), error: undefined })
        return true
      }
      let changed = false
      let rows = 0
      const conn = await this.connect()
      this.busy.add(conn)
      const timer = setTimeout(() => conn.interrupt(), Math.max(5, s.timeoutSec) * 1000)
      try {
        const cleanup: string[] = []
        if (s.kind === 'duckdb') {
          await conn.run(`ATTACH ${lit(s.path!)} AS ${ident(`db_${s.id}`)} (READ_ONLY)`)
          cleanup.push(`DETACH ${ident(`db_${s.id}`)}`)
        }
        try {
          const memo: Memo = {}
          for (const t of s.tables) {
            const r = await this.extractTable(conn, s, t.ref, stat, memo)
            changed ||= r.changed
            rows += r.rows
          }
        } finally {
          for (const sql of cleanup) await conn.run(sql).catch(() => {})
        }
      } finally {
        clearTimeout(timer)
        this.busy.delete(conn)
        conn.closeSync()
      }
      this.setStatus(s.id, { state: 'ok', changed, rows, refreshedAt: Date.now(), error: undefined, auth: undefined })
      return changed
    } catch (e) {
      if (gen !== this.gen) return false
      this.onLog('error', `Refresh of ${s.id} failed: ${(e as Error).message}`)
      this.setStatus(s.id, { state: 'error', error: explainError(e, s), auth: isAuthError(e) })
      return false
    }
  }

  /** Extracts one table in a transaction; rolls back when the data is identical, so nothing downstream changes. */
  private async extractTable(conn: DuckDBConnection, s: ResolvedSource, ref: string | undefined, stat: Stat | null, memo: Memo): Promise<{ changed: boolean; rows: number }> {
    const name = extractName(s.id, ref)
    const target = `cache.main.${ident(name)}`
    const { select, cleanup } = await extractSelect(conn, s, ref, memo)
    try {
      await conn.run('BEGIN TRANSACTION')
      try {
        await conn.run(`CREATE OR REPLACE TABLE ${target} AS ${select}`)
        const [n, fp] = (await conn.runAndReadAll(`SELECT count(*)::BIGINT, coalesce(sum(hash(t)), 0)::VARCHAR FROM ${target} t`)).getRows()[0]
        const fingerprint = `${this.version}:${String(n)}:${String(fp)}`
        const prev = this.metaCache.get(name)
        const changed = prev?.fingerprint !== fingerprint
        if (changed) await conn.run('COMMIT')
        else await conn.run('ROLLBACK')
        const meta: Meta = { size: stat?.size ?? null, mtime: stat?.mtime ?? null, fingerprint, refreshedAt: Date.now(), rows: Number(n) }
        await conn.run(`INSERT OR REPLACE INTO cache.main.__meta VALUES (${lit(name)}, ${meta.size ?? 'NULL'}, ${meta.mtime ?? 'NULL'}, ${lit(fingerprint)}, ${meta.refreshedAt}, ${meta.rows})`)
        this.metaCache.set(name, meta)
        return { changed, rows: meta.rows }
      } catch (e) {
        await conn.run('ROLLBACK').catch(() => {})
        throw e
      }
    } finally {
      await cleanup()
    }
  }

  /** Lists the tables a database source offers (connection dialog), from a short-lived instance. */
  static async probe(s: ResolvedSource, extensionsDir: string | null): Promise<{ tables: string[] }> {
    const inst = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
    const c = await inst.connect()
    try {
      if (s.kind === 'sqlserver') {
        return { tables: await sqlServerTables(s) }
      } else if (isServer(s.kind)) {
        const ext = s.kind === 'mysql' ? 'mysql_scanner' : 'postgres_scanner'
        if (!extensionsDir) throw new Error(`The ${SERVER[s.kind].label} extension is not bundled with this build.`)
        await c.run(`LOAD ${lit(path.join(extensionsDir, `${ext}.duckdb_extension`))}`)
        await new Engine().attachServer(c, s)
      } else if (s.kind === 'sqlite') {
        if (!extensionsDir) throw new Error('The SQLite extension is not bundled with this build.')
        await c.run(`LOAD ${lit(path.join(extensionsDir, 'sqlite_scanner.duckdb_extension'))}`)
        await c.run(`ATTACH ${lit(s.path!)} AS ${ident(`db_${s.id}`)} (TYPE sqlite, READ_ONLY)`)
      } else if (s.kind === 'duckdb') {
        await c.run(`ATTACH ${lit(s.path!)} AS ${ident(`db_${s.id}`)} (READ_ONLY)`)
      } else if (s.kind === 'file' && isRemotePath(s.path)) {
        // A file on the web or in cloud storage: can it be read, and what tables does it hold?
        for (const e of remoteExtensions([s])) {
          if (!extensionsDir) throw new Error(`The ${e} extension is not bundled with this build.`)
          await c.run(`LOAD ${lit(path.join(extensionsDir, `${e}.duckdb_extension`))}`)
        }
        await remoteSecret(c, s)
        if (s.format === 'xlsx' || s.format === 'xls' || s.format === 'ods' || s.format === 'xml2003') return { tables: (await fileTables(await readBytes(c, s.path!), s.format as SheetFormat)).map((t) => t.ref) }
        const { select } = await extractSelect(c, s, undefined)
        await c.run(`DESCRIBE ${select}`)
        return { tables: [decodeURIComponent(s.path!.split(/[/?#]/).filter(Boolean).pop() ?? 'data').replace(/\.[a-z0-9]+$/i, '')] }
      }
      const rows = (await c.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${lit(`db_${s.id}`)} UNION ALL SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = ${lit(`db_${s.id}`)} AND NOT internal ORDER BY 1, 2`)).getRows()
      return { tables: rows.map(([sch, t]) => (isServer(s.kind) || (s.kind === 'duckdb' && sch !== 'main') ? `${sch}.${t}` : String(t))) }
    } catch (e) {
      throw new Error(explainError(e, s))
    } finally {
      c.closeSync()
      inst.closeSync()
    }
  }
}

/** The expression applying a user's type correction to a column (null for an unknown type name). */
function castExpr(col: string, ty: string): string | null {
  const t = ty.trim().toUpperCase()
  if (t === 'CURRENCY') return numberFromText(col)
  if (t === 'DATE_MDY') return `coalesce(TRY_CAST(${ident(col)} AS DATE), CAST(TRY_STRPTIME(CAST(${ident(col)} AS VARCHAR), '%m/%d/%Y') AS DATE))`
  if (t === 'DATE_DMY') return `coalesce(TRY_CAST(${ident(col)} AS DATE), CAST(TRY_STRPTIME(CAST(${ident(col)} AS VARCHAR), '%d/%m/%Y') AS DATE))`
  return isSafeType(t) ? `TRY_CAST(${ident(col)} AS ${t})` : null
}

const isAuthError = (e: unknown) => /password authentication failed|no password supplied|authentication failed|password is required|Access denied for user|Login failed for user/i.test(String((e as Error)?.message ?? e))

function splitRef(ref: string | undefined, s: ResolvedSource): [string | null, string] {
  const r = ref ?? ''
  const dot = r.indexOf('.')
  if (s.kind === 'postgres') return dot > 0 ? [r.slice(0, dot), r.slice(dot + 1)] : ['public', r]
  // MySQL: schemas are databases.
  if (s.kind === 'mysql') return dot > 0 ? [r.slice(0, dot), r.slice(dot + 1)] : [s.database || null, r]
  return [null, r]
}

function bindParams(p: { parameterCount: number; parameterName(i: number): string; bindValue(i: number, v: never): void; bindNull(i: number): void; bindVarchar(i: number, v: string): void; bindDouble(i: number, v: number): void; bindBoolean(i: number, v: boolean): void; bindBigInt(i: number, v: bigint): void }, params?: Record<string, Value>) {
  for (let i = 1; i <= p.parameterCount; i++) {
    const name = p.parameterName(i)
    if (!params || !(name in params)) throw new Error(`No value was given for the parameter $${name}.`)
    const v = params[name]
    if (v === null) p.bindNull(i)
    else if (typeof v === 'boolean') p.bindBoolean(i, v)
    else if (typeof v === 'number') Number.isSafeInteger(v) ? p.bindBigInt(i, BigInt(v)) : p.bindDouble(i, v)
    else p.bindVarchar(i, v)
  }
}

async function readPage(conn: DuckDBConnection, sql: string, offset = 0): Promise<ResultPage> {
  const reader = await conn.runAndReadAll(sql)
  return toPage(reader, offset, Infinity)
}

/** JSON-safe values; integers and decimals become numbers when that loses nothing a chart or grid would show. */
export function toPage(reader: DuckDBResultReader, offset: number, limit: number): ResultPage {
  const columns = reader.columnNames().map((name, i) => ({ name, type: reader.columnType(i).toString() }))
  const numeric = columns.map((c) => /^(BIGINT|HUGEINT|UBIGINT|UHUGEINT|DECIMAL)/.test(c.type))
  const rows = reader.getRowsJson().slice(0, limit) as Value[][]
  for (const row of rows)
    for (let i = 0; i < row.length; i++) {
      const v = row[i]
      if (numeric[i] && typeof v === 'string') {
        const n = Number(v)
        if (Number.isFinite(n) && (columns[i].type.startsWith('DECIMAL') || Number.isSafeInteger(n))) row[i] = n
      }
    }
  return { columns, rows, offset }
}


/** Extensions remote files need: httpfs (web, S3 and compatible), azure (Azure Blob / Data Lake). */
function remoteExtensions(sources: ResolvedSource[]): string[] {
  const remote = sources.filter((s) => isRemotePath(s.path))
  return [...(remote.some((s) => !/^(az|azure|abfss):/i.test(s.path!)) ? ['httpfs'] : []), ...(remote.some((s) => /^(az|azure|abfss):/i.test(s.path!)) ? ['azure'] : [])]
}

/** Credentials for one remote file, as a temporary secret scoped to its URL (nothing is written to disk). */
async function remoteSecret(c: DuckDBConnection, s: ResolvedSource) {
  const r = s.remote
  if (!r) return
  const name = ident(`rs_${s.id}`)
  const scope = `SCOPE ${lit(s.path!)}`
  if (r.provider === 's3' && (r.keyId || r.region || r.endpoint)) {
    const parts = ['TYPE s3', scope]
    if (r.keyId) parts.push(`KEY_ID ${lit(r.keyId)}`)
    if (s.password) parts.push(`SECRET ${lit(s.password)}`)
    if (r.region) parts.push(`REGION ${lit(r.region)}`)
    if (r.endpoint) parts.push(`ENDPOINT ${lit(r.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, ''))}`, `USE_SSL ${r.useSsl === false || /^http:\/\//.test(r.endpoint) ? 'false' : 'true'}`)
    if (r.urlStyle) parts.push(`URL_STYLE ${lit(r.urlStyle)}`)
    await c.run(`CREATE OR REPLACE TEMPORARY SECRET ${name} (${parts.join(', ')})`)
  } else if (r.provider === 'azure' && s.password) {
    await c.run(`CREATE OR REPLACE TEMPORARY SECRET ${name} (TYPE azure, CONNECTION_STRING ${lit(s.password)}, ${scope})`)
  } else if (r.provider === 'http' && s.password) {
    await c.run(`CREATE OR REPLACE TEMPORARY SECRET ${name} (TYPE http, BEARER_TOKEN ${lit(s.password)}, ${scope})`)
  }
}

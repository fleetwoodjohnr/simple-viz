// ODBC: any database with a driver, read through DuckDB's odbc_scanner in an instance of its own. Checked against
// PostgreSQL through its ODBC driver (psqlodbc) where both exist; skipped (and reported) otherwise. SAP HANA and
// Teradata share this path with their vendors' drivers, which can't be installed here: their connection strings and
// the "no driver" message are checked, not the databases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { Engine } from '../../src/engine/engine'
import { odbcConnString } from '../../src/engine/odbc'
import { odbcProblem } from '../../src/shared/project'
import type { ResolvedSource } from '../../src/shared/engine-protocol'
import { bootEngine, extensionsDir, odbcPgDriver, pgSource, rows, startPostgres, tmp, type Pg } from './helpers'

const src = (kind: ResolvedSource['kind'], extra: Partial<ResolvedSource>): ResolvedSource => ({ id: 'o1', kind, mode: 'extract', timeoutSec: 10, tables: [], ...extra })

describe('ODBC connection strings', () => {
  it('refuses passwords, file data sources and drivers given as files', () => {
    expect(odbcProblem('Sales')).toBeNull()
    expect(odbcProblem('Driver={PostgreSQL};Server=db.example.com;Database=sales')).toBeNull()
    expect(odbcProblem('')).toMatch(/Enter a data source/)
    expect(odbcProblem('DSN=Sales;PWD=secret')).toMatch(/password/)
    expect(odbcProblem('DSN=Sales; Password = secret')).toMatch(/password/)
    expect(odbcProblem('FILEDSN=/tmp/x.dsn')).toMatch(/File data sources/)
    expect(odbcProblem('DSN=Sales;SaveFile=/tmp/x.dsn')).toMatch(/File data sources/)
    expect(odbcProblem('Driver=/tmp/evil.so;Server=x')).toMatch(/not a driver file/)
    expect(odbcProblem('driver = {C:\\evil.dll}')).toMatch(/not a driver file/)
    expect(odbcProblem('Sales;x')).toMatch(/data source name/)
    expect(odbcProblem('DSN=a\nb')).toMatch(/line breaks/)
  })

  it('builds the string: a DSN, user and password in braces, the vendor drivers of SAP HANA and Teradata', () => {
    expect(odbcConnString(src('odbc', { database: 'Sales' }), [])).toBe('DSN=Sales')
    expect(odbcConnString(src('odbc', { database: 'Driver={PostgreSQL};Server=h; ', user: 'me', password: 'a;b}c' }), [])).toBe('Driver={PostgreSQL};Server=h;UID=me;PWD={a;b}}c}')
    expect(() => odbcConnString(src('odbc', { database: 'DSN=x;PWD=y' }), [])).toThrow(/password/)
    expect(odbcConnString(src('hana', { host: 'hana.example.com', port: 30015, database: 'HXE', user: 'SYSTEM', password: 'p', sslmode: 'verify-full' }), ['PostgreSQL', 'HDBODBC'])).toBe('Driver={HDBODBC};ServerNode=hana.example.com:30015;DatabaseName=HXE;encrypt=true;sslValidateCertificate=true;UID=SYSTEM;PWD=p')
    expect(odbcConnString(src('teradata', { host: 'td.example.com', port: 1025, database: 'sales', user: 'dbc', sslmode: 'prefer' }), ['Teradata Database ODBC Driver 20.00'])).toBe('Driver={Teradata Database ODBC Driver 20.00};DBCName=td.example.com;TDMSTPortNumber=1025;Database=sales;UID=dbc')
    expect(() => odbcConnString(src('hana', { host: 'h' }), ['PostgreSQL'])).toThrow('No ODBC driver for SAP HANA is installed on this computer.')
    expect(() => odbcConnString(src('teradata', { host: 'h' }), [])).toThrow('No ODBC driver for Teradata is installed on this computer.')
  })
})

describe('ODBC against PostgreSQL', () => {
  let pg: Pg | null = null
  const driver = odbcPgDriver()
  beforeAll(async () => {
    if (!driver) return console.warn('ODBC tests skipped: no PostgreSQL ODBC driver (unixODBC + psqlodbc) on this computer.')
    pg = await startPostgres()
    if (!pg) console.warn('ODBC tests skipped: set SV_PG_HOST or install podman.')
  })
  afterAll(() => pg?.stop())
  const source = (p: Pg, extra: Partial<ResolvedSource> = {}) => src('odbc', { database: `Driver={${driver}};Server=${p.host};Port=${p.port};Database=${p.database};SSLmode=disable`, user: p.user, password: p.password, tables: [{ alias: 'customers_odbc', ref: 'public.customers' }], ...extra })

  it('lists tables, extracts one, and leaves nothing of ODBC in the engine that runs user SQL', async (ctx) => {
    if (!pg) return ctx.skip()
    expect((await Engine.probe(source(pg), extensionsDir)).tables).toContain('public.customers')
    const cacheDir = tmp()
    const { engine } = await bootEngine([source(pg), pgSource(pg, 'extract')], [], cacheDir)
    expect(engine.statuses().map((s) => s.error ?? 'ok')).toEqual(['ok', 'ok'])
    const viaOdbc = await rows(engine, 'SELECT customer_id, customer_name, region, segment FROM customers_odbc ORDER BY 1')
    expect(viaOdbc.length).toBeGreaterThan(10)
    expect(viaOdbc).toEqual(await rows(engine, 'SELECT customer_id, customer_name, region, segment FROM customers ORDER BY 1'))
    // The staging file is gone, and user SQL has no ODBC functions to call.
    expect(readdirSync(path.join(cacheDir, 'tmp')).filter((f) => f.startsWith('odbc-'))).toEqual([])
    await expect(rows(engine, "SELECT odbc_connect('DSN=x')")).rejects.toThrow(/odbc_connect/)
    await expect(rows(engine, "SELECT * FROM odbc_list_drivers()")).rejects.toThrow()
    await engine.close()
  })

  it('explains a wrong password without repeating it, and a table that does not exist', async (ctx) => {
    if (!pg) return ctx.skip()
    await expect(Engine.probe(source(pg, { password: 'wrong-Secret-123' }), extensionsDir)).rejects.toThrow('The server rejected the user name or password.')
    const { engine } = await bootEngine([source(pg, { password: 'wrong-Secret-123' })])
    expect(engine.statuses()[0]).toMatchObject({ state: 'error', auth: true })
    await engine.close()
    const missing = await bootEngine([source(pg, { tables: [{ alias: 'nope', ref: 'public.no_such_table' }] })])
    expect(missing.engine.statuses()[0].error).toMatch(/no_such_table/)
    expect(missing.engine.statuses()[0].error).not.toContain(pg.password)
    await missing.engine.close()
  })
})

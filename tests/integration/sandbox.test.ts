// The security core: SQL from a user or a project file can read the project's data and nothing else.
// Each attack is tried against the SQL gate, and separately against DuckDB's own lockdown (gate bypassed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { bootEngine, fileSource, fixture, tmp, rows } from './helpers'
import type { Engine } from '../../src/engine/engine'

const secret = path.join(tmp('sv-secret-'), 'secret.csv')
writeFileSync(secret, 'password\nhunter2\n')
const outside = path.join(os.tmpdir(), `sv-written-${process.pid}.csv`)
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

const ATTACKS: [string, string][] = [
  ['read a file with a table function', `SELECT * FROM read_csv(${lit(secret)})`],
  ['read a file by path (replacement scan)', `SELECT * FROM ${lit(secret)}`],
  ['read raw text', `SELECT * FROM read_text(${lit(secret)})`],
  ['read inside a CTE', `WITH x AS (SELECT * FROM read_csv(${lit(secret)})) SELECT * FROM x`],
  ['read inside a scalar subquery', `SELECT (SELECT count(*) FROM read_csv(${lit(secret)})) AS n`],
  ['write a file', `COPY (SELECT 1) TO ${lit(outside)}`],
  ['attach a database', `ATTACH ${lit(path.join(os.tmpdir(), 'x.duckdb'))} AS x`],
  ['load an extension', 'LOAD httpfs'],
  ['install an extension', 'INSTALL httpfs'],
  ['change a setting', "SET enable_external_access = true"],
  ['pragma', 'PRAGMA enable_profiling'],
  ['drop a view', 'DROP VIEW transactions'],
  ['create a table', 'CREATE TABLE x AS SELECT 1'],
  ['two statements', 'SELECT 1; DROP VIEW transactions'],
  ['engine settings', 'SELECT * FROM duckdb_settings()'],
  ['catalog', 'SELECT * FROM information_schema.tables'],
  ['the cache directly', 'SELECT * FROM cache.main.__meta'],
  ['query()', "SELECT * FROM query('SELECT 1')"],
  ['postgres_scan with a DSN', "SELECT * FROM postgres_scan('host=203.0.113.1 dbname=x', 'public', 't')"]
]

describe('SQL gate', () => {
  let engine: Engine
  beforeAll(async () => {
    ;({ engine } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])]))
  })
  afterAll(() => engine?.close())

  for (const [what, sql] of ATTACKS)
    it(`refuses: ${what}`, async () => {
      await expect(engine.query(1, sql)).rejects.toThrow()
      expect(existsSync(outside)).toBe(false)
    })

  it('still runs ordinary analysis', async () => {
    const [r] = await rows(engine, `WITH t AS (SELECT * FROM transactions) SELECT count(*) AS n, (SELECT max(i) FROM range(3) r(i)) AS m FROM t`)
    expect(r).toEqual({ n: 1000, m: 2 })
  })

  it('refuses a dataset that writes, and keeps the rest of the project working', async () => {
    const { engine: e } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])], [
      { name: 'evil', sql: `COPY (SELECT 1) TO ${lit(outside)}` },
      { name: 'snoop', sql: `SELECT * FROM read_csv(${lit(secret)})` },
      { name: 'good', sql: 'SELECT count(*) AS n FROM transactions' }
    ])
    const d = e.describe()
    expect(Object.keys(d.datasetErrors).sort()).toEqual(['evil', 'snoop'])
    expect(d.relations.map((r) => r.name)).toContain('good')
    expect(existsSync(outside)).toBe(false)
    await e.close()
  })
})

describe('DuckDB lockdown (gate bypassed)', () => {
  let engine: Engine
  beforeAll(async () => {
    ;({ engine } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])]))
  })
  afterAll(() => engine?.close())

  const blocked: [string, string][] = [
    ['read a file outside the project', `SELECT * FROM read_csv(${lit(secret)})`],
    ['write a file outside the cache', `COPY (SELECT 1) TO ${lit(outside)}`],
    ['load an extension', 'LOAD httpfs'],
    ['change a setting', "SET enable_external_access = true"],
    ['lift the allowlist', `SET allowed_directories = [${lit(os.tmpdir())}]`],
    ['attach a file outside the project', `ATTACH ${lit(path.join(os.tmpdir(), `sv-${process.pid}.duckdb`))} AS x`]
  ]
  for (const [what, sql] of blocked)
    it(`refuses: ${what}`, async () => {
      await expect(engine._ungated(sql)).rejects.toThrow(/disabled|locked|Permission|not allowed/i)
      expect(existsSync(outside)).toBe(false)
    })

  it('reads the project’s own files', async () => {
    const r = await engine._ungated(`SELECT count(*) FROM transactions`)
    expect(Number(r[0][0])).toBe(1000)
  })
})

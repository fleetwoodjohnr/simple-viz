// The engine against real files: Excel, CSV, Parquet, JSON; derived columns, datasets, joins, refresh, errors, cancel.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync, writeFileSync, utimesSync, renameSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { bootEngine, expected, fileSource, fixture, rows, tmp } from './helpers'
import { Engine } from '../../src/engine/engine'
import type { EngineConfig } from '../../src/shared/engine-protocol'

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01)

const SEGMENT_SQL = `SELECT t.customer_id, t.product_name, t.revenue, t.cost, t.revenue - t.cost AS profit,
  CASE WHEN t.revenue >= 10000 THEN 'High Value' WHEN t.revenue >= 5000 THEN 'Medium Value' ELSE 'Low Value' END AS customer_segment,
  c.region, t.order_date
FROM transactions AS t LEFT JOIN customers AS c ON t.customer_id = c.customer_id
WHERE t.revenue > 0`

describe('Excel + CSV project', () => {
  let engine: Engine
  let config: EngineConfig
  let dir: string
  let sales: string
  const exp = expected()

  beforeAll(async () => {
    dir = tmp()
    sales = path.join(dir, 'Sales.xlsx')
    copyFileSync(fixture('Sales.xlsx'), sales)
    ;({ engine, config } = await bootEngine(
      [fileSource('xl', sales, 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), fileSource('cust', fixture('customers.csv'), 'csv', [{ alias: 'customers' }])],
      [{ name: 'sales_enriched', sql: SEGMENT_SQL }],
      path.join(dir, 'cache')
    ))
  })
  afterAll(() => engine?.close())

  it('reads the worksheet with typed columns', async () => {
    const d = engine.describe()
    const t = d.relations.find((r) => r.name === 'transactions')!
    expect(t.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['order_id:BIGINT', 'order_date:DATE', 'customer_id:BIGINT', 'product_name:VARCHAR', 'quantity:BIGINT', 'revenue:DOUBLE', 'cost:DOUBLE'])
    const [r] = await rows(engine, 'SELECT count(*) AS n, sum(revenue) AS rev FROM transactions')
    expect(r.n).toBe(1000)
    close(r.rev as number, exp.v1.revenue)
  })

  it('computes derived columns in a saved dataset that charts can use', async () => {
    const d = engine.describe()
    const ds = d.relations.find((r) => r.name === 'sales_enriched')!
    expect(ds.kind).toBe('dataset')
    expect(ds.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['profit', 'customer_segment', 'region']))
    const [r] = await rows(engine, 'SELECT sum(profit) AS p, count(DISTINCT customer_segment) AS segs FROM sales_enriched')
    close(r.p as number, exp.v1.profit)
    expect(d.deps.sales_enriched).toEqual(expect.arrayContaining(['transactions', 'customers']))
  })

  it('joins, groups, and matches the expected revenue by region', async () => {
    const out = await rows(engine, 'SELECT region, round(sum(revenue), 2) AS revenue FROM sales_enriched GROUP BY region ORDER BY region')
    for (const r of out) close(r.revenue as number, exp.v1.revenueByRegion[r.region as string])
  })

  it('runs CTEs, window functions, and date functions', async () => {
    const out = await rows(
      engine,
      `WITH m AS (SELECT date_trunc('month', order_date) AS month, sum(revenue) AS revenue FROM transactions GROUP BY 1)
       SELECT strftime(month, '%Y-%m') AS m, revenue, sum(revenue) OVER (ORDER BY month) AS running, rank() OVER (ORDER BY revenue DESC) AS rk FROM m ORDER BY month`
    )
    expect(out.length).toBe(Object.keys(exp.v1.revenueByMonth).length)
    for (const r of out) close(r.revenue as number, exp.v1.revenueByMonth[r.m as string])
    close(out.at(-1)!.running as number, exp.v1.revenue)
  })

  it('binds $parameters', async () => {
    const r = await engine.query(9001, 'SELECT count(*) AS n FROM transactions WHERE product_name = $p AND revenue > $min', { params: { p: 'Laptop', min: 0 } })
    expect(Number(r.rows[0][0])).toBeGreaterThan(0)
    await expect(engine.query(9002, 'SELECT * FROM transactions WHERE revenue > $min')).rejects.toThrow(/parameter \$min/)
  })

  it('keeps big results for paging', async () => {
    const r = await engine.query(9003, 'SELECT * FROM range(25000) t(i)', { keep: true, limit: 100 })
    expect(r.rowCount).toBe(25000)
    expect(r.rows.length).toBe(100)
    const p = await engine.page(r.resultId!, 24990, 50)
    expect(p.rows.map((x) => Number(x[0]))).toEqual([24990, 24991, 24992, 24993, 24994, 24995, 24996, 24997, 24998, 24999])
  })

  it('explains SQL errors in plain words', async () => {
    await expect(engine.query(9004, 'SELECT nope FROM transactions')).rejects.toThrow(/nope/)
    await expect(engine.query(9005, 'SELEC 1')).rejects.toThrow(/syntax error/i)
    await expect(engine.query(9006, 'SELECT * FROM missing_table')).rejects.toThrow(/Unknown table “missing_table”/)
  })

  it('cancels a long-running query', async () => {
    const run = engine.query(9007, 'SELECT count(*) FROM range(100000000000) a')
    setTimeout(() => engine.cancel(9007), 300)
    await expect(run).rejects.toThrow(/cancel|interrupt/i)
  })

  it('refreshes when the workbook changes, and recalculates the dataset', async () => {
    // Unchanged content with a new timestamp: re-read, but nothing downstream changes.
    utimesSync(sales, new Date(), new Date(Date.now() + 5000))
    let st = await engine.refresh(['xl'])
    expect(st.find((s) => s.id === 'xl')).toMatchObject({ state: 'ok', changed: false })
    // The user adds 500 orders in Excel and saves (atomic replace, as spreadsheet apps do).
    copyFileSync(fixture('Sales-v2.xlsx'), sales + '.tmp')
    renameSync(sales + '.tmp', sales)
    st = await engine.refresh(['xl'])
    expect(st.find((s) => s.id === 'xl')).toMatchObject({ state: 'ok', changed: true, rows: 1500 })
    const [r] = await rows(engine, 'SELECT count(*) AS n, sum(revenue) AS rev, sum(profit) AS p FROM sales_enriched')
    expect(r.n).toBe(1500)
    close(r.rev as number, exp.v2.revenue)
    close(r.p as number, exp.v2.profit)
  })

  it('keeps the last good data when the file disappears, and recovers', async () => {
    renameSync(sales, sales + '.away')
    const st = await engine.refresh(['xl'])
    const s = st.find((x) => x.id === 'xl')!
    expect(s.state).toBe('error')
    expect(s.error).toMatch(/missing/i)
    expect(s.refreshedAt).toBeTruthy()
    const [r] = await rows(engine, 'SELECT count(*) AS n FROM transactions')
    expect(r.n).toBe(1500)
    renameSync(sales + '.away', sales)
    expect((await engine.refresh(['xl'])).find((x) => x.id === 'xl')!.state).toBe('ok')
  })

  it('opens from the cache before any refresh (offline)', async () => {
    await engine.close()
    const again = new Engine()
    await again.boot(config)
    engine = again
    // No refresh yet: the data comes from the cache, marked stale until checked.
    expect(again.statuses().find((s) => s.id === 'xl')!.state).toBe('stale')
    const [r] = await rows(again, 'SELECT count(*) AS n FROM sales_enriched')
    expect(r.n).toBe(1500)
  })
})

describe('flat files', () => {
  it('reads CSV, TSV, Parquet, JSON and JSON Lines', async () => {
    const dir = tmp()
    const i = await DuckDBInstance.create(':memory:')
    const c = await i.connect()
    const src = `SELECT i AS id, 'name ' || i AS name, i * 1.5 AS amount, DATE '2025-01-01' + i::INTEGER AS day FROM range(100) t(i)`
    const f = (n: string) => path.join(dir, n).replace(/'/g, "''")
    await c.run(`COPY (${src}) TO '${f('a.csv')}' (HEADER)`)
    await c.run(`COPY (${src}) TO '${f('a.tsv')}' (HEADER, DELIM '\t')`)
    await c.run(`COPY (${src}) TO '${f('a.parquet')}' (FORMAT parquet)`)
    await c.run(`COPY (${src}) TO '${f('a.jsonl')}' (FORMAT json)`)
    await c.run(`COPY (${src}) TO '${f('a.json')}' (FORMAT json, ARRAY true)`)
    c.closeSync()
    i.closeSync()
    const { engine } = await bootEngine([
      fileSource('c', path.join(dir, 'a.csv'), 'csv', [{ alias: 'c' }]),
      fileSource('t', path.join(dir, 'a.tsv'), 'tsv', [{ alias: 't' }]),
      fileSource('p', path.join(dir, 'a.parquet'), 'parquet', [{ alias: 'p' }]),
      fileSource('j', path.join(dir, 'a.json'), 'json', [{ alias: 'j' }]),
      fileSource('l', path.join(dir, 'a.jsonl'), 'jsonl', [{ alias: 'l' }])
    ])
    for (const t of ['c', 't', 'p', 'j', 'l']) {
      const [r] = await rows(engine, `SELECT count(*) AS n, sum(amount) AS s FROM ${t}`)
      expect(r.n, t).toBe(100)
      expect(r.s, t).toBe(7425)
    }
    await engine.close()
  })

  it('explains malformed and hostile files instead of crashing', async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'bad.csv'), 'a,b\n1,2\n3,4,5,6\n"unterminated\n')
    writeFileSync(path.join(dir, 'fake.xlsx'), 'this is not a zip file')
    // A ZIP whose one entry claims to be enormous (zip-bomb guard).
    const { zipSync } = await import('fflate')
    writeFileSync(path.join(dir, 'bomb.xlsx'), zipSync({ 'xl/workbook.xml': new Uint8Array(3 * 1024 * 1024) }, { level: 9 }))
    const { engine } = await bootEngine([
      fileSource('bad', path.join(dir, 'bad.csv'), 'csv', [{ alias: 'bad' }]),
      fileSource('fake', path.join(dir, 'fake.xlsx'), 'xlsx', [{ alias: 'fake' }]),
      fileSource('bomb', path.join(dir, 'bomb.xlsx'), 'xlsx', [{ alias: 'bomb' }])
    ])
    const st = Object.fromEntries(engine.statuses().map((s) => [s.id, s]))
    expect(st.fake.state).toBe('error')
    expect(st.fake.error).toMatch(/not a valid package|ZIP/i)
    expect(st.bomb.state).toBe('error')
    expect(st.bomb.error).toMatch(/zip bomb|compressed suspiciously/i)
    // DuckDB's CSV reader either rejects the file with an explanation or reads it with nulls padded; never a crash.
    expect(['ok', 'error']).toContain(st.bad.state)
    if (st.bad.state === 'error') expect(st.bad.error).toBeTruthy()
    await engine.close()
  })

  it('never writes to the source workbook', async () => {
    const dir = tmp()
    const file = path.join(dir, 'Sales.xlsx')
    copyFileSync(fixture('Sales.xlsx'), file)
    const before = readFileSync(file)
    const { engine } = await bootEngine([fileSource('xl', file, 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    await rows(engine, 'SELECT * FROM transactions')
    await engine.refresh(undefined, true)
    expect(readFileSync(file).equals(before)).toBe(true)
    await engine.close()
  })
})

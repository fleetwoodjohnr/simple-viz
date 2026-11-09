// Arrow, Feather, ordinary XML and Excel 97–2003 files as sources: extracted into the cache with their types.
import { it, expect } from 'vitest'
import path from 'node:path'
import { bootEngine, fileSource, rows, root } from './helpers'

const arrow = (n: string) => path.join(root, 'tests', 'fixtures', 'arrow', n)

it('extracts Arrow and Feather files with their column types', async () => {
  const { engine } = await bootEngine([fileSource('a', arrow('mixed-lz4.feather'), 'arrow', [{ alias: 'mixed' }]), fileSource('b', arrow('big-lz4.feather'), 'arrow', [{ alias: 'big' }]), fileSource('c', arrow('mixed.arrows'), 'arrow', [{ alias: 'stream' }])])
  expect(engine.statuses().map((s) => s.state)).toEqual(['ok', 'ok', 'ok'])
  const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE mixed)')).map((r) => [r.column_name, r.column_type]))
  expect(types).toMatchObject({ id: 'BIGINT', name: 'VARCHAR', amount: 'DOUBLE', price: 'DOUBLE', day: 'DATE', at: 'TIMESTAMP', ok: 'BOOLEAN', region: 'VARCHAR' })
  const [m] = await rows(engine, "SELECT sum(price) AS p, max(day)::VARCHAR AS d, count(*) FILTER (WHERE region = 'East') AS east FROM mixed")
  expect([Number(m.p), m.d, Number(m.east)]).toEqual([6.76, '2025-02-28', 2])
  const [b] = await rows(engine, 'SELECT count(*) AS n, sum(k) AS s FROM big')
  expect([Number(b.n), Number(b.s)]).toEqual([1_200_000, 1200 * 499_500])
  expect(Number((await rows(engine, 'SELECT count(*) AS n FROM stream JOIN mixed USING (id)'))[0].n)).toBe(4)
  await engine.close()
})

it('reads an ordinary XML file: its repeated elements are the rows', async () => {
  const xml = path.join(root, 'tests', 'fixtures', 'orders.xml')
  const { engine } = await bootEngine([fileSource('x', xml, 'xml2003', [{ alias: 'orders' }]), fileSource('s', path.join(root, 'tests', 'fixtures', 'customers.csv'), 'csv', [{ alias: 'customers' }])])
  expect(engine.statuses()[0].state).toBe('ok')
  const out = await rows(engine, 'SELECT customer, amount, ship_city, placed::VARCHAR AS placed FROM orders ORDER BY id')
  expect(out).toEqual([{ customer: 'Ann', amount: 10.5, ship_city: 'Austin', placed: '2025-01-02' }, { customer: 'Bo & Co', amount: 7, ship_city: 'Dallas', placed: '2025-01-03' }, { customer: 'Côte', amount: null, ship_city: null, placed: '2025-02-10' }])
  const { fileTables } = await import('../../src/engine/ingest')
  const { readFileSync } = await import('node:fs')
  expect((await fileTables(new Uint8Array(readFileSync(xml)), 'xml2003')).map((t) => t.ref)).toEqual(['order'])
  await engine.close()
})


it('reads an Excel binary (.xlsb) workbook natively', async () => {
  const xlsb = path.join(root, 'tests', 'fixtures', 'xlsb', 'sample.xlsb')
  const { engine } = await bootEngine([fileSource('b', xlsb, 'xlsb', [{ alias: 'lorem', ref: 'Sheet1' }])])
  expect(engine.statuses()[0].state).toBe('ok')
  const { fileTables } = await import('../../src/engine/ingest')
  const { readFileSync } = await import('node:fs')
  expect((await fileTables(new Uint8Array(readFileSync(xlsb)), 'xlsb')).map((t) => t.ref)).toEqual(expect.arrayContaining(['Sheet1', 'rich test']))
  const r = await rows(engine, 'SELECT count(*) AS n FROM lorem')
  expect(Number(r[0].n)).toBeGreaterThan(5)
  await engine.close()
})

it('reads an Excel 97–2003 (.xls) workbook natively (no conversion)', async () => {
  const xls = path.join(root, 'tests', 'fixtures', 'Sales.xls')
  const { engine } = await bootEngine([fileSource('l', xls, 'xls', [{ alias: 'transactions', ref: 'Transactions' }, { alias: 'notes', ref: 'Notes' }]), fileSource('c', path.join(root, 'tests', 'fixtures', 'customers.csv'), 'csv', [{ alias: 'customers' }])])
  expect(engine.statuses()[0].state).toBe('ok')
  const { expected } = await import('./helpers')
  const byRegion = await rows(engine, 'SELECT region, round(sum(revenue), 2) AS revenue FROM transactions JOIN customers USING (customer_id) GROUP BY 1')
  for (const r of byRegion) expect(Math.abs(Number(r.revenue) - expected().v1.revenueByRegion[r.region as string])).toBeLessThan(0.01)
  const [m] = await rows(engine, "SELECT strftime(min(order_date), '%Y-%m') AS first FROM transactions")
  expect(m.first).toBe(Object.keys(expected().v1.revenueByMonth)[0])
  const [n] = await rows(engine, 'SELECT count(*) AS n, count(*) FILTER (WHERE flag) AS flagged FROM notes')
  expect([Number(n.n), Number(n.flagged)]).toEqual([2000, 666])
  const { fileTables } = await import('../../src/engine/ingest')
  const { readFileSync } = await import('node:fs')
  expect((await fileTables(new Uint8Array(readFileSync(xls)), 'xls')).map((t) => t.ref)).toEqual(expect.arrayContaining(['Transactions', 'Notes']))
  await engine.close()
})

it('a portable package: tables are packaged as Parquet and seed a new cache when the source is gone', async () => {
  const { Engine } = await import('../../src/engine/engine')
  const { mkdtempSync, copyFileSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sv-pkg-'))
  const csv = path.join(dir, 'customers.csv')
  copyFileSync(path.join(root, 'tests', 'fixtures', 'customers.csv'), csv)
  const src = fileSource('c1', csv, 'csv', [{ alias: 'customers' }])
  const a = await bootEngine([src])
  const staged = await a.engine.packageTables([{ sourceId: 'c1', alias: 'customers' }])
  expect(Object.keys(staged)).toEqual(['c1__customers'])
  // Another computer: the file isn't there, the cache is empty; the packaged data is all there is.
  const pkgDir = mkdtempSync(path.join(os.tmpdir(), 'sv-pkg-cache-'))
  const seeded = path.join(pkgDir, 'packaged.parquet')
  copyFileSync(staged.c1__customers, seeded)
  a.engine.close()
  rmSync(csv)
  const b = new Engine()
  await b.boot({ projectId: 'other', cacheDir: pkgDir, extensionsDir: null, sources: [src], datasets: [], packaged: { c1__customers: seeded } })
  await b.refresh().catch(() => {})
  expect(Number((await rows(b, 'SELECT count(*) AS n FROM customers'))[0].n)).toBe(120)
  expect(b.statuses()[0].state).toBe('error') // the source itself is missing: the packaged copy is the last good data
  b.close()
})

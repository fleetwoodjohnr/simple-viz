// Scale benchmarks (npm run bench): sales-like data at 10k, 100k, 1M and 10M rows (SV_BENCH_SIZES to change), joined
// with a customer table from another source. For each size: extract into the cache, then the chart queries a dashboard
// runs (compiled by the real chart compiler, through the SQL gate), one by one and twelve at once; memory as RSS.
// Also: a 100,000-row Excel workbook, and a sort that must spill to disk under a 256 MB memory limit.
// Results print as a table; docs/PERFORMANCE_BENCHMARKS.md records a run.
import { it, expect, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { DuckDBInstance } from '@duckdb/node-api'
import { bootEngine, fileSource, rows, tmp } from '../integration/helpers'
import { compileQuery } from '../../src/core/query/compile'
import { rowsToXlsx } from '../../src/core/sheets/fromRows'
import type { Engine } from '../../src/engine/engine'
import type { Chart, FieldRef } from '../../src/shared/charts'

const SIZES = (process.env.SV_BENCH_SIZES ?? '10000,100000,1000000,10000000').split(',').map(Number)
const engines: Engine[] = []
afterAll(() => engines.forEach((e) => e.close()))
const lines: string[] = []
const report = (s: string) => (lines.push(s), console.log(s))
const ms = (t: number) => (t < 1000 ? `${Math.round(t)} ms` : `${(t / 1000).toFixed(2)} s`)
const mb = () => `${Math.round(process.memoryUsage().rss / 2 ** 20)} MB`
const time = async <T>(f: () => Promise<T>) => {
  const s = performance.now()
  const v = await f()
  return [v, performance.now() - s] as const
}

async function generate(dir: string, n: number) {
  const gen = await (await DuckDBInstance.create(':memory:')).connect()
  const sales = path.join(dir, `sales-${n}.parquet`)
  const customers = path.join(dir, 'customers.csv')
  await gen.run(`COPY (
    SELECT i AS order_id, DATE '2020-01-01' + CAST(hash(i, 1) % 1826 AS INTEGER) AS order_date, 1 + hash(i, 2) % 5000 AS customer_id,
      ['Laptop', 'Monitor', 'Keyboard', 'Desk', 'Chair', 'Headset', 'Server', 'License'][CAST(1 + hash(i, 3) % 8 AS INTEGER)] AS product,
      1 + hash(i, 4) % 9 AS quantity, round((hash(i, 5) % 1000000) / 100.0, 2) AS revenue, round((hash(i, 6) % 700000) / 100.0, 2) AS cost
    FROM range(${n}) t(i)) TO '${sales}' (FORMAT parquet)`)
  await gen.run(`COPY (SELECT i AS customer_id, 'Customer ' || i AS name, ['East', 'West', 'North', 'South', 'Central'][CAST(1 + i % 5 AS INTEGER)] AS region, ['Consumer', 'Corporate', 'Small Business'][CAST(1 + i % 3 AS INTEGER)] AS segment FROM range(1, 5001) t(i)) TO '${customers}' (HEADER)`)
  gen.closeSync()
  return { sales, customers }
}

const dim = (field: string, extra: Partial<FieldRef> = {}): FieldRef => ({ field, ...extra })
const sum = (field: string): FieldRef => ({ field, agg: 'sum' })
const chart = (enc: Partial<Chart['enc']>, extra: Partial<Chart> = {}): Chart => ({ id: 'c', name: 'c', dataset: 'sales_enriched', type: 'bar', filters: [], options: {}, updatedAt: 0, ...extra, enc: { x: [], y: [], detail: [], tooltip: [], ...enc } })

/** The charts of a typical sales dashboard. */
const CHARTS: [string, Chart][] = [
  ['Revenue by region (bar)', chart({ x: [dim('region')], y: [sum('revenue')] })],
  ['Revenue by month (line)', chart({ x: [dim('order_date', { grain: 'month' })], y: [sum('revenue')] }, { type: 'line' })],
  ['Top 10 products by profit', chart({ x: [dim('product')], y: [sum('profit')] }, { filters: [{ id: 't', field: 'product', op: 'top', top: { n: 10, by: sum('profit') } }] })],
  ['Region × segment (crosstab)', chart({ x: [dim('segment')], y: [dim('region'), sum('revenue')] }, { type: 'crosstab' })],
  ['KPI: total profit', chart({ y: [sum('profit')] }, { type: 'kpi' })],
  ['Revenue by year and region', chart({ x: [dim('order_date', { grain: 'year' })], y: [sum('revenue')], color: dim('region') })],
  ['Filtered: 2023, East only', chart({ x: [dim('product')], y: [sum('revenue')] }, { filters: [{ id: 'f1', field: 'region', op: 'in', values: ['East'] }, { id: 'f2', field: 'order_date', op: 'between', min: '2023-01-01', max: '2024-01-01', maxExclusive: true }] })],
  ['Distinct customers by month', chart({ x: [dim('order_date', { grain: 'month' })], y: [{ field: 'customer_id', agg: 'countd' }] }, { type: 'line' })],
  ['Average order by segment', chart({ x: [dim('segment')], y: [{ field: 'revenue', agg: 'avg' }] })],
  ['Quantity by product and region', chart({ x: [dim('product')], y: [sum('quantity')], color: dim('region') })],
  ['Median revenue by region', chart({ x: [dim('region')], y: [{ field: 'revenue', agg: 'median' }] })],
  ['FIXED: revenue share of region', chart({ x: [dim('region')], y: [{ field: 'share', agg: 'none' }] })]
]
const CALCS = [{ id: 'share', dataset: 'sales_enriched', name: 'share', formula: 'SUM([revenue]) / ANY_VALUE({FIXED : SUM([revenue])})' }]

it('scale: extract and dashboard queries at each size', async () => {
  const dir = tmp('sv-scale-')
  report(`Hardware: ${os.cpus()[0]?.model} × ${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, ${process.platform}-${process.arch}, Node ${process.versions.node}`)
  report('')
  report(`| Rows | Extract | ${CHARTS.map(([n]) => n).join(' | ')} | 12 charts at once | RSS after |`)
  report(`|${'---|'.repeat(CHARTS.length + 4)}`)
  for (const n of SIZES) {
    const { sales, customers } = await generate(dir, n)
    const [{ engine }, tExtract] = await time(() =>
      bootEngine([fileSource('s', sales, 'parquet', [{ alias: 'transactions' }]), fileSource('c', customers, 'csv', [{ alias: 'customers' }])], [{ name: 'sales_enriched', sql: 'SELECT t.*, c.region, c.segment, t.revenue - t.cost AS profit FROM transactions t JOIN customers c USING (customer_id)' }], tmp('sv-scale-cache-'), `scale${n}`)
    )
    engines.push(engine)
    expect(Number((await rows(engine, 'SELECT count(*) AS n FROM sales_enriched'))[0].n)).toBe(n)
    const columns = engine.describe().relations.find((r) => r.name === 'sales_enriched')!.columns
    const sqls = CHARTS.map(([, c]) => compileQuery({ chart: c, columns, calcs: CALCS }).sql)
    const each: number[] = []
    for (const sql of sqls) {
      const [, t] = await time(() => rows(engine, sql))
      each.push(t)
    }
    const [, tAll] = await time(() => Promise.all(sqls.map((sql) => rows(engine, sql))))
    report(`| ${n.toLocaleString()} | ${ms(tExtract)} | ${each.map(ms).join(' | ')} | ${ms(tAll)} | ${mb()} |`)
    engine.close()
    engines.pop()
  }
}, 3_600_000)

it('scale: a 100,000-row Excel workbook', async () => {
  const dir = tmp('sv-xlsx-')
  const file = path.join(dir, 'big.xlsx')
  const n = 100_000
  const data = Array.from({ length: n }, (_, i) => [i, `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, `Product ${i % 50}`, (i % 1000) / 10, i % 7])
  writeFileSync(file, rowsToXlsx([{ name: 'id', type: 'BIGINT' }, { name: 'day', type: 'DATE' }, { name: 'product', type: 'VARCHAR' }, { name: 'amount', type: 'DOUBLE' }, { name: 'qty', type: 'BIGINT' }], data, 'Data'))
  const [{ engine }, t] = await time(() => bootEngine([fileSource('x', file, 'xlsx', [{ alias: 'big', ref: 'Data' }])]))
  engines.push(engine)
  expect(Number((await rows(engine, 'SELECT count(*) AS n FROM big'))[0].n)).toBe(n)
  report('')
  report(`Excel: ${n.toLocaleString()} rows × 5 columns extracted in ${ms(t)} (${mb()} RSS)`)
}, 600_000)

it('scale: a sort larger than memory spills to disk instead of failing', async () => {
  const dir = tmp('sv-spill-')
  const { sales, customers } = await generate(dir, 5_000_000)
  const cfg = await bootEngine([fileSource('s', sales, 'parquet', [{ alias: 'transactions' }]), fileSource('c', customers, 'csv', [{ alias: 'customers' }])], [], tmp('sv-spill-cache-'), 'spill')
  cfg.engine.close()
  // Same cache, now with a 256 MB memory limit: the window function sorts all 5M rows with their text.
  const { Engine } = await import('../../src/engine/engine')
  const engine = new Engine()
  engines.push(engine)
  await engine.boot({ ...cfg.config, memoryLimit: '256MB' })
  const [r, t] = await time(() => rows(engine, "SELECT count(*) AS n, max(rk) AS top FROM (SELECT row_number() OVER (ORDER BY product || CAST(revenue AS VARCHAR) || CAST(order_id AS VARCHAR) DESC) AS rk FROM transactions)"))
  expect(Number(r[0].n)).toBe(5_000_000)
  report(`Spill: a 5,000,000-row sort under a 256 MB limit finished in ${ms(t)}`)
  writeFileSync(path.join(dir, 'report.md'), lines.join('\n'))
}, 1_200_000)

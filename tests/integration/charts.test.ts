// Chart queries against hand-written SQL on the fixture data: aggregation, dates, filters, calculated fields,
// level of detail (FIXED / INCLUDE / EXCLUDE with Tableau's aggregation rules), table calculations, top N.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { bootEngine, expected, fileSource, fixture, rows } from './helpers'
import { compileQuery, type QueryInput } from '../../src/core/query/compile'
import type { Engine } from '../../src/engine/engine'
import type { CalcField, Chart, FieldRef } from '../../src/shared/charts'

let engine: Engine
const exp = expected()
const DS = `SELECT t.*, c.region, c.segment, t.revenue - t.cost AS profit FROM transactions t JOIN customers c USING (customer_id)`

beforeAll(async () => {
  ;({ engine } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), fileSource('c', fixture('customers.csv'), 'csv', [{ alias: 'customers' }])], [{ name: 'sales', sql: DS }]))
})
afterAll(() => engine?.close())

const columns = () => engine.describe().relations.find((r) => r.name === 'sales')!.columns
const dim = (field: string, extra: Partial<FieldRef> = {}): FieldRef => ({ field, ...extra })
const sum = (field: string, extra: Partial<FieldRef> = {}): FieldRef => ({ field, agg: 'sum', ...extra })

type ChartIn = Omit<Partial<Chart>, 'enc'> & { enc: Partial<Chart['enc']> }
async function run(chart: ChartIn, calcs: CalcField[] = [], extra: Partial<QueryInput> = {}) {
  const c = compileQuery({ chart: { dataset: 'sales', type: 'bar', filters: [], options: {}, ...chart, enc: { ...{ x: [], y: [], detail: [], tooltip: [] }, ...chart.enc } }, columns: columns(), calcs, ...extra })
  return rows(engine, c.sql)
}
const near = (a: unknown, b: number, tol = 0.01) => expect(Math.abs(Number(a) - b)).toBeLessThan(tol)
const calc = (name: string, formula: string): CalcField => ({ id: name, dataset: 'sales', name, formula })

describe('chart queries', () => {
  it('sums a measure by a dimension', async () => {
    const out = await run({ enc: { x: [dim('region')], y: [sum('revenue')] } })
    expect(out.map((r) => r.d0)).toEqual([...exp.regions].sort())
    for (const r of out) near(r.m0, exp.v1.revenueByRegion[r.d0 as string])
  })

  it('truncates dates to months and sorts in time order', async () => {
    const out = await run({ type: 'line', enc: { x: [dim('order_date', { grain: 'month' })], y: [sum('revenue')] } })
    expect(out.map((r) => String(r.d0).slice(0, 7))).toEqual(Object.keys(exp.v1.revenueByMonth))
    out.forEach((r) => near(r.m0, exp.v1.revenueByMonth[String(r.d0).slice(0, 7)]))
  })

  it('applies dimension, range and measure filters', async () => {
    const out = await run({
      enc: { x: [dim('region')], y: [sum('revenue')] },
      filters: [
        { id: 'f1', field: 'region', op: 'in', values: ['Virginia', 'Texas'] },
        { id: 'f2', field: 'revenue', agg: 'sum', op: 'between', min: 1_200_000, max: null }
      ]
    })
    expect(out.map((r) => r.d0)).toEqual(['Texas'])
  })

  it('keeps the top N by a measure', async () => {
    const out = await run({ enc: { x: [dim('product_name')], y: [sum('revenue')] }, filters: [{ id: 't', field: 'product_name', op: 'top', top: { n: 3, by: sum('revenue') } }], options: { sort: { by: 'value', dir: 'desc' } } })
    const ref = await rows(engine, 'SELECT product_name, sum(revenue) s FROM sales GROUP BY 1 ORDER BY 2 DESC LIMIT 3')
    expect(out.map((r) => r.d0)).toEqual(ref.map((r) => r.product_name))
  })

  it('row-level and aggregate calculated fields, with Tableau syntax', async () => {
    const calcs = [calc('Margin', 'SUM([profit]) / SUM([revenue])'), calc('Size', "IF [revenue] >= 10000 THEN 'Large' ELSEIF [revenue] >= 5000 THEN 'Medium' ELSE 'Small' END")]
    const out = await run({ enc: { x: [dim('Size')], y: [{ field: 'Margin', agg: 'none' }, sum('revenue')] } }, calcs)
    const ref = await rows(engine, `SELECT CASE WHEN revenue >= 10000 THEN 'Large' WHEN revenue >= 5000 THEN 'Medium' ELSE 'Small' END AS s, sum(profit)/sum(revenue) m, sum(revenue) r FROM sales GROUP BY 1 ORDER BY 1`)
    expect(out.map((r) => r.d0)).toEqual(ref.map((r) => r.s))
    out.forEach((r, i) => near(r.m0, ref[i].m as number, 1e-9))
  })

  it('INCLUDE: averages the per-customer values, not the records', async () => {
    const out = await run({ enc: { x: [dim('region')], y: [{ field: 'Customer revenue', agg: 'avg' }] } }, [calc('Customer revenue', '{INCLUDE [customer_id] : SUM([revenue])}')])
    const ref = await rows(engine, 'SELECT region, avg(s) a FROM (SELECT region, customer_id, sum(revenue) s FROM sales GROUP BY ALL) GROUP BY region ORDER BY region')
    out.forEach((r, i) => near(r.m0, ref[i].a as number))
  })

  it('FIXED with no dimensions: the grand total on every mark, and a percent of total', async () => {
    const calcs = [calc('Total', '{FIXED : SUM([revenue])}'), calc('Share', 'SUM([revenue]) / SUM({FIXED : SUM([revenue])})')]
    const out = await run({ enc: { x: [dim('region')], y: [{ field: 'Total', agg: 'sum' }, { field: 'Share', agg: 'none' }] } }, calcs)
    for (const r of out) {
      near(r.m0, exp.v1.revenue)
      near(r.m1, exp.v1.revenueByRegion[r.d0 as string] / exp.v1.revenue, 1e-9)
    }
  })

  it('FIXED ignores dimension filters; a context filter applies before it', async () => {
    const calcs = [calc('Total', '{FIXED : SUM([revenue])}')]
    const f = { id: 'f', field: 'region', op: 'in' as const, values: ['Virginia'] }
    const plain = await run({ enc: { x: [dim('region')], y: [{ field: 'Total', agg: 'max' }] }, filters: [f] }, calcs)
    near(plain[0].m0, exp.v1.revenue)
    const ctx = await run({ enc: { x: [dim('region')], y: [{ field: 'Total', agg: 'max' }] }, filters: [{ ...f, context: true }] }, calcs)
    near(ctx[0].m0, exp.v1.revenueByRegion.Virginia)
  })

  it('FIXED as a dimension: customers by month of first purchase (cohorts)', async () => {
    const out = await run({ enc: { x: [dim('First month')], y: [{ field: 'customer_id', agg: 'countd' }] } }, [calc('First month', "DATETRUNC('month', {FIXED [customer_id] : MIN([order_date])})")])
    const ref = await rows(engine, "SELECT date_trunc('month', f) m, count(*) n FROM (SELECT customer_id, min(order_date) f FROM sales GROUP BY 1) GROUP BY 1 ORDER BY 1")
    expect(out.map((r) => Number(r.m0))).toEqual(ref.map((r) => Number(r.n)))
  })

  it('EXCLUDE: the region total repeated on each product mark', async () => {
    const out = await run({ enc: { x: [dim('region')], color: dim('product_name'), y: [{ field: 'Region total', agg: 'sum' }] } }, [calc('Region total', '{EXCLUDE [product_name] : SUM([revenue])}')])
    for (const r of out) near(r.m0, exp.v1.revenueByRegion[r.d0 as string])
  })

  it('table calculations: running total, rank, difference, percent of total', async () => {
    const calcs = [calc('Running', 'RUNNING_SUM(SUM([revenue]))'), calc('Pct', 'SUM([revenue]) / TOTAL(SUM([revenue]))'), calc('Prev', 'LOOKUP(SUM([revenue]), -1)')]
    const out = await run({ type: 'line', enc: { x: [dim('order_date', { grain: 'month' })], y: [{ field: 'Running', agg: 'none' }, { field: 'Pct', agg: 'none' }, { field: 'Prev', agg: 'none' }, sum('revenue', { quick: 'rank' })] } }, calcs)
    const months = Object.values(exp.v1.revenueByMonth) as number[]
    let acc = 0
    out.forEach((r, i) => {
      acc += months[i]
      near(r.m0, acc)
      near(r.m1, months[i] / exp.v1.revenue, 1e-9)
      if (i === 0) expect(r.m2).toBeNull()
      else near(r.m2, months[i - 1])
    })
    const ranks = out.map((r) => Number(r.m3))
    expect([...ranks].sort((a, b) => a - b)).toEqual(months.map((_, i) => i + 1))
  })

  it('reports unknown fields and broken formulas in plain words', () => {
    expect(() => compileQuery({ chart: { dataset: 'sales', type: 'bar', filters: [], options: {}, enc: { x: [dim('nope')], y: [], detail: [], tooltip: [] } }, columns: columns(), calcs: [] })).toThrow(/no field “nope”/)
    expect(() => compileQuery({ chart: { dataset: 'sales', type: 'bar', filters: [], options: {}, enc: { x: [], y: [{ field: 'Bad', agg: 'none' }], detail: [], tooltip: [] } }, columns: columns(), calcs: [calc('Bad', '{FIXED [region] SUM([revenue])}')] })).toThrow(/needs a colon/)
    expect(() => compileQuery({ chart: { dataset: 'sales', type: 'bar', filters: [], options: {}, enc: { x: [], y: [{ field: 'Loop', agg: 'sum' }], detail: [], tooltip: [] } }, columns: columns(), calcs: [calc('Loop', '[Loop] + 1')] })).toThrow(/refers to itself/)
  })
})

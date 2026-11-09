// Charts over related tables: measures are never duplicated by joins (fan-out), two fact tables share dimensions,
// a coarser table (targets per region) isn't multiplied, rows without a match form a Null group.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { bootEngine, rows, tmp } from './helpers'
import { compileModelQuery, modelProblems, suggestRelationships } from '../../src/core/query/model'
import { computedSetFormula } from '../../src/core/calc/compile'
import type { Engine } from '../../src/engine/engine'
import type { Model } from '../../src/shared/project'
import type { Chart } from '../../src/shared/charts'

let engine: Engine
const model: Model = {
  id: 'm',
  name: 'Sales model',
  tables: ['orders', 'customers', 'returns', 'targets'].map((name, i) => ({ name, x: i * 200, y: 0 })),
  relationships: [
    { id: 'r1', left: 'orders', leftField: 'customer_id', right: 'customers', rightField: 'customer_id' },
    { id: 'r2', left: 'returns', leftField: 'order_id', right: 'orders', rightField: 'order_id' },
    { id: 'r3', left: 'targets', leftField: 'region', right: 'customers', rightField: 'region' }
  ]
}

beforeAll(async () => {
  const file = path.join(tmp(), 'model.duckdb')
  const i = await DuckDBInstance.create(file)
  const c = await i.connect()
  await c.run(`CREATE TABLE customers AS SELECT * FROM (VALUES (1, 'East', 100.0), (2, 'East', 50.0), (3, 'West', 80.0)) t(customer_id, region, credit)`)
  // order 5 has an unknown customer (9): its revenue shows under a Null region.
  await c.run(`CREATE TABLE orders AS SELECT * FROM (VALUES (1, 1, 'A', 10.0), (2, 1, 'B', 20.0), (3, 2, 'A', 5.0), (4, 3, 'A', 7.0), (5, 9, 'B', 1.0)) t(order_id, customer_id, product, revenue)`)
  await c.run(`CREATE TABLE returns AS SELECT * FROM (VALUES (1, 2.0), (1, 1.0), (4, 3.0)) t(order_id, refund)`)
  await c.run(`CREATE TABLE targets AS SELECT * FROM (VALUES ('East', 1000.0), ('West', 500.0)) t(region, target)`)
  // Role-playing: shipments go from one region to another; one regions table serves both roles.
  await c.run(`CREATE TABLE regions AS SELECT * FROM (VALUES ('East', 'Ann'), ('West', 'Bo')) t(region, manager)`)
  await c.run(`CREATE TABLE shipments AS SELECT * FROM (VALUES ('East', 'West', 5.0), ('East', 'East', 1.0), ('West', 'East', 2.0)) t(from_region, to_region, weight)`)
  c.closeSync()
  i.closeSync()
  ;({ engine } = await bootEngine([{ id: 'db', kind: 'duckdb', path: file, mode: 'extract', timeoutSec: 30, tables: ['customers', 'orders', 'returns', 'targets', 'regions', 'shipments'].map((t) => ({ alias: t, ref: t })) }]))
})
afterAll(() => engine?.close())

const run = async (enc: Partial<Chart['enc']>, filters: Chart['filters'] = [], calcs: Parameters<typeof compileModelQuery>[0]['calcs'] = []) => {
  const columns = Object.fromEntries(engine.describe().relations.map((r) => [r.name.toLowerCase(), r.columns]))
  const q = compileModelQuery({ chart: { type: 'bar', options: {}, filters, enc: { x: [], y: [], detail: [], tooltip: [], ...enc } }, model, columns, calcs })
  return rows(engine, q.sql)
}

describe('models', () => {
  it('sums a fact by a dimension in a related table, with a Null group for unmatched rows', async () => {
    const out = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }] })
    expect(out).toEqual([{ d0: 'East', m0: 35 }, { d0: 'West', m0: 7 }, { d0: null, m0: 1 }])
  })

  it('does not duplicate a measure from the "one" side across the "many" side (fan-out)', async () => {
    // Credit per product: each customer counted once per product they bought, not once per order.
    const out = await run({ x: [{ field: 'orders.product' }], y: [{ field: 'customers.credit', agg: 'sum' }] })
    expect(out).toEqual([{ d0: 'A', m0: 230 }, { d0: 'B', m0: 100 }])
  })

  it('combines two fact tables that share dimensions', async () => {
    const out = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }, { field: 'returns.refund', agg: 'sum' }] })
    expect(out).toEqual([{ d0: 'East', m0: 35, m1: 3 }, { d0: 'West', m0: 7, m1: 3 }, { d0: null, m0: 1, m1: null }])
  })

  it('does not multiply a coarser table (targets per region) by the rows it relates to', async () => {
    const out = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'targets.target', agg: 'sum' }, { field: 'orders.revenue', agg: 'sum' }] })
    expect(out.filter((r) => r.d0)).toEqual([{ d0: 'East', m0: 1000, m1: 35 }, { d0: 'West', m0: 500, m1: 7 }])
  })

  it('applies filters on any related table and to totals', async () => {
    const out = await run({ x: [{ field: 'orders.product' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 'f', field: 'customers.region', op: 'in', values: ['East'] }])
    expect(out).toEqual([{ d0: 'A', m0: 15 }, { d0: 'B', m0: 20 }])
    const big = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 'g', field: 'orders.revenue', agg: 'sum', op: 'between', min: 5, max: null }])
    expect(big.map((r) => r.d0)).toEqual(['East', 'West'])
  })

  it('top N by a measure of another table, computed without duplication', async () => {
    // The best customer by revenue is customer 1 (30): only their orders remain.
    const top = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 't', field: 'customers.customer_id', op: 'top', top: { n: 1, by: { field: 'orders.revenue', agg: 'sum' } } }])
    expect(top).toEqual([{ d0: 'East', m0: 30 }])
    // The product with the most customer credit (A: 230 against B: 100), as a filter on the orders.
    const prod = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 't', field: 'orders.product', op: 'top', top: { n: 1, by: { field: 'customers.credit', agg: 'sum' } } }])
    expect(prod).toEqual([{ d0: 'East', m0: 15 }, { d0: 'West', m0: 7 }])
    // Bottom 2 customers by revenue, with another filter applied first (East only: customers 1 and 2).
    const bottom = await run({ x: [{ field: 'customers.customer_id' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 'e', field: 'customers.region', op: 'in', values: ['East'] }, { id: 'b', field: 'customers.customer_id', op: 'top', top: { n: 1, bottom: true, by: { field: 'orders.revenue', agg: 'sum' } } }])
    expect(bottom).toEqual([{ d0: 2, m0: 5 }])
  })

  it('calculated fields: row-level on one table, aggregates of several tables combined per mark', async () => {
    const calcs = [
      { name: 'Size', formula: "IF [orders.revenue] >= 10 THEN 'big' ELSE 'small' END" },
      { name: 'Double', formula: '[orders.revenue] * 2' },
      { name: 'Refund rate', formula: 'SUM([returns.refund]) / SUM([orders.revenue])' },
      { name: 'Buyers', formula: 'COUNTD([orders.customer_id])' },
      { name: 'Mixed', formula: '[orders.revenue] * [customers.credit]' }
    ]
    expect(await run({ x: [{ field: 'Size' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [], calcs)).toEqual([{ d0: 'big', m0: 30 }, { d0: 'small', m0: 13 }])
    expect(await run({ x: [{ field: 'customers.region' }], y: [{ field: 'Double', agg: 'sum' }] }, [], calcs)).toEqual([{ d0: 'East', m0: 70 }, { d0: 'West', m0: 14 }, { d0: null, m0: 2 }])
    // Refunds per region over revenue per region, each summed at its own table (no duplication by the join).
    const rate = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'Refund rate', agg: 'none' }] }, [], calcs)
    expect(rate.map((r) => [r.d0, r.m0 === null ? null : Math.round(Number(r.m0) * 1e6) / 1e6])).toEqual([['East', Math.round((3 / 35) * 1e6) / 1e6], ['West', Math.round((3 / 7) * 1e6) / 1e6], [null, null]])
    expect(await run({ x: [{ field: 'orders.product' }], y: [{ field: 'Buyers', agg: 'none' }] }, [], calcs)).toEqual([{ d0: 'A', m0: 3 }, { d0: 'B', m0: 2 }])
    // A filter on a calculated field.
    expect(await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 'f', field: 'Size', op: 'in', values: ['big'] }], calcs)).toEqual([{ d0: 'East', m0: 30 }])
    await expect(run({ x: [{ field: 'Mixed' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [], calcs)).rejects.toThrow(/reads one table/)
  })

  it('role-playing: one table in two roles (origin and destination regions)', async () => {
    const roles: Model = {
      id: 'r',
      name: 'Shipping',
      tables: [{ name: 'shipments', x: 0, y: 0 }, { name: 'origin', source: 'regions', x: 0, y: 0 }, { name: 'destination', source: 'regions', x: 0, y: 0 }],
      relationships: [
        { id: 'a', left: 'shipments', leftField: 'from_region', right: 'origin', rightField: 'region' },
        { id: 'b', left: 'shipments', leftField: 'to_region', right: 'destination', rightField: 'region' }
      ]
    }
    const columns = Object.fromEntries(engine.describe().relations.map((r) => [r.name.toLowerCase(), r.columns]))
    const q = (enc: Partial<Chart['enc']>) => rows(engine, compileModelQuery({ chart: { type: 'bar', options: {}, filters: [], enc: { x: [], y: [], detail: [], tooltip: [], ...enc } }, model: roles, columns }).sql)
    expect(await q({ x: [{ field: 'origin.manager' }], y: [{ field: 'shipments.weight', agg: 'sum' }] })).toEqual([{ d0: 'Ann', m0: 6 }, { d0: 'Bo', m0: 2 }])
    expect(await q({ x: [{ field: 'destination.manager' }], y: [{ field: 'shipments.weight', agg: 'sum' }] })).toEqual([{ d0: 'Ann', m0: 3 }, { d0: 'Bo', m0: 5 }])
    // Both roles at once: from Ann to Bo is the 5.
    const both = await q({ x: [{ field: 'origin.manager' }, { field: 'destination.manager' }], y: [{ field: 'shipments.weight', agg: 'sum' }] })
    expect(both.sort((a, b) => `${a.d0}${a.d1}`.localeCompare(`${b.d0}${b.d1}`))).toEqual([
      { d0: 'Ann', d1: 'Ann', m0: 1 },
      { d0: 'Ann', d1: 'Bo', m0: 5 },
      { d0: 'Bo', d1: 'Ann', m0: 2 }
    ])
    expect(modelProblems(roles)).toEqual([])
  })

  it('level of detail on a model: FIXED row by row and aggregated, INCLUDE, EXCLUDE (Tableau’s rules)', async () => {
    const lod = { name: 'Customer revenue', formula: '{FIXED [customers.customer_id] : SUM([orders.revenue])}' }
    // Aggregated: one value per customer (30, 5 | 7 | the unmatched order's 1), averaged per region.
    expect(await run({ x: [{ field: 'customers.region' }], y: [{ field: 'Customer revenue', agg: 'avg' }] }, [], [lod])).toEqual([{ d0: 'East', m0: 17.5 }, { d0: 'West', m0: 7 }, { d0: null, m0: 1 }])
    // Row by row: a dimension of customers.
    const big = { name: 'Size', formula: "IF {FIXED [customers.customer_id] : SUM([orders.revenue])} >= 10 THEN 'Big' ELSE 'Small' END" }
    expect(await run({ x: [{ field: 'Size' }], y: [{ field: 'customers.credit', agg: 'sum' }] }, [], [big])).toEqual([{ d0: 'Big', m0: 100 }, { d0: 'Small', m0: 130 }])
    // FIXED ignores dimension filters (the customer's total over all products); the marks are still filtered.
    const onlyB = [{ id: 'f', field: 'orders.product', op: 'in' as const, values: ['B'] }]
    expect(await run({ x: [{ field: 'customers.region' }], y: [{ field: 'Customer revenue', agg: 'max' }] }, onlyB, [lod])).toEqual([{ d0: 'East', m0: 30 }, { d0: null, m0: 1 }])
    // INCLUDE: average order per region (orders 10, 20, 5 | 7 | the unmatched order 1).
    const perOrder = { name: 'Avg order', formula: 'AVG({INCLUDE [orders.order_id] : SUM([orders.revenue])})' }
    const inc = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'Avg order' }] }, [], [perOrder])
    expect(inc.map((r) => [r.d0, Math.round(Number(r.m0) * 1e6) / 1e6])).toEqual([['East', 11.666667], ['West', 7], [null, 1]])
    // EXCLUDE: the region's total on every product of the region.
    const regionTotal = { name: 'Region total', formula: 'MAX({EXCLUDE [orders.product] : SUM([orders.revenue])})' }
    const exc = await run({ x: [{ field: 'customers.region' }, { field: 'orders.product' }], y: [{ field: 'orders.revenue', agg: 'sum' }, { field: 'Region total' }] }, [], [regionTotal])
    expect(exc).toEqual([{ d0: 'East', d1: 'A', m0: 15, m1: 35 }, { d0: 'East', d1: 'B', m0: 20, m1: 35 }, { d0: 'West', d1: 'A', m0: 7, m1: 7 }, { d0: null, d1: 'B', m0: 1, m1: 1 }])
    // INCLUDE/EXCLUDE depend on the view, so they can't be a dimension.
    await expect(run({ x: [{ field: 'Bad' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [], [{ name: 'Bad', formula: '{INCLUDE [orders.order_id] : SUM([orders.revenue])}' }])).rejects.toThrow(/INCLUDE and EXCLUDE/)
  })

  it('table calculations and quick calculations on a model: windows over the marks', async () => {
    const running = { name: 'Running', formula: 'RUNNING_SUM(SUM([orders.revenue]))' }
    const share = { name: 'Share', formula: 'SUM([orders.revenue]) / WINDOW_SUM(SUM([orders.revenue]))' }
    const out = await run({ x: [{ field: 'customers.region' }], y: [{ field: 'Running' }, { field: 'Share' }, { field: 'orders.revenue', agg: 'sum', quick: 'rank' }] }, [], [running, share])
    expect(out.map((r) => [r.d0, r.m0, Math.round(Number(r.m1) * 1000) / 1000, r.m2])).toEqual([['East', 35, 0.814, 1], ['West', 42, 0.163, 2], [null, 43, 0.023, 3]])
    // Within each pane: running sums restart for each product (color).
    const byProduct = await run({ x: [{ field: 'customers.region' }], color: { field: 'orders.product' }, y: [{ field: 'Running' }] }, [], [running])
    expect(byProduct.filter((r) => r.d1 === 'A').map((r) => r.m0)).toEqual([15, 22])
  })

  it('computed sets on a model: top N and conditions, measures not duplicated by joins', async () => {
    const top = { id: 'top1', name: 'Top customer', formula: computedSetFormula('customers.customer_id', 'top1'), set: { field: 'customers.customer_id', values: [], top: { n: 1, by: 'orders.revenue', agg: 'sum' as const } } }
    expect(await run({ x: [{ field: 'Top customer' }], y: [{ field: 'customers.credit', agg: 'sum' }] }, [], [top])).toEqual([{ d0: 'In', m0: 100 }, { d0: 'Out', m0: 130 }])
    const cond = { id: 'c1', name: 'Busy regions', formula: computedSetFormula('customers.region', 'c1'), set: { field: 'customers.region', values: [], condition: 'COUNT([orders.order_id]) >= 3' } }
    expect(await run({ x: [{ field: 'customers.region' }], y: [{ field: 'orders.revenue', agg: 'sum' }] }, [{ id: 'f', field: 'Busy regions', op: 'in', values: ['In'] }], [cond])).toEqual([{ d0: 'East', m0: 35 }])
  })

  it('explains missing relationships, loops and suggestions', async () => {
    const lone: Model = { ...model, tables: [...model.tables, { name: 'other', x: 0, y: 0 }] }
    expect(modelProblems(lone)).toEqual(['other isn’t related to any other table yet.'])
    expect(modelProblems({ ...model, relationships: [...model.relationships, { id: 'x', left: 'returns', leftField: 'order_id', right: 'customers', rightField: 'customer_id' }] })[0]).toMatch(/loop/)
    const rel = engine.describe().relations
    const cols = (n: string) => rel.find((r) => r.name === n)!.columns
    expect(suggestRelationships({ name: 'orders', columns: cols('orders') }, { name: 'customers', columns: cols('customers') })).toEqual([{ leftField: 'customer_id', rightField: 'customer_id', why: 'Same name' }])
  })
})

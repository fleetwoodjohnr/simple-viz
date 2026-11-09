// Charts over related tables: measures are never duplicated by joins (fan-out), two fact tables share dimensions,
// a coarser table (targets per region) isn't multiplied, rows without a match form a Null group.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { bootEngine, rows, tmp } from './helpers'
import { compileModelQuery, modelProblems, suggestRelationships } from '../../src/core/query/model'
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
  c.closeSync()
  i.closeSync()
  ;({ engine } = await bootEngine([{ id: 'db', kind: 'duckdb', path: file, mode: 'extract', timeoutSec: 30, tables: ['customers', 'orders', 'returns', 'targets'].map((t) => ({ alias: t, ref: t })) }]))
})
afterAll(() => engine?.close())

const run = async (enc: Partial<Chart['enc']>, filters: Chart['filters'] = []) => {
  const columns = Object.fromEntries(engine.describe().relations.map((r) => [r.name.toLowerCase(), r.columns]))
  const q = compileModelQuery({ chart: { type: 'bar', options: {}, filters, enc: { x: [], y: [], detail: [], tooltip: [], ...enc } }, model, columns })
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

  it('explains missing relationships, loops and suggestions', async () => {
    const lone: Model = { ...model, tables: [...model.tables, { name: 'other', x: 0, y: 0 }] }
    expect(modelProblems(lone)).toEqual(['other isn’t related to any other table yet.'])
    expect(modelProblems({ ...model, relationships: [...model.relationships, { id: 'x', left: 'returns', leftField: 'order_id', right: 'customers', rightField: 'customer_id' }] })[0]).toMatch(/loop/)
    const rel = engine.describe().relations
    const cols = (n: string) => rel.find((r) => r.name === n)!.columns
    expect(suggestRelationships({ name: 'orders', columns: cols('orders') }, { name: 'customers', columns: cols('customers') })).toEqual([{ leftField: 'customer_id', rightField: 'customer_id', why: 'Same name' }])
  })
})

// Visual transform steps run through the engine (and its SQL gate) on the fixture data.
import { it, expect, beforeAll, afterAll } from 'vitest'
import { bootEngine, fileSource, fixture, rows, expected } from './helpers'
import { transformSql, dateTableSql } from '../../src/core/transform'
import type { Engine } from '../../src/engine/engine'
import type { TransformStep } from '../../src/shared/project'

let engine: Engine
let n = 0
const step = <T extends TransformStep['kind']>(kind: T, rest: Omit<Extract<TransformStep, { kind: T }>, 'id' | 'kind'>) => ({ id: `s${n++}`, kind, ...rest }) as unknown as TransformStep

beforeAll(async () => {
  ;({ engine } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), fileSource('c', fixture('customers.csv'), 'csv', [{ alias: 'customers' }])]))
})
afterAll(() => engine?.close())

it('filter, calculated column, join, group, sort', async () => {
  const sql = transformSql('transactions', [
    step('filter', { column: 'revenue', op: '>', value: '1000' }),
    step('calc', { name: 'profit', expr: 'revenue - cost' }),
    step('join', { with: 'customers', type: 'left', on: [{ left: 'customer_id', right: 'customer_id' }] }),
    step('group', { by: ['region'], aggs: [{ column: 'profit', fn: 'sum', as: 'profit' }, { column: 'order_id', fn: 'count', as: 'orders' }] }),
    step('sort', { column: 'profit', dir: 'desc' })
  ])
  const out = await rows(engine, sql)
  const ref = await rows(engine, `SELECT c.region, sum(t.revenue - t.cost) AS profit, count(*) AS orders FROM transactions t LEFT JOIN customers c USING (customer_id) WHERE t.revenue > 1000 GROUP BY 1 ORDER BY 2 DESC`)
  expect(out.map((r) => [r.region, Math.round(Number(r.profit)), r.orders])).toEqual(ref.map((r) => [r.region, Math.round(Number(r.profit)), r.orders]))
})

it('rename, keep columns, change type, fill, clean text, split, dedupe', async () => {
  const sql = transformSql('customers', [
    step('rename', { from: 'customer_name', to: 'name' }),
    step('text', { column: 'name', fn: 'upper' }),
    step('split', { column: 'name', sep: ' ', into: ['first', 'number'] }),
    step('cast', { column: 'number', type: 'INTEGER' }),
    step('fill', { column: 'segment', value: 'Unknown' }),
    step('select', { columns: ['region', 'segment', 'number'] }),
    step('dedupe', { columns: ['region'] })
  ])
  const out = await rows(engine, sql)
  expect(out.length).toBe(expected().regions.length)
  expect(Object.keys(out[0])).toEqual(['region', 'segment', 'number'])
  expect(typeof out[0].number).toBe('number')
})

it('pivot, unpivot, append, custom SQL, date table', async () => {
  const pivot = await rows(engine, transformSql('customers', [step('pivot', { column: 'segment', value: 'customer_id', fn: 'count', values: ['Consumer', 'Corporate', 'Small Business'] })]).replace('SELECT * FROM s1', 'SELECT * FROM s1 ORDER BY region'))
  const total = pivot.reduce((a, r) => a + Number(r.Consumer) + Number(r.Corporate) + Number(r['Small Business']), 0)
  expect(total).toBe(expected().customers)
  const unpivot = await rows(engine, transformSql('transactions', [step('select', { columns: ['order_id', 'revenue', 'cost'] }), step('unpivot', { columns: ['revenue', 'cost'], name: 'measure', value: 'amount' })]))
  expect(unpivot.length).toBe(2000)
  const appended = await rows(engine, transformSql('customers', [step('union', { with: 'customers' })]))
  expect(appended.length).toBe(2 * expected().customers)
  const custom = await rows(engine, transformSql('transactions', [step('sql', { sql: 'SELECT product_name, count(*) AS n FROM previous GROUP BY 1' })]))
  expect(custom.reduce((a, r) => a + Number(r.n), 0)).toBe(1000)
  const dates = await rows(engine, dateTableSql('2025-01-01', '2025-12-31'))
  expect(dates.length).toBe(365)
  expect(dates[0]).toMatchObject({ year: 2025, quarter: 1, month: 1 })
})

it('a step that reads files or other projects is refused by the gate', async () => {
  await expect(engine.query(1, transformSql('transactions', [step('sql', { sql: "SELECT * FROM read_csv('/etc/passwd')" })]))).rejects.toThrow(/read_csv/)
})

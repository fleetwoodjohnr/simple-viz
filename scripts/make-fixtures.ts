// Builds the test and example data (npm run fixtures):
//   tests/fixtures/Sales.xlsx         sheet "Transactions", 1,000 orders
//   tests/fixtures/Sales-v2.xlsx      the same workbook after 500 more orders (the refresh test copies it over Sales.xlsx)
//   tests/fixtures/customers.sql      PostgreSQL table customers(customer_id, customer_name, region, segment)
//   tests/fixtures/customers.csv      the same customers, for tests without a database
//   tests/fixtures/expected.json      totals the tests assert, computed here independently of DuckDB
// Deterministic: the same files every run.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { rowsToXlsx } from '../src/core/sheets/fromRows'

const out = path.resolve(import.meta.dirname, '..', 'tests', 'fixtures')
mkdirSync(out, { recursive: true })

// mulberry32: small, seeded, reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const REGIONS = ['Virginia', 'California', 'Texas', 'New York', 'Florida', 'Washington']
const SEGMENTS = ['Consumer', 'Corporate', 'Small Business']
const PRODUCTS: [string, number, number][] = [
  ['Laptop', 1400, 0.72],
  ['Monitor', 320, 0.65],
  ['Keyboard', 85, 0.55],
  ['Desk', 650, 0.6],
  ['Chair', 420, 0.58],
  ['Headset', 140, 0.5],
  ['Server', 9800, 0.78],
  ['Software license', 2400, 0.3]
]

const r = rng(42)
const customers = Array.from({ length: 120 }, (_, i) => ({
  customer_id: 1001 + i,
  customer_name: `Customer ${String(i + 1).padStart(3, '0')}`,
  region: REGIONS[i % REGIONS.length],
  segment: SEGMENTS[Math.floor(r() * SEGMENTS.length)]
}))

type Order = { order_id: number; order_date: string; customer_id: number; product_name: string; quantity: number; revenue: number; cost: number }
const orders: Order[] = []
for (let i = 0; i < 1500; i++) {
  const [name, price, costRatio] = PRODUCTS[Math.floor(r() * PRODUCTS.length)]
  const quantity = 1 + Math.floor(r() * 8)
  const revenue = Math.round(price * quantity * (0.85 + r() * 0.3) * 100) / 100
  const cost = Math.round(revenue * costRatio * (0.9 + r() * 0.2) * 100) / 100
  // The first 1,000 orders are in 2025; the 500 added later run into 2026.
  const day = i < 1000 ? Math.floor((i / 1000) * 365) : 365 + Math.floor(((i - 1000) / 500) * 120)
  const d = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000)
  orders.push({ order_id: 50001 + i, order_date: d.toISOString().slice(0, 10), customer_id: customers[Math.floor(r() * customers.length)].customer_id, product_name: name, quantity, revenue, cost })
}

const cols = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'order_date', type: 'DATE' },
  { name: 'customer_id', type: 'BIGINT' },
  { name: 'product_name', type: 'VARCHAR' },
  { name: 'quantity', type: 'BIGINT' },
  { name: 'revenue', type: 'DOUBLE' },
  { name: 'cost', type: 'DOUBLE' }
]
const toRows = (list: Order[]) => list.map((o) => [o.order_id, o.order_date, o.customer_id, o.product_name, o.quantity, o.revenue, o.cost])
writeFileSync(path.join(out, 'Sales.xlsx'), rowsToXlsx(cols, toRows(orders.slice(0, 1000)), 'Transactions'))
writeFileSync(path.join(out, 'Sales-v2.xlsx'), rowsToXlsx(cols, toRows(orders), 'Transactions'))

const esc = (s: string) => s.replace(/'/g, "''")
writeFileSync(
  path.join(out, 'customers.sql'),
  `DROP TABLE IF EXISTS customers;\nCREATE TABLE customers (customer_id integer PRIMARY KEY, customer_name text NOT NULL, region text NOT NULL, segment text NOT NULL);\nINSERT INTO customers VALUES\n${customers.map((c) => `(${c.customer_id}, '${esc(c.customer_name)}', '${esc(c.region)}', '${esc(c.segment)}')`).join(',\n')};\n`
)
writeFileSync(path.join(out, 'customers.csv'), `customer_id,customer_name,region,segment\n${customers.map((c) => `${c.customer_id},${c.customer_name},${c.region},${c.segment}`).join('\n')}\n`)

const round = (n: number) => Math.round(n * 100) / 100
function totals(list: Order[]) {
  const region = Object.fromEntries(REGIONS.map((x) => [x, 0]))
  const month: Record<string, number> = {}
  let revenue = 0
  let profit = 0
  for (const o of list) {
    revenue += o.revenue
    profit += o.revenue - o.cost
    region[customers.find((c) => c.customer_id === o.customer_id)!.region] += o.revenue
    const m = o.order_date.slice(0, 7)
    month[m] = (month[m] ?? 0) + o.revenue
  }
  return { rows: list.length, revenue: round(revenue), profit: round(profit), revenueByRegion: Object.fromEntries(Object.entries(region).map(([k, v]) => [k, round(v)])), revenueByMonth: Object.fromEntries(Object.entries(month).sort().map(([k, v]) => [k, round(v)])) }
}
writeFileSync(path.join(out, 'expected.json'), JSON.stringify({ v1: totals(orders.slice(0, 1000)), v2: totals(orders), customers: customers.length, regions: REGIONS }, null, 2) + '\n')
console.log(`Wrote fixtures to ${path.relative(process.cwd(), out)}`)

// ---------------------------------------------------------------- statistics fixtures (reference values: stats-ref.py)
{
  const r2 = rng(7)
  const normal = () => Math.sqrt(-2 * Math.log(1 - r2())) * Math.cos(2 * Math.PI * r2())
  const lines = ['id,x1,x2,y,grp,y2,cat,b,before,after']
  for (let i = 0; i < 500; i++) {
    const x1 = normal()
    const x2 = 10 * r2()
    const y = 3 + 2 * x1 - 1.5 * x2 + 2 * normal()
    const grp = ['A', 'B', 'C'][i % 3]
    const y2 = 10 + { A: 0, B: 1.2, C: 2.5 }[grp]! + 3 * normal() + (grp === 'C' ? 2 * Math.abs(normal()) : 0)
    const cat = r2() < ({ A: 0.6, B: 0.4, C: 0.2 } as Record<string, number>)[grp] ? 'Red' : r2() < 0.5 ? 'Green' : 'Blue'
    const b = r2() < 1 / (1 + Math.exp(-(0.5 + 1.2 * x1 - 0.3 * x2))) ? 1 : 0
    const before = 50 + 10 * normal()
    const after = before + 0.8 + 3 * normal()
    const f = (v: number) => v.toFixed(6)
    lines.push([i + 1, f(x1), i % 97 === 5 ? '' : f(x2), f(y), grp, f(y2), cat, b, f(before), f(after)].join(','))
  }
  writeFileSync(path.join(out, 'stats.csv'), lines.join('\n') + '\n')
  const series = ['month,sales']
  for (let t = 0; t < 60; t++) {
    const d = new Date(Date.UTC(2020, t, 1)).toISOString().slice(0, 10)
    series.push(`${d},${(100 + 2 * t + 15 * Math.sin((2 * Math.PI * t) / 12) + 4 * normal()).toFixed(4)}`)
  }
  writeFileSync(path.join(out, 'series.csv'), series.join('\n') + '\n')
}

// A messy sheet for the table finder: a title and a note around one table, and a second table further down.
{
  const { Workbook } = await import('../src/core/sheets/model/workbook')
  const { writeXlsx } = await import('../src/core/sheets/formats/xlsx/write')
  const wb = new Workbook()
  const s = wb.addSheet('Report')
  const cells: (string | number | null)[][] = [
    ['Quarterly sales report', null, null, null],
    ['Prepared by Finance', null, null, null],
    [null, null, null, null],
    [null, 'Region', 'Q1', 'Q2'],
    [null, 'East', 10, 12],
    [null, 'West', 7, 9],
    ['Source: ledger', null, null, null],
    [null, null, null, null],
    [null, null, null, null],
    ['Product', 'Units', null, null],
    ['A', 5, null, null],
    ['B', 6, null, null],
    ['C', 7, null, null]
  ]
  cells.forEach((r, i) => r.forEach((v, j) => v !== null && s.set(i, j, { v })))
  writeFileSync(path.join(out, 'messy.xlsx'), writeXlsx(wb).data)
}

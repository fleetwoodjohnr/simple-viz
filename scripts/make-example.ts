// Builds the example project shipped with the app (npm run example): resources/examples/ holds the sales workbook,
// the customer list and example.json, a project whose source paths start with ${EXAMPLES}. Home → "Open the example"
// copies the folder into the user's data folder, puts that path in, and opens it.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_REFRESH, PROJECT_SCHEMA_VERSION, type Project } from '../src/shared/project'
import type { Chart, FieldRef } from '../src/shared/charts'
import type { DashItem } from '../src/shared/dashboards'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'resources', 'examples')
mkdirSync(out, { recursive: true })
copyFileSync(path.join(root, 'tests', 'fixtures', 'Sales.xlsx'), path.join(out, 'Sales.xlsx'))
copyFileSync(path.join(root, 'tests', 'fixtures', 'customers.csv'), path.join(out, 'customers.csv'))

const SALES_SQL = `SELECT t.order_id, t.order_date, t.customer_id, c.customer_name, c.region, c.segment, t.product_name, t.quantity,
  t.revenue, t.cost, t.revenue - t.cost AS profit
FROM transactions t LEFT JOIN customers c USING (customer_id)`

const dim = (field: string, extra: Partial<FieldRef> = {}): FieldRef => ({ field, ...extra })
const sum = (field: string, format?: string): FieldRef => ({ field, agg: 'sum', ...(format ? { format } : {}) })
let n = 0
const chart = (name: string, type: string, enc: Partial<Chart['enc']>, options: Chart['options'] = {}): Chart => ({
  id: `example-chart-${++n}`,
  name,
  dataset: 'sales',
  type,
  enc: { x: [], y: [], detail: [], tooltip: [], ...enc },
  filters: [],
  options,
  updatedAt: 0
})

const MONEY = '$#,##0'
const charts = [
  chart('Profit', 'kpi', { y: [sum('profit', MONEY), sum('revenue', MONEY)] }, { title: 'Profit' }),
  chart('Revenue by region', 'bar', { x: [dim('region')], y: [sum('revenue', MONEY)] }, { sort: { by: 'value', dir: 'desc' }, refLines: [{ id: 'avg', kind: 'average' }] }),
  chart('Revenue by month', 'line', { x: [dim('order_date', { grain: 'month' })], y: [sum('revenue', MONEY)] }, { forecast: { periods: 3 } }),
  chart('Revenue by state', 'map', { x: [dim('region')], y: [sum('revenue', MONEY)] }, { map: 'us-states' }),
  chart('Profit by product', 'bar', { x: [dim('product_name')], y: [sum('profit', MONEY)] }, { horizontal: true, sort: { by: 'value', dir: 'desc' } })
]

const item = (id: string, kind: DashItem['kind'], x: number, y: number, w: number, h: number, extra: Partial<DashItem> = {}): DashItem => ({ id, kind, x, y, w, h, ...extra })
const items: DashItem[] = [
  item('example-title', 'text', 24, 16, 640, 48, { text: 'Sales overview — {region}', textStyle: { size: 22, bold: true } }),
  item('example-filter', 'filter', 1040, 8, 304, 64, { filter: { field: 'region', mode: 'dropdown', title: 'Region', multi: true } }),
  item('example-kpi', 'chart', 24, 80, 320, 160, { chartId: charts[0].id }),
  item('example-region', 'chart', 360, 80, 480, 320, { chartId: charts[1].id }),
  item('example-map', 'chart', 856, 80, 488, 320, { chartId: charts[3].id }),
  item('example-kpi-note', 'text', 24, 256, 320, 144, { text: 'Switch to View (top of the dashboard), then click a region on the bars or the map to filter everything else. Click it again to clear.', textStyle: { size: 13 } }),
  item('example-month', 'chart', 24, 416, 816, 328, { chartId: charts[2].id }),
  item('example-product', 'chart', 856, 416, 488, 328, { chartId: charts[4].id })
]

const project: Project = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: 'example-sales-overview',
  title: 'Sales example',
  createdAt: 0,
  sources: [
    { id: 'example-sales', kind: 'file', name: 'Sales.xlsx', format: 'xlsx', path: '${EXAMPLES}/Sales.xlsx', tables: [{ alias: 'transactions', ref: 'Transactions' }], refresh: DEFAULT_REFRESH },
    { id: 'example-customers', kind: 'file', name: 'customers.csv', format: 'csv', path: '${EXAMPLES}/customers.csv', tables: [{ alias: 'customers' }], refresh: DEFAULT_REFRESH }
  ],
  datasets: [{ id: 'example-dataset', name: 'sales', sql: SALES_SQL, description: 'Orders with their customer, region and profit' }],
  queries: [{ id: 'example-query', name: 'Revenue and profit by segment', sql: 'SELECT segment, round(sum(revenue)) AS revenue, round(sum(profit)) AS profit\nFROM sales\nGROUP BY segment\nORDER BY revenue DESC' }],
  charts,
  models: [],
  hierarchies: [],
  calcs: [],
  params: [],
  dashboards: [{ id: 'example-dashboard', name: 'Sales overview', size: { mode: 'fit', w: 1366, h: 760 }, items, actions: [{ id: 'example-action', kind: 'filter', source: '*', target: '*' }], updatedAt: 0 }],
  maps: []
}
writeFileSync(path.join(out, 'example.json'), JSON.stringify(project, null, 1))
console.log(`Wrote the example to ${path.relative(root, out)}`)

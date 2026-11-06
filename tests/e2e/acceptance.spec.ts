// The brief's end-to-end acceptance scenario, through the UI of the real app:
// Excel + PostgreSQL → SQL join with profit and customer_segment → dataset → bar, line and KPI charts → dashboard with a
// region filter → save, quit → the workbook changes → reopen: figures refreshed → dark/light → PDF → update check.
// With no PostgreSQL available (Windows/macOS CI), customers come from a CSV instead and the test says so.
import { type Page } from '@playwright/test'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { test, expect, launch, quit, stubDialogs, fixture, tempDir, setSql, chartSeries, MOD } from './helpers'
import { startPostgres, type Pg } from '../integration/helpers'

const exp = JSON.parse(readFileSync(fixture('expected.json'), 'utf8'))
const near = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b)).toBeLessThan(tol)

let pg: Pg | null = null
test.beforeAll(async () => {
  pg = await startPostgres()
  if (!pg) console.warn('Acceptance: no PostgreSQL (SV_PG_HOST or podman); customers come from customers.csv.')
})
test.afterAll(() => pg?.stop())

async function addField(page: Page, field: string, shelf: string) {
  await page.getByTestId(`field-${field}`).hover()
  await page.getByTestId(`field-menu-${field}`).click()
  await page.getByTestId(`add-to-${shelf}`).click()
}

async function newChart(page: Page, name: string) {
  await page.getByTestId(/^new-chart(-empty)?$/).first().click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await page.getByTestId('chart-name').fill(name)
  await page.getByTestId('chart-name').press('Enter')
}

const tile = (page: Page, chart: string) => page.locator(`[data-chart="${chart}"]`)
const kpiValue = async (page: Page) => Number(await tile(page, 'Total profit').getByTestId('kpi-value').getAttribute('data-value'))

test('Excel + PostgreSQL interactive dashboard, refreshed after the workbook changes', async () => {
  test.setTimeout(240_000)
  const dir = tempDir('sv-accept-')
  const sales = path.join(dir, 'Sales.xlsx')
  copyFileSync(fixture('Sales.xlsx'), sales)
  copyFileSync(fixture('customers.csv'), path.join(dir, 'customers.csv'))
  const projectFile = path.join(dir, 'Sales dashboard.sviz')
  const pdf = path.join(dir, 'Sales dashboard.pdf')

  // 1–2. Launch, new project.
  const first = await launch()
  let { app, page } = first
  await page.getByTestId('new-project').click()

  // 3. Import the Excel workbook.
  await stubDialogs(app, { open: [sales] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  await expect(page.getByTestId('relation-transactions')).toBeVisible()

  // 4. Connect to PostgreSQL (or the CSV stand-in).
  if (pg) {
    await page.getByTestId('add-data').click()
    await page.getByTestId('add-postgres').click()
    await page.getByTestId('pg-host').fill(pg.host)
    await page.getByTestId('pg-port').fill(String(pg.port))
    await page.getByTestId('pg-database').fill(pg.database)
    await page.getByTestId('pg-user').fill(pg.user)
    await page.getByTestId('pg-password').fill(pg.password)
    await page.getByTestId('pg-test').click()
    await page.getByText('public.customers').click()
    await page.getByTestId('pg-add').click()
  } else {
    await stubDialogs(app, { open: [path.join(dir, 'customers.csv')] })
    await page.getByTestId('add-data').click()
    await page.getByTestId('add-file').click()
  }
  await expect(page.getByTestId('relation-customers')).toBeVisible()

  // 5. Preview the source tables.
  await page.getByTestId('relation-transactions').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('1,000 rows')
  await page.getByTestId('relation-customers').click()
  await expect(page.getByTestId('relation-rows')).toHaveText(`${exp.customers} rows`)

  // 6–10. SQL editor: join Excel with PostgreSQL, add profit and customer_segment, save as a dataset.
  await page.getByTestId('nav-sql').click()
  await setSql(
    page,
    `SELECT t.order_id, t.order_date, t.customer_id, c.customer_name, c.region, t.product_name, t.revenue, t.cost,
  t.revenue - t.cost AS profit,
  CASE WHEN t.revenue >= 10000 THEN 'High Value' WHEN t.revenue >= 5000 THEN 'Medium Value' ELSE 'Low Value' END AS customer_segment
FROM transactions AS t
LEFT JOIN customers AS c ON t.customer_id = c.customer_id
WHERE t.revenue > 0`
  )
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-rowcount')).toHaveText('1,000')
  await page.getByTestId('save-dataset').click()
  await page.getByTestId('dataset-name').fill('sales_enriched')
  await page.getByTestId('save-dataset-confirm').click()
  await page.waitForFunction(() => (window as any).__sv.get().relations.some((r: { name: string }) => r.name === 'sales_enriched'))

  // 11. Bar chart: revenue by region.
  await page.getByTestId('nav-charts').click()
  await newChart(page, 'Revenue by region')
  await addField(page, 'region', 'x')
  await addField(page, 'revenue', 'y')
  const bars = await chartSeries(page)
  bars.categories.forEach((r, i) => near(bars.series['Sum of revenue'][i], exp.v1.revenueByRegion[r]))

  // 12. Line chart: monthly sales.
  await newChart(page, 'Monthly sales')
  await addField(page, 'order_date', 'x')
  await addField(page, 'revenue', 'y')
  await expect(page.getByTestId('type-line')).toHaveAttribute('aria-checked', 'true')

  // 13. KPI card: total profit.
  await newChart(page, 'Total profit')
  await addField(page, 'profit', 'y')
  await page.getByTestId('type-kpi').click()
  await page.getByTestId('chart-title').fill('Total profit')
  await page.getByTestId('chart-title').blur()
  near(Number(await page.getByTestId('kpi-value').getAttribute('data-value')), exp.v1.profit)

  // 14–15. Dashboard with the three charts and a region filter.
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  for (const name of ['Total profit', 'Revenue by region', 'Monthly sales']) await page.getByTestId(`palette-chart-${name}`).click()
  await page.getByTestId('add-filter').click()
  await page.getByTestId('prompt-input').fill('region')
  await page.getByTestId('prompt-ok').click()
  await page.getByTestId('mode-view').click()
  await expect(page.getByTestId('filter-control-region')).toBeVisible()
  await page.getByTestId('filter-control-region').getByText('Virginia').click()
  await expect.poll(async () => (await chartSeries(page, tile(page, 'Revenue by region'))).categories).toEqual(['Virginia'])
  near((await chartSeries(page, tile(page, 'Revenue by region'))).series['Sum of revenue'][0], exp.v1.revenueByRegion.Virginia)
  await page.getByTestId('filter-control-region').getByText('Clear').click()
  await expect.poll(async () => (await chartSeries(page, tile(page, 'Revenue by region'))).categories.length).toBe(exp.regions.length)

  // 16. Save, quit.
  await stubDialogs(app, { save: projectFile })
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await quit(app)

  // 17. Someone edits the workbook (500 more orders), saving it the way spreadsheet apps do.
  copyFileSync(fixture('Sales-v2.xlsx'), `${sales}.tmp`)
  execFileSync(process.platform === 'win32' ? 'cmd' : 'mv', process.platform === 'win32' ? ['/c', 'move', '/y', `${sales}.tmp`, sales] : [`${sales}.tmp`, sales])

  // A local release feed for step 24 (the updater reads its address at launch).
  const payload = randomBytes(2048)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const feed = `version: 99.0.0\nfiles:\n${['AppImage', 'deb', 'rpm', 'exe', 'zip'].map((x) => `  - url: simple-viz-99.0.0.${x}\n    sha512: ${sha512}\n    size: ${payload.length}`).join('\n')}\npath: simple-viz-99.0.0.zip\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`
  const server = createServer((req, res) => res.end(/latest/.test(req.url ?? '') ? feed : payload))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const appImage = path.join(dir, 'stand-in.AppImage')
  if (process.platform === 'linux') copyFileSync(fixture('customers.csv'), appImage)
  const feedEnv = { SV_UPDATE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...(process.platform === 'linux' ? { APPIMAGE: appImage } : {}) }

  // 18–21. Reopen: the dashboard shows the new figures without any re-import.
  ;({ app, page } = await launch({ userData: first.userData, env: feedEnv }))
  await page.getByTestId('recent-card').first().click()
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('mode-view').click()
  await expect.poll(() => kpiValue(page), { timeout: 30_000 }).toBeCloseTo(exp.v2.profit, 1)
  // Without a system keychain (CI, minimal Linux) the database password lasts one session: enter it again.
  const keychain = await page.evaluate(() => window.simpleViz.credentialStatus())
  if (pg && !keychain.secure) {
    await page.getByTestId('refresh-status').click()
    await page.getByTestId('enter-password').click()
    await page.getByTestId('prompt-input').fill(pg.password)
    await page.getByTestId('prompt-ok').click()
  }
  const refreshed = await chartSeries(page, tile(page, 'Revenue by region'))
  refreshed.categories.forEach((r, i) => near(refreshed.series['Sum of revenue'][i], exp.v2.revenueByRegion[r]))
  await expect(page.getByTestId('refresh-status')).toHaveAttribute('data-state-summary', 'ok', { timeout: 30_000 })
  await page.keyboard.press('Escape')

  if (process.env.SV_SHOTS) await page.screenshot({ path: `${process.env.SV_SHOTS}/dashboard.png` })

  // 22. Dark and light.
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  if (process.env.SV_SHOTS) await page.waitForTimeout(400), await page.screenshot({ path: `${process.env.SV_SHOTS}/dashboard-dark.png` })
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // 23. PDF export.
  await stubDialogs(app, { save: pdf })
  await page.getByTestId('dashboard-export').click()
  await page.getByTestId('export-pdf').click()
  await expect.poll(() => existsSync(pdf) && statSync(pdf).size > 10_000, { timeout: 30_000 }).toBe(true)
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
  if (process.env.SV_SHOTS) copyFileSync(pdf, `${process.env.SV_SHOTS}/dashboard.pdf`)
  try {
    const text = execFileSync('pdftotext', [pdf, '-']).toString()
    expect(text).toContain('Revenue by region')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e // poppler not installed: content check skipped
  }

  // 24. Check for updates against the local release feed (development builds say updates need an installed build).
  try {
    await app.evaluate(({ dialog }) => {
      const log: string[] = []
      ;(globalThis as { svLog?: string[] }).svLog = log
      dialog.showMessageBox = (async (...a: { message: string }[]) => (log.push(a[a.length - 1].message), { response: 1, checkboxChecked: false })) as never
    })
    await page.getByRole('button', { name: 'Settings' }).first().click()
    await page.getByRole('button', { name: 'About and updates' }).click()
    await page.getByTestId('check-updates').click()
    await expect.poll(() => app.evaluate(() => (globalThis as { svLog?: string[] }).svLog?.[0])).toMatch(process.env.SV_PACKAGED ? /is available|up to date/ : /installed builds only/)
  } finally {
    server.close()
  }
  await quit(app)
})

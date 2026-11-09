// M1 workflow through the UI: add an Excel workbook and a CSV, preview, query with SQL, save a dataset, save and reopen.
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, stubDialogs, fixture, tempDir, setSql, sql, MOD } from './helpers'

const shots = process.env.SV_SHOTS

test('import Excel and CSV, query with SQL, save a dataset, save and reopen', async () => {
  const dir = tempDir()
  const sales = path.join(dir, 'Sales.xlsx')
  copyFileSync(fixture('Sales.xlsx'), sales)
  copyFileSync(fixture('customers.csv'), path.join(dir, 'customers.csv'))
  const projectFile = path.join(dir, 'Sales analysis.sviz')
  const { app, page, userData } = await launch()

  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [sales, path.join(dir, 'customers.csv')] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  await expect(page.getByTestId('relation-transactions')).toBeVisible()
  await expect(page.getByTestId('relation-customers')).toBeVisible()
  await page.getByTestId('relation-transactions').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 }) // loads after the refresh
  await expect(page.getByTestId('data-grid')).toContainText('Laptop')
  if (shots) await page.screenshot({ path: `${shots}/data.png` })

  // SQL across both sources, with calculated columns.
  await page.getByTestId('nav-sql').click()
  await setSql(page, `SELECT t.customer_id, c.region, t.revenue, t.cost,\n  t.revenue - t.cost AS profit,\n  CASE WHEN t.revenue >= 10000 THEN 'High Value' WHEN t.revenue >= 5000 THEN 'Medium Value' ELSE 'Low Value' END AS customer_segment\nFROM transactions t LEFT JOIN customers c ON t.customer_id = c.customer_id\nWHERE t.revenue > 0`)
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-rowcount')).toHaveText('1,000')
  if (shots) await page.screenshot({ path: `${shots}/sql.png` })
  await page.getByTestId('save-dataset').click()
  await page.getByTestId('dataset-name').fill('sales_enriched')
  await page.getByTestId('save-dataset-confirm').click()
  await expect(page.getByTestId('toast-success').last()).toContainText('sales_enriched')
  const [r] = await sql(page, 'SELECT count(*) AS n, count(DISTINCT customer_segment) AS segs FROM sales_enriched')
  expect(r.n).toBe(1000)

  // Errors are explained, and the source file is never written.
  await setSql(page, 'DROP VIEW transactions')
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-error')).toContainText('Only queries that read data')

  // Save, quit, reopen: the dataset is still there and answers from the refreshed source.
  await stubDialogs(app, { save: projectFile })
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  expect(existsSync(projectFile)).toBe(true)
  await quit(app)

  const second = await launch({ userData })
  await second.page.getByTestId('recent-card').first().click()
  await expect(second.page.getByTestId('relation-sales_enriched')).toBeVisible()
  await second.page.getByTestId('relation-sales_enriched').click()
  await expect(second.page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 })
  await quit(second.app)
})

// Data modeling through the UI: relate two tables (accepting the suggestion), chart a measure of one by a field of the
// other; and a visual transform with a live preview, its SQL, and "Edit as SQL" that undo reverses.
import { type Page } from '@playwright/test'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect, launch, quit, salesProject, chartSeries, tempDir, sql, MOD } from './helpers'

const exp = JSON.parse(readFileSync(path.resolve('tests/fixtures/expected.json'), 'utf8'))
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01)

async function addField(page: Page, field: string, shelf: string) {
  await page.getByTestId(`field-${field}`).hover()
  await page.getByTestId(`field-menu-${field}`).click()
  await page.getByTestId(`add-to-${shelf}`).click()
}

test('relate tables in a model and chart across them; transform with steps', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())

  // A model: transactions + customers, related by the suggested customer_id.
  await page.getByTestId('nav-data').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-model').click()
  await page.getByTestId('model-add-table').selectOption('transactions')
  await page.getByTestId('model-add-table').selectOption('customers')
  await expect(page.getByTestId('model-problems')).toContainText('isn’t related')
  await page.getByTestId('accept-suggestion').click()
  await expect(page.getByTestId('relationship-stats')).toContainText('many-to-one · 1,000 of 1,000 transactions rows match')
  await expect(page.getByTestId('model-problems')).toHaveCount(0)

  // A chart over the model: revenue (transactions) by region (customers).
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('Model 1')
  await addField(page, 'customers.region', 'x')
  await addField(page, 'transactions.revenue', 'y')
  const bars = await chartSeries(page)
  expect(bars.categories).toEqual([...exp.regions].sort())
  bars.categories.forEach((r, i) => near(bars.series['Sum of revenue'][i], exp.v1.revenueByRegion[r]))
  // A calculated field on the model: each aggregate at its own table, combined per region.
  await page.getByTestId('new-calc').click()
  await page.getByTestId('calc-name').fill('Margin')
  await page.getByTestId('calc-formula').fill('SUM([transactions.revenue] - [transactions.cost]) / SUM([transactions.revenue])')
  await expect(page.getByTestId('calc-status')).toContainText('Valid. Aggregate')
  await page.getByTestId('calc-save').click()
  const margin = await sql(page, 'SELECT c.region, sum(t.revenue - t.cost) / sum(t.revenue) AS m FROM transactions t JOIN customers c USING (customer_id) GROUP BY 1')
  await expect.poll(async () => Object.keys((await chartSeries(page)).series)).toContain('Margin')
  const withMargin = await chartSeries(page)
  for (const r of margin) near(withMargin.series.Margin[withMargin.categories.indexOf(String(r.region))], Number(r.m))

  // A visual transform: transactions with revenue over 1,000.
  await page.getByTestId('nav-data').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-transform').click()
  await page.getByTestId('transform-input').selectOption('transactions')
  await page.getByTestId('add-step').click()
  await page.getByTestId('step-filter').click()
  const form = page.getByTestId('step-form')
  await form.getByLabel('Column').selectOption('revenue')
  await form.getByLabel('Condition').selectOption('>')
  await form.getByPlaceholder('Value').fill('1000')
  await form.getByPlaceholder('Value').blur()
  const [ref] = await sql(page, 'SELECT count(*) AS n FROM transactions WHERE revenue > 1000')
  await expect(page.getByText(`${Number(ref.n).toLocaleString()} rows after step 1`)).toBeVisible()
  await page.getByTestId('transform-tab-sql').click()
  await expect(page.getByTestId('transform-sql')).toContainText('WHERE "revenue" > 1000')
  // The transform is a dataset: queryable by name.
  const [t] = await sql(page, 'SELECT count(*) AS n FROM transform')
  expect(t.n).toBe(ref.n)
  // Edit as SQL keeps the work; undo brings the steps back.
  await page.getByTestId('edit-as-sql').click()
  await expect(page.getByTestId('transform-editor')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('transform-editor')).toBeVisible()
  await quit(app)
})

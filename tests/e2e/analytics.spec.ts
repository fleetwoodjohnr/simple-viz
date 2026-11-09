// The Analytics workspace through the UI: descriptive statistics, regression, forecasting and clustering on the sales
// data, each checked against SQL computed independently; clusters saved as a dataset; results exported; and a
// forecast overlay on a line chart.
import { type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, chartSeries, tempDir, sql, stubDialogs } from './helpers'

const cell = async (page: Page, table: number, col: string, row = 0) => {
  const t = page.getByTestId('analysis-table').nth(table)
  const headers = await t.locator('thead th').allInnerTexts()
  return (await t.locator('tbody tr').nth(row).locator('td').nth(headers.indexOf(col)).innerText()).replace(/,/g, '')
}

async function pickAnalysis(page: Page, kind: string) {
  await page.getByTestId(`analysis-${kind}`).click()
  await page.getByTestId('analysis-dataset').selectOption('sales_enriched')
}

test('statistics, forecast and clusters in the Analytics workspace; forecast overlay on a chart', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  const dir = tempDir()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-analytics').click()

  // Descriptive statistics of revenue: mean and median as computed by SQL.
  await pickAnalysis(page, 'describe')
  await page.getByTestId('analysis-columns').getByText('revenue', { exact: true }).click()
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-summary')).toContainText('revenue has a mean of')
  const [d] = await sql(page, 'SELECT avg(revenue) AS m, median(revenue) AS md, count(revenue) AS n FROM sales_enriched')
  expect(Math.abs(Number(await cell(page, 0, 'Mean')) - Number(d.m))).toBeLessThan(1e-3)
  expect(Math.abs(Number(await cell(page, 0, 'Median')) - Number(d.md))).toBeLessThan(1e-3)
  expect(Number(await cell(page, 0, 'N'))).toBe(Number(d.n))
  await expect(page.getByTestId('analysis-chart')).toBeVisible()

  // Simple regression of profit on revenue: slope and R² as DuckDB's regr_* aggregates give them.
  await pickAnalysis(page, 'regression')
  await page.getByTestId('analysis-y').selectOption('profit')
  await page.getByTestId('analysis-x').getByText('revenue', { exact: true }).click()
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-result')).toContainText('Simple linear regression')
  const [r] = await sql(page, 'SELECT regr_slope(profit, revenue) AS b, regr_r2(profit, revenue) AS r2 FROM sales_enriched')
  const slope = page.getByTestId('analysis-table').first().locator('tbody tr').nth(1).locator('td').nth(1)
  expect(Math.abs(Number((await slope.innerText()).replace(/,/g, '')) - Number(r.b))).toBeLessThan(1e-4)
  expect(Math.abs(Number(await cell(page, 1, 'R²')) - Number(r.r2))).toBeLessThan(1e-4)
  await expect(page.getByTestId('analysis-n')).toContainText('1,000 used')

  // An analysis that cannot run explains why.
  await pickAnalysis(page, 'anova')
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-error')).toContainText('Choose a numeric column and a grouping column')

  // Forecast of monthly revenue: 12 months of history, 12 ahead.
  await pickAnalysis(page, 'forecast')
  await page.getByTestId('analysis-date').selectOption('order_date')
  await page.getByTestId('analysis-y').selectOption('revenue')
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-summary')).toContainText('The next month is forecast at')
  await expect(page.getByTestId('analysis-table').first().locator('tbody tr')).toHaveCount(12)
  expect(await cell(page, 0, 'Period')).toBe('2026-01-01')
  // The same with ARIMA: orders chosen stepwise.
  await page.getByRole('radio', { name: 'ARIMA' }).click()
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-summary')).toContainText(/ARIMA\(\d,\d,\d\).* fits best/)
  await expect(page.getByTestId('analysis-table').first().locator('tbody tr')).toHaveCount(12)
  await page.getByRole('radio', { name: 'Exponential smoothing' }).click()
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-summary')).not.toContainText('ARIMA')

  // Export the results as CSV.
  const csv = path.join(dir, 'forecast.csv')
  await stubDialogs(app, { save: csv })
  await page.getByTestId('analysis-export').click()
  await expect.poll(() => { try { return readFileSync(csv, 'utf8') } catch { return '' } }).toContain('Period,Forecast')

  // K-means with 3 clusters, saved as a dataset that labels every row.
  await pickAnalysis(page, 'kmeans')
  await page.getByTestId('analysis-columns').getByText('revenue', { exact: true }).click()
  await page.getByTestId('analysis-columns').getByText('cost', { exact: true }).click()
  await page.getByLabel('Number of clusters').fill('3')
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-table').first().locator('tbody tr')).toHaveCount(3)
  await page.getByTestId('save-clusters').click()
  await page.waitForFunction(() => (window as any).__sv.get().relations.some((r: { name: string }) => r.name === 'clusters'))
  const groups = await sql(page, 'SELECT cluster, count(*) AS n FROM clusters GROUP BY 1 ORDER BY 1')
  expect(groups.map((g) => Number(g.cluster))).toEqual([1, 2, 3])
  expect(groups.reduce((a, g) => a + Number(g.n), 0)).toBe(1000)

  // A forecast on a monthly line chart: 6 more months, drawn as a separate dashed series.
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  for (const [field, shelf] of [['order_date', 'x'], ['revenue', 'y']]) {
    await page.getByTestId(`field-${field}`).hover()
    await page.getByTestId(`field-menu-${field}`).click()
    await page.getByTestId(`add-to-${shelf}`).click()
  }
  await expect(page.getByTestId('type-line')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('forecast-toggle').check()
  await expect.poll(async () => Object.keys((await chartSeries(page)).series)).toContain('Sum of revenue forecast')
  const s = await chartSeries(page)
  expect(s.categories).toHaveLength(18)
  expect(s.series['Sum of revenue forecast'].slice(12).every((v) => typeof v === 'number')).toBe(true)

  await quit(app)
})

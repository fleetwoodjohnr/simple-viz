// The chart builder through the UI: fields onto shelves, recommended types, a calculated field, a filter, a KPI card;
// drawn values are checked against SQL on the same data, and survive save and reopen.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect, launch, quit, salesProject, chartSeries, tempDir, stubDialogs, sql, MOD } from './helpers'

const exp = JSON.parse(readFileSync(path.resolve('tests/fixtures/expected.json'), 'utf8'))
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01)

async function addField(page: import('@playwright/test').Page, field: string, shelf: string) {
  await page.getByTestId(`field-${field}`).hover()
  await page.getByTestId(`field-menu-${field}`).click()
  await page.getByTestId(`add-to-${shelf}`).click()
}

test('build charts, add a calculation and a filter, save and reopen', async () => {
  const dir = tempDir()
  const { app, page, userData } = await launch()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')

  // Revenue by region: the builder picks a bar chart.
  await addField(page, 'region', 'x')
  await addField(page, 'revenue', 'y')
  await expect(page.getByTestId('type-bar')).toHaveAttribute('aria-checked', 'true')
  const bars = await chartSeries(page)
  expect(bars.categories).toEqual([...exp.regions].sort())
  bars.categories.forEach((r, i) => near(bars.series['Sum of revenue'][i], exp.v1.revenueByRegion[r]))

  // Drag and drop works too: segment onto Color splits the bars.
  await page.getByTestId('field-segment').dragTo(page.getByTestId('shelf-color'))
  await expect(page.getByTestId('pill-color-0')).toHaveText(/segment/)
  expect(Object.keys((await chartSeries(page)).series).length).toBe(3)
  if (process.env.SV_SHOTS) await page.screenshot({ path: `${process.env.SV_SHOTS}/chart-bar.png` })
  await page.getByTestId('pill-color-0').click()
  await page.getByTestId('pill-remove').click()

  // A calculated field (aggregate) as a second measure.
  await page.getByTestId('new-calc').click()
  await page.getByTestId('calc-name').fill('Margin')
  await page.getByTestId('calc-formula').fill('SUM([profit]) / SUM([revenue])')
  await expect(page.getByTestId('calc-status')).toContainText('Valid. Aggregate')
  await page.getByTestId('calc-save').click()
  const ref = await sql(page, 'SELECT region, sum(profit)/sum(revenue) AS m FROM sales_enriched GROUP BY 1 ORDER BY 1')
  await expect.poll(async () => Object.keys((await chartSeries(page)).series)).toContain('Margin')
  const withMargin = await chartSeries(page)
  ref.forEach((r, i) => expect(Math.abs(withMargin.series['Margin'][i] - Number(r.m))).toBeLessThan(1e-9))

  // A filter: only two regions.
  await addField(page, 'region', 'filters')
  await page.getByTestId('filter-values').getByText('Virginia').click()
  await page.getByTestId('filter-values').getByText('Texas').click()
  await page.getByTestId('filter-apply').click()
  await expect.poll(async () => (await chartSeries(page)).categories).toEqual(['Texas', 'Virginia'])

  // Monthly sales line chart.
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'order_date', 'x')
  await addField(page, 'revenue', 'y')
  await expect(page.getByTestId('type-line')).toHaveAttribute('aria-checked', 'true')
  const line = await chartSeries(page)
  expect(line.series['Sum of revenue'].length).toBe(Object.keys(exp.v1.revenueByMonth).length)
  Object.values(exp.v1.revenueByMonth).forEach((v, i) => near(line.series['Sum of revenue'][i], v as number))

  // KPI card: total profit.
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'profit', 'y')
  await page.getByTestId('type-kpi').click()
  const kpi = page.getByTestId('kpi-value')
  await expect(kpi).toHaveAttribute('data-value', /.+/)
  near(Number(await kpi.getAttribute('data-value')), exp.v1.profit)

  // Light and dark: charts take their colors from the theme.
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveClass(/dark/)

  // Save, reopen: the charts are there and draw the same values.
  await stubDialogs(app, { save: path.join(dir, 'charts.sviz') })
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await quit(app)
  const again = await launch({ userData })
  await again.page.getByTestId('recent-card').first().click()
  await again.page.getByTestId('nav-charts').click()
  await expect(again.page.getByTestId('chart-item')).toHaveCount(3)
  await again.page.getByTestId('chart-item').first().click()
  expect((await chartSeries(again.page)).categories).toEqual(['Texas', 'Virginia'])
  await quit(again.app)
})

test('group values of a dimension (Create group)', async () => {
  const dir = tempDir()
  const { app, page } = await launch()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await page.getByTestId('field-region').hover()
  await page.getByTestId('field-menu-region').click()
  await page.getByTestId('group-region').click()
  const dialog = page.getByRole('dialog')
  for (const [name, values] of [['East', ['Virginia', 'New York']], ['West', ['California', 'Washington']]] as const) {
    for (const v of values) await dialog.getByRole('checkbox', { name: v }).check()
    await dialog.getByLabel('Group name').fill(name)
    await dialog.getByTestId('group-add').click()
  }
  await dialog.getByRole('checkbox', { name: 'Put the other values in “Other”' }).check()
  await dialog.getByTestId('group-save').click()
  await addField(page, 'region (group)', 'x')
  await addField(page, 'revenue', 'y')
  await expect.poll(async () => (await chartSeries(page)).categories).toEqual(['East', 'Other', 'West'])
  const s = await chartSeries(page)
  const r = exp.v1.revenueByRegion
  near(s.series['Sum of revenue'][0], r.Virginia + r['New York'])
  near(s.series['Sum of revenue'][2], r.California + r.Washington)
  await quit(app)
})

test('show missing dates fills the empty months of a filtered line chart', async () => {
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'order_date', 'x')
  await addField(page, 'revenue', 'y')
  // Only sales above the median of each month's largest: about half the months have none.
  const [{ t }] = await sql(page, `SELECT quantile_disc(m, 0.5) AS t FROM (SELECT date_trunc('month', order_date) AS mo, max(revenue) AS m FROM sales_enriched GROUP BY 1)`)
  await page.evaluate((min) => {
    const sv = (window as any).__sv
    const id = sv.get().project.charts.at(-1).id
    sv.P.edit((p: any) => ({ ...p, charts: p.charts.map((c: any) => (c.id === id ? { ...c, filters: [{ id: 'f', field: 'revenue', op: 'between', min }] } : c)) }))
  }, Number(t) + 0.01)
  // From the first to the last month left by the filter.
  const [{ span, n }] = await sql(page, `SELECT datediff('month', min(mo), max(mo)) + 1 AS span, count(DISTINCT mo) AS n FROM (SELECT date_trunc('month', order_date) AS mo FROM sales_enriched WHERE revenue >= ${Number(t) + 0.01})`)
  const months = Number(span)
  expect(Number(n)).toBeLessThan(months)
  await expect.poll(async () => (await chartSeries(page)).categories.length).toBe(Number(n))
  await page.getByTestId('show-missing').check()
  await expect.poll(async () => (await chartSeries(page)).categories.length).toBe(months)
  expect((await chartSeries(page)).series['Sum of revenue'].some((v) => v === null)).toBe(true)
  await quit(app)
})

test('quick table calculation computed along a chosen dimension', async () => {
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'region', 'x')
  await addField(page, 'revenue', 'y')
  await page.getByTestId('field-segment').dragTo(page.getByTestId('shelf-color'))
  await page.getByTestId('pill-y-0').click()
  await page.getByRole('menuitem', { name: 'Quick calculation' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Running total' }).click()
  await page.getByTestId('pill-y-0').click()
  await page.getByRole('menuitem', { name: 'Compute using' }).click()
  await page.getByTestId('compute-using-segment').click()
  // Along segment within each region: the last segment's value is the region's total.
  const totals = await sql(page, 'SELECT region, sum(revenue) AS r FROM sales_enriched GROUP BY 1')
  const last = await sql(page, 'SELECT max(segment) AS s FROM sales_enriched')
  await expect.poll(async () => {
    const s = await chartSeries(page)
    return totals.every((t) => Math.abs((s.series[String(last[0].s)][s.categories.indexOf(String(t.region))] ?? NaN) - Number(t.r)) < 0.01)
  }).toBe(true)
  await quit(app)
})

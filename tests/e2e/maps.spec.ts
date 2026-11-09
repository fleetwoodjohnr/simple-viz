// M6 in the real app: the new chart types draw (their ECharts series and components are registered: a production
// build drops unknown ones silently), maps find the right areas, a custom GeoJSON map is added to the project, and
// small multiples split a chart into panels.
import { type Page } from '@playwright/test'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect, launch, quit, salesProject, tempDir, stubDialogs, fixture, sql } from './helpers'

const exp = JSON.parse(readFileSync(path.resolve('tests/fixtures/expected.json'), 'utf8'))

async function addField(page: Page, field: string, shelf: string) {
  await page.getByTestId(`field-${field}`).hover()
  await page.getByTestId(`field-menu-${field}`).click()
  await page.getByTestId(`add-to-${shelf}`).click()
}

/** What ECharts actually built: series types, components present, and the first series' option. */
async function drawn(page: Page) {
  const canvas = page.getByTestId('chart-canvas')
  await expect(canvas.locator('[data-chart-state]').first()).toHaveAttribute('data-chart-state', 'ready')
  return canvas.locator('[data-testid=echart]').first().evaluate((el) => {
    const c = (el as any).__echart
    const model = c.getModel()
    const has = (k: string) => !!model.getComponent(k)
    return {
      types: model.getSeries().map((s: any) => s.subType),
      components: ['calendar', 'geo', 'radar', 'grid'].filter(has),
      markArea: model.getSeries().some((s: any) => s.get('markArea')?.data?.length),
      option: c.getOption()
    }
  })
}

test('more chart types draw; maps match areas; custom GeoJSON; small multiples', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const { app, page } = await launch()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'region', 'x')
  await addField(page, 'revenue', 'y')

  // The regions are US states: the automatic map is the US one, every state is matched, values are the totals.
  await page.getByTestId('type-map').click()
  let d = await drawn(page)
  expect(d.types).toEqual(['map'])
  expect(d.option.series[0].map).toBe('us-states')
  // ECharts lists every area of the map; the ones with data have a value.
  const withData = (o: any) => o.series[0].data.filter((x: any) => Number.isFinite(x.value))
  const states = Object.fromEntries(withData(d.option).map((x: any) => [x.name, x.value]))
  expect(Object.keys(states).sort()).toEqual([...exp.regions].sort())
  for (const r of exp.regions) expect(Math.abs(states[r] - exp.v1.revenueByRegion[r])).toBeLessThan(0.01)

  // A custom map: two areas (a point feature is dropped), named by their only text property.
  await stubDialogs(app, { open: [fixture('two-areas.geojson')] })
  await page.getByTestId('add-map').click()
  await expect(page.getByText('Added the map “two-areas”: 2 areas named by “AREA_NAME”')).toBeVisible()
  await expect.poll(async () => (await drawn(page)).option.series[0].map).not.toBe('us-states')
  d = await drawn(page)
  expect(withData(d.option).map((x: any) => x.name).sort()).toEqual(['Florida', 'Texas'])
  expect(d.option.title[0].subtext).toContain('4 values not on the map')
  expect(await page.evaluate(() => (window as any).__sv.get().project.maps.map((m: any) => m.geojson.features.length))).toEqual([2])

  // Each type below draws its own series (and components): a type missing from the build would leave none.
  const cases: [string, string[], string[]][] = [
    ['waterfall', ['bar', 'bar'], ['grid']],
    ['pareto', ['bar', 'line'], ['grid']],
    ['funnel', ['funnel'], []],
    ['radar', ['radar'], ['radar']],
    ['sunburst', ['sunburst'], []],
    ['custom', ['line'], ['grid']]
  ]
  for (const [type, types, components] of cases) {
    await page.getByTestId(`type-${type}`).click()
    d = await drawn(page)
    expect(d.types, type).toEqual(types)
    for (const c of components) expect(d.components, type).toContain(c)
  }

  // Flows region → product.
  await addField(page, 'product_name', 'x')
  await page.getByTestId('type-sankey').click()
  d = await drawn(page)
  expect(d.types).toEqual(['sankey'])
  expect(d.option.series[0].links.reduce((a: number, l: any) => a + l.value, 0)).toBeCloseTo(exp.v1.revenue, 0)

  // Dates: a calendar by day, and a line with a ±1 SD band (markArea) in small multiples by segment.
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'order_date', 'x')
  await addField(page, 'revenue', 'y')
  await page.getByTestId('refline-band').click()
  d = await drawn(page)
  expect(d.markArea).toBe(true)
  await addField(page, 'segment', 'facet')
  d = await drawn(page)
  expect(d.option.grid).toHaveLength(3)
  expect(d.option.title.map((t: any) => t.text).sort()).toEqual(['Consumer', 'Corporate', 'Small Business'])
  const max = d.option.yAxis.map((a: any) => a.max)
  expect(new Set(max).size).toBe(1)
  await page.getByTestId('type-calendar').click()
  d = await drawn(page)
  expect(d.types[0]).toBe('heatmap')
  expect(d.components).toContain('calendar')

  // Distributions per group (custom series, binned in SQL over every row) and a correlation matrix (SQL corr()).
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'segment', 'x')
  await addField(page, 'revenue', 'y')
  await page.getByTestId('type-violin').click()
  d = await drawn(page)
  expect(d.types).toEqual(['custom'])
  expect(d.option.xAxis[0].data.sort()).toEqual(['Consumer', 'Corporate', 'Small Business'])
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  for (const m of ['revenue', 'cost', 'profit']) await addField(page, m, 'y')
  await page.getByTestId('type-corrmatrix').click()
  d = await drawn(page)
  const [ref] = await sql(page, 'SELECT corr(revenue, cost) AS r FROM sales_enriched')
  const cell = d.option.series[0].data.find((x: number[]) => x[0] === 1 && x[1] === 0)
  expect(Math.abs(cell[2] - Number(ref.r))).toBeLessThan(1e-9)

  // A gauge of the total, with its own scale.
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'profit', 'y')
  await page.getByTestId('type-gauge').click()
  d = await drawn(page)
  expect(d.types).toEqual(['gauge'])
  expect(Math.abs(d.option.series[0].data[0].value - exp.v1.profit)).toBeLessThan(0.01)

  await quit(app)
})

// M6 in the real app: the new chart types draw (their ECharts series and components are registered: a production
// build drops unknown ones silently), maps find the right areas, a custom GeoJSON map is added to the project, and
// small multiples split a chart into panels.
import { type Page } from '@playwright/test'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
  // A zipped shapefile and a KML file become maps too.
  await stubDialogs(app, { open: [fixture('spatial/areas.zip')] })
  await page.getByTestId('add-map').click()
  await expect(page.getByText('Added the map “areas”: 2 areas named by “NAME”')).toBeVisible()
  await stubDialogs(app, { open: [fixture('spatial/areas.kml')] })
  await page.getByTestId('add-map').click()
  await expect(page.getByText('Added the map “areas”: 2 areas named by “name”', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__sv.get().project.maps.map((m: any) => m.geojson.features.map((f: any) => f.properties.name))))
    .toEqual([['Texas', 'Florida'], ['North', 'Südfeld'], ['North', 'Südfeld']])


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
  // A polynomial trend (its own dashed series) and a 90th-percentile line.
  await page.getByTestId('refline-trend').click()
  await page.getByTestId('trend-model').selectOption('poly')
  await page.getByTestId('trend-degree').fill('3')
  await page.getByTestId('refline-percentile').fill('90')
  await expect.poll(async () => (await drawn(page)).option.series.map((s: any) => s.id)).toContain('trend-0')
  await expect.poll(async () => (await drawn(page)).option.series[0].markLine.data.some((l: any) => /90th percentile/.test(l.label?.formatter))).toBe(true)
  await page.getByTestId('refline-trend').click()
  await page.getByTestId('refline-percentile').fill('')
  // An average line for each color (segment), in that color.
  await page.getByTestId('refline-average').click()
  await addField(page, 'segment', 'color')
  await page.getByTestId('ref-per-color').check()
  await expect.poll(async () => (await drawn(page)).option.series.filter((s: any) => s.markLine?.data?.length).length).toBe(3)
  await page.getByTestId('ref-per-color').uncheck()
  await page.getByTestId('refline-average').click()
  await page.getByTestId('pill-color-0').click()
  await page.getByTestId('pill-remove').click()
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

  // Points placed by name: each state's capital ("City, ST"), sized by revenue, on the US map.
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await page.getByTestId('new-calc').click()
  await page.getByTestId('calc-name').fill('Capital')
  await page.getByTestId('calc-formula').fill("CASE [region] WHEN 'Virginia' THEN 'Richmond, VA' WHEN 'Texas' THEN 'Austin, TX' WHEN 'California' THEN 'Sacramento, CA' WHEN 'New York' THEN 'Albany, NY' WHEN 'Florida' THEN 'Tallahassee, FL' WHEN 'Washington' THEN 'Olympia, WA' END")
  await page.getByTestId('calc-save').click()
  await page.getByTestId('type-pointmap').click()
  await addField(page, 'Capital', 'detail')
  await addField(page, 'revenue', 'size')
  await page.getByTestId('chart-map').selectOption('us-states')
  await expect.poll(async () => (await drawn(page)).option.series[0]?.data?.length).toBe(exp.regions.length)
  d = await drawn(page)
  const richmond = d.option.series[0].data.find((p: any) => p.value[0] === -77.452)
  expect(richmond.value.slice(0, 2)).toEqual([-77.452, 37.552])
  expect(Math.abs(richmond.value[2] - exp.v1.revenueByRegion.Virginia)).toBeLessThan(0.01)

  // Background tiles from a tile server (a local one here): requested through the app, drawn under the points, with
  // the provider's credit; none without a server.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAA4EAgFZu6v8AAAAAElFTkSuQmCC', 'base64')
  const asked: string[] = []
  const server = createServer((req, res) => (asked.push(req.url ?? ''), res.writeHead(200, { 'Content-Type': 'image/png' }), res.end(PNG)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as AddressInfo).port
    await page.getByRole('button', { name: 'Settings' }).first().click()
    await page.getByRole('button', { name: 'Data and refresh' }).click()
    await page.getByTestId('map-tiles').fill('http://tiles.example.com/{z}/{x}/{y}.png')
    await page.getByTestId('map-tiles').blur()
    await expect(page.getByText('A tile server address starts with https://')).toBeVisible()
    await page.getByTestId('map-tiles').fill(`http://127.0.0.1:${port}/{z}/{x}/{y}.png`)
    await page.getByTestId('map-tiles').blur()
    await page.getByTestId('map-tiles-credit').fill('© Test tiles')
    await page.getByTestId('map-tiles-credit').blur()
    await page.keyboard.press('Escape')
    const graphics = async () => ((await drawn(page)).option.graphic ?? []).flatMap((g: any) => g.elements ?? [g])
    const tileIds = async () => (await graphics()).map((e: any) => String(e.id))
    await expect.poll(async () => (await tileIds()).filter((id: string) => id.startsWith('tile:')).length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(asked.every((u) => /^\/\d+\/\d+\/\d+\.png$/.test(u))).toBe(true)
    expect(await tileIds()).toContain('credit')
    const credit = (await graphics()).find((e: any) => e.id === 'credit')
    expect([credit.type, credit.style.text]).toEqual(['text', '© Test tiles'])
    // Off again: no tiles.
    await page.evaluate(() => (window as any).__sv.get().settings && (window as any).simpleViz.settingsSet({ mapTiles: '' }))
    await page.evaluate(() => (window as any).__sv.set((s: any) => ({ settings: { ...s.settings, mapTiles: '' } })))
    await expect.poll(async () => (await tileIds()).filter((id: string) => id.startsWith('tile:')).length).toBe(0)
  } finally {
    server.close()
  }
  await quit(app)
})

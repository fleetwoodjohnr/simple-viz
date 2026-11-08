// Dashboard editing and interaction through the UI: add, move and resize tiles, cross-filter by clicking a bar,
// drill down, text with live values, PNG export, save and reopen.
import { type Page, type Locator } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, chartSeries, tempDir, stubDialogs, MOD } from './helpers'

const exp = JSON.parse(readFileSync(path.resolve('tests/fixtures/expected.json'), 'utf8'))

async function addField(page: Page, field: string, shelf: string) {
  await page.getByTestId(`field-${field}`).hover()
  await page.getByTestId(`field-menu-${field}`).click()
  await page.getByTestId(`add-to-${shelf}`).click()
}

/**
 * Clicks the bar of a category in an ECharts bar chart (screen coordinates account for the canvas scale). Waits until
 * the bar stays put: switching modes re-fits the canvas, and a chart resizes a moment later.
 */
async function clickBar(page: Page, tile: Locator, category: string) {
  const el = tile.locator('[data-testid=echart]')
  const where = async () => {
    const pt = await el.evaluate((node, cat) => {
      const c = (node as any).__echart
      const opt = c.getOption()
      const i = opt.xAxis[0].data.indexOf(cat)
      const v = opt.series[0].data[i].value
      const [x, y] = c.convertToPixel({ seriesIndex: 0 }, [i, v / 2])
      return { x, y, scale: Number(node.closest('[data-scale]')?.getAttribute('data-scale') ?? 1) }
    }, category)
    const box = (await el.boundingBox())!
    return { x: box.x + pt.x * pt.scale, y: box.y + pt.y * pt.scale }
  }
  let prev = await where()
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100)
    const now = await where()
    if (Math.abs(now.x - prev.x) < 0.5 && Math.abs(now.y - prev.y) < 0.5) break
    prev = now
  }
  await page.mouse.click(prev.x, prev.y)
}

test('edit a dashboard, cross-filter, drill down, export, save and reopen', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const { app, page, userData } = await launch()
  await salesProject(app, page, dir)

  // Two charts: revenue by region (drills into product), and revenue by product.
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await page.getByTestId('chart-name').fill('By region')
  await page.getByTestId('chart-name').press('Enter')
  await addField(page, 'region', 'x')
  await addField(page, 'revenue', 'y')
  await page.getByTestId('drill-add').selectOption('product_name')
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await page.getByTestId('chart-name').fill('By product')
  await page.getByTestId('chart-name').press('Enter')
  await addField(page, 'product_name', 'x')
  await addField(page, 'revenue', 'y')

  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  await page.getByTestId('palette-chart-By region').click()
  await page.getByTestId('palette-chart-By product').click()
  await page.getByTestId('add-text').click()
  await page.getByTestId('text-edit').fill('Sales for {region}')
  await page.getByTestId('text-edit').blur()
  const tiles = page.locator('[data-testid=item-chart]')
  await expect(tiles).toHaveCount(2)

  // Move and resize the first tile (snapped to the 8 px grid).
  const first = tiles.first()
  const id = await first.getAttribute('data-item')
  const before = await page.evaluate((id) => (window as any).__sv.get().project.dashboards[0].items.find((i: any) => i.id === id), id)
  const box = (await first.boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + 120, { steps: 5 })
  await page.mouse.up()
  // Wait for the move to land before grabbing the handle at its new place.
  await expect.poll(() => page.evaluate((id) => (window as any).__sv.get().project.dashboards[0].items.find((i: any) => i.id === id).y, id)).toBeGreaterThan(before.y)
  await page.waitForTimeout(100)
  const handle = page.getByTestId('handle-se')
  const hb = (await handle.boundingBox())!
  await handle.hover({ timeout: 5000 })
  await page.mouse.down()
  await page.mouse.move(hb.x - 60, hb.y - 40, { steps: 5 })
  await page.mouse.up()
  const after = await page.evaluate((id) => (window as any).__sv.get().project.dashboards[0].items.find((i: any) => i.id === id), id)
  expect(after.y).toBeGreaterThan(before.y)
  expect(after.w).toBeLessThan(before.w)
  for (const k of ['x', 'y', 'w', 'h']) expect(after[k] % 8).toBe(0)
  // Undo restores the size.
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => page.evaluate((id) => (window as any).__sv.get().project.dashboards[0].items.find((i: any) => i.id === id).w, id)).toBe(before.w)

  // View mode: clicking Virginia filters the product chart and the title.
  await page.getByTestId('mode-view').click()
  const region = page.locator('[data-chart="By region"]')
  const product = page.locator('[data-chart="By product"]')
  const allProducts = (await chartSeries(page, product)).series['Sum of revenue'].reduce((a, b) => a + b, 0)
  expect(Math.abs(allProducts - exp.v1.revenue)).toBeLessThan(0.01)
  await region.locator('[data-chart-state=ready]').waitFor()
  // The region chart drills down on click; cross-filtering comes from the product chart instead.
  await clickBar(page, product, 'Laptop')
  await expect.poll(async () => (await chartSeries(page, region)).series['Sum of revenue'].reduce((a, b) => a + b, 0)).toBeLessThan(exp.v1.revenue)
  await clickBar(page, product, 'Laptop') // again: clears the selection
  await expect.poll(async () => Math.round((await chartSeries(page, region)).series['Sum of revenue'].reduce((a, b) => a + b, 0))).toBe(Math.round(exp.v1.revenue))

  // Drill down: Virginia → its products.
  await clickBar(page, region, 'Virginia')
  await expect(region.getByTestId('drill-up')).toBeVisible()
  const drilled = await chartSeries(page, region)
  expect(drilled.categories).toContain('Laptop')
  expect(Math.abs(drilled.series['Sum of revenue'].reduce((a, b) => a + b, 0) - exp.v1.revenueByRegion.Virginia)).toBeLessThan(0.01)
  await region.getByTestId('drill-up').click()
  await expect.poll(async () => (await chartSeries(page, region)).categories.length).toBe(exp.regions.length)

  // PNG export.
  const png = path.join(dir, 'dash.png')
  await stubDialogs(app, { save: png })
  await page.getByTestId('dashboard-export').click()
  await page.getByTestId('export-png').click()
  await expect.poll(() => existsSync(png)).toBe(true)
  expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG')

  // Save and reopen: the layout comes back.
  await stubDialogs(app, { save: path.join(dir, 'dash.sviz') })
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await quit(app)
  const again = await launch({ userData })
  await again.page.getByTestId('recent-card').first().click()
  await again.page.getByTestId('nav-dashboards').click()
  await expect(again.page.locator('[data-testid=item-chart]')).toHaveCount(2)
  await expect(again.page.getByTestId('text-tile')).toHaveText('Sales for All')
  await quit(again.app)
})

// Dashboard objects beyond charts: text, a shape, an image (embedded), a button that resets filters, a row layout
// that arranges its items side by side; and the dashboard scaled to the window or shown at its fixed size.
import { type Page, type Locator } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, tempDir, stubDialogs } from './helpers'

// A 2 × 2 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAA4EAgFZu6v8AAAAAElFTkSuQmCC', 'base64')

const items = (page: Page) => page.evaluate(() => (window as any).__sv.get().project.dashboards[0].items.map((i: any) => ({ id: i.id, kind: i.kind, parent: i.parent ?? null })))

async function clickBar(page: Page, tile: Locator, category: string) {
  const el = tile.locator('[data-testid=echart]')
  const where = async () => {
    const pt = await el.evaluate((node, cat) => {
      const c = (node as any).__echart
      const opt = c.getOption()
      const i = opt.xAxis[0].data.indexOf(cat)
      const [x, y] = c.convertToPixel({ seriesIndex: 0 }, [i, opt.series[0].data[i].value / 2])
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

test('text, shape, image, reset button, row layout; fit to window', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const img = path.join(dir, 'logo.png')
  writeFileSync(img, PNG)
  const { app, page } = await launch()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  for (const [field, shelf] of [['region', 'x'], ['revenue', 'y']]) {
    await page.getByTestId(`field-${field}`).hover()
    await page.getByTestId(`field-menu-${field}`).click()
    await page.getByTestId(`add-to-${shelf}`).click()
  }
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  await page.locator('[data-testid^=palette-chart-]').first().click()

  // Objects.
  await page.getByTestId('add-text').click()
  await page.getByTestId('add-shape').click()
  await stubDialogs(app, { open: [img] })
  await page.getByTestId('add-image').click()
  await expect(page.locator('[data-testid=item-image] img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await page.getByTestId('add-button').click()
  await expect(page.getByTestId('dash-button')).toHaveText('Reset filters')

  // A row layout holding the shape and the image: side by side, inside it.
  await page.getByTestId('add-row').click()
  // The image first: new objects may sit over a shape (shapes are backgrounds), so it is on top.
  for (const kind of ['image', 'shape']) {
    await page.locator(`[data-testid=item-${kind}]`).click({ position: { x: 6, y: 6 }, force: true })
    await page.getByLabel('Layout container').selectOption({ index: 1 })
  }
  await expect.poll(async () => (await items(page)).filter((i) => i.parent).length).toBe(2)
  const row = (await page.locator('[data-testid=item-container]').boundingBox())!
  const shape = (await page.locator('[data-testid=item-shape]').boundingBox())!
  const image = (await page.locator('[data-testid=item-image]').boundingBox())!
  for (const b of [shape, image]) {
    expect(b.x).toBeGreaterThanOrEqual(row.x - 1)
    expect(b.x + b.width).toBeLessThanOrEqual(row.x + row.width + 1)
    expect(b.y).toBeGreaterThanOrEqual(row.y - 1)
  }
  expect(Math.abs(shape.y - image.y)).toBeLessThan(2) // a row: same top
  expect(Math.abs(shape.x - image.x)).toBeGreaterThan(20) // next to each other

  // View mode: a click on a bar filters; the dashboard's button clears it.
  await page.getByTestId('mode-view').click()
  await clickBar(page, page.locator('[data-testid=item-chart]').first(), 'Texas')
  await expect(page.getByTestId('reset-filters')).toBeVisible()
  await page.getByTestId('dash-button').click()
  await expect(page.getByTestId('reset-filters')).toHaveCount(0)

  // Fit to window scales a dashboard wider than the window down; fixed size shows it at 100%.
  const scale = () => page.locator('[data-scale]').first().getAttribute('data-scale').then(Number)
  const width = await page.evaluate(() => (window as any).__sv.get().project.dashboards[0].size.w)
  const room = await page.locator('[data-scale]').first().evaluate((el) => el.parentElement!.clientWidth)
  if (room < width) expect(await scale()).toBeLessThan(1)
  await page.evaluate(() => {
    const sv = (window as any).__sv
    sv.P.edit((p: any) => ({ ...p, dashboards: p.dashboards.map((d: any) => ({ ...d, size: { ...d.size, mode: 'fixed' } })) }))
  })
  await expect.poll(scale).toBe(1)
  await quit(app)
})

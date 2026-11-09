// Dashboard objects beyond charts: text, a shape, an image (embedded), a button that resets filters, a row layout
// that arranges its items side by side; and the dashboard scaled to the window or shown at its fixed size.
import { type Page, type Locator } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, tempDir, stubDialogs, sql } from './helpers'

// A 2 × 2 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAA4EAgFZu6v8AAAAAElFTkSuQmCC', 'base64')

const items = (page: Page) => page.evaluate(() => (window as any).__sv.get().project.dashboards[0].items.map((i: any) => ({ id: i.id, kind: i.kind, parent: i.parent ?? null }))) as Promise<{ id: string; kind: string; parent: string | null }[]>

async function clickBar(page: Page, tile: Locator, category: string) {
  const el = tile.locator('[data-testid=echart]')
  const where = async () => {
    const pt = await el.evaluate((node, cat) => {
      const c = (node as any).__echart
      const opt = c.getOption()
      const i = opt.xAxis[0].data.indexOf(cat)
      // The series with a bar for this category (with a color field, the others have none there).
      const val = (d: any) => (d !== null && typeof d === 'object' ? d.value : d)
      const si = Math.max(0, opt.series.findIndex((s: any) => val(s.data[i]) != null))
      const [x, y] = c.convertToPixel({ seriesIndex: si }, [i, val(opt.series[si].data[i]) / 2])
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
  // The layout shows a frame after the change (before it, a new object may sit exactly on a shape).
  const box = (kind: string) => page.locator(`[data-testid=item-${kind}]`).boundingBox().then((b) => b!)
  await expect.poll(async () => Math.abs((await box('shape')).x - (await box('image')).x)).toBeGreaterThan(20)
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

  // A URL action opens a web page for the clicked mark (the system browser is stubbed).
  await app.evaluate(({ shell }) => {
    ;(globalThis as any).__opened = []
    shell.openExternal = async (u: string) => void (globalThis as any).__opened.push(u)
  })
  await page.getByTestId('mode-edit').click() // clears the selection: the dashboard's own properties show
  await page.getByRole('button', { name: 'Add action' }).click()
  await page.getByLabel('Action kind').last().selectOption('url')
  await page.getByLabel('Web address').fill('https://example.com/search?q={region}')
  await page.getByTestId('mode-view').click()
  await clickBar(page, page.locator('[data-testid=item-chart]').first(), 'New York')
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened)).toEqual(['https://example.com/search?q=New%20York'])
  await page.getByTestId('dash-button').click()

  // A web page of the dashboard: self-contained, charts as images, no scripts.
  const html = path.join(dir, 'report.html')
  await stubDialogs(app, { save: html })
  await page.getByTestId('dashboard-export').click()
  await page.getByTestId('export-html').click()
  await expect.poll(() => existsSync(html)).toBe(true)
  const report = readFileSync(html, 'utf8')
  expect(report).toMatch(/^<!doctype html>/)
  expect(report.match(/<img[^>]+src="data:image\/png;base64,/g)?.length).toBeGreaterThanOrEqual(2) // the chart and the image
  expect(report).toContain('Reset filters')
  expect(report).not.toMatch(/<script|data-testid="echart"/)

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

test('saved views: filter choices kept under a name and applied again', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
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
  await page.getByTestId('add-filter').click()
  await page.getByRole('dialog').getByRole('textbox').fill('region')
  await page.getByRole('dialog').getByRole('textbox').press('Enter')
  const categories = () => page.locator('[data-testid=item-chart] [data-testid=echart]').first().evaluate((el) => (el as any).__echart.getOption().xAxis[0].data as string[])

  // Choose Texas, save it as a view, clear, apply the view again.
  await page.getByTestId('filter-control-region').getByText('Texas').click()
  await expect.poll(categories).toEqual(['Texas'])
  await page.getByTestId('views-menu').click()
  await page.getByTestId('save-view').click()
  await page.getByRole('dialog').getByRole('textbox').fill('Texas only')
  await page.getByRole('dialog').getByRole('textbox').press('Enter')
  await page.getByTestId('reset-filters').click()
  await expect.poll(async () => (await categories()).length).toBeGreaterThan(1)
  await page.getByTestId('views-menu').click()
  await page.getByTestId('view-Texas only').click()
  await expect.poll(categories).toEqual(['Texas'])
  // The view is part of the project.
  const views = await page.evaluate(() => (window as any).__sv.get().project.dashboards[0].views)
  expect(views.map((v: any) => [v.name, v.selections.region.values])).toEqual([['Texas only', ['Texas']]])
  await quit(app)
})

test('parameters: created in the chart builder, a reference line, a dashboard control, a parameter action', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  for (const [field, shelf] of [['region', 'x'], ['revenue', 'y']]) {
    await page.getByTestId(`field-${field}`).hover()
    await page.getByTestId(`field-menu-${field}`).click()
    await page.getByTestId(`add-to-${shelf}`).click()
  }
  for (const [name, type, value] of [['Threshold', 'number', '1000000'], ['Focus', 'text', '']]) {
    await page.getByTestId('new-param').click()
    await page.getByLabel('Parameter name').fill(name)
    await page.getByLabel('Parameter type').selectOption(type)
    await page.getByLabel('Parameter value').fill(value)
    await page.getByTestId('param-save').click()
  }
  await expect(page.getByTestId('param-Threshold')).toContainText('1000000')
  const lineAt = (scope: Page | Locator) =>
    scope.locator('[data-testid=echart]').first().evaluate((el) => ((el as any).__echart.getOption().series[0].markLine?.data ?? []).map((x: any) => x.yAxis))
  await page.getByLabel('Line at parameter').selectOption('Threshold')
  await expect.poll(() => lineAt(page)).toEqual([1000000])

  // On a dashboard: a control changes the value, and the line follows.
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  await page.locator('[data-testid^=palette-chart-]').first().click()
  await page.getByTestId('add-param').click()
  const control = page.getByTestId('param-control-Threshold').getByRole('spinbutton')
  await control.fill('1500000')
  await control.press('Enter')
  const tile = page.locator('[data-testid=item-chart]').first()
  await expect.poll(() => lineAt(tile)).toEqual([1500000])

  // A parameter action: clicking a bar sets Focus to its region.
  await page.getByTestId('mode-edit').click()
  await page.getByRole('button', { name: 'Add action' }).click()
  await page.getByLabel('Action kind').last().selectOption('param')
  await page.getByLabel('Target parameter').selectOption('Focus')
  await page.getByLabel('Value from field').fill('region')
  await page.getByTestId('mode-view').click()
  await clickBar(page, tile, 'Texas')
  await expect.poll(() => page.evaluate(() => (window as any).__sv.get().project.params.find((p: any) => p.name === 'Focus').value)).toBe('Texas')

  // A number parameter with a range (a slider on the dashboard) drives a top-N filter.
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-param').click()
  await page.getByLabel('Parameter name').fill('Top')
  await page.getByLabel('Parameter value').fill('9')
  await page.getByTestId('param-min').fill('1')
  await page.getByTestId('param-max').fill('6')
  await page.getByTestId('param-step').fill('1')
  await page.getByTestId('param-save').click()
  expect(await page.evaluate(() => (window as any).__sv.get().project.params.find((p: any) => p.name === 'Top'))).toMatchObject({ value: 6, min: 1, max: 6, step: 1 }) // kept within the range
  await page.getByTestId('field-region').hover()
  await page.getByTestId('field-menu-region').click()
  await page.getByTestId('add-to-filters').click()
  await page.getByRole('radio', { name: 'Top N' }).click()
  await page.getByTestId('filter-top-param').selectOption('Top')
  await page.getByTestId('filter-apply').click()
  const bars = (scope: Page | Locator) => scope.locator('[data-testid=echart]').first().evaluate((el) => (el as any).__echart.getOption().xAxis[0].data.length)
  await expect.poll(() => bars(page)).toBe(6)
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('mode-edit').click()
  await page.locator('[data-testid^=palette-chart-]').first().click() // the chart again: it has the filter now
  await page.getByTestId('add-param').click()
  const items = await page.evaluate(() => (window as any).__sv.get().project.dashboards[0].items.filter((i: any) => i.kind === 'param').map((i: any) => i.id))
  await page.evaluate(([id]) => (window as any).__sv.P.edit((p: any) => ({ ...p, dashboards: p.dashboards.map((d: any) => ({ ...d, items: d.items.map((i: any) => (i.id === id ? { ...i, param: 'Top' } : i)) })) })), [items[items.length - 1]])
  await page.getByTestId('mode-view').click()
  await page.getByTestId('reset-filters').click() // the earlier click on Texas filters the other tiles
  const slider = page.getByTestId('param-slider-Top')
  await slider.focus()
  await slider.press('Home') // the minimum, 1
  await expect.poll(() => page.evaluate(() => (window as any).__sv.get().project.params.find((p: any) => p.name === 'Top').value)).toBe(1)
  await slider.press('ArrowRight')
  await expect.poll(() => page.evaluate(() => (window as any).__sv.get().project.params.find((p: any) => p.name === 'Top').value)).toBe(2)
  await expect.poll(() => bars(page.locator('[data-testid=item-chart]').last())).toBe(2)
  await quit(app)
})

test('sets: created from a field, In/Out on a chart, changed by a set action', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  for (const [field, shelf] of [['region', 'x'], ['revenue', 'y']]) {
    await page.getByTestId(`field-${field}`).hover()
    await page.getByTestId(`field-menu-${field}`).click()
    await page.getByTestId(`add-to-${shelf}`).click()
  }
  await page.getByTestId('field-region').hover()
  await page.getByTestId('field-menu-region').click()
  await page.getByTestId('set-region').click()
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Texas' }).check()
  await page.getByTestId('group-save').click()
  await page.getByTestId('field-region (set)').dragTo(page.getByTestId('shelf-color'))
  const inOut = async (scope: Page | Locator) => {
    const opt = await scope.locator('[data-testid=echart]').first().evaluate((el) => (el as any).__echart.getOption())
    const cats: string[] = opt.xAxis[0].data
    const inSeries = opt.series.find((s: any) => s.name === 'In')
    const val = (d: any) => (d !== null && typeof d === 'object' ? d.value : d)
    return cats.filter((_, i) => inSeries && val(inSeries.data[i]) != null)
  }
  await expect.poll(() => inOut(page)).toEqual(['Texas'])

  // A computed set: the top 2 regions by revenue (In for them), on the color shelf instead.
  await page.getByTestId('field-region').hover()
  await page.getByTestId('field-menu-region').click()
  await page.getByTestId('set-region').click()
  await page.getByRole('dialog').getByRole('radio', { name: 'Top N' }).click()
  await page.getByTestId('set-top-n').fill('2')
  await page.getByTestId('set-top-by').selectOption('revenue')
  await page.getByTestId('group-save').click()
  await page.getByTestId('field-region (top 2)').dragTo(page.getByTestId('shelf-color'))
  const top2 = (await sql(page, 'SELECT region FROM sales_enriched GROUP BY 1 ORDER BY sum(revenue) DESC LIMIT 2')).map((r) => r.region)
  await expect.poll(async () => (await inOut(page)).sort()).toEqual([...top2].sort())
  // A condition that doesn't aggregate is refused with the reason.
  await page.getByTestId('field-region').hover()
  await page.getByTestId('field-menu-region').click()
  await page.getByTestId('set-region').click()
  await page.getByRole('dialog').getByRole('radio', { name: 'Condition' }).click()
  await page.getByTestId('set-condition').fill('[revenue] > 1')
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('set-error')).toContainText('must aggregate')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await page.getByTestId('field-region (set)').dragTo(page.getByTestId('shelf-color'))
  await expect.poll(() => inOut(page)).toEqual(['Texas'])
  // Stacked, so a click at the category's centre lands on its bar (grouped bars sit either side of it).
  await page.evaluate(() => {
    const sv = (window as any).__sv
    sv.P.edit((p: any) => ({ ...p, charts: p.charts.map((c: any) => ({ ...c, options: { ...c.options, stack: 'stacked' } })) }))
  })

  // A set action on a dashboard: clicking New York makes it the set's member.
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  await page.locator('[data-testid^=palette-chart-]').first().click()
  await page.getByTestId('mode-view').click()
  await page.getByTestId('mode-edit').click() // nothing selected: the dashboard's own properties and actions
  await page.getByRole('button', { name: 'Add action' }).click()
  await page.getByLabel('Action kind').last().selectOption('set')
  await page.getByLabel('Target set').selectOption('region (set)')
  await page.getByTestId('mode-view').click()
  const tile = page.locator('[data-testid=item-chart]').first()
  await clickBar(page, tile, 'New York')
  await expect.poll(() => page.evaluate(() => (window as any).__sv.get().project.calcs.find((c: any) => c.set).set.values)).toEqual(['New York'])
  await expect.poll(() => inOut(tile)).toEqual(['New York'])
  await quit(app)
})

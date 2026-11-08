// Chart exports and reference lines in the app; dashboard editing by mouse and keyboard (nudge, lock, duplicate,
// delete, align, group), sizes and presentation mode; hierarchies saved on one chart and reused on another.
import { type Page } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, tempDir, stubDialogs, chartSeries, MOD } from './helpers'

async function addField(page: Page, field: string, shelf: string) {
  await page.getByTestId(`field-${field}`).hover()
  await page.getByTestId(`field-menu-${field}`).click()
  await page.getByTestId(`add-to-${shelf}`).click()
}
const items = (page: Page) => page.evaluate(() => {
  const sv = (window as any).__sv.get()
  return sv.project.dashboards[0].items.map((i: any) => ({ id: i.id, kind: i.kind, x: i.x, y: i.y, locked: !!i.locked, group: i.group ?? null }))
}) as Promise<{ id: string; kind: string; x: number; y: number; locked: boolean; group: string | null }[]>

test('chart exports, reference lines, hierarchies; dashboard editing, sizes, presentation', async () => {
  test.setTimeout(240_000)
  const dir = tempDir()
  const { app, page } = await launch()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await page.getByTestId('chart-name').fill('By region')
  await page.getByTestId('chart-name').press('Enter')
  await addField(page, 'region', 'x')
  await addField(page, 'revenue', 'y')
  const s = await chartSeries(page)

  // An average line at the mean of the bars.
  await page.getByTestId('refline-average').click()
  const mark = await page.getByTestId('chart-canvas').locator('[data-testid=echart]').evaluate((el) => (el as any).__echart.getOption().series[0].markLine.data[0].yAxis)
  const vals = s.series['Sum of revenue']
  expect(Math.abs(mark - vals.reduce((a, b) => a + b, 0) / vals.length)).toBeLessThan(1e-6)

  // Exports: a high-resolution PNG, an SVG with the data's labels, the chart's data as CSV.
  const out = (n: string) => path.join(dir, n)
  for (const [file, label] of [['chart.png', 'PNG image (high resolution)'], ['chart.svg', 'SVG image'], ['chart.csv', /Chart data/]] as const) {
    await stubDialogs(app, { save: out(file) })
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: label }).click()
    await expect.poll(() => existsSync(out(file))).toBe(true)
  }
  const png = readFileSync(out('chart.png'))
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  const canvasWidth = await page.getByTestId('chart-canvas').locator('[data-testid=echart]').evaluate((el) => el.clientWidth)
  expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(canvasWidth * 2) // IHDR width: at least 2× the screen size
  const svg = readFileSync(out('chart.svg'), 'utf8')
  expect(svg).toContain('<svg')
  for (const r of s.categories) expect(svg).toContain(r)
  const csv = readFileSync(out('chart.csv'), 'utf8').trim().split('\n')
  expect(csv).toHaveLength(s.categories.length + 1)

  // A drill path saved as a hierarchy, reused on a second chart of the same data.
  await page.getByTestId('drill-add').selectOption('product_name')
  await stubDialogs(app, { message: 0 })
  page.once('dialog', () => {})
  await page.getByTestId('save-hierarchy').click()
  await page.getByRole('dialog').getByRole('textbox').fill('Region › Product')
  await page.getByRole('dialog').getByRole('textbox').press('Enter')
  await page.getByTestId('new-chart').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  await addField(page, 'revenue', 'y')
  await page.getByRole('button', { name: 'Region › Product' }).click()
  const second = await page.evaluate(() => {
    const p = (window as any).__sv.get().project
    return { h: p.hierarchies.map((x: any) => [x.name, x.levels.map((l: any) => l.field)]), c: p.charts[1].options.drill.map((l: any) => l.field), x: p.charts[1].enc.x[0].field }
  })
  expect(second).toEqual({ h: [['Region › Product', ['region', 'product_name']]], c: ['region', 'product_name'], x: 'region' })

  // A dashboard with both charts.
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  await page.getByTestId('palette-chart-By region').click()
  await page.locator('[data-testid^=palette-chart-]').nth(1).click()
  await expect(page.locator('[data-testid=item-chart]')).toHaveCount(2)
  let [a, b] = await items(page)

  // Keyboard: arrows nudge by the grid (Shift: five steps); a locked tile stays put.
  const tile = (i: number) => page.locator('[data-testid=item-chart]').nth(i)
  await tile(0).click({ position: { x: 20, y: 8 }, force: true })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => (await items(page))[0]).toMatchObject({ x: a.x + 8, y: a.y + 40 })
  await page.getByTestId('lock').click()
  await expect.poll(async () => (await items(page))[0].locked).toBe(true)
  // (Toolbar buttons take the focus: click the tile again before using the keyboard.)
  await tile(0).click({ position: { x: 20, y: 8 }, force: true })
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  expect((await items(page))[0]).toMatchObject({ x: a.x + 8, locked: true })
  await page.getByTestId('lock').click()
  await tile(0).click({ position: { x: 20, y: 8 }, force: true })
  // Duplicate and delete from the keyboard.
  await page.keyboard.press(`${MOD}+d`)
  await expect.poll(async () => (await items(page)).length).toBe(3)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await items(page)).length).toBe(2)
  // Two tiles: align their left edges, then group them.
  ;[a, b] = await items(page)
  void b
  await tile(0).click({ position: { x: 20, y: 8 }, force: true })
  await tile(1).click({ position: { x: 20, y: 8 }, modifiers: ['Shift'], force: true })
  await page.getByTestId('align-left').click()
  await expect.poll(async () => new Set((await items(page)).map((i) => i.x)).size).toBe(1)
  await page.getByTestId('group').click()
  await expect.poll(async () => { const g = (await items(page)).map((i) => i.group); return !!g[0] && g[0] === g[1] }).toBe(true)

  // Size presets keep tiles inside the page; presentation mode fills the screen and Escape leaves it.
  await page.getByTestId('dashboard-canvas').click({ position: { x: 5, y: 5 } })
  await page.getByTestId('dashboard-size').selectOption('phone')
  const size = await page.evaluate(() => (window as any).__sv.get().project.dashboards[0].size)
  expect([size.w, size.h]).toEqual([390, 844])
  for (const i of await page.evaluate(() => (window as any).__sv.get().project.dashboards[0].items)) expect(i.x + i.w).toBeLessThanOrEqual(390)
  await page.getByTestId('present').click()
  await expect(page.getByTestId('presentation')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('presentation')).toHaveCount(0)
  await quit(app)
})

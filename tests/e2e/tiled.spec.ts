// Tiled dashboards (items fill the dashboard without overlapping, and re-flow when one is added) and device layouts
// (phone and tablet layouts made from the default, edited on their own; view mode picks one by the window's width).
import { type Page } from '@playwright/test'
import { test, expect, launch, quit, salesProject, tempDir } from './helpers'

type It = { id: string; x: number; y: number; w: number; h: number; floating?: boolean }
const dash = (page: Page) => page.evaluate(() => (window as any).__sv.get().project.dashboards[0]) as Promise<{ size: { w: number; h: number }; tiled?: boolean; items: It[]; devices?: { phone?: { w: number; pos: Record<string, It & { hidden?: boolean }> } } }>
const overlap = (a: It, b: It) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('tiled layout and a phone layout', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  await salesProject(app, page, tempDir())
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard').click()
  await page.getByTestId('template-grid-4').click()
  await page.getByTestId('mode-view').click()
  await page.getByTestId('mode-edit').click() // nothing selected: the dashboard's properties
  await page.getByRole('switch', { name: 'Tiled layout' }).click()
  await expect.poll(async () => (await dash(page)).tiled).toBe(true)
  const check = async () => {
    const d = await dash(page)
    for (const a of d.items) for (const b of d.items) if (a !== b) expect(overlap(a, b)).toBe(false)
    expect(Math.max(...d.items.map((i) => i.x + i.w))).toBe(d.size.w - 16)
    expect(Math.max(...d.items.map((i) => i.y + i.h))).toBe(d.size.h - 16)
    return d
  }
  const before = await check()
  // A new object gets a row of its own at the bottom; the rest make room.
  await page.getByTestId('add-text').click()
  await expect.poll(async () => (await dash(page)).items.length).toBe(before.items.length + 1)
  const after = await check()
  const added = after.items.find((i) => !before.items.some((b) => b.id === i.id))!
  expect(added.y).toBe(Math.max(...after.items.map((i) => i.y)))

  // A phone layout: one column, made from the default; moving an item there leaves the default alone.
  await page.getByTestId('device-phone').click()
  await expect.poll(async () => (await dash(page)).devices?.phone?.w).toBe(390)
  const ph = (await dash(page)).devices!.phone!
  const xs = new Set(Object.values(ph.pos).filter((p) => !p.hidden).map((p) => p.x))
  expect(xs.size).toBe(1)
  const tile = page.locator('[data-testid^=item-]').first()
  const box = (await tile.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 90, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => JSON.stringify((await dash(page)).devices!.phone!.pos)).not.toBe(JSON.stringify(ph.pos))
  expect((await dash(page)).items.map((i) => [i.id, i.x, i.y])).toEqual(after.items.map((i) => [i.id, i.x, i.y]))

  // Previewing the phone layout in view mode: the tiles stack in one column.
  await page.getByTestId('mode-view').click()
  await expect(page.locator('[data-layout-width]')).toHaveAttribute('data-layout-width', '390')
  await expect.poll(async () => new Set(await page.locator('[data-testid=item-chart]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))).size).toBe(1)
  // With a tablet layout too, view mode picks the layout by the window's width (tablet below 1,100 px).
  await page.getByTestId('device-tablet').click()
  await page.getByTestId('device-default').click()
  const width = () => page.locator('[data-layout-width]').getAttribute('data-layout-width')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800))
  await expect.poll(width).toBe('1024')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await expect.poll(width).toBe('1366')
  // Edit mode shows the layout being edited (the default).
  await page.getByTestId('mode-edit').click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800))
  await expect.poll(width).toBe('1366')
  await quit(app)
})

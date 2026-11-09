// The example project from Home: a fresh copy opens on its dashboard with live data. And the database dialog switches
// between server types.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit } from './helpers'

const exp = JSON.parse(readFileSync(path.resolve('tests/fixtures/expected.json'), 'utf8'))

test('open the example: its dashboard shows the sales data', async () => {
  const { app, page, userData } = await launch()
  await page.getByTestId('start-example').click()
  await expect(page.getByTestId('dashboards-view')).toBeVisible()
  await expect(page.locator('[data-testid=item-chart]')).toHaveCount(5)
  await expect(page.getByTestId('kpi-value').first()).toHaveAttribute('data-value', /.+/)
  expect(Math.abs(Number(await page.getByTestId('kpi-value').first().getAttribute('data-value')) - exp.v1.profit)).toBeLessThan(0.01)
  // Its sources are copies in the user's data folder, and nothing asked for permission to read them.
  const paths = await page.evaluate(() => (window as any).__sv.get().project.sources.map((s: any) => s.path))
  for (const p of paths) expect(p.startsWith(path.join(userData, 'examples'))).toBe(true)
  await expect(page.locator('[data-chart-state=ready]')).toHaveCount(5)
  const map = await page.locator('[data-testid=echart]').evaluateAll((els) => els.map((el) => (el as any).__echart?.getOption().series?.[0]?.type))
  expect(map).toContain('map')
  await quit(app)
})

test('the database dialog switches between PostgreSQL, MySQL and SQL Server', async () => {
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-postgres').click()
  await expect(page.getByTestId('pg-port')).toHaveValue('5432')
  await page.getByRole('radio', { name: 'MySQL / MariaDB' }).click()
  await expect(page.getByRole('dialog')).toContainText('Connect to MySQL / MariaDB')
  await expect(page.getByTestId('pg-port')).toHaveValue('3306')
  await page.getByRole('radio', { name: 'SQL Server' }).click()
  await expect(page.getByTestId('pg-port')).toHaveValue('1433')
  await quit(app)
})

test('a story: dashboards in order with captions, presented point by point', async () => {
  const { app, page } = await launch()
  await page.getByTestId('start-example').click()
  await expect(page.getByTestId('dashboards-view')).toBeVisible()
  await page.getByTestId('new-dashboard').click()
  await page.getByTestId('new-dashboard-blank').click()
  await page.getByTestId('new-story').click()
  await expect(page.getByTestId('story-view')).toBeVisible()
  await expect(page.getByTestId('story-point-0')).toHaveText('1. Sales overview')
  await expect(page.locator('[data-testid=story-view] [data-chart-state=ready]')).toHaveCount(5)
  await page.getByTestId('story-caption').fill('Where revenue comes from')
  await page.getByTestId('story-caption').blur()
  await expect(page.getByTestId('story-point-0')).toHaveText('1. Where revenue comes from')
  await page.getByTestId('story-point-1').click()
  await expect(page.locator('[data-testid=story-view] [data-testid=item-chart]')).toHaveCount(0) // the blank dashboard
  // Presented: full screen, ← → move between points, Esc leaves.
  await page.getByTestId('present-story').click()
  await expect(page.getByTestId('presentation')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('story-point-0')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('story-view')).toBeVisible()
  const stories = await page.evaluate(() => (window as any).__sv.get().project.stories)
  expect(stories[0].points.map((p: any) => p.caption)).toEqual(['Where revenue comes from', 'Dashboard 2'])
  await quit(app)
})

// The README's screenshots, taken from the example project in the real app: SV_SCREENSHOTS=1 npx playwright test screenshots
import { mkdirSync } from 'node:fs'
import { test, expect, launch, quit } from './helpers'

test('README screenshots', async () => {
  test.skip(!process.env.SV_SCREENSHOTS, 'only on request')
  mkdirSync('docs/screenshots', { recursive: true })
  const { app, page } = await launch()
  const shot = async (name: string) => {
    await page.waitForTimeout(1200) // chart animations
    await page.screenshot({ path: `docs/screenshots/${name}.png` })
  }
  await page.getByTestId('start-example').click()
  await expect(page.locator('[data-chart-state=ready]')).toHaveCount(5)
  await page.getByLabel('Mode').getByText('View').click()
  await shot('dashboard')
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('chart-item').nth(1).click()
  await expect(page.locator('[data-chart-state=ready]').first()).toBeVisible()
  await shot('chart-builder')
  await page.getByTestId('nav-data').click()
  await page.locator('button[data-testid^=relation-]').first().click()
  await expect(page.getByTestId('relation-rows')).toContainText('rows')
  await shot('data')
  await page.getByTestId('nav-sql').click()
  await page.locator('.cm-content').click()
  await page.evaluate((sql) => {
    const v = (window as any).__svEditor
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: sql } })
  }, `SELECT region, count(*) AS orders, round(sum(revenue), 2) AS revenue\nFROM sales\nGROUP BY region\nORDER BY revenue DESC`)
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-rowcount')).toBeVisible()
  await shot('sql')
  await quit(app)
})

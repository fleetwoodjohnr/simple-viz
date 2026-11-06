import { test, expect, launch, quit, sql } from './helpers'

test('launches, shows Home, and the engine answers from the page', async () => {
  const { app, page } = await launch()
  await expect(page.getByTestId('home')).toBeVisible()
  await expect(page.getByTestId('new-project')).toBeVisible()
  await page.getByTestId('new-project').click()
  await expect(page.getByTestId('data-view')).toBeVisible()
  // The renderer's port goes straight to DuckDB in the engine process.
  expect(await sql(page, 'SELECT 40 + 2 AS answer')).toEqual([{ answer: 42 }])
  await quit(app)
})

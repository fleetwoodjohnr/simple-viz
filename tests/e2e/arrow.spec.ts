// Feather and Excel 97–2003 files added like any other file: the engine's own readers load in the app.
import { test, expect, launch, quit, stubDialogs, fixture } from './helpers'

test('add an LZ4-compressed Feather file', async () => {
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [fixture('arrow/mixed-lz4.feather')] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  await page.getByTestId('relation-mixed_lz4').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('4 rows', { timeout: 20_000 })
  await quit(app)
})

test('add an Excel 97–2003 workbook and pick its sheets', async () => {
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [fixture('Sales.xls')] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  // Every sheet is offered (and picked by default).
  await expect(page.getByTestId('sheet-list')).toContainText('Transactions')
  await expect(page.getByTestId('sheet-list')).toContainText('Notes')
  await page.getByTestId('sheet-add').click()
  await page.getByTestId('relation-transactions').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 })
  await page.getByTestId('relation-notes').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('2,000 rows', { timeout: 20_000 })
  await quit(app)
})

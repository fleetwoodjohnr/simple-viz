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

test('a messy sheet: the tables in it are found and picked, titles and notes left out', async () => {
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [fixture('messy.xlsx')] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  const list = page.getByTestId('sheet-list')
  await expect(list).toContainText('Report!B4:D6')
  await expect(list).toContainText('Report!A10:B13')
  await expect(list.getByRole('checkbox')).toHaveCount(3)
  // The two tables are picked; the whole sheet isn't.
  expect(await list.getByRole('checkbox').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([false, true, true])
  await page.getByTestId('sheet-add').click()
  const rel = await page.evaluate(() => (window as any).__sv.get().project.sources[0].tables.map((t: any) => [t.alias, t.ref]))
  expect(rel.map((r: string[]) => r[1])).toEqual(['Report!B4:D6', 'Report!A10:B13'])
  await expect.poll(() => page.evaluate(() => (window as any).__sv.get().relations.map((r: any) => [r.name, r.columns.map((c: any) => c.name)])), { timeout: 20_000 })
    .toEqual(expect.arrayContaining([[rel[0][0], ['Region', 'Q1', 'Q2']], [rel[1][0], ['Product', 'Units']]]))
  await quit(app)
})

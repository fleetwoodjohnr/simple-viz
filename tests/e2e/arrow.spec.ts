// A Feather file added like any other file: the engine's Arrow reader (and its LZ4 codec) loads in the app.
import { test, expect, launch, quit, stubDialogs, fixture } from './helpers'

test('add an LZ4-compressed Feather file', async () => {
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [fixture('arrow/mixed-lz4.feather')] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  await page.getByTestId('relation-mixed_lz4').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('4 rows')
  await quit(app)
})

// Connecting to SQL Server through the UI (tables are extracted with tedious; there is no live mode).
import { test, expect, launch, quit } from './helpers'
import { startSqlServer, type Ms } from '../integration/helpers'

let ms: Ms | null = null
test.beforeAll(async () => {
  test.setTimeout(300_000)
  ms = await startSqlServer()
})
test.afterAll(() => ms?.stop())

test('connect to SQL Server, pick a table, preview it', async () => {
  test.skip(!ms, 'needs SQL Server: set SV_MS_HOST or install podman (x64)')
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-sqlserver').click()
  await expect(page.getByRole('dialog')).toContainText('Connect to SQL Server')
  await expect(page.getByTestId('pg-port')).toHaveValue('1433')
  await expect(page.getByRole('dialog').getByText('How to use the data')).toHaveCount(0)
  await page.getByTestId('pg-host').fill(ms!.host)
  await page.getByTestId('pg-port').fill(String(ms!.port))
  await page.getByTestId('pg-database').fill(ms!.database)
  await page.getByTestId('pg-user').fill(ms!.user)
  await page.getByTestId('pg-password').fill(ms!.password)
  await page.getByRole('dialog').getByLabel('SSL mode').selectOption('require')
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-tables')).toContainText('dbo.customers')
  // A short list is picked by default.
  await expect(page.getByTestId('pg-tables').getByRole('checkbox')).toBeChecked()
  await page.getByTestId('pg-add').click()
  await page.getByTestId('relation-customers').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('120 rows')
  const src = await page.evaluate(() => (window as any).__sv.get().project.sources[0])
  expect([src.kind, src.mode, JSON.stringify(src).includes(ms!.password)]).toEqual(['sqlserver', 'extract', false])
  await quit(app)
})

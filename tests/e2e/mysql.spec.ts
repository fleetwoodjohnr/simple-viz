// Connecting to MySQL / MariaDB through the UI, with the bundled mysql extension.
import { test, expect, launch, quit } from './helpers'
import { startMysql, type My } from '../integration/helpers'

let my: My | null = null
test.beforeAll(async () => {
  test.setTimeout(180_000)
  my = await startMysql()
})
test.afterAll(() => my?.stop())

test('connect to MariaDB, pick a table, preview it; the password stays out of the project', async () => {
  test.skip(!my, 'needs MySQL/MariaDB: set SV_MY_HOST or install podman')
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-mysql').click()
  await expect(page.getByRole('dialog')).toContainText('Connect to MySQL / MariaDB')
  await expect(page.getByTestId('pg-port')).toHaveValue('3306')
  await page.getByTestId('pg-host').fill(my!.host)
  await page.getByTestId('pg-port').fill(String(my!.port))
  await page.getByTestId('pg-database').fill(my!.database)
  await page.getByTestId('pg-user').fill(my!.user)
  await page.getByTestId('pg-password').fill('wrong')
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-error')).toContainText('rejected the user name or password')
  await page.getByTestId('pg-password').fill(my!.password)
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-tables')).toContainText('shop.customers')
  await page.getByText('shop.customers').click()
  await page.getByTestId('pg-add').click()
  await page.getByTestId('relation-customers').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('120 rows', { timeout: 20_000 })
  const project = await page.evaluate(() => JSON.stringify((window as any).__sv.get().project))
  expect(project).not.toContain(my!.password)
  expect(project).toContain('"kind":"mysql"')
  await quit(app)
})

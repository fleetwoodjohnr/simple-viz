// Connecting to PostgreSQL through the UI (the packaged app loads the bundled postgres extension).
import { test, expect, launch, quit } from './helpers'
import { startPostgres, type Pg } from '../integration/helpers'

let pg: Pg | null = null
test.beforeAll(async () => {
  pg = await startPostgres()
})
test.afterAll(() => pg?.stop())

test('connect, pick a table, preview it; a wrong password is explained', async () => {
  test.skip(!pg, 'needs PostgreSQL: set SV_PG_HOST or install podman')
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-postgres').click()
  await page.getByTestId('pg-host').fill(pg!.host)
  await page.getByTestId('pg-port').fill(String(pg!.port))
  await page.getByTestId('pg-database').fill(pg!.database)
  await page.getByTestId('pg-user').fill(pg!.user)
  await page.getByTestId('pg-password').fill('wrong')
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-error')).toContainText('rejected the user name or password')
  await page.getByTestId('pg-password').fill(pg!.password)
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-tables')).toContainText('public.customers')
  await page.getByText('public.customers').click()
  await page.getByTestId('pg-add').click()
  await page.getByTestId('relation-customers').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('120 rows', { timeout: 20_000 })
  // The password is in the keychain (or this session), never in the project.
  const project = await page.evaluate(() => JSON.stringify((window as any).__sv.get().project))
  expect(project).not.toContain(pg!.password)
  await quit(app)
})

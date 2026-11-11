// Connectors added through the UI: a database over ODBC (PostgreSQL through its ODBC driver, where both exist) and a
// Google Sheets spreadsheet (a local server answering as Google's export does).
import http from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { test, expect, launch, quit, fixture } from './helpers'
import { odbcPgDriver, startPostgres, type Pg } from '../integration/helpers'

const driver = odbcPgDriver()
let pg: Pg | null = null
test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (driver) pg = await startPostgres()
})
test.afterAll(() => pg?.stop())

test('connect over ODBC, pick a table, preview it; the password stays out of the project', async () => {
  test.skip(!pg, 'needs a PostgreSQL ODBC driver (unixODBC + psqlodbc) and PostgreSQL (SV_PG_HOST or podman)')
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-odbc').click()
  const conn = `Driver={${driver}};Server=${pg!.host};Port=${pg!.port};Database=${pg!.database};SSLmode=disable`
  // A password belongs in its own box (the keychain), not in the string the project keeps.
  await page.getByTestId('pg-database').fill(`${conn};PWD=${pg!.password}`)
  await expect(page.getByRole('dialog')).toContainText('password')
  await expect(page.getByTestId('pg-test')).toBeDisabled()
  await page.getByTestId('pg-database').fill(conn)
  await page.getByTestId('pg-user').fill(pg!.user)
  await page.getByTestId('pg-password').fill('wrong')
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-error')).toContainText('rejected the user name or password')
  await page.getByTestId('pg-password').fill(pg!.password)
  await page.getByTestId('pg-test').click()
  await expect(page.getByTestId('pg-tables')).toContainText('public.customers')
  // A short list is picked by default.
  await expect(page.getByTestId('pg-tables').getByRole('checkbox')).toBeChecked()
  await page.getByTestId('pg-add').click()
  await page.getByTestId('relation-customers').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('120 rows', { timeout: 20_000 })
  const project = await page.evaluate(() => JSON.stringify((window as any).__sv.get().project))
  expect(project).not.toContain(pg!.password)
  expect(project).toContain('"kind":"odbc"')
  await quit(app)
})

test('add a Google Sheets spreadsheet by its address', async () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-pub'
  const server = http.createServer((req, res) => (req.url === `/spreadsheets/d/${id}/export?format=xlsx` ? res.writeHead(200).end(readFileSync(fixture('Sales.xlsx'))) : res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!DOCTYPE html><title>Sign in</title>')))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { app, page } = await launch({ env: { SV_GOOGLE_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } })
  try {
    await page.getByTestId('new-project').click()
    await page.getByTestId('add-data').click()
    await page.getByTestId('add-gsheets').click()
    await page.getByTestId('remote-url').fill('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-prv/edit')
    await page.getByTestId('remote-test').click()
    await expect(page.getByTestId('remote-error')).toContainText('isn’t shared by link')
    await page.getByTestId('remote-url').fill(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`)
    await page.getByTestId('remote-test').click()
    await expect(page.getByTestId('remote-tables')).toContainText('Transactions')
    await page.getByTestId('remote-add').click()
    await page.getByTestId('relation-transactions').click()
    await expect(page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 })
    expect(await page.evaluate(() => (window as any).__sv.get().project.sources.map((s: any) => [s.remote?.provider, s.format]))).toEqual([['gsheets', 'xlsx']])
  } finally {
    await quit(app)
    server.close()
  }
})

// A file on the web, added through the UI: the address is tried, its sheets listed, and it loads like a local file.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { test, expect, launch, quit, fixture } from './helpers'

let server: http.Server
let base = ''
test.beforeAll(async () => {
  const files: Record<string, Buffer> = { '/data/customers.csv': readFileSync(fixture('customers.csv')), '/data/Sales.xlsx': readFileSync(fixture('Sales.xlsx')) }
  server = http.createServer((req, res) => {
    const body = files[(req.url ?? '').split('?')[0]]
    if (!body) return void res.writeHead(404).end()
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    if (req.method === 'HEAD') return void res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' }).end()
    if (range) {
      const a = Number(range[1])
      const b = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      return void res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' }).end(body.subarray(a, b + 1))
    }
    res.writeHead(200, { 'Content-Length': body.length }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => server?.close())

test('add a CSV and a workbook by web address', async () => {
  const { app, page } = await launch()
  await page.getByTestId('new-project').click()
  const addRemote = async (url: string) => {
    await page.getByTestId('add-data').click()
    await page.getByTestId('add-remote').click()
    await page.getByTestId('remote-url').fill(url)
    await page.getByTestId('remote-test').click()
  }
  await addRemote(`${base}/data/missing.csv`)
  await expect(page.getByTestId('remote-error')).toBeVisible()
  await page.getByTestId('remote-url').fill(`${base}/data/customers.csv`)
  await page.getByTestId('remote-test').click()
  await expect(page.getByTestId('remote-tables')).toContainText('customers')
  await page.getByTestId('remote-add').click()
  await page.getByTestId('relation-customers').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('120 rows')

  await addRemote(`${base}/data/Sales.xlsx`)
  await expect(page.getByTestId('remote-tables')).toContainText('Transactions')
  await page.getByTestId('remote-add').click()
  await page.getByTestId('relation-transactions').click()
  await expect(page.getByTestId('relation-rows')).toHaveText('1,000 rows')
  const project = await page.evaluate(() => (window as any).__sv.get().project.sources.map((s: any) => [s.path.startsWith('http'), s.remote?.provider, s.refresh.watch]))
  expect(project).toEqual([[true, 'http', false], [true, 'http', false]])
  await quit(app)
})

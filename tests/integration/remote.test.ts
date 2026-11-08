// Files on the web (and, below, in S3-compatible storage): read through DuckDB's httpfs under the same lockdown as
// local files. Only the exact address of each source can be read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { bootEngine, fixture, rows, expected, extensionsDir } from './helpers'
import { Engine } from '../../src/engine/engine'
import type { ResolvedSource } from '../../src/shared/engine-protocol'

let server: http.Server
let base = ''
const files: Record<string, Buffer> = {}
beforeAll(async () => {
  files['/customers.csv'] = readFileSync(fixture('customers.csv'))
  files['/Sales.xlsx'] = readFileSync(fixture('Sales.xlsx'))
  files['/private/customers.csv'] = files['/customers.csv']
  server = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0]
    if (p.startsWith('/private/') && req.headers.authorization !== 'Bearer sv-token') return void res.writeHead(401).end('no')
    const body = files[p]
    if (!body) return void res.writeHead(404).end('missing')
    // httpfs asks for ranges; answer them as a static server would.
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    const head = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Last-Modified': new Date(0).toUTCString() }
    if (req.method === 'HEAD') return void res.writeHead(200, { ...head, 'Content-Length': body.length }).end()
    if (range) {
      const a = Number(range[1])
      const b = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      return void res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 }).end(body.subarray(a, b + 1))
    }
    res.writeHead(200, { ...head, 'Content-Length': body.length }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server?.close())

const web = (id: string, p: string, format: ResolvedSource['format'], tables: ResolvedSource['tables'], token?: string): ResolvedSource => ({ id, kind: 'file', format, path: `${base}${p}`, tables, mode: 'extract', timeoutSec: 20, remote: { provider: 'http', hasSecret: !!token }, password: token })

describe('files on the web', () => {
  it('extracts a CSV and an Excel workbook by URL and joins them; a changed file is picked up on refresh', async () => {
    const { engine } = await bootEngine([web('w1', '/customers.csv', 'csv', [{ alias: 'customers' }]), web('w2', '/Sales.xlsx', 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    const out = await rows(engine, 'SELECT c.region, round(sum(t.revenue), 2) AS revenue FROM transactions t JOIN customers c USING (customer_id) GROUP BY 1')
    for (const r of out) expect(Math.abs(Number(r.revenue) - expected().v1.revenueByRegion[r.region as string])).toBeLessThan(0.01)
    // A new version on the server (no modification time to compare: the content fingerprint decides).
    files['/Sales.xlsx'] = readFileSync(fixture('Sales-v2.xlsx'))
    await engine.refresh(['w2'])
    expect(Number((await rows(engine, 'SELECT count(*) AS n FROM transactions'))[0].n)).toBe(expected().v2.rows)
    files['/Sales.xlsx'] = readFileSync(fixture('Sales.xlsx'))
    // Only the sources' own addresses can be read, even below the SQL gate.
    await expect((engine as any)._ungated(`SELECT * FROM read_csv('${base}/private/customers.csv')`)).rejects.toThrow(/disabled by configuration/)
    await engine.close()
  })

  it('a token-protected file needs its token; probing lists a remote workbook’s sheets', async () => {
    const ok = await bootEngine([web('p1', '/private/customers.csv', 'csv', [{ alias: 'customers' }], 'sv-token')])
    expect(Number((await rows(ok.engine, 'SELECT count(*) AS n FROM customers'))[0].n)).toBe(expected().customers)
    await ok.engine.close()
    const bad = await bootEngine([web('p2', '/private/customers.csv', 'csv', [{ alias: 'customers' }])])
    expect(bad.engine.statuses().find((s) => s.id === 'p2')?.state).toBe('error')
    await bad.engine.close()
    expect((await Engine.probe(web('x', '/Sales.xlsx', 'xlsx', []), extensionsDir)).tables).toContain('Transactions')
    expect((await Engine.probe(web('y', '/customers.csv', 'csv', []), extensionsDir)).tables).toEqual(['customers'])
  })
})

// ---------------------------------------------------------------- S3 (S3Mock in podman: an S3-compatible endpoint)

describe('files in S3-compatible storage', () => {
  let s3: { endpoint: string; stop(): void } | null = null
  beforeAll(async () => {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('podman', ['--version'], { stdio: 'ignore' })
    } catch {
      return console.warn('S3 tests skipped: no podman')
    }
    if (process.env.SV_NO_PODMAN) return
    const name = `sv-s3-${process.pid}-${Date.now()}`
    const port = 20000 + Math.floor(Math.random() * 20000)
    execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:9090`, '-e', 'COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=data', '-e', 'initialBuckets=data', 'docker.io/adobe/s3mock:latest'], { stdio: 'ignore' })
    const endpoint = `127.0.0.1:${port}`
    s3 = { endpoint, stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
    const put = (key: string, body: Buffer) => fetch(`http://${endpoint}/data/${key}`, { method: 'PUT', body: new Uint8Array(body) })
    for (const t0 = Date.now(); ; ) {
      try {
        if ((await put('customers.csv', readFileSync(fixture('customers.csv')))).ok) break
      } catch {
        /* starting */
      }
      if (Date.now() - t0 > 90_000) throw new Error('S3Mock did not start')
      await new Promise((r) => setTimeout(r, 1000))
    }
    await put('sales/Sales.xlsx', readFileSync(fixture('Sales.xlsx')))
  }, 180_000)
  afterAll(() => s3?.stop())

  const src = (id: string, key: string, format: ResolvedSource['format'], tables: ResolvedSource['tables']): ResolvedSource => ({ id, kind: 'file', format, path: `s3://data/${key}`, tables, mode: 'extract', timeoutSec: 20, remote: { provider: 's3', endpoint: s3!.endpoint, urlStyle: 'path', useSsl: false, region: 'us-east-1', keyId: 'test-key', hasSecret: true }, password: 'test-secret' })

  it('reads a CSV and a workbook from a bucket through a custom endpoint', async (ctx) => {
    if (!s3) return ctx.skip()
    const { engine } = await bootEngine([src('s1', 'customers.csv', 'csv', [{ alias: 'customers' }]), src('s2', 'sales/Sales.xlsx', 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    expect(engine.statuses().map((s) => s.state)).toEqual(['ok', 'ok'])
    const [r] = await rows(engine, 'SELECT count(*) AS n, round(sum(revenue), 2) AS revenue FROM transactions JOIN customers USING (customer_id)')
    expect(Number(r.n)).toBe(expected().v1.rows)
    expect(Math.abs(Number(r.revenue) - expected().v1.revenue)).toBeLessThan(0.01)
    expect((await Engine.probe(src('x', 'sales/Sales.xlsx', 'xlsx', []), extensionsDir)).tables).toContain('Transactions')
    await engine.close()
  })
})

// ---------------------------------------------------------------- Azure Blob (Azurite in podman)

describe('files in Azure Blob storage', () => {
  // Azurite's published development account (not a secret).
  const ACCOUNT = 'devstoreaccount1'
  const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
  let az: { conn: string; stop(): void } | null = null

  /** PUT with Shared Key authorization (Azure's REST signing), enough for creating a container and uploading blobs. */
  async function azPut(blobBase: string, resource: string, body: Buffer | null, query = '') {
    const { createHmac } = await import('node:crypto')
    const date = new Date().toUTCString()
    const headers: Record<string, string> = { 'x-ms-date': date, 'x-ms-version': '2021-08-06', ...(body ? { 'x-ms-blob-type': 'BlockBlob' } : {}) }
    const canonHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}`).join('\n')
    const canonQuery = query ? `\n${query.split('&').map((kv) => kv.split('=')).sort().map(([k, v]) => `${k}:${v}`).join('\n')}` : ''
    const length = body?.length ? String(body.length) : ''
    const toSign = ['PUT', '', '', length, '', body ? 'application/octet-stream' : '', '', '', '', '', '', '', canonHeaders, `/${ACCOUNT}/${ACCOUNT}/${resource}${canonQuery}`].join('\n')
    const sig = createHmac('sha256', Buffer.from(KEY, 'base64')).update(toSign, 'utf8').digest('base64')
    const res = await fetch(`${blobBase}/${resource}${query ? `?${query}` : ''}`, { method: 'PUT', body: body ? new Uint8Array(body) : undefined, headers: { ...headers, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}), Authorization: `SharedKey ${ACCOUNT}:${sig}` } })
    if (!res.ok && res.status !== 409) throw new Error(`Azurite PUT ${resource}: ${res.status} ${await res.text()}`)
  }

  beforeAll(async () => {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('podman', ['--version'], { stdio: 'ignore' })
    } catch {
      return console.warn('Azure tests skipped: no podman')
    }
    if (process.env.SV_NO_PODMAN) return
    const name = `sv-az-${process.pid}-${Date.now()}`
    const port = 20000 + Math.floor(Math.random() * 20000)
    execFileSync('podman', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:10000`, 'mcr.microsoft.com/azure-storage/azurite:latest', 'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'], { stdio: 'ignore' })
    const blobBase = `http://127.0.0.1:${port}/${ACCOUNT}`
    az = { conn: `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};BlobEndpoint=${blobBase};`, stop: () => void execFileSync('podman', ['rm', '-f', name], { stdio: 'ignore' }) }
    for (const t0 = Date.now(); ; ) {
      try {
        await azPut(blobBase, 'data', null, 'restype=container')
        break
      } catch (e) {
        if (Date.now() - t0 > 90_000) throw e
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    await azPut(blobBase, 'data/customers.csv', readFileSync(fixture('customers.csv')))
  }, 180_000)
  afterAll(() => az?.stop())

  it('reads a CSV from a container with a connection string', async (ctx) => {
    if (!az) return ctx.skip()
    const s: ResolvedSource = { id: 'a1', kind: 'file', format: 'csv', path: 'az://data/customers.csv', tables: [{ alias: 'customers' }], mode: 'extract', timeoutSec: 20, remote: { provider: 'azure', hasSecret: true }, password: az.conn }
    const { engine } = await bootEngine([s])
    expect(engine.statuses()[0]).toMatchObject({ state: 'ok' })
    expect(Number((await rows(engine, 'SELECT count(*) AS n FROM customers'))[0].n)).toBe(expected().customers)
    await engine.close()
  })
})

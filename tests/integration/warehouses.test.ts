// ClickHouse (HTTP interface) and Trino (REST protocol), extract only: tables copied into the cache with their types,
// joined with a file, refreshed, listed for the connection dialog; a wrong password is explained. Skipped without
// podman (or SV_CH_HOST / SV_TRINO_HOST).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { bootEngine, startClickHouse, startTrino, startBigQuery, chExec, whSource, fileSource, fixture, rows, expected, extensionsDir, type Wh } from './helpers'
import { Engine } from '../../src/engine/engine'
import { bigqueryType, clickhouseType, trinoType } from '../../src/engine/warehouses'

let ch: Wh | null = null
let tr: Wh | null = null
let bq: Wh | null = null
// Small result pages, so BigQuery's paging is exercised.
process.env.SV_BQ_PAGE = '1000'
beforeAll(async () => {
  ;[ch, tr, bq] = await Promise.all([startClickHouse(), startTrino(), startBigQuery()])
  if (!ch) console.warn('ClickHouse tests skipped: no podman and no SV_CH_HOST')
  if (!tr) console.warn('Trino tests skipped: no podman and no SV_TRINO_HOST')
}, 300_000)
afterAll(() => (ch?.stop(), tr?.stop(), bq?.stop()))

describe('ClickHouse and Trino', () => {
  it('BigQuery sign-in: a service-account key becomes a signed JWT for a read-only token, used as the bearer', async () => {
    const { generateKeyPairSync, createVerify } = await import('node:crypto')
    const { createServer } = await import('node:http')
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const seen: { claim?: Record<string, unknown>; valid?: boolean; bearer?: string } = {}
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.url === '/token') {
          const jwt = new URLSearchParams(body).get('assertion')!
          const [h, c, sig] = jwt.split('.')
          seen.valid = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'))
          seen.claim = JSON.parse(Buffer.from(c, 'base64url').toString())
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }))
        } else {
          seen.bearer = req.headers.authorization
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(req.url!.endsWith('/datasets') ? { datasets: [{ datasetReference: { datasetId: 'd' } }] } : { tables: [{ tableReference: { tableId: 't' } }] }))
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const key = JSON.stringify({ client_email: 'sv@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `http://127.0.0.1:${port}/token` })
      const src = { id: 'bq', kind: 'bigquery' as const, host: '127.0.0.1', port, database: 'p', sslmode: 'disable' as const, password: key, mode: 'extract' as const, timeoutSec: 10, tables: [] }
      expect(await Engine.probe(src, extensionsDir)).toEqual({ tables: ['d.t'] })
      expect(seen.valid).toBe(true)
      expect(seen.claim).toMatchObject({ iss: 'sv@p.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/bigquery.readonly', aud: `http://127.0.0.1:${port}/token` })
      expect(seen.bearer).toBe('Bearer tok-123')
      await expect(Engine.probe({ ...src, password: '{"client_email":"x"}' }, extensionsDir)).rejects.toThrow(/needs client_email, private_key/)
    } finally {
      server.close()
    }
  })

  it('maps their types to DuckDB types', () => {
    expect(['UInt32', 'Nullable(Int64)', 'LowCardinality(Nullable(String))', 'UInt64', 'Decimal(6, 2)', 'Date32', "DateTime64(3, 'UTC')", 'Bool', 'Array(String)'].map(clickhouseType)).toEqual(['BIGINT', 'BIGINT', 'VARCHAR', 'DOUBLE', 'DOUBLE', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR'])
    expect(['integer', 'bigint', 'decimal(12,2)', 'real', 'date', 'timestamp(3) with time zone', 'boolean', 'varchar(25)', 'array(integer)'].map(trinoType)).toEqual(['BIGINT', 'BIGINT', 'DOUBLE', 'DOUBLE', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR', 'VARCHAR'])
    expect(['INTEGER', 'INT64', 'FLOAT', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'DATETIME', 'STRING', 'RECORD'].map(bigqueryType)).toEqual(['BIGINT', 'BIGINT', 'DOUBLE', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'TIMESTAMP', 'VARCHAR', 'VARCHAR'])
  })

  it('BigQuery (its emulator): extracts tables with their types over several result pages, lists datasets', async (ctx) => {
    if (!bq) return ctx.skip()
    const src = { ...whSource(bq, 'bigquery', [{ alias: 'bq_customers', ref: 'shop.customers' }, { alias: 'numbers', ref: 'shop.numbers' }]), sslmode: 'disable' as const }
    const { engine } = await bootEngine([src, fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    expect(engine.statuses().find((s) => s.id === 'bigquery1')?.error ?? 'ok').toBe('ok')
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE bq_customers)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toEqual({ customer_id: 'BIGINT', customer_name: 'VARCHAR', region: 'VARCHAR', segment: 'VARCHAR', since: 'DATE', score: 'DOUBLE', vip: 'BOOLEAN', seen: 'TIMESTAMP' })
    const out = await rows(engine, 'SELECT c.region, round(sum(t.revenue), 2) AS revenue FROM transactions t JOIN bq_customers c USING (customer_id) GROUP BY 1')
    for (const r of out) expect(Math.abs(Number(r.revenue) - expected().v1.revenueByRegion[r.region as string])).toBeLessThan(0.01)
    const [f] = await rows(engine, 'SELECT min(since)::VARCHAR AS first, count(*) FILTER (WHERE vip) AS vip, max(seen)::VARCHAR AS last FROM bq_customers')
    expect(f).toEqual({ first: '2024-01-02', vip: Array.from({ length: expected().customers }, (_, i) => i).filter((i) => i % 3 === 0).length, last: '2024-03-09 10:20:30' })
    const [n] = await rows(engine, 'SELECT count(*) AS c, sum(n) AS s FROM numbers')
    expect([Number(n.c), Number(n.s)]).toEqual([2_500, (2_500 * 2_501) / 2])
    expect((await Engine.probe(src, extensionsDir)).tables).toEqual(['shop.customers', 'shop.numbers'])
    await engine.close()
  })

  it('ClickHouse: extracts a table with its types, joins it with Excel, refreshes, lists tables', async (ctx) => {
    if (!ch) return ctx.skip()
    const src = whSource(ch, 'clickhouse', [{ alias: 'ch_customers', ref: 'shop.customers' }])
    const { engine } = await bootEngine([src, fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    expect(engine.statuses().find((s) => s.id === 'clickhouse1')?.state).toBe('ok')
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE ch_customers)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toEqual({ customer_id: 'BIGINT', customer_name: 'VARCHAR', region: 'VARCHAR', segment: 'VARCHAR', since: 'DATE', score: 'DOUBLE', vip: 'BOOLEAN', seen: 'TIMESTAMP', big: 'DOUBLE' })
    const out = await rows(engine, 'SELECT c.region, round(sum(t.revenue), 2) AS revenue FROM transactions t JOIN ch_customers c USING (customer_id) GROUP BY 1')
    for (const r of out) expect(Math.abs(Number(r.revenue) - expected().v1.revenueByRegion[r.region as string])).toBeLessThan(0.01)
    const [f] = await rows(engine, "SELECT min(since)::VARCHAR AS first, count(*) FILTER (WHERE vip) AS vip, count(score) AS scored, max(seen)::VARCHAR AS last, round(sum(score), 2) AS total FROM ch_customers")
    const n = expected().customers
    const idx = Array.from({ length: n }, (_, i) => i)
    expect(f).toEqual({ first: '2024-01-02', vip: idx.filter((i) => i % 3 === 0).length, scored: idx.filter((i) => i % 7).length, last: `2024-03-09 10:20:30.${String(Math.max(...idx.filter((i) => i % 9 === 8))).padStart(3, '0')}`, total: Math.round(idx.filter((i) => i % 7).reduce((a, i) => a + i * 1.25, 0) * 100) / 100 })
    await chExec(ch, "INSERT INTO shop.customers (customer_id, customer_name, region, segment, vip, seen, big) VALUES (9999, 'Late', 'Texas', 'Consumer', false, now(), 1)")
    await engine.refresh(['clickhouse1'])
    expect(Number((await rows(engine, 'SELECT count(*) AS n FROM ch_customers'))[0].n)).toBe(n + 1)
    await chExec(ch, 'ALTER TABLE shop.customers DELETE WHERE customer_id = 9999 SETTINGS mutations_sync = 1')
    expect((await Engine.probe(src, extensionsDir)).tables).toContain('shop.customers')
    await engine.close()
    // A wrong password is explained; nothing but reads reach the server (readonly=1).
    const { engine: bad } = await bootEngine([whSource(ch, 'clickhouse', [{ alias: 'x', ref: 'shop.customers' }], 'wrong')])
    expect(bad.statuses().find((s) => s.id === 'clickhouse1')).toMatchObject({ state: 'error' })
    expect(bad.statuses().find((s) => s.id === 'clickhouse1')!.error).toMatch(/password|Authentication/i)
    await bad.close()
  })

  it('Trino: extracts TPC-H tables over several result pages with their types, lists a catalog', async (ctx) => {
    if (!tr) return ctx.skip()
    const src = whSource(tr, 'trino', [{ alias: 'orders', ref: 'tiny.orders' }, { alias: 'nation', ref: 'tiny.nation' }])
    const { engine } = await bootEngine([src])
    expect(engine.statuses().find((s) => s.id === 'trino1')?.error ?? 'ok').toBe('ok')
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE orders)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toMatchObject({ orderkey: 'BIGINT', totalprice: 'DOUBLE', orderdate: 'DATE', orderstatus: 'VARCHAR' })
    // TPC-H scale "tiny" (0.01): 15,000 orders from 1992-01-01; 25 nations numbered 0–24.
    const [o] = await rows(engine, 'SELECT count(*) AS n, min(orderdate)::VARCHAR AS first FROM orders')
    expect(o).toEqual({ n: 15000, first: '1992-01-01' })
    expect(Number((await rows(engine, 'SELECT sum(nationkey) AS s FROM nation'))[0].s)).toBe(300)
    const tables = (await Engine.probe(src, extensionsDir)).tables
    expect(tables).toEqual(expect.arrayContaining(['tiny.orders', 'tiny.nation', 'tiny.customer']))
    await engine.close()
    await expect(Engine.probe({ ...src, database: '' }, extensionsDir)).rejects.toThrow(/catalog/)
  })
})

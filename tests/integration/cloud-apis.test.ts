// Snowflake (SQL API v2) and Databricks (SQL Statement Execution API) against local servers that answer as each API's
// documentation describes: sign-in (Snowflake key-pair JWT, Databricks token), statements still running (202 /
// PENDING), results in several partitions or chunks, and their value formats. Not the services themselves.
import { it, expect } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateKeyPairSync, createVerify, createHash } from 'node:crypto'
import { bootEngine, rows, extensionsDir } from './helpers'
import { Engine } from '../../src/engine/engine'
import type { ResolvedSource } from '../../src/shared/engine-protocol'

async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(req, body, res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, close: () => server.close() }
}
const json = (res: ServerResponse, status: number, o: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o))
const src = (kind: 'snowflake' | 'databricks', port: number, extra: Partial<ResolvedSource>): ResolvedSource => ({ id: kind, kind, host: '127.0.0.1', port, sslmode: 'disable', mode: 'extract', timeoutSec: 10, tables: [], ...extra })

it('Snowflake: key-pair JWT sign-in, a statement that is still running, two result partitions, typed values', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const fp = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  const rowType = [{ name: 'ID', type: 'fixed', scale: 0 }, { name: 'AMOUNT', type: 'fixed', scale: 2 }, { name: 'NAME', type: 'text' }, { name: 'DAY', type: 'date' }, { name: 'AT', type: 'timestamp_ntz' }, { name: 'OK', type: 'boolean' }]
  const issuers: string[] = []
  const srv = await serve((req, body, res) => {
    const [h, c, sig] = (req.headers.authorization ?? '').replace('Bearer ', '').split('.')
    const ok = !!sig && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')) && req.headers['x-snowflake-authorization-token-type'] === 'KEYPAIR_JWT'
    if (!ok) return json(res, 401, { message: 'JWT token is invalid.', code: '390144' })
    issuers.push(JSON.parse(Buffer.from(c, 'base64url').toString()).iss)
    const url = new URL(req.url!, 'http://x')
    if (req.method === 'POST') {
      const b = JSON.parse(body) as { statement: string; database: string }
      if (b.database !== 'SALES') return json(res, 422, { message: 'Database does not exist.' })
      if (/information_schema/i.test(b.statement)) return json(res, 200, { resultSetMetaData: { rowType: [{ name: 'TABLE_SCHEMA', type: 'text' }, { name: 'TABLE_NAME', type: 'text' }], partitionInfo: [{ rowCount: 1 }] }, data: [['PUBLIC', 'ORDERS']], statementHandle: 'h1' })
      expect(b.statement).toBe('SELECT * FROM "SALES"."PUBLIC"."ORDERS"')
      return json(res, 202, { statementHandle: 'h2', message: 'Asynchronous execution in progress.' })
    }
    if (url.pathname === '/api/v2/statements/h2' && !url.searchParams.get('partition')) return json(res, 200, { resultSetMetaData: { rowType, partitionInfo: [{ rowCount: 2 }, { rowCount: 1 }] }, data: [['1', '10.50', 'a', '19723', '1704103200.000000000', 'true'], ['2', null, 'b', '19724', '1704189600.500000000', 'false']], statementHandle: 'h2' })
    if (url.searchParams.get('partition') === '1') return json(res, 200, { data: [['3', '7.25', null, null, null, null]] })
    json(res, 404, { message: 'not found' })
  })
  try {
    const s = src('snowflake', srv.port, { user: 'sv', database: 'SALES', password: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, tables: [{ alias: 'orders', ref: 'PUBLIC.ORDERS' }] })
    expect(await Engine.probe(s, extensionsDir)).toEqual({ tables: ['PUBLIC.ORDERS'] })
    const { engine } = await bootEngine([s])
    expect(engine.statuses()[0].error ?? 'ok').toBe('ok')
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE orders)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toEqual({ ID: 'BIGINT', AMOUNT: 'DOUBLE', NAME: 'VARCHAR', DAY: 'DATE', AT: 'TIMESTAMP', OK: 'BOOLEAN' })
    expect(await rows(engine, 'SELECT ID, AMOUNT, NAME, DAY::VARCHAR AS DAY, "AT"::VARCHAR AS "AT", OK FROM orders ORDER BY ID')).toEqual([
      { ID: 1, AMOUNT: 10.5, NAME: 'a', DAY: '2024-01-01', AT: '2024-01-01 10:00:00', OK: true },
      { ID: 2, AMOUNT: null, NAME: 'b', DAY: '2024-01-02', AT: '2024-01-02 10:00:00.5', OK: false },
      { ID: 3, AMOUNT: 7.25, NAME: null, DAY: null, AT: null, OK: null }
    ])
    expect(issuers.every((i) => i === `127.SV.SHA256:${fp}`)).toBe(true)
    await engine.close()
    await expect(Engine.probe({ ...s, password: 'not a key' }, extensionsDir)).rejects.toThrow(/JWT token is invalid/)
  } finally {
    srv.close()
  }
})

it('Databricks: token sign-in, a statement that is pending, results in two chunks, typed values', async () => {
  const srv = await serve((req, body, res) => {
    if (req.headers.authorization !== 'Bearer dapi-test') return json(res, 401, { error_code: 'UNAUTHENTICATED', message: 'Invalid access token.' })
    const url = new URL(req.url!, 'http://x')
    const columns = [{ name: 'id', type_name: 'LONG' }, { name: 'amount', type_name: 'DECIMAL' }, { name: 'day', type_name: 'DATE' }, { name: 'at', type_name: 'TIMESTAMP' }, { name: 'ok', type_name: 'BOOLEAN' }, { name: 'tags', type_name: 'ARRAY' }]
    if (req.method === 'POST') {
      const b = JSON.parse(body) as { statement: string; warehouse_id: string; catalog: string; disposition: string }
      expect([b.warehouse_id, b.catalog, b.disposition]).toEqual(['wh1', 'main', 'INLINE'])
      if (/information_schema/i.test(b.statement)) return json(res, 200, { statement_id: 's0', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'table_schema', type_name: 'STRING' }, { name: 'table_name', type_name: 'STRING' }] } }, result: { data_array: [['shop', 'orders']] } })
      expect(b.statement).toBe('SELECT * FROM `main`.`shop`.`orders`')
      return json(res, 200, { statement_id: 's1', status: { state: 'PENDING' } })
    }
    if (url.pathname === '/api/2.0/sql/statements/s1') return json(res, 200, { statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns } }, result: { data_array: [['1', '10.50', '2024-01-01', '2024-01-01T10:00:00.000Z', 'true', '["x"]']], next_chunk_internal_link: '/api/2.0/sql/statements/s1/result/chunks/1' } })
    if (url.pathname === '/api/2.0/sql/statements/s1/result/chunks/1') return json(res, 200, { chunk_index: 1, data_array: [['2', null, null, null, 'false', null]] })
    json(res, 404, { message: 'not found' })
  })
  try {
    const s = src('databricks', srv.port, { user: 'wh1', database: 'main', password: 'dapi-test', tables: [{ alias: 'orders', ref: 'shop.orders' }] })
    expect(await Engine.probe(s, extensionsDir)).toEqual({ tables: ['shop.orders'] })
    const { engine } = await bootEngine([s])
    expect(engine.statuses()[0].error ?? 'ok').toBe('ok')
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE orders)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toEqual({ id: 'BIGINT', amount: 'DOUBLE', day: 'DATE', at: 'TIMESTAMP', ok: 'BOOLEAN', tags: 'VARCHAR' })
    expect(await rows(engine, 'SELECT id, amount, day::VARCHAR AS day, "at"::VARCHAR AS "at", ok, tags FROM orders ORDER BY id')).toEqual([
      { id: 1, amount: 10.5, day: '2024-01-01', at: '2024-01-01 10:00:00', ok: true, tags: '["x"]' },
      { id: 2, amount: null, day: null, at: null, ok: false, tags: null }
    ])
    await engine.close()
    await expect(Engine.probe({ ...s, password: 'wrong' }, extensionsDir)).rejects.toThrow(/Invalid access token/)
  } finally {
    srv.close()
  }
})

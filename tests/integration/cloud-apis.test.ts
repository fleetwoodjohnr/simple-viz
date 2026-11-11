// Snowflake (SQL API v2), Databricks (SQL Statement Execution API), Amazon Athena and Google Sheets against local
// servers that answer as each API's documentation describes: sign-in (Snowflake key-pair JWT, Databricks token, AWS
// Signature Version 4, a Google service account), statements still running (202 / PENDING / QUEUED), results in
// several partitions, chunks or pages, and their value formats. Not the services themselves.
import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { sigv4, athenaEndpoint } from '../../src/engine/athena'
import { sheetId } from '../../src/engine/gsheets'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateKeyPairSync, createVerify, createHash } from 'node:crypto'
import { bootEngine, rows, extensionsDir, fixture, expected } from './helpers'
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
const src = (kind: 'snowflake' | 'databricks' | 'athena', port: number, extra: Partial<ResolvedSource>): ResolvedSource => ({ id: kind, kind, host: '127.0.0.1', port, sslmode: 'disable', mode: 'extract', timeoutSec: 10, tables: [], ...extra })

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
    await expect(Engine.probe({ ...s, password: 'not a key' }, extensionsDir)).rejects.toThrow('The server rejected the user name or password.')
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
    await expect(Engine.probe({ ...s, password: 'wrong' }, extensionsDir)).rejects.toThrow('The server rejected the user name or password.')
  } finally {
    srv.close()
  }
})

// The two worked examples of AWS's Signature Version 4 documentation (its test suite's get-vanilla, and the IAM
// ListUsers request of the signing guide): the signer is checked against AWS's numbers, not against itself.
it('Signature Version 4 matches AWS’s published examples', () => {
  const aws = { region: 'us-east-1', keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z', body: '' }
  expect(sigv4({ ...aws, method: 'GET', host: 'example.amazonaws.com', path: '/', service: 'service' })).toBe(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
  )
  expect(sigv4({ ...aws, method: 'GET', host: 'iam.amazonaws.com', path: '/', query: 'Action=ListUsers&Version=2010-05-08', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, service: 'iam' })).toBe(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7'
  )
  const at = (host: string, extra: Partial<ResolvedSource> = {}) => athenaEndpoint(src('athena', 443, { host, sslmode: 'require', ...extra }))
  expect(at('eu-west-2')).toEqual({ url: 'https://athena.eu-west-2.amazonaws.com/', host: 'athena.eu-west-2.amazonaws.com', region: 'eu-west-2' })
  expect(at('athena-fips.us-gov-west-1.amazonaws.com').region).toBe('us-gov-west-1')
  expect(at('127.0.0.1', { port: 5000, sslmode: 'disable' })).toEqual({ url: 'http://127.0.0.1:5000/', host: '127.0.0.1:5000', region: 'us-east-1' })
})

it('Athena: signed requests, a query that is still running, two result pages, typed values, a failed query, a refused key', async () => {
  const KEY = 'AKIDEXAMPLE'
  const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  const head = (...names: string[]) => ({ Data: names.map((n) => ({ VarCharValue: n })) })
  const info = [['id', 'bigint'], ['amount', 'decimal'], ['name', 'varchar'], ['day', 'date'], ['at', 'timestamp'], ['ok', 'boolean'], ['score', 'double']].map(([Name, Type]) => ({ Name, Type }))
  const started: Record<string, unknown>[] = []
  let polls = 0
  const srv = await serve((req, body, res) => {
    const h = (n: string) => String(req.headers[n])
    const signed = sigv4({ method: 'POST', host: h('host'), path: '/', headers: { 'content-type': h('content-type'), 'x-amz-target': h('x-amz-target') }, body, region: 'us-east-1', service: 'athena', keyId: KEY, secret: SECRET, amzDate: h('x-amz-date') })
    if (req.headers.authorization !== signed) return json(res, 403, { __type: 'InvalidSignatureException', message: 'The request signature we calculated does not match the signature you provided.' })
    const b = JSON.parse(body) as { QueryString?: string; QueryExecutionId?: string; NextToken?: string }
    switch (h('x-amz-target')) {
      case 'AmazonAthena.StartQueryExecution':
        started.push(b)
        return json(res, 200, { QueryExecutionId: /information_schema/.test(b.QueryString!) ? 'q-tables' : b.QueryString === 'SELECT * FROM "sales"."orders"' ? 'q-orders' : 'q-broken' })
      case 'AmazonAthena.GetQueryExecution': {
        if (b.QueryExecutionId === 'q-broken') return json(res, 200, { QueryExecution: { Status: { State: 'FAILED', StateChangeReason: 'TABLE_NOT_FOUND: line 1:15: Table awsdatacatalog.sales.broken does not exist' } } })
        const State = b.QueryExecutionId === 'q-orders' ? (['QUEUED', 'RUNNING'][polls++] ?? 'SUCCEEDED') : 'SUCCEEDED'
        return json(res, 200, { QueryExecution: { Status: { State } } })
      }
      case 'AmazonAthena.GetQueryResults':
        if (b.QueryExecutionId === 'q-tables') return json(res, 200, { ResultSet: { Rows: [head('table_schema', 'table_name'), head('sales', 'orders')], ResultSetMetadata: { ColumnInfo: [] } } })
        if (!b.NextToken) return json(res, 200, { NextToken: 'page2', ResultSet: { ResultSetMetadata: { ColumnInfo: info }, Rows: [head(...info.map((c) => c.Name)), head('1', '10.50', 'a', '2024-01-01', '2024-01-01 10:00:00.000', 'true', '1.5'), head('2', '0.00', 'b', '2024-01-02', '2024-01-02 10:00:00.500', 'false', '-2')] } })
        expect(b.NextToken).toBe('page2')
        // A null has no VarCharValue.
        return json(res, 200, { ResultSet: { ResultSetMetadata: { ColumnInfo: info }, Rows: [{ Data: [{ VarCharValue: '3' }, {}, {}, {}, {}, {}, {}] }] } })
    }
    json(res, 400, { __type: 'UnknownOperationException' })
  })
  try {
    const s = src('athena', srv.port, { user: KEY, password: SECRET, database: 'sales', workgroup: 'analytics', output: 's3://bucket/results/', tables: [{ alias: 'orders', ref: 'sales.orders' }] })
    expect(await Engine.probe(s, extensionsDir)).toEqual({ tables: ['sales.orders'] })
    const { engine } = await bootEngine([s])
    expect(engine.statuses()[0].error ?? 'ok').toBe('ok')
    expect(polls).toBe(3)
    expect(started.at(-1)).toEqual({ QueryString: 'SELECT * FROM "sales"."orders"', QueryExecutionContext: { Database: 'sales' }, WorkGroup: 'analytics', ResultConfiguration: { OutputLocation: 's3://bucket/results/' } })
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE orders)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toEqual({ id: 'BIGINT', amount: 'DOUBLE', name: 'VARCHAR', day: 'DATE', at: 'TIMESTAMP', ok: 'BOOLEAN', score: 'DOUBLE' })
    expect(await rows(engine, 'SELECT id, amount, name, day::VARCHAR AS day, "at"::VARCHAR AS "at", ok, score FROM orders ORDER BY id')).toEqual([
      { id: 1, amount: 10.5, name: 'a', day: '2024-01-01', at: '2024-01-01 10:00:00', ok: true, score: 1.5 },
      { id: 2, amount: 0, name: 'b', day: '2024-01-02', at: '2024-01-02 10:00:00.5', ok: false, score: -2 },
      { id: 3, amount: null, name: null, day: null, at: null, ok: null, score: null }
    ])
    await engine.close()
    const broken = await bootEngine([{ ...s, tables: [{ alias: 'broken', ref: 'sales.broken' }] }])
    expect(broken.engine.statuses()[0].error).toContain('Table awsdatacatalog.sales.broken does not exist')
    await broken.engine.close()
    await expect(Engine.probe({ ...s, password: 'not the secret' }, extensionsDir)).rejects.toThrow('The server rejected the user name or password.')
    await expect(Engine.probe({ ...s, password: '' }, extensionsDir)).rejects.toThrow('The server rejected the user name or password.')
  } finally {
    srv.close()
  }
})

it('Google Sheets: a spreadsheet shared by link, a private one through a service account, and one that isn’t shared', async () => {
  const PUBLIC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-pub'
  const PRIVATE = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-prv'
  expect(sheetId(`https://docs.google.com/spreadsheets/d/${PUBLIC}/edit?gid=0#gid=0`)).toBe(PUBLIC)
  expect(sheetId(`https://docs.google.com.evil.example/spreadsheets/d/${PUBLIC}/edit`)).toBeNull()
  expect(sheetId(`http://docs.google.com/spreadsheets/d/${PUBLIC}`)).toBeNull()
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const book = readFileSync(fixture('Sales.xlsx'))
  const xlsx = (res: ServerResponse) => res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).end(book)
  const scopes: string[] = []
  const srv = await serve((req, body, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/token') {
      const [h, c, sig] = (new URLSearchParams(body).get('assertion') ?? '').split('.')
      if (!sig || !createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'))) return json(res, 400, { error_description: 'Invalid JWT Signature.' })
      scopes.push(JSON.parse(Buffer.from(c, 'base64url').toString()).scope)
      return json(res, 200, { access_token: 'tok-1', expires_in: 3600 })
    }
    // Shared by link: the workbook. Not shared: Google answers with its sign-in page.
    if (url.pathname === `/spreadsheets/d/${PUBLIC}/export` && url.searchParams.get('format') === 'xlsx') return xlsx(res)
    if (url.pathname === `/spreadsheets/d/${PRIVATE}/export`) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!DOCTYPE html><html><title>Sign in - Google Accounts</title></html>')
    if (url.pathname === `/drive/v3/files/${PRIVATE}/export` && url.searchParams.get('mimeType') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return req.headers.authorization === 'Bearer tok-1' ? xlsx(res) : json(res, 401, { error: { message: 'Invalid Credentials' } })
    json(res, 404, { error: { message: 'File not found.' } })
  })
  process.env.SV_GOOGLE_API = `http://127.0.0.1:${srv.port}`
  try {
    const gs = (id: string, password?: string): ResolvedSource => ({ id: 'gs', kind: 'file', format: 'xlsx', path: `https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`, remote: { provider: 'gsheets' }, password, mode: 'extract', timeoutSec: 10, tables: [{ alias: 'transactions', ref: 'Transactions' }] })
    const total = async (s: ResolvedSource) => {
      const { engine } = await bootEngine([s])
      expect(engine.statuses()[0].error ?? 'ok').toBe('ok')
      const [r] = await rows(engine, 'SELECT count(*)::INT AS n, round(sum(revenue), 2) AS revenue FROM transactions')
      await engine.close()
      return r
    }
    const exp = expected().v1
    expect((await Engine.probe(gs(PUBLIC), extensionsDir)).tables).toContain('Transactions')
    expect(await total(gs(PUBLIC))).toEqual({ n: exp.rows, revenue: exp.revenue })
    // Private: no key says how to share it; a service account's key reads it (with a read-only Drive scope).
    await expect(Engine.probe(gs(PRIVATE), extensionsDir)).rejects.toThrow('the spreadsheet isn’t shared by link')
    const key = JSON.stringify({ client_email: 'reader@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `http://127.0.0.1:${srv.port}/token` })
    expect(await total(gs(PRIVATE, key))).toEqual({ n: exp.rows, revenue: exp.revenue })
    expect(scopes).toEqual(['https://www.googleapis.com/auth/drive.readonly'])
    // A key the spreadsheet isn't shared with: who to share it with.
    await expect(Engine.probe(gs(PUBLIC.replace('pub', 'zzz'), key), extensionsDir)).rejects.toThrow('reader@project.iam.gserviceaccount.com can’t open this spreadsheet')
    // Anything but this computer is ignored as a stand-in.
    process.env.SV_GOOGLE_API = 'http://evil.example'
    await expect(Engine.probe(gs('not-an-id'), extensionsDir)).rejects.toThrow('That isn’t a Google Sheets address')
  } finally {
    delete process.env.SV_GOOGLE_API
    srv.close()
  }
})

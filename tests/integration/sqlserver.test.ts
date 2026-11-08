// SQL Server through tedious (extract only): tables copied into the cache with their types, joined with a file,
// listed for the connection dialog; a wrong password is explained. Skipped without podman (or SV_MS_HOST), and on
// non-x64 machines (the official image is x64).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { bootEngine, startSqlServer, msSource, msExec, fileSource, fixture, rows, expected, extensionsDir, type Ms } from './helpers'
import { Engine } from '../../src/engine/engine'

let ms: Ms | null = null
beforeAll(async () => {
  ms = await startSqlServer()
  if (!ms) console.warn('SQL Server tests skipped: no podman (x64) and no SV_MS_HOST')
}, 300_000)
afterAll(() => ms?.stop())

describe('SQL Server', () => {
  it('extracts a table with its types and joins it with Excel; refresh picks up changes', async (ctx) => {
    if (!ms) return ctx.skip()
    const { engine } = await bootEngine([msSource(ms), fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    expect(engine.statuses().find((s) => s.id === 'ms1')?.state).toBe('ok')
    const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE ms_customers)')).map((r) => [r.column_name, r.column_type]))
    expect(types).toEqual({ customer_id: 'BIGINT', customer_name: 'VARCHAR', region: 'VARCHAR', segment: 'VARCHAR', since: 'DATE', score: 'DOUBLE', vip: 'BOOLEAN' })
    const out = await rows(engine, 'SELECT c.region, round(sum(t.revenue), 2) AS revenue FROM transactions t JOIN ms_customers c USING (customer_id) GROUP BY 1')
    for (const r of out) expect(Math.abs(Number(r.revenue) - expected().v1.revenueByRegion[r.region as string])).toBeLessThan(0.01)
    const [f] = await rows(engine, "SELECT min(since)::VARCHAR AS first, count(*) FILTER (WHERE vip) AS vip, count(score) AS scored FROM ms_customers")
    expect(f).toEqual({ first: '2024-01-02', vip: 40, scored: 102 })
    await msExec(ms, "INSERT INTO dbo.customers (customer_id, customer_name, region, segment) VALUES (9999, N'Late', N'Texas', N'Consumer')")
    await engine.refresh(['ms1'])
    expect(Number((await rows(engine, 'SELECT count(*) AS n FROM ms_customers'))[0].n)).toBe(expected().customers + 1)
    await msExec(ms, 'DELETE FROM dbo.customers WHERE customer_id = 9999')
    expect((await Engine.probe(msSource(ms), extensionsDir)).tables).toContain('dbo.customers')
    await engine.close()
  })

  it('a wrong password is reported as such (and asks for the password again)', async (ctx) => {
    if (!ms) return ctx.skip()
    const { engine } = await bootEngine([msSource(ms, 'wrong')])
    const st = engine.statuses().find((s) => s.id === 'ms1')!
    expect(st).toMatchObject({ state: 'error', error: 'The server rejected the user name or password.', auth: true })
    await engine.close()
  })
})

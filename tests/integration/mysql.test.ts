// MySQL / MariaDB through the bundled mysql extension: extract and live, joined with a file, read-only, errors explained.
// Runs where podman (or SV_MY_HOST) is available; skipped elsewhere, and says so.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { bootEngine, startMysql, myExec, mySource, fileSource, fixture, rows, expected, extensionsDir, type My } from './helpers'
import { Engine } from '../../src/engine/engine'

let my: My | null = null
beforeAll(async () => {
  my = await startMysql()
  if (!my) console.warn('MySQL tests skipped: no podman and no SV_MY_HOST')
}, 180_000)
afterAll(() => my?.stop())

describe('MySQL / MariaDB', () => {
  it('extracts a table, joins it with an Excel file, and lists the tables', async (ctx) => {
    if (!my) return ctx.skip()
    const { engine } = await bootEngine([mySource(my, 'extract'), fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }])])
    expect(engine.describe().relations.find((r) => r.name === 'my_customers')?.kind).toBe('extract')
    const out = await rows(engine, 'SELECT c.region, round(sum(t.revenue), 2) AS revenue FROM transactions t JOIN my_customers c USING (customer_id) GROUP BY 1 ORDER BY 1')
    for (const r of out) expect(Math.abs(Number(r.revenue) - expected().v1.revenueByRegion[r.region as string])).toBeLessThan(0.01)
    expect((await Engine.probe(mySource(my, 'extract'), extensionsDir)).tables).toContain('shop.customers')
    await engine.close()
  })

  it('live: changes on the server show at once; nothing can write through Simple Viz', async (ctx) => {
    if (!my) return ctx.skip()
    const { engine } = await bootEngine([mySource(my, 'live')])
    expect(engine.describe().relations.find((r) => r.name === 'my_customers')?.kind).toBe('live')
    const count = async () => Number((await rows(engine, 'SELECT count(*) AS n FROM my_customers'))[0].n)
    expect(await count()).toBe(expected().customers)
    await myExec(my, "INSERT INTO customers VALUES (9999, 'Late', 'Texas', 'Consumer')")
    expect(await count()).toBe(expected().customers + 1)
    await myExec(my, 'DELETE FROM customers WHERE customer_id = 9999')
    // The gate refuses anything but SELECT; the attachment itself is read-only too.
    await expect(rows(engine, 'DELETE FROM my_customers')).rejects.toThrow(/Only queries that read data/)
    await expect((engine as any)._ungated(`CALL mysql_execute('db_mylive', 'DELETE FROM customers')`)).rejects.toThrow()
    expect(await count()).toBe(expected().customers)
    await engine.close()
  })

  it('a wrong password is reported as such (and asks for the password again)', async (ctx) => {
    if (!my) return ctx.skip()
    const { engine } = await bootEngine([mySource(my, 'extract', 'wrong')])
    const st = engine.statuses().find((s) => s.id === 'myextract')!
    expect(st.state).toBe('error')
    expect(st.error).toBe('The server rejected the user name or password.')
    expect(st.auth).toBe(true)
    await engine.close()
  })
})

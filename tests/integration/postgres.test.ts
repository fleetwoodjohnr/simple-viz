// PostgreSQL: extract and live modes, cross-source joins with Excel, errors, outages and recovery.
// Runs against SV_PG_HOST (the CI service) or a podman container; skipped (and reported) when neither exists.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { Engine } from '../../src/engine/engine'
import { bootEngine, expected, extensionsDir, fileSource, fixture, pgSource, rows, startPostgres, tmp, waitFor, type Pg } from './helpers'

let pg: Pg | null = null
beforeAll(async () => {
  pg = await startPostgres()
  if (!pg) console.warn('PostgreSQL tests skipped: set SV_PG_HOST or install podman.')
})
afterAll(() => pg?.stop())

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01)
const JOIN = `SELECT c.region, round(sum(t.revenue), 2) AS revenue FROM transactions t LEFT JOIN customers c ON t.customer_id = c.customer_id GROUP BY c.region ORDER BY c.region`

describe('PostgreSQL', () => {
  it.skipIf(!process.env.SV_PG_HOST && process.env.SV_NO_PODMAN)('lists the tables of a database', async (ctx) => {
    if (!pg) return ctx.skip()
    const { tables } = await Engine.probe(pgSource(pg, 'extract'), extensionsDir)
    expect(tables).toContain('public.customers')
  })

  for (const mode of ['extract', 'live'] as const)
    it(`joins an Excel sheet with a PostgreSQL table (${mode})`, async (ctx) => {
      if (!pg) return ctx.skip()
      const { engine } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), pgSource(pg, mode)])
      const exp = expected()
      const out = await rows(engine, JOIN)
      expect(out.length).toBe(exp.regions.length)
      for (const r of out) close(r.revenue as number, exp.v1.revenueByRegion[r.region as string])
      const plan = await engine.explain(`SELECT * FROM customers WHERE region = 'Virginia'`)
      // Live: the filter runs on the server (pushed down). Extract: the local copy is scanned.
      if (mode === 'live') expect(plan).toMatch(/Postgres Scan[\s\S]*Filters: region = 'Virginia'/i)
      else expect(plan).not.toMatch(/Postgres Scan/i)
      expect(engine.describe().relations.find((r) => r.name === 'customers')!.kind).toBe(mode)
      await engine.close()
    })

  it('explains a wrong password and keeps other sources working', async (ctx) => {
    if (!pg) return ctx.skip()
    const { engine } = await bootEngine([fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), { ...pgSource(pg, 'extract'), password: 'wrong' }])
    const st = engine.statuses().find((s) => s.id === 'pgextract')!
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/rejected the user name or password/)
    expect((await rows(engine, 'SELECT count(*) AS n FROM transactions'))[0].n).toBe(1000)
    await engine.close()
  })

  it('survives the server going away and coming back', async (ctx) => {
    if (!pg || process.env.SV_PG_HOST) return ctx.skip()
    const dir = tmp()
    const sales = path.join(dir, 'Sales.xlsx')
    copyFileSync(fixture('Sales.xlsx'), sales)
    const { engine } = await bootEngine([fileSource('xl', sales, 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), pgSource(pg, 'extract')], [], path.join(dir, 'cache'))
    expect((await rows(engine, JOIN)).length).toBeGreaterThan(0)

    // Outage: the refresh fails, the last good extract stays and is marked stale.
    const { execFileSync } = await import('node:child_process')
    const name = pg.name!
    execFileSync('podman', ['stop', name], { stdio: 'ignore' })
    const down = (await engine.refresh(['pgextract'], true)).find((s) => s.id === 'pgextract')!
    expect(down.state).toBe('error')
    expect(down.refreshedAt).toBeTruthy()
    expect((await rows(engine, JOIN)).length).toBe(expected().regions.length)

    // Recovery: the server is back, the next refresh succeeds.
    execFileSync('podman', ['start', name], { stdio: 'ignore' })
    await waitFor(pg)
    const up = (await engine.refresh(['pgextract'], true)).find((s) => s.id === 'pgextract')!
    expect(up.state).toBe('ok')
    await engine.close()
  })

  it('attaches a database that was down at boot once it is back', async (ctx) => {
    if (!pg || process.env.SV_PG_HOST) return ctx.skip()
    const bad = { ...pgSource(pg, 'extract'), port: 1 }
    const { engine, config } = await bootEngine([bad])
    expect(engine.statuses()[0].state).toBe('error')
    // The user fixes the port: the engine reboots with the new configuration.
    await engine.boot({ ...config, sources: [pgSource(pg, 'extract')] })
    const st = await engine.refresh()
    expect(st[0]).toMatchObject({ state: 'ok' })
    expect((await rows(engine, 'SELECT count(*) AS n FROM customers'))[0].n).toBe(expected().customers)
    await engine.close()
  })
})

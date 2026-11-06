// Reconfiguring while a refresh runs (adding a dataset right after adding sources) must not lose anything.
import { it, expect } from 'vitest'
import path from 'node:path'
import { Engine } from '../../src/engine/engine'
import { fileSource, fixture, rows, tmp } from './helpers'
import type { EngineConfig } from '../../src/shared/engine-protocol'

it('reboots with a new dataset while the previous refresh is still running', async () => {
  const cacheDir = tmp()
  const sources = [fileSource('xl', fixture('Sales.xlsx'), 'xlsx', [{ alias: 'transactions', ref: 'Transactions' }]), fileSource('c', fixture('customers.csv'), 'csv', [{ alias: 'customers' }])]
  const config: EngineConfig = { projectId: 'p', cacheDir, extensionsDir: null, sources, datasets: [] }
  const e = new Engine()
  const logs: string[] = []
  e.onLog = (l, m) => logs.push(`${l}: ${m}`)
  await e.boot(config)
  const first = e.refresh()
  await e.boot({ ...config, datasets: [{ name: 'enriched', sql: 'SELECT t.*, c.region FROM transactions t JOIN customers c USING (customer_id)' }] })
  await first.catch(() => {})
  await e.refresh()
  expect(logs.filter((l) => l.startsWith('error'))).toEqual([])
  expect(e.describe().relations.map((r) => r.name).sort()).toEqual(['customers', 'enriched', 'transactions'])
  expect((await rows(e, 'SELECT count(*) AS n FROM enriched'))[0].n).toBe(1000)
  await e.close()
  void path
})

// Closing DuckDB under running native work aborted the engine process (an uncaught Napi::Error); a reboot now waits.
it('reboots while queries are running without taking the process down', async () => {
  const config: EngineConfig = { projectId: 'q', cacheDir: tmp(), extensionsDir: null, sources: [fileSource('c', fixture('customers.csv'), 'csv', [{ alias: 'customers' }])], datasets: [] }
  const e = new Engine()
  await e.boot(config)
  await e.refresh()
  for (let round = 0; round < 5; round++) {
    const slow = [1, 2, 3].map((i) => e.work(() => e.query(round * 10 + i, 'SELECT count(*) AS n FROM range(3000000000) a WHERE a % 7 = 3', {})).then(() => 'done', (err: Error) => err.message))
    await new Promise((r) => setTimeout(r, 20 * round))
    await e.boot(config)
    for (const r of await Promise.all(slow)) expect(r).toMatch(/^(done|The query was cancelled\.)$/)
    expect((await rows(e, 'SELECT count(*) AS n FROM customers'))[0].n).toBe(120)
  }
  await e.close()
})

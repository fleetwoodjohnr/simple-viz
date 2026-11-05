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

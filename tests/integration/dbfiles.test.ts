// SQLite and DuckDB database files as sources.
import { it, expect } from 'vitest'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { Engine } from '../../src/engine/engine'
import { bootEngine, extensionsDir, rows, tmp } from './helpers'
import type { ResolvedSource } from '../../src/shared/engine-protocol'

it('reads SQLite and DuckDB files, lists their tables, and does not lock the DuckDB file', async () => {
  const dir = tmp()
  const sqlite = path.join(dir, 'shop.sqlite')
  const duck = path.join(dir, 'warehouse.duckdb')
  const i = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
  const c = await i.connect()
  await c.run(`LOAD '${path.join(extensionsDir, 'sqlite_scanner.duckdb_extension')}'`)
  await c.run(`ATTACH '${sqlite}' AS s (TYPE sqlite)`)
  await c.run(`CREATE TABLE s.orders AS SELECT i AS id, i * 10 AS amount FROM range(50) t(i)`)
  await c.run(`ATTACH '${duck}' AS d`)
  await c.run(`CREATE SCHEMA d.sales`)
  await c.run(`CREATE TABLE d.sales.items AS SELECT i AS id, 'item ' || i AS name FROM range(7) t(i)`)
  c.closeSync()
  i.closeSync()

  const sq: ResolvedSource = { id: 'sq', kind: 'sqlite', path: sqlite, tables: [{ alias: 'orders', ref: 'orders' }], mode: 'extract', timeoutSec: 30 }
  const dk: ResolvedSource = { id: 'dk', kind: 'duckdb', path: duck, tables: [{ alias: 'items', ref: 'sales.items' }], mode: 'extract', timeoutSec: 30 }
  expect((await Engine.probe(sq, extensionsDir)).tables).toEqual(['orders'])
  expect((await Engine.probe(dk, extensionsDir)).tables).toEqual(['sales.items'])
  const { engine } = await bootEngine([sq, dk])
  expect((await rows(engine, 'SELECT sum(amount) AS s FROM orders'))[0].s).toBe(12250)
  expect((await rows(engine, 'SELECT count(*) AS n FROM items'))[0].n).toBe(7)
  // Another program can still open the DuckDB file for writing while the project is open.
  const other = await DuckDBInstance.create(duck)
  other.closeSync()
  await engine.close()
})

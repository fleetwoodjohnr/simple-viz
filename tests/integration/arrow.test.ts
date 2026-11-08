// Arrow and Feather files as sources: extracted into the cache with their types, compressed or not.
import { it, expect } from 'vitest'
import path from 'node:path'
import { bootEngine, fileSource, rows, root } from './helpers'

const arrow = (n: string) => path.join(root, 'tests', 'fixtures', 'arrow', n)

it('extracts Arrow and Feather files with their column types', async () => {
  const { engine } = await bootEngine([fileSource('a', arrow('mixed-lz4.feather'), 'arrow', [{ alias: 'mixed' }]), fileSource('b', arrow('big-lz4.feather'), 'arrow', [{ alias: 'big' }]), fileSource('c', arrow('mixed.arrows'), 'arrow', [{ alias: 'stream' }])])
  expect(engine.statuses().map((s) => s.state)).toEqual(['ok', 'ok', 'ok'])
  const types = Object.fromEntries((await rows(engine, 'SELECT column_name, column_type FROM (DESCRIBE mixed)')).map((r) => [r.column_name, r.column_type]))
  expect(types).toMatchObject({ id: 'BIGINT', name: 'VARCHAR', amount: 'DOUBLE', price: 'DOUBLE', day: 'DATE', at: 'TIMESTAMP', ok: 'BOOLEAN', region: 'VARCHAR' })
  const [m] = await rows(engine, "SELECT sum(price) AS p, max(day)::VARCHAR AS d, count(*) FILTER (WHERE region = 'East') AS east FROM mixed")
  expect([Number(m.p), m.d, Number(m.east)]).toEqual([6.76, '2025-02-28', 2])
  const [b] = await rows(engine, 'SELECT count(*) AS n, sum(k) AS s FROM big')
  expect([Number(b.n), Number(b.s)]).toEqual([1_200_000, 1200 * 499_500])
  expect(Number((await rows(engine, 'SELECT count(*) AS n FROM stream JOIN mixed USING (id)'))[0].n)).toBe(4)
  await engine.close()
})

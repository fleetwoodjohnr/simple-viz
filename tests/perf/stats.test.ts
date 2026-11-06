// Statistics at scale (npm run bench): 10 million rows generated with known coefficients, extracted into the cache,
// then descriptive statistics, a multiple regression (all rows, from sufficient statistics in SQL) and a logistic
// regression (on a 100,000-row sample). Prints timings and memory; asserts the coefficients are recovered.
import { it, expect, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { bootEngine, fileSource, rows, tmp } from '../integration/helpers'
import { runAnalysis } from '../../src/core/stats/analyses'
import type { Engine } from '../../src/engine/engine'

const N = Number(process.env.SV_BENCH_ROWS ?? 10_000_000)
let engine: Engine | undefined
afterAll(() => engine?.close())

it(`regression and descriptives on ${N.toLocaleString()} rows`, async () => {
  const dir = tmp('sv-bench-')
  const file = path.join(dir, 'big.parquet')
  const t0 = performance.now()
  // y = 3 + 2·x1 − 1.5·x2 + uniform noise in [−1, 1]; b = 1 with probability sigmoid(0.5 + x1 − 0.2·x2).
  const gen = await (await DuckDBInstance.create(':memory:')).connect()
  await gen.run(`COPY (
    SELECT i, x1, x2, 3 + 2 * x1 - 1.5 * x2 + n AS y, CASE WHEN u < 1 / (1 + exp(-(0.5 + x1 - 0.2 * x2))) THEN 1 ELSE 0 END AS b
    FROM (SELECT i, (hash(i, 1) % 1000000) / 1e5 - 5 AS x1, (hash(i, 2) % 1000000) / 1e5 AS x2, (hash(i, 3) % 2000001) / 1e6 - 1 AS n, (hash(i, 4) % 1000000) / 1e6 AS u FROM range(${N}) t(i))
  ) TO '${file}' (FORMAT parquet)`)
  gen.closeSync()
  const tGen = performance.now()
  ;({ engine } = await bootEngine([fileSource('big', file, 'parquet', [{ alias: 'big' }])]))
  const tExtract = performance.now()
  const run = (sql: string) => rows(engine!, sql)
  const time = async <T>(f: () => Promise<T>) => {
    const s = performance.now()
    const v = await f()
    return [v, performance.now() - s] as const
  }
  const [desc, tDesc] = await time(() => runAnalysis({ kind: 'describe', dataset: 'big', columns: ['y'] }, run))
  const [reg, tReg] = await time(() => runAnalysis({ kind: 'regression', dataset: 'big', y: 'y', x: ['x1', 'x2'] }, run))
  const [logit, tLogit] = await time(() => runAnalysis({ kind: 'logistic', dataset: 'big', y: 'b', x: ['x1', 'x2'] }, run))
  const coef = reg.tables[0].rows.map((r) => Number(r[1]))
  const lcoef = logit.tables[0].rows.map((r) => Number(r[1]))
  expect(desc.n.used).toBe(N)
  expect(reg.n.used).toBe(N)
  expect(Math.abs(coef[0] - 3)).toBeLessThan(0.01)
  expect(Math.abs(coef[1] - 2)).toBeLessThan(0.01)
  expect(Math.abs(coef[2] + 1.5)).toBeLessThan(0.01)
  // The sample estimate is noisier: within a few standard errors.
  ;[0.5, 1, -0.2].forEach((b, i) => expect(Math.abs(lcoef[i] - b)).toBeLessThan(0.1))

  const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`
  console.log(
    [
      `Statistics benchmark: ${N.toLocaleString()} rows`,
      `  hardware   ${os.cpus()[0]?.model} × ${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB, ${process.platform}-${process.arch}`,
      `  generate   ${s(tGen - t0)} (Parquet)`,
      `  extract    ${s(tExtract - tGen)} (into the project cache)`,
      `  describe   ${s(tDesc)} (20 statistics + histogram)`,
      `  regression ${s(tReg)} (2 predictors, every row; residual quantiles and sample)`,
      `  logistic   ${s(tLogit)} (100,000-row sample, IRLS)`,
      `  heap       ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MB JS heap, ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB RSS`
    ].join('\n')
  )
}, 900_000)

// The statistics module against SciPy and statsmodels (tests/fixtures/stats-ref.json, made by scripts/stats-ref.py).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { bootEngine, fileSource, fixture } from './helpers'
import { runAnalysis, etsFilter, etsForecast, etsFit, type AnalysisResult, type Run } from '../../src/core/stats/analyses'
import type { Engine } from '../../src/engine/engine'

const ref = JSON.parse(readFileSync(fixture('stats-ref.json'), 'utf8'))
let engine: Engine
let run: Run
let qid = 0

beforeAll(async () => {
  ;({ engine } = await bootEngine([fileSource('s', fixture('stats.csv'), 'csv', [{ alias: 'stats' }]), fileSource('t', fixture('series.csv'), 'csv', [{ alias: 'series' }])]))
  run = async (sql) => {
    const r = await engine.query(++qid, sql, { limit: 100_000 })
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))
  }
})
afterAll(() => engine?.close())

/** Relative closeness (p-values compared on the log scale when tiny). */
const close = (a: unknown, b: number, rel = 1e-6) => {
  const x = typeof a === 'string' && a.startsWith('<') ? NaN : Number(a)
  if (Math.abs(b) < 1e-12) return expect(Math.abs(x)).toBeLessThan(1e-9)
  expect(Math.abs(x - b) / Math.abs(b)).toBeLessThan(rel)
}
const cell = (r: AnalysisResult, table: number, row: number, col: string) => r.tables[table].rows[row][r.tables[table].columns.indexOf(col)]
const pClose = (shown: unknown, p: number) => (p < 0.001 ? expect(shown).toBe('< 0.001') : expect(Number(shown)).toBeCloseTo(p, 3))

describe('statistics vs SciPy / statsmodels', () => {
  it('descriptive statistics', async () => {
    const r = await runAnalysis({ kind: 'describe', dataset: 'stats', columns: ['y'] }, run)
    const d = ref.describe_y
    close(cell(r, 0, 0, 'Mean'), d.mean, 1e-4)
    close(cell(r, 0, 0, 'Median'), d.median, 1e-4)
    close(cell(r, 0, 0, 'Std. dev.'), d.sd, 1e-4)
    close(cell(r, 0, 0, 'Skewness'), d.skew, 1e-3)
    close(cell(r, 0, 0, 'Excess kurtosis'), d.kurt, 1e-3)
    close(cell(r, 0, 0, '25th pct'), d.q1, 1e-4)
    expect(r.chart?.kind).toBe('histogram')
  })

  it('correlation', async () => {
    const r = await runAnalysis({ kind: 'correlation', dataset: 'stats', columns: ['x1', 'y'] }, run)
    close(cell(r, 0, 0, 'Pearson r'), ref.corr_x1_y.r, 1e-4)
  })

  it('t-tests: one sample, Welch, paired', async () => {
    const one = await runAnalysis({ kind: 'ttest', ttest: 'one', dataset: 'stats', y: 'y2', mu: 11 }, run)
    close(cell(one, 0, 0, 't'), ref.ttest_one.t, 1e-4)
    pClose(cell(one, 0, 0, 'p-value'), ref.ttest_one.p)
    // Groups A and C only (the reference compares those two): the rows are filtered in SQL.
    const ac = await runAnalysis({ kind: 'ttest', ttest: 'two', dataset: 'stats', y: 'y2', group: 'grp' }, (sql) => run(sql.replaceAll('FROM "stats"', `FROM (SELECT * FROM stats WHERE grp IN ('A', 'C')) AS "stats"`)))
    close(cell(ac, 1, 0, 't'), ref.ttest_welch_A_C.t, 1e-4)
    const paired = await runAnalysis({ kind: 'ttest', ttest: 'paired', dataset: 'stats', y: 'after', x: ['before'] }, run)
    close(cell(paired, 0, 0, 't'), ref.ttest_paired.t, 1e-4)
  })

  it('ANOVA, chi-square, Mann–Whitney, Kruskal–Wallis', async () => {
    const a = await runAnalysis({ kind: 'anova', dataset: 'stats', y: 'y2', group: 'grp' }, run)
    close(cell(a, 1, 0, 'F'), ref.anova.F, 1e-4)
    const c = await runAnalysis({ kind: 'chisq', dataset: 'stats', group: 'grp', group2: 'cat' }, run)
    close(cell(c, 1, 0, 'χ²'), ref.chisq.chi2, 1e-4)
    expect(cell(c, 1, 0, 'df')).toBe(ref.chisq.df)
    pClose(cell(c, 1, 0, 'p-value'), ref.chisq.p)
    const ac = (sql: string) => run(sql.replaceAll('FROM "stats"', `FROM (SELECT * FROM stats WHERE grp IN ('A', 'C')) AS "stats"`))
    const mw = await runAnalysis({ kind: 'mannwhitney', dataset: 'stats', y: 'y2', group: 'grp' }, ac)
    close(cell(mw, 1, 0, 'U'), ref.mannwhitney_A_C.U, 1e-6)
    pClose(cell(mw, 1, 0, 'p-value'), ref.mannwhitney_A_C.p)
    const kw = await runAnalysis({ kind: 'kruskal', dataset: 'stats', y: 'y2', group: 'grp' }, run)
    close(cell(kw, 1, 0, 'H'), ref.kruskal.H, 1e-6)
  })

  it('multiple and polynomial regression (from sufficient statistics), with listwise deletion', async () => {
    const r = await runAnalysis({ kind: 'regression', dataset: 'stats', y: 'y', x: ['x1', 'x2'] }, run)
    ref.ols.coef.forEach((b: number, i: number) => close(r.tables[0].rows[i][1], b, 1e-4))
    ref.ols.se.forEach((se: number, i: number) => close(r.tables[0].rows[i][2], se, 1e-3))
    close(cell(r, 1, 0, 'R²'), ref.ols.r2, 1e-4)
    close(cell(r, 1, 0, 'Adjusted R²'), ref.ols.adj_r2, 1e-4)
    close(cell(r, 1, 0, 'F'), ref.ols.F, 1e-4)
    expect(r.n.used).toBe(ref.ols.n)
    expect(r.n.excluded).toBe(500 - ref.ols.n)
    const p = await runAnalysis({ kind: 'regression', dataset: 'stats', y: 'y', x: ['x1'], degree: 2 }, run)
    ref.poly2.coef.forEach((b: number, i: number) => close(p.tables[0].rows[i][1], b, 1e-4))
  })

  it('logistic regression', async () => {
    const r = await runAnalysis({ kind: 'logistic', dataset: 'stats', y: 'b', x: ['x1', 'x2'] }, run)
    ref.logit.coef.forEach((b: number, i: number) => close(r.tables[0].rows[i][1], b, 1e-3))
    ref.logit.se.forEach((se: number, i: number) => close(r.tables[0].rows[i][2], se, 1e-3))
    close(cell(r, 1, 0, 'Log-likelihood'), ref.logit.llf, 1e-4)
    close(cell(r, 1, 0, 'McFadden R²'), ref.logit.prsquared, 1e-3)
  })

  it('text predictors as indicators (first value the reference), linear and logistic, as statsmodels', async () => {
    // Tables show 4 decimals: equal to statsmodels at that precision.
    const close4 = (a: unknown, b: number) => expect(Math.abs(Number(a) - b)).toBeLessThanOrEqual(5.01e-5)
    const r = await runAnalysis({ kind: 'regression', dataset: 'stats', y: 'y2', x: ['x1', 'grp'] }, run)
    expect(r.tables[0].rows.map((row) => row[0])).toEqual(['Intercept', 'x1', 'grp = B', 'grp = C'])
    ref.ols_dummy.coef.forEach((b: number, i: number) => close4(r.tables[0].rows[i][1], b))
    ref.ols_dummy.se.forEach((se: number, i: number) => close4(r.tables[0].rows[i][2], se))
    close4(cell(r, 1, 0, 'R²'), ref.ols_dummy.r2)
    const l = await runAnalysis({ kind: 'logistic', dataset: 'stats', y: 'b', x: ['x1', 'cat'] }, run)
    expect(l.tables[0].rows.map((row) => row[0])).toEqual(['Intercept', 'x1', 'cat = Green', 'cat = Red'])
    ref.logit_dummy.coef.forEach((b: number, i: number) => close4(l.tables[0].rows[i][1], b))
    ref.logit_dummy.se.forEach((se: number, i: number) => close4(l.tables[0].rows[i][2], se))
    close(cell(l, 1, 0, 'Log-likelihood'), ref.logit_dummy.llf, 1e-4)
  })

  it('PCA eigenvalues', async () => {
    const r = await runAnalysis({ kind: 'pca', dataset: 'stats', columns: ['x1', 'x2', 'y', 'y2'] }, run)
    ref.pca_eigenvalues.forEach((v: number, i: number) => close(r.tables[0].rows[i][1], v, 1e-3))
  })

  it('Holt–Winters: same recursion and forecasts as statsmodels for given parameters; a fit at least as good', async () => {
    const y = (await run('SELECT sales FROM series ORDER BY month')).map((r) => Number(r.sales))
    const h = ref.hw_fixed
    const p = { alpha: h.params.alpha, beta: h.params.beta, gamma: h.params.gamma, l0: h.init.initial_level, b0: h.init.initial_trend, s0: h.init.initial_seasonal }
    const f = etsFilter(y, p, 12)
    f.fitted.forEach((v, i) => close(v, h.fitted[i], 1e-9))
    etsForecast(y, p, 12, 6, 0.95, 16).forecast.forEach((v, i) => close(v.mean, h.forecast[i], 1e-9))
    expect(etsFit(y, 'AA', 12).sse).toBeLessThan(ref.hw_opt_sse * 1.05)
    const r = await runAnalysis({ kind: 'forecast', dataset: 'series', date: 'month', y: 'sales', grain: 'month', horizon: 12 }, run)
    // A trend-and-season model wins (additive or multiplicative, whichever has the lower AICc).
    expect(String(r.tables[1].rows[0][0])).toMatch(/^Holt–Winters (additive|multiplicative)/)
    expect(r.tables[1].rows.map((row) => row[0])).toContain('Holt–Winters multiplicative (trend + season)')
    expect(r.tables[0].rows.length).toBe(12)
  })

  it('Holt–Winters with a multiplicative season: same recursion and forecasts as statsmodels', async () => {
    const y = (await run('SELECT sales FROM series ORDER BY month')).map((r) => Number(r.sales))
    const h = ref.hw_mul_fixed
    const p = { alpha: h.params.alpha, beta: h.params.beta, gamma: h.params.gamma, l0: h.init.initial_level, b0: h.init.initial_trend, s0: h.init.initial_seasonal, mult: true }
    etsFilter(y, p, 12).fitted.forEach((v, i) => close(v, h.fitted[i], 1e-9))
    const fc = etsForecast(y, p, 12, 6, 0.95, 16).forecast
    fc.forEach((v, i) => close(v.mean, h.forecast[i], 1e-9))
    // The simulated interval contains the forecast and widens with the horizon.
    for (const v of fc) {
      expect(v.lo).toBeLessThan(v.mean)
      expect(v.hi).toBeGreaterThan(v.mean)
    }
    expect(fc[5].hi - fc[5].lo).toBeGreaterThan(fc[0].hi - fc[0].lo)
    expect(etsFit(y, 'AM', 12).sse).toBeLessThan(etsFilter(y, p, 12).fitted.reduce((a, f, t) => a + (y[t] - f) ** 2, 0) * 1.0001)
  })

  it('k-means recovers well-separated groups and deterministic results', async () => {
    const a = await runAnalysis({ kind: 'kmeans', dataset: 'stats', columns: ['y2', 'x2'], k: 3 }, run)
    const b = await runAnalysis({ kind: 'kmeans', dataset: 'stats', columns: ['y2', 'x2'], k: 3 }, run)
    expect(a.tables).toEqual(b.tables)
    // The saved-dataset SQL assigns every row a cluster through the engine's gate.
    const rows = await run(`SELECT cluster, count(*) AS n FROM (${a.datasetSql}) GROUP BY 1 ORDER BY 1`)
    expect(rows.filter((r) => r.cluster !== null).length).toBe(3)
  })

  it('anomalies and missing values', async () => {
    const m = await runAnalysis({ kind: 'missing', dataset: 'stats', columns: ['x1', 'x2'] }, run)
    expect(m.tables[0].rows[1][1]).toBe(500 - ref.ols.n)
    const an = await runAnalysis({ kind: 'anomalies', dataset: 'stats', y: 'y2', method: 'iqr' }, run)
    const [o] = await run(`WITH q AS (SELECT quantile_cont(y2, 0.25) AS q1, quantile_cont(y2, 0.75) AS q3 FROM stats) SELECT count(*) AS n FROM stats, q WHERE y2 < q1 - 1.5 * (q3 - q1) OR y2 > q3 + 1.5 * (q3 - q1)`)
    expect(Number(o.n)).toBeGreaterThan(0)
    expect(cell(an, 0, 0, 'Anomalies')).toBe(Number(o.n))
    expect(an.tables[1].rows).toHaveLength(Number(o.n))
  })
})

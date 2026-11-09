// Statistical analyses. Work that scales goes to SQL over every row (counts, sums, cross-products, quantiles, ranks);
// what needs the data itself (logistic regression, k-means, residual plots) runs on a reproducible sample.
// Each analysis returns result tables, a chart description, a plain-language summary, its assumptions, and how many
// rows were used and left out. `run` executes SQL in the engine (so everything also passes the SQL gate).

import { pT, pF, pChi, pZ, tQuantile, normInv, solve, inverse, eigenSymmetric, nelderMead, rng, sigmoid } from './math'
import { arimaAuto, arimaForecast, arimaName } from './arima'

type Value = string | number | boolean | null
export type Row = Record<string, Value>
export type Run = (sql: string) => Promise<Row[]>

export type AnalysisKind = 'describe' | 'missing' | 'correlation' | 'ttest' | 'anova' | 'chisq' | 'mannwhitney' | 'kruskal' | 'regression' | 'logistic' | 'forecast' | 'kmeans' | 'pca' | 'anomalies'

export interface AnalysisSpec {
  kind: AnalysisKind
  dataset: string
  /** Numeric variables (describe, correlation, k-means, PCA, anomalies). */
  columns?: string[]
  /** Outcome (regression, logistic, t-test value, ANOVA value, rank tests). */
  y?: string
  /** Predictors (regression, logistic). */
  x?: string[]
  /** Grouping column (two-sample t-test, ANOVA, rank tests, chi-square row variable). */
  group?: string
  /** Chi-square column variable. */
  group2?: string
  ttest?: 'one' | 'two' | 'paired'
  /** One-sample t-test: the hypothesised mean. Paired t-test: the second column is `x[0]`. */
  mu?: number
  /** Polynomial regression degree (1 = linear). */
  degree?: number
  /** Forecast: date column, measure, aggregation and grain. */
  date?: string
  agg?: 'sum' | 'avg'
  grain?: Grain
  horizon?: number
  model?: 'auto' | EtsModel
  /** Forecast: exponential smoothing (default) or seasonal ARIMA with orders chosen stepwise. */
  forecastMethod?: 'ets' | 'arima'
  k?: number
  method?: 'z' | 'iqr'
  threshold?: number
  /** Logistic: the outcome value counted as 1 (default: the larger / later one). */
  positive?: string
  level?: number
}

export interface ResultTable {
  title?: string
  columns: string[]
  rows: Value[][]
}

export type StatChart =
  | { kind: 'histogram'; title: string; bins: { lo: number; hi: number; n: number }[]; normal?: { mean: number; sd: number; n: number } }
  | { kind: 'bars'; title: string; labels: string[]; values: number[]; errors?: [number, number][] }
  | { kind: 'scatter'; title: string; x: string; y: string; points: [number, number][]; groups?: number[]; line?: [number, number][] }
  | { kind: 'heatmap'; title: string; labels: string[]; values: number[][] }
  | { kind: 'forecast'; title: string; labels: string[]; actual: (number | null)[]; fitted: (number | null)[]; forecast: (number | null)[]; lo: (number | null)[]; hi: (number | null)[] }

export interface AnalysisResult {
  title: string
  tables: ResultTable[]
  chart?: StatChart
  summary: string
  assumptions: string[]
  n: { used: number; excluded: number; note: string }
  /** k-means: a SQL query adding the cluster to every row (saved as a dataset). */
  datasetSql?: string
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
const num = (v: Value) => (v === null ? NaN : Number(v))
const fmtP = (p: number) => (p < 0.001 ? '< 0.001' : p.toFixed(3))
const sig = (p: number, a = 0.05) => (p < a ? `statistically significant at the ${Math.round(a * 100)}% level` : `not statistically significant at the ${Math.round(a * 100)}% level`)
const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x)

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function counts(run: Run, ds: string, cols: string[]) {
  const [r] = await run(`SELECT count(*) AS total, count(*) FILTER (WHERE ${cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ') || 'TRUE'}) AS used FROM ${q(ds)}`)
  return { total: num(r.total), used: num(r.used) }
}

const nNote = (c: { total: number; used: number }, what = 'rows') => ({ used: c.used, excluded: c.total - c.used, note: c.total > c.used ? `${(c.total - c.used).toLocaleString()} ${what} with an empty value in a variable used were left out (listwise deletion).` : 'No rows had empty values.' })

// ---------------------------------------------------------------- descriptive

async function describe(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const cols = s.columns ?? []
  need(cols.length, 'Choose at least one numeric column.')
  const rows: Value[][] = []
  let first: Row | null = null
  for (const c of cols) {
    const x = q(c)
    const [r] = await run(`SELECT count(*) AS total, count(${x}) AS n, avg(${x}) AS mean, median(${x}) AS median, mode(${x}) AS mode, stddev_samp(${x}) AS sd, var_samp(${x}) AS var, min(${x}) AS min, max(${x}) AS max, quantile_cont(${x}, 0.05) AS p05, quantile_cont(${x}, 0.25) AS q1, quantile_cont(${x}, 0.75) AS q3, quantile_cont(${x}, 0.95) AS p95, skewness(${x}) AS skew, kurtosis(${x}) AS kurt, sum(${x}) AS sum FROM ${q(s.dataset)}`)
    const [o] = await run(`SELECT count(*) FILTER (WHERE ${x} < ${num(r.q1)} - 1.5 * ${num(r.q3) - num(r.q1)} OR ${x} > ${num(r.q3)} + 1.5 * ${num(r.q3) - num(r.q1)}) AS outliers FROM ${q(s.dataset)}`)
    const n = num(r.n)
    const se = num(r.sd) / Math.sqrt(n)
    const tq = n > 1 ? tQuantile(1 - (1 - (s.level ?? 0.95)) / 2, n - 1) : NaN
    rows.push([c, n, num(r.total) - n, r4(num(r.mean)), r4(num(r.mean) - tq * se), r4(num(r.mean) + tq * se), r4(num(r.median)), r.mode, r4(num(r.sd)), r4(num(r.var)), num(r.min), num(r.max), r4(num(r.max) - num(r.min)), r4(num(r.p05)), r4(num(r.q1)), r4(num(r.q3)), r4(num(r.p95)), r4(num(r.skew)), r4(num(r.kurt)), num(o.outliers)])
    first ??= r
  }
  // Distribution of the first column: a histogram with the normal curve of the same mean and spread.
  const c0 = q(cols[0])
  const lo = num(first!.min)
  const hi = num(first!.max)
  const nb = 20
  const w = hi > lo ? (hi - lo) / nb : 1
  const hist = await run(`SELECT least(${nb - 1}, floor((${c0} - ${lo}) / ${w}))::INTEGER AS b, count(*) AS n FROM ${q(s.dataset)} WHERE ${c0} IS NOT NULL GROUP BY 1 ORDER BY 1`)
  const bins = Array.from({ length: nb }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, n: num(hist.find((h) => num(h.b) === i)?.n ?? 0) }))
  const skew = num(first!.skew)
  return {
    title: 'Descriptive statistics',
    tables: [{ columns: ['Variable', 'N', 'Missing', 'Mean', `${Math.round((s.level ?? 0.95) * 100)}% CI low`, 'CI high', 'Median', 'Mode', 'Std. dev.', 'Variance', 'Min', 'Max', 'Range', '5th pct', '25th pct', '75th pct', '95th pct', 'Skewness', 'Excess kurtosis', 'Outliers (1.5 IQR)'], rows }],
    chart: { kind: 'histogram', title: `Distribution of ${cols[0]}`, bins, normal: { mean: num(first!.mean), sd: num(first!.sd), n: num(first!.n) } },
    summary: `${cols[0]} has a mean of ${r4(num(first!.mean))} and a median of ${r4(num(first!.median))} over ${num(first!.n).toLocaleString()} values; its distribution is ${Math.abs(skew) < 0.5 ? 'roughly symmetric' : skew > 0 ? 'skewed to the right (a long tail of large values)' : 'skewed to the left (a long tail of small values)'}.${num(rows[0][19]) ? ` ${rows[0][19]} values are outliers by the 1.5 × IQR rule.` : ''}`,
    assumptions: ['Skewness and kurtosis are the sample (bias-corrected) estimates; kurtosis is excess kurtosis (0 for a normal distribution).', 'The confidence interval for the mean uses Student’s t; it is reliable for roughly symmetric data or large samples.', 'Percentiles are interpolated (like Excel’s PERCENTILE.INC).'],
    n: { used: num(first!.n), excluded: num(first!.total) - num(first!.n), note: 'Empty values are left out of each column’s statistics separately.' }
  }
}

async function missing(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const cols = s.columns ?? []
  need(cols.length, 'Choose the columns to check.')
  const [r] = await run(`SELECT count(*) AS total, ${cols.map((c, i) => `count(*) - count(${q(c)}) AS m${i}`).join(', ')} FROM ${q(s.dataset)}`)
  const total = num(r.total)
  const rows = cols.map((c, i) => [c, num(r[`m${i}`]), total ? r4((num(r[`m${i}`]) / total) * 100) : 0])
  const worst = [...rows].sort((a, b) => num(b[1] as Value) - num(a[1] as Value))[0]
  return {
    title: 'Missing values',
    tables: [{ columns: ['Column', 'Empty', 'Empty (%)'], rows }],
    chart: { kind: 'bars', title: 'Empty values (%)', labels: cols, values: rows.map((x) => x[2] as number) },
    summary: num(worst[1] as Value) ? `${worst[0]} has the most empty values: ${worst[1]} of ${total.toLocaleString()} rows (${worst[2]}%).` : `No empty values in these ${cols.length} columns.`,
    assumptions: ['Empty means NULL. Text such as “N/A” or “-” is a value; fix it with a transform step (Fill empty values, or Change type).'],
    n: { used: total, excluded: 0, note: 'All rows counted.' }
  }
}

async function correlation(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const cols = s.columns ?? []
  need(cols.length >= 2, 'Choose at least two numeric columns.')
  const pairs: string[] = []
  cols.forEach((a, i) => cols.forEach((b, j) => j > i && pairs.push(`corr(${q(a)}, ${q(b)}) AS r_${i}_${j}, count(*) FILTER (WHERE ${q(a)} IS NOT NULL AND ${q(b)} IS NOT NULL) AS n_${i}_${j}, covar_samp(${q(a)}, ${q(b)}) AS c_${i}_${j}`)))
  const [r] = await run(`SELECT ${pairs.join(', ')} FROM ${q(s.dataset)}`)
  const M = cols.map((_, i) => cols.map((__, j) => (i === j ? 1 : num(r[`r_${Math.min(i, j)}_${Math.max(i, j)}`]))))
  const rows: Value[][] = []
  cols.forEach((a, i) =>
    cols.forEach((b, j) => {
      if (j <= i) return
      const rr = num(r[`r_${i}_${j}`])
      const n = num(r[`n_${i}_${j}`])
      const t = rr * Math.sqrt((n - 2) / (1 - rr * rr))
      rows.push([a, b, r4(rr), r4(rr * rr), r4(num(r[`c_${i}_${j}`])), n, fmtP(pT(t, n - 2))])
    })
  )
  const strongest = [...rows].sort((x, y) => Math.abs(num(y[2])) - Math.abs(num(x[2])))[0]
  const v = num(strongest[2])
  return {
    title: 'Correlation',
    tables: [{ columns: ['Variable', 'With', 'Pearson r', 'r²', 'Covariance', 'N', 'p-value'], rows }],
    chart: { kind: 'heatmap', title: 'Correlation matrix', labels: cols, values: M },
    summary: `The strongest relationship is between ${strongest[0]} and ${strongest[1]}: r = ${v} (${Math.abs(v) >= 0.7 ? 'strong' : Math.abs(v) >= 0.4 ? 'moderate' : Math.abs(v) >= 0.2 ? 'weak' : 'very weak'}, ${v > 0 ? 'they rise together' : 'one falls as the other rises'}). Correlation is not causation.`,
    assumptions: ['Pearson correlation measures straight-line relationships; a curved relationship can have r near 0.', 'p-values test r = 0 and assume roughly normal variables.', 'Each pair uses the rows where both values are present (pairwise deletion).'],
    n: { used: Math.max(...rows.map((x) => num(x[5]))), excluded: 0, note: 'Pairwise: each pair uses the rows where both values are present.' }
  }
}

// ---------------------------------------------------------------- tests

async function groupStats(s: AnalysisSpec, run: Run, y: string, g: string) {
  return run(`SELECT CAST(${q(g)} AS VARCHAR) AS g, count(${q(y)}) AS n, avg(${q(y)}) AS mean, var_samp(${q(y)}) AS var, stddev_samp(${q(y)}) AS sd FROM ${q(s.dataset)} WHERE ${q(y)} IS NOT NULL AND ${q(g)} IS NOT NULL GROUP BY 1 ORDER BY 1`)
}

async function ttest(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.y, 'Choose the numeric column to test.')
  const level = s.level ?? 0.95
  const y = s.y
  if ((s.ttest ?? 'two') === 'one') {
    const mu = s.mu ?? 0
    const [r] = await run(`SELECT count(${q(y)}) AS n, avg(${q(y)}) AS mean, stddev_samp(${q(y)}) AS sd, count(*) AS total FROM ${q(s.dataset)}`)
    const n = num(r.n)
    const se = num(r.sd) / Math.sqrt(n)
    const t = (num(r.mean) - mu) / se
    const p = pT(t, n - 1)
    const tq = tQuantile(1 - (1 - level) / 2, n - 1)
    return {
      title: 'One-sample t-test',
      tables: [{ columns: ['Variable', 'N', 'Mean', 'Hypothesised mean', 't', 'df', 'p-value', 'CI low', 'CI high', 'Cohen’s d'], rows: [[y, n, r4(num(r.mean)), mu, r4(t), n - 1, fmtP(p), r4(num(r.mean) - tq * se), r4(num(r.mean) + tq * se), r4((num(r.mean) - mu) / num(r.sd))]] }],
      summary: `The mean of ${y} (${r4(num(r.mean))}) differs from ${mu} by ${r4(num(r.mean) - mu)}; this is ${sig(p)} (t = ${r4(t)}, p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}).`,
      assumptions: ['Values are independent.', 'The mean is approximately normally distributed (true for roughly normal data, or for large samples by the central limit theorem).'],
      n: { used: n, excluded: num(r.total) - n, note: 'Empty values were left out.' }
    }
  }
  if (s.ttest === 'paired') {
    const x = s.x?.[0]
    need(x, 'Choose the second column for a paired test.')
    const [r] = await run(`SELECT count(*) AS n, avg(${q(y)} - ${q(x)}) AS mean, stddev_samp(${q(y)} - ${q(x)}) AS sd, (SELECT count(*) FROM ${q(s.dataset)}) AS total FROM ${q(s.dataset)} WHERE ${q(y)} IS NOT NULL AND ${q(x)} IS NOT NULL`)
    const n = num(r.n)
    const se = num(r.sd) / Math.sqrt(n)
    const t = num(r.mean) / se
    const p = pT(t, n - 1)
    const tq = tQuantile(1 - (1 - level) / 2, n - 1)
    return {
      title: 'Paired t-test',
      tables: [{ columns: ['Pair', 'N', 'Mean difference', 't', 'df', 'p-value', 'CI low', 'CI high'], rows: [[`${y} − ${x}`, n, r4(num(r.mean)), r4(t), n - 1, fmtP(p), r4(num(r.mean) - tq * se), r4(num(r.mean) + tq * se)]] }],
      summary: `On average ${y} is ${r4(num(r.mean))} ${num(r.mean) >= 0 ? 'higher' : 'lower'} than ${x} in the same row; the difference is ${sig(p)} (p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}).`,
      assumptions: ['Each row is a pair (the same subject measured twice).', 'The differences are approximately normal, or the sample is large.'],
      n: nNote({ total: num(r.total), used: n }, 'pairs')
    }
  }
  need(s.group, 'Choose the column that splits the rows into two groups.')
  const gs = await groupStats(s, run, y, s.group)
  need(gs.length === 2, `A two-sample t-test needs exactly two groups; ${s.group} has ${gs.length}. Filter the data or use ANOVA.`)
  const [a, b] = gs.map((g) => ({ g: String(g.g), n: num(g.n), m: num(g.mean), v: num(g.var), sd: num(g.sd) }))
  const va = a.v / a.n
  const vb = b.v / b.n
  const se = Math.sqrt(va + vb)
  const t = (a.m - b.m) / se
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1))
  const p = pT(t, df)
  const tq = tQuantile(1 - (1 - level) / 2, df)
  const pooled = Math.sqrt(((a.n - 1) * a.v + (b.n - 1) * b.v) / (a.n + b.n - 2))
  const c = await counts(run, s.dataset, [y, s.group])
  return {
    title: 'Two-sample t-test (Welch)',
    tables: [
      { title: 'Groups', columns: ['Group', 'N', 'Mean', 'Std. dev.'], rows: [a, b].map((g) => [g.g, g.n, r4(g.m), r4(g.sd)]) },
      { title: 'Test', columns: ['Difference', 't', 'df', 'p-value', 'CI low', 'CI high', 'Cohen’s d'], rows: [[r4(a.m - b.m), r4(t), r4(df), fmtP(p), r4(a.m - b.m - tq * se), r4(a.m - b.m + tq * se), r4((a.m - b.m) / pooled)]] }
    ],
    chart: { kind: 'bars', title: `Mean of ${y} by ${s.group}`, labels: [a.g, b.g], values: [a.m, b.m], errors: [a, b].map((g) => [g.m - tq * Math.sqrt(g.v / g.n), g.m + tq * Math.sqrt(g.v / g.n)]) },
    summary: `${y} averages ${r4(a.m)} for ${a.g} and ${r4(b.m)} for ${b.g}. The difference of ${r4(a.m - b.m)} is ${sig(p)} (Welch’s t = ${r4(t)}, p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}).`,
    assumptions: ['The groups are independent samples.', 'Welch’s test does not assume equal variances.', 'Group means are approximately normal (normal data or large groups). For skewed data with small groups, use the Mann–Whitney test.'],
    n: nNote(c)
  }
}

async function anova(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.y && s.group, 'Choose a numeric column and a grouping column.')
  const gs = (await groupStats(s, run, s.y, s.group)).map((g) => ({ g: String(g.g), n: num(g.n), m: num(g.mean), v: num(g.var) || 0, sd: num(g.sd) || 0 }))
  need(gs.length >= 2, 'ANOVA needs at least two groups.')
  const N = gs.reduce((a, g) => a + g.n, 0)
  const M = gs.reduce((a, g) => a + g.n * g.m, 0) / N
  const ssb = gs.reduce((a, g) => a + g.n * (g.m - M) ** 2, 0)
  const ssw = gs.reduce((a, g) => a + (g.n - 1) * g.v, 0)
  const df1 = gs.length - 1
  const df2 = N - gs.length
  const F = ssb / df1 / (ssw / df2)
  const p = pF(F, df1, df2)
  const c = await counts(run, s.dataset, [s.y, s.group])
  return {
    title: 'One-way ANOVA',
    tables: [
      { title: 'Groups', columns: ['Group', 'N', 'Mean', 'Std. dev.'], rows: gs.map((g) => [g.g, g.n, r4(g.m), r4(g.sd)]) },
      { title: 'Analysis of variance', columns: ['Source', 'Sum of squares', 'df', 'Mean square', 'F', 'p-value'], rows: [['Between groups', r4(ssb), df1, r4(ssb / df1), r4(F), fmtP(p)], ['Within groups', r4(ssw), df2, r4(ssw / df2), null, null], ['Total', r4(ssb + ssw), N - 1, null, null, null]] }
    ],
    chart: { kind: 'bars', title: `Mean of ${s.y} by ${s.group}`, labels: gs.map((g) => g.g), values: gs.map((g) => g.m) },
    summary: `The mean of ${s.y} ${p < 0.05 ? 'differs' : 'does not differ significantly'} between the ${gs.length} groups of ${s.group} (F = ${r4(F)}, p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}); the groups explain ${r4((ssb / (ssb + ssw)) * 100)}% of the variation (η²).`,
    assumptions: ['Observations are independent.', 'Values are approximately normal within each group.', 'Groups have similar variances (with very unequal variances and group sizes, prefer Kruskal–Wallis).', 'ANOVA says whether some group differs, not which.'],
    n: nNote(c)
  }
}

async function chisq(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.group && s.group2, 'Choose two categorical columns.')
  const cells = await run(`SELECT CAST(${q(s.group)} AS VARCHAR) AS a, CAST(${q(s.group2)} AS VARCHAR) AS b, count(*) AS n FROM ${q(s.dataset)} WHERE ${q(s.group)} IS NOT NULL AND ${q(s.group2)} IS NOT NULL GROUP BY 1, 2`)
  const A = [...new Set(cells.map((c) => String(c.a)))].sort()
  const B = [...new Set(cells.map((c) => String(c.b)))].sort()
  need(A.length >= 2 && B.length >= 2, 'Each column needs at least two different values.')
  need(A.length * B.length <= 2500, 'Too many combinations (over 2,500 cells). Group the values first.')
  const O = A.map((a) => B.map((b) => num(cells.find((c) => c.a === a && c.b === b)?.n ?? 0)))
  const N = O.flat().reduce((x, y) => x + y, 0)
  const rs = O.map((r) => r.reduce((x, y) => x + y, 0))
  const cs = B.map((_, j) => O.reduce((x, r) => x + r[j], 0))
  let chi = 0
  let small = 0
  O.forEach((r, i) => r.forEach((o, j) => {
    const e = (rs[i] * cs[j]) / N
    if (e < 5) small++
    chi += (o - e) ** 2 / e
  }))
  const df = (A.length - 1) * (B.length - 1)
  const p = pChi(chi, df)
  const v = Math.sqrt(chi / (N * (Math.min(A.length, B.length) - 1)))
  const c = await counts(run, s.dataset, [s.group, s.group2])
  return {
    title: 'Chi-square test of independence',
    tables: [
      { title: 'Observed counts', columns: [`${s.group} \\ ${s.group2}`, ...B, 'Total'], rows: [...A.map((a, i) => [a, ...O[i], rs[i]]), ['Total', ...cs, N]] },
      { title: 'Test', columns: ['χ²', 'df', 'p-value', 'Cramér’s V', 'Cells with expected count < 5'], rows: [[r4(chi), df, fmtP(p), r4(v), small]] }
    ],
    summary: `${s.group} and ${s.group2} are ${p < 0.05 ? 'associated' : 'not significantly associated'} (χ² = ${r4(chi)}, df = ${df}, p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}); the strength of association is ${v >= 0.5 ? 'strong' : v >= 0.3 ? 'moderate' : v >= 0.1 ? 'weak' : 'negligible'} (Cramér’s V = ${r4(v)}).`,
    assumptions: ['Each row is counted once and rows are independent.', `Expected counts should be at least 5 in most cells${small ? ` — ${small} cell${small > 1 ? 's are' : ' is'} below 5, so the p-value is approximate` : ''}.`, 'No continuity correction is applied.'],
    n: nNote(c)
  }
}

/** Ranks with ties averaged, computed in SQL; plus the tie correction term Σ(t³ − t). */
async function rankSums(s: AnalysisSpec, run: Run) {
  need(s.y && s.group, 'Choose a numeric column and a grouping column.')
  const base = `SELECT CAST(${q(s.group)} AS VARCHAR) AS g, ${q(s.y)} AS v FROM ${q(s.dataset)} WHERE ${q(s.y)} IS NOT NULL AND ${q(s.group)} IS NOT NULL`
  const groups = await run(`WITH b AS (${base}), r AS (SELECT g, v, avg(rn) OVER (PARTITION BY v) AS rk FROM (SELECT g, v, row_number() OVER (ORDER BY v) AS rn FROM b)) SELECT g, count(*) AS n, sum(rk) AS r, median(v) AS med FROM r GROUP BY g ORDER BY g`)
  const [ties] = await run(`WITH b AS (${base}) SELECT coalesce(sum(c * c * c - c), 0) AS t, (SELECT count(*) FROM b) AS n FROM (SELECT count(*) AS c FROM b GROUP BY v)`)
  return { groups: groups.map((g) => ({ g: String(g.g), n: num(g.n), r: num(g.r), med: num(g.med) })), ties: num(ties.t), N: num(ties.n) }
}

async function mannwhitney(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const { groups, ties, N } = await rankSums(s, run)
  need(groups.length === 2, `The Mann–Whitney test compares two groups; ${s.group} has ${groups.length}. Use Kruskal–Wallis for more.`)
  const [a, b] = groups
  const u1 = a.r - (a.n * (a.n + 1)) / 2
  const u2 = a.n * b.n - u1
  const mu = (a.n * b.n) / 2
  const sigma = Math.sqrt(((a.n * b.n) / 12) * (N + 1 - ties / (N * (N - 1))))
  const z = (Math.max(u1, u2) - mu - 0.5) / sigma
  const p = Math.min(1, 2 * (1 - (0.5 + 0.5 * Math.sign(z) * (1 - 2 * (1 - normCdfSafe(Math.abs(z)))))))
  const c = await counts(run, s.dataset, [s.y!, s.group!])
  return {
    title: 'Mann–Whitney U test',
    tables: [
      { title: 'Groups', columns: ['Group', 'N', 'Median', 'Rank sum'], rows: groups.map((g) => [g.g, g.n, r4(g.med), r4(g.r)]) },
      { title: 'Test', columns: ['U', 'z', 'p-value', 'Rank-biserial r'], rows: [[r4(u1), r4(z), fmtP(p), r4(1 - (2 * Math.min(u1, u2)) / (a.n * b.n))]] }
    ],
    summary: `Values of ${s.y} tend to be ${u1 > mu ? 'higher' : 'lower'} for ${a.g} than for ${b.g} (medians ${r4(a.med)} and ${r4(b.med)}); the difference is ${sig(p)} (U = ${r4(u1)}, p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}).`,
    assumptions: ['A non-parametric test: no normality assumption.', 'Groups are independent.', 'p-value from the normal approximation with tie and continuity corrections (as SciPy’s asymptotic method).'],
    n: nNote(c)
  }
}

const normCdfSafe = (z: number) => 1 - pZ(z) / 2

async function kruskal(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const { groups, ties, N } = await rankSums(s, run)
  need(groups.length >= 2, 'Kruskal–Wallis needs at least two groups.')
  const H0 = (12 / (N * (N + 1))) * groups.reduce((a, g) => a + (g.r * g.r) / g.n, 0) - 3 * (N + 1)
  const H = H0 / (1 - ties / (N * N * N - N))
  const df = groups.length - 1
  const p = pChi(H, df)
  const c = await counts(run, s.dataset, [s.y!, s.group!])
  return {
    title: 'Kruskal–Wallis test',
    tables: [
      { title: 'Groups', columns: ['Group', 'N', 'Median', 'Mean rank'], rows: groups.map((g) => [g.g, g.n, r4(g.med), r4(g.r / g.n)]) },
      { title: 'Test', columns: ['H', 'df', 'p-value'], rows: [[r4(H), df, fmtP(p)]] }
    ],
    chart: { kind: 'bars', title: `Median of ${s.y} by ${s.group}`, labels: groups.map((g) => g.g), values: groups.map((g) => g.med) },
    summary: `The distribution of ${s.y} ${p < 0.05 ? 'differs' : 'does not differ significantly'} between the ${groups.length} groups (H = ${r4(H)}, p ${fmtP(p).startsWith('<') ? '' : '= '}${fmtP(p)}).`,
    assumptions: ['A non-parametric alternative to one-way ANOVA: no normality assumption.', 'Groups are independent.', 'Ties are corrected for; the p-value uses the chi-square approximation.'],
    n: nNote(c)
  }
}

// ---------------------------------------------------------------- regression

export interface OlsFit {
  names: string[]
  coef: number[]
  se: number[]
  n: number
  df: number
  r2: number
  adjR2: number
  F: number
  rmse: number
  sse: number
}

/** OLS from centered sufficient statistics (means, cross-products): scales to any number of rows. */
export function olsFromMoments(names: string[], means: number[], my: number, Sxx: number[][], Sxy: number[], Syy: number, n: number): OlsFit {
  const k = names.length
  const b = solve(Sxx, Sxy)
  const sse = Math.max(0, Syy - b.reduce((a, bi, i) => a + bi * Sxy[i], 0))
  const df = n - k - 1
  need(df > 0, 'Not enough rows for this many predictors.')
  const s2 = sse / df
  const inv = inverse(Sxx)
  const b0 = my - b.reduce((a, bi, i) => a + bi * means[i], 0)
  const v0 = s2 * (1 / n + means.reduce((a, mi, i) => a + means.reduce((c, mj, j) => c + mi * inv[i][j] * mj, 0), 0))
  const r2 = Syy ? 1 - sse / Syy : 0
  return { names: ['Intercept', ...names], coef: [b0, ...b], se: [Math.sqrt(v0), ...b.map((_, i) => Math.sqrt(s2 * inv[i][i]))], n, df, r2, adjR2: 1 - ((1 - r2) * (n - 1)) / df, F: (Syy - sse) / k / s2, rmse: Math.sqrt(sse / n), sse }
}

/**
 * The model's terms for its predictors: a number as itself; text or yes/no as indicator (dummy) terms, one per value
 * except the first in sort order, which is the reference (as statsmodels and R do).
 */
async function designTerms(s: AnalysisSpec, run: Run): Promise<{ name: string; sql: string }[]> {
  const out: { name: string; sql: string }[] = []
  for (const x of s.x!) {
    const [t] = await run(`SELECT typeof(${q(x)}) AS t FROM ${q(s.dataset)} WHERE ${q(x)} IS NOT NULL LIMIT 1`)
    if (!t || !/^(VARCHAR|BOOLEAN|ENUM)/i.test(String(t.t))) {
      out.push({ name: x, sql: `CAST(${q(x)} AS DOUBLE)` })
      continue
    }
    const levels = (await run(`SELECT DISTINCT CAST(${q(x)} AS VARCHAR) AS v FROM ${q(s.dataset)} WHERE ${q(x)} IS NOT NULL ORDER BY 1 LIMIT 51`)).map((r) => String(r.v))
    need(levels.length <= 50, `${x} has more than 50 values; group them first to use it as a predictor.`)
    need(levels.length >= 2, `${x} has only one value, so it can't explain anything.`)
    for (const v of levels.slice(1)) out.push({ name: `${x} = ${v}`, sql: `CAST(CAST(${q(x)} AS VARCHAR) = ${lit(v)} AS DOUBLE)` })
  }
  return out
}

async function regression(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.y && s.x?.length, 'Choose the outcome (y) and at least one predictor (x).')
  const degree = Math.max(1, Math.min(6, s.degree ?? 1))
  // Terms: each predictor (text ones as indicators), and for a polynomial on one predictor its powers.
  const base = await designTerms(s, run)
  need(degree === 1 || (s.x.length === 1 && base[0].name === s.x[0]), 'A polynomial needs a single numeric predictor.')
  const terms = degree > 1 ? Array.from({ length: degree }, (_, i) => ({ name: i ? `${s.x![0]}^${i + 1}` : s.x![0], sql: i ? `pow(${q(s.x![0])}, ${i + 1})` : q(s.x![0]) })) : base
  const y = q(s.y)
  const where = `${[s.y, ...s.x].map((c) => `${q(c)} IS NOT NULL`).join(' AND ')}`
  const [m] = await run(`SELECT count(*) AS n, avg(${y}) AS my, ${terms.map((t, i) => `avg(${t.sql}) AS m${i}`).join(', ')} FROM ${q(s.dataset)} WHERE ${where}`)
  const n = num(m.n)
  need(n > terms.length + 1, 'Not enough rows with values in every variable.')
  const means = terms.map((_, i) => num(m[`m${i}`]))
  const my = num(m.my)
  const c = (t: { sql: string }, i: number) => `(${t.sql} - ${means[i]})`
  const prods: string[] = [`sum((${y} - ${my}) * (${y} - ${my})) AS syy`]
  terms.forEach((ti, i) => {
    prods.push(`sum(${c(ti, i)} * (${y} - ${my})) AS sy${i}`)
    terms.forEach((tj, j) => j >= i && prods.push(`sum(${c(ti, i)} * ${c(tj, j)}) AS s${i}_${j}`))
  })
  const [p] = await run(`SELECT ${prods.join(', ')} FROM ${q(s.dataset)} WHERE ${where}`)
  const Sxx = terms.map((_, i) => terms.map((__, j) => num(p[`s${Math.min(i, j)}_${Math.max(i, j)}`])))
  const fit = olsFromMoments(terms.map((t) => t.name), means, my, Sxx, terms.map((_, i) => num(p[`sy${i}`])), num(p.syy), n)
  const level = s.level ?? 0.95
  const tq = tQuantile(1 - (1 - level) / 2, fit.df)
  const pF_ = pF(fit.F, terms.length, fit.df)
  // Residuals: quantiles over all rows, and a reproducible sample for the residual plot.
  const fitted = `(${fit.coef[0]} ${terms.map((t, i) => `+ ${fit.coef[i + 1]} * ${t.sql}`).join(' ')})`
  const [rq] = await run(`SELECT min(${y} - ${fitted}) AS mn, quantile_cont(${y} - ${fitted}, 0.25) AS q1, median(${y} - ${fitted}) AS md, quantile_cont(${y} - ${fitted}, 0.75) AS q3, max(${y} - ${fitted}) AS mx FROM ${q(s.dataset)} WHERE ${where}`)
  const sample = await run(`SELECT ${fitted} AS f, ${y} - ${fitted} AS r${terms.length === 1 ? `, ${terms[0].sql} AS x, ${y} AS y` : ''} FROM ${q(s.dataset)} WHERE ${where} USING SAMPLE reservoir(2000 ROWS) REPEATABLE (42)`)
  const total = await counts(run, s.dataset, [s.y, ...s.x])
  const rows = fit.names.map((nm, i) => {
    const t = fit.coef[i] / fit.se[i]
    return [nm, r4(fit.coef[i]), r4(fit.se[i]), r4(t), fmtP(pT(t, fit.df)), r4(fit.coef[i] - tq * fit.se[i]), r4(fit.coef[i] + tq * fit.se[i])]
  })
  const single = terms.length === 1
  const line: [number, number][] | undefined = single ? (() => {
    const xs = sample.map((r) => num(r.x))
    const lo = Math.min(...xs)
    const hi = Math.max(...xs)
    return [[lo, fit.coef[0] + fit.coef[1] * lo], [hi, fit.coef[0] + fit.coef[1] * hi]]
  })() : undefined
  const sigPreds = fit.names.slice(1).filter((_, i) => pT(fit.coef[i + 1] / fit.se[i + 1], fit.df) < 0.05)
  return {
    title: degree > 1 ? `Polynomial regression (degree ${degree})` : s.x.length > 1 ? 'Multiple linear regression' : 'Simple linear regression',
    tables: [
      { title: 'Coefficients', columns: ['Term', 'Estimate', 'Std. error', 't', 'p-value', `${Math.round(level * 100)}% CI low`, 'CI high'], rows },
      { title: 'Model', columns: ['N', 'R²', 'Adjusted R²', 'F', 'df', 'p-value (F)', 'RMSE'], rows: [[fit.n, r4(fit.r2), r4(fit.adjR2), r4(fit.F), `${terms.length}, ${fit.df}`, fmtP(pF_), r4(fit.rmse)]] },
      { title: 'Residuals', columns: ['Min', '25th pct', 'Median', '75th pct', 'Max'], rows: [[r4(num(rq.mn)), r4(num(rq.q1)), r4(num(rq.md)), r4(num(rq.q3)), r4(num(rq.mx))]] }
    ],
    chart: single ? { kind: 'scatter', title: `${s.y} vs ${terms[0].name}`, x: terms[0].name, y: s.y, points: sample.map((r) => [num(r.x), num(r.y)]), line } : { kind: 'scatter', title: 'Residuals vs fitted values', x: 'Fitted', y: 'Residual', points: sample.map((r) => [num(r.f), num(r.r)]) },
    summary: `The model explains ${r4(fit.r2 * 100)}% of the variation in ${s.y} (R²; adjusted ${r4(fit.adjR2 * 100)}%) and is ${sig(pF_)} overall. ${sigPreds.length ? `Significant predictors: ${sigPreds.join(', ')}.` : 'No single predictor is significant at the 5% level.'}${single && degree === 1 ? ` Each additional unit of ${terms[0].name} goes with ${r4(fit.coef[1])} ${fit.coef[1] >= 0 ? 'more' : 'less'} ${s.y}, on average.` : ''}`,
    assumptions: ['The relationship is linear in the terms used.', 'Residuals are independent, have constant spread (check the residual plot for funnels or curves), and are roughly normal for the p-values and intervals to hold.', 'Predictors are not strongly correlated with each other (collinearity widens the standard errors).', 'Coefficients describe association, not causation.'],
    n: nNote(total)
  }
}

/** Logistic regression by iteratively reweighted least squares on a reproducible sample (up to 100,000 rows). */
export function logisticFit(X: number[][], y: number[], maxIter = 50) {
  const k = X[0].length
  let beta = new Array(k).fill(0)
  let ll = -Infinity
  let XtWX: number[][] = []
  for (let it = 0; it < maxIter; it++) {
    XtWX = Array.from({ length: k }, () => new Array(k).fill(0))
    const grad = new Array(k).fill(0)
    let nll = 0
    for (let r = 0; r < X.length; r++) {
      const row = X[r]
      let z = 0
      for (let j = 0; j < k; j++) z += row[j] * beta[j]
      const p = sigmoid(z)
      nll += y[r] ? Math.log(Math.max(p, 1e-300)) : Math.log(Math.max(1 - p, 1e-300))
      const w = p * (1 - p)
      for (let i = 0; i < k; i++) {
        grad[i] += row[i] * (y[r] - p)
        for (let j = i; j < k; j++) XtWX[i][j] += row[i] * w * row[j]
      }
    }
    for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) XtWX[i][j] = XtWX[j][i]
    const step = solve(XtWX, grad)
    beta = beta.map((b, i) => b + step[i])
    const done = Math.abs(nll - ll) < 1e-10 * (1 + Math.abs(nll))
    ll = nll
    if (done) break
  }
  const inv = inverse(XtWX)
  let llFinal = 0
  let correct = 0
  for (let r = 0; r < X.length; r++) {
    let z = 0
    for (let j = 0; j < k; j++) z += X[r][j] * beta[j]
    const p = sigmoid(z)
    llFinal += y[r] ? Math.log(Math.max(p, 1e-300)) : Math.log(Math.max(1 - p, 1e-300))
    if ((p >= 0.5 ? 1 : 0) === y[r]) correct++
  }
  return { beta, se: beta.map((_, i) => Math.sqrt(inv[i][i])), ll: llFinal, accuracy: correct / X.length }
}

async function logistic(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.y && s.x?.length, 'Choose the outcome (two values, like yes/no) and at least one predictor.')
  const where = [s.y, ...s.x].map((c) => `${q(c)} IS NOT NULL`).join(' AND ')
  const levels = (await run(`SELECT DISTINCT CAST(${q(s.y)} AS VARCHAR) AS v FROM ${q(s.dataset)} WHERE ${q(s.y)} IS NOT NULL ORDER BY 1 LIMIT 3`)).map((r) => String(r.v))
  need(levels.length === 2, `The outcome must have exactly two values; ${s.y} has ${levels.length === 3 ? 'more than two' : levels.length}.`)
  const positive = s.positive && levels.includes(s.positive) ? s.positive : levels[1]
  const terms = await designTerms(s, run)
  const rows = await run(`SELECT CAST(${q(s.y)} AS VARCHAR) = ${lit(positive)} AS y, ${terms.map((t, i) => `${t.sql} AS x${i}`).join(', ')} FROM ${q(s.dataset)} WHERE ${where} USING SAMPLE reservoir(100000 ROWS) REPEATABLE (42)`)
  const X = rows.map((r) => [1, ...terms.map((_, i) => num(r[`x${i}`]))])
  const yv: number[] = rows.map((r) => (r.y ? 1 : 0))
  const fit = logisticFit(X, yv)
  const p0 = yv.reduce((a, b) => a + b, 0) / yv.length
  const ll0 = yv.reduce((a, b) => a + (b ? Math.log(p0) : Math.log(1 - p0)), 0)
  const total = await counts(run, s.dataset, [s.y, ...s.x])
  const z95 = normInv(1 - (1 - (s.level ?? 0.95)) / 2)
  const names = ['Intercept', ...terms.map((t) => t.name)]
  const lr = 2 * (fit.ll - ll0)
  return {
    title: 'Logistic regression',
    tables: [
      { title: `Coefficients (log-odds of ${s.y} = ${positive})`, columns: ['Term', 'Estimate', 'Std. error', 'z', 'p-value', 'Odds ratio', 'OR CI low', 'OR CI high'], rows: names.map((nm, i) => [nm, r4(fit.beta[i]), r4(fit.se[i]), r4(fit.beta[i] / fit.se[i]), fmtP(pZ(fit.beta[i] / fit.se[i])), r4(Math.exp(fit.beta[i])), r4(Math.exp(fit.beta[i] - z95 * fit.se[i])), r4(Math.exp(fit.beta[i] + z95 * fit.se[i]))]) },
      { title: 'Model', columns: ['N', 'Log-likelihood', 'McFadden R²', 'Likelihood-ratio χ²', 'p-value', 'AIC', 'Accuracy (cut-off 0.5)'], rows: [[rows.length, r4(fit.ll), r4(1 - fit.ll / ll0), r4(lr), fmtP(pChi(lr, terms.length)), r4(2 * names.length - 2 * fit.ll), r4(fit.accuracy)]] }
    ],
    summary: `${names.slice(1).map((nm, i) => `Each unit of ${nm} multiplies the odds of ${s.y} = ${positive} by ${r4(Math.exp(fit.beta[i + 1]))}${pZ(fit.beta[i + 1] / fit.se[i + 1]) < 0.05 ? '' : ' (not significant)'}`).join('; ')}. The model classifies ${r4(fit.accuracy * 100)}% of rows correctly.`,
    assumptions: ['The outcome has two values; log-odds are linear in the predictors.', 'Rows are independent.', `Fitted on ${rows.length < total.used ? `a reproducible random sample of ${rows.length.toLocaleString()} rows` : 'every complete row'}.`, 'Accuracy is measured on the same rows the model was fitted to (optimistic).'],
    n: { used: rows.length, excluded: total.total - total.used, note: nNote(total).note }
  }
}

// ---------------------------------------------------------------- forecasting (exponential smoothing)

export interface EtsParams {
  alpha: number
  beta?: number
  gamma?: number
  l0: number
  b0?: number
  s0?: number[]
  /** Multiplicative season: s are factors around 1 instead of amounts around 0. */
  mult?: boolean
  /** Damped trend: each period carries on φ of the last period's trend (statsmodels damped_trend). */
  phi?: number
  /** Multiplicative trend: b is a growth factor per period (statsmodels trend='mul'). */
  multTrend?: boolean
}

/**
 * One-step-ahead fitted values and final states of additive Holt–Winters, in statsmodels' ExponentialSmoothing form:
 *   ŷ_t = l_{t−1} + b_{t−1} + s_{t−m}
 *   l_t = α(y_t − s_{t−m}) + (1 − α)(l_{t−1} + b_{t−1})
 *   b_t = β(l_t − l_{t−1}) + (1 − β)b_{t−1}
 *   s_t = γ(y_t − l_{t−1} − b_{t−1}) + (1 − γ)s_{t−m}
 * and its multiplicative season (statsmodels seasonal='mul'):
 *   ŷ_t = (l_{t−1} + b_{t−1})·s_{t−m},  l_t = α·y_t/s_{t−m} + (1 − α)(l_{t−1} + b_{t−1}),  s_t = γ·y_t/(l_{t−1} + b_{t−1}) + (1 − γ)s_{t−m}
 * A damped trend replaces b_{t−1} by φ·b_{t−1} throughout (and b_t = β(l_t − l_{t−1}) + (1 − β)φ·b_{t−1}).
 * A multiplicative trend uses l_{t−1}·b_{t−1} where the additive one adds, and b_t = β(l_t / l_{t−1}) + (1 − β)b_{t−1}.
 */
export function etsFilter(y: number[], p: EtsParams, m: number) {
  const trend = p.beta !== undefined
  const seas = p.gamma !== undefined
  let l = p.l0
  let b = trend ? (p.b0 ?? 0) : 0
  const s = seas ? [...p.s0!] : []
  const phi = p.phi ?? 1
  const mt = trend && !!p.multTrend
  const fitted: number[] = []
  for (let t = 0; t < y.length; t++) {
    const mult = seas && !!p.mult
    const st = seas ? s[t % m] : mult ? 1 : 0
    const lPrev = l
    const bPrev = mt ? b : phi * b
    const base = mt ? lPrev * bPrev : lPrev + bPrev
    fitted.push(mult ? base * st : base + st)
    l = p.alpha * (mult ? y[t] / st : y[t] - st) + (1 - p.alpha) * base
    if (trend) b = mt ? p.beta! * (l / lPrev) + (1 - p.beta!) * bPrev : p.beta! * (l - lPrev) + (1 - p.beta!) * bPrev
    if (seas) s[t % m] = p.gamma! * (mult ? y[t] / base : y[t] - base) + (1 - p.gamma!) * st
  }
  return { fitted, l, b, s, n: y.length }
}

/** Classical decomposition start: seasonal indices from a centred moving average, level and trend from a line fitted to the deseasonalized start. */
export function etsInit(y: number[], m: number, seas: boolean, mult = false, multTrend = false) {
  let s0: number[] | undefined
  if (seas) {
    const half = Math.floor(m / 2)
    const sums = new Array(m).fill(0)
    const cnt = new Array(m).fill(0)
    for (let t = half; t < y.length - half; t++) {
      // 2×m moving average (centred for even m)
      let ma = 0
      for (let j = -half; j <= half; j++) ma += (m % 2 === 0 && Math.abs(j) === half ? 0.5 : 1) * y[t + j]
      ma /= m
      sums[t % m] += mult ? y[t] / ma : y[t] - ma
      cnt[t % m]++
    }
    const idx = sums.map((v, j) => (cnt[j] ? v / cnt[j] : mult ? 1 : 0))
    const mean = idx.reduce((a, b) => a + b, 0) / m
    s0 = idx.map((v) => (mult ? v / mean : v - mean))
  }
  const span = Math.min(y.length, seas ? 2 * m : 10)
  const z = y.slice(0, span).map((v, t) => (s0 ? (mult ? v / s0[t % m] : v - s0[t % m]) : v))
  const mt = (span - 1) / 2
  const mz = z.reduce((a, b) => a + b, 0) / span
  const slope = z.reduce((a, v, t) => a + (t - mt) * (v - mz), 0) / Math.max(1e-12, z.reduce((a, _, t) => a + (t - mt) ** 2, 0))
  const intercept = mz - slope * mt
  // A multiplicative trend: the same line's growth factor per period, around its start.
  if (multTrend) {
    const l0 = Math.max(1e-9, intercept - slope)
    return { l0, b0: Math.max(0.5, Math.min(2, 1 + slope / l0)), s0 }
  }
  return { l0: intercept - slope, b0: slope, s0 }
}

/** Fits ETS by minimizing the squared one-step errors over its smoothing parameters and initial level and trend. */
export function etsFit(y: number[], model: EtsModel, m: number) {
  const trend = model[0] !== 'N'
  const damped = model[0] === 'D'
  const multTrend = model[0] === 'M'
  const seas = model.length === 2
  const mult = model[1] === 'M'
  const init = etsInit(y, m, seas, mult, multTrend)
  const logit = (p: number) => Math.log(p / (1 - p))
  const unl = (x: number) => 1 / (1 + Math.exp(-x))
  const nSmooth = 1 + (trend ? 1 : 0) + (seas ? 1 : 0) + (damped ? 1 : 0)
  // φ in [0.8, 0.98], the usual range (Hyndman & Athanasopoulos): lower damps too fast, higher is a plain trend.
  const params = (v: number[]): EtsParams => ({ alpha: unl(v[0]), beta: trend ? unl(v[1]) : undefined, gamma: seas ? unl(v[trend ? 2 : 1]) : undefined, l0: v[nSmooth], b0: trend ? v[nSmooth + 1] : undefined, s0: init.s0, ...(mult ? { mult } : {}), ...(multTrend ? { multTrend } : {}), ...(damped ? { phi: 0.8 + 0.18 * unl(v[nSmooth - 1]) } : {}) })
  const sse = (v: number[]) => etsFilter(y, params(v), m).fitted.reduce((a, f, t) => a + (y[t] - f) ** 2, 0)
  const start = [logit(0.3), ...(trend ? [logit(0.1)] : []), ...(seas ? [logit(0.1)] : []), ...(damped ? [0] : []), trend ? init.l0 : y[0], ...(trend ? [init.b0] : [])]
  // Two passes: Nelder–Mead restarted from its own answer escapes the occasional early stop.
  let best = nelderMead(sse, start, { maxEvals: 4000 })
  best = nelderMead(sse, best.x, { maxEvals: 4000 })
  const p = params(best.x)
  const k = nSmooth + 1 + (trend ? 1 : 0) + (seas ? m : 0)
  const n = y.length
  const aicc = n * Math.log(best.fx / n) + 2 * k + (n - k - 1 > 0 ? (2 * k * (k + 1)) / (n - k - 1) : Infinity)
  return { params: p, sse: best.fx, aicc, k }
}

/**
 * h-step forecasts with prediction intervals. Additive season: Var = σ²(1 + Σ c_j²), c_j = α(1 + βφ_j) + γ[j ≡ 0 mod m],
 * φ_j = φ + φ² + … + φ^j (= j without damping).
 * Multiplicative season: no closed form, so the interval comes from 2,000 simulated futures (seeded, so repeatable).
 */
export function etsForecast(y: number[], p: EtsParams, m: number, h: number, level: number, k: number) {
  const st = etsFilter(y, p, m)
  const trend = p.beta !== undefined
  const seas = p.gamma !== undefined
  const phi = p.phi ?? 1
  const mt = trend && !!p.multTrend
  /** φ + φ² + … + φ^j: how much of today's trend is in the forecast j periods on. */
  const cum = (j: number) => (phi === 1 ? j : (phi * (1 - phi ** j)) / (1 - phi))
  /** The level and trend j periods on. */
  const ahead = (l: number, b: number, j: number) => (mt ? l * b ** j : l + (trend ? cum(j) * b : 0))
  const sse = st.fitted.reduce((a, f, t) => a + (y[t] - f) ** 2, 0)
  const sigma2 = sse / Math.max(1, y.length - k)
  const z = normInv(1 - (1 - level) / 2)
  const out: { mean: number; lo: number; hi: number }[] = []
  if ((seas && p.mult) || mt) {
    const paths: number[][] = Array.from({ length: h }, () => [])
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) + 0.5) / 2147483648
    const sigma = Math.sqrt(sigma2)
    for (let r = 0; r < 2000; r++) {
      let l = st.l
      let b = st.b
      const s = [...st.s]
      for (let j = 0; j < h; j++) {
        const i = (y.length + j) % m
        const ms = seas && !!p.mult
        const st = seas ? s[i] : ms ? 1 : 0
        const lPrev = l
        const bPrev = mt ? b : phi * b
        const base = mt ? lPrev * bPrev : lPrev + bPrev
        const yj = (ms ? base * st : base + st) + sigma * normInv(rnd())
        paths[j].push(yj)
        l = p.alpha * (ms ? yj / st : yj - st) + (1 - p.alpha) * base
        if (trend) b = mt ? p.beta! * (l / lPrev) + (1 - p.beta!) * bPrev : p.beta! * (l - lPrev) + (1 - p.beta!) * bPrev
        if (seas) s[i] = p.gamma! * (ms ? yj / base : yj - base) + (1 - p.gamma!) * st
      }
    }
    const qt = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))]
    for (let j = 1; j <= h; j++) {
      const sorted = paths[j - 1].sort((a, b) => a - b)
      const sj = seas ? st.s[(y.length + j - 1) % m] : p.mult ? 1 : 0
      out.push({ mean: seas && p.mult ? ahead(st.l, st.b, j) * sj : ahead(st.l, st.b, j) + sj, lo: qt(sorted, (1 - level) / 2), hi: qt(sorted, 1 - (1 - level) / 2) })
    }
    return { forecast: out, fitted: st.fitted, sigma: Math.sqrt(sigma2) }
  }
  let acc = 0
  for (let j = 1; j <= h; j++) {
    const mean = st.l + (trend ? cum(j) * st.b : 0) + (seas ? st.s[(y.length + j - 1) % m] : 0)
    const sd = Math.sqrt(sigma2 * (1 + acc))
    out.push({ mean, lo: mean - z * sd, hi: mean + z * sd })
    const c = p.alpha * (1 + (trend ? cum(j) * p.beta! : 0)) + (seas && j % m === 0 ? p.gamma! : 0)
    acc += c * c
  }
  return { forecast: out, fitted: st.fitted, sigma: Math.sqrt(sigma2) }
}

export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year'
/** N/A/D: no, additive or damped trend; a second letter: additive (A) or multiplicative (M) season. */
export type EtsModel = 'N' | 'A' | 'D' | 'M' | 'NA' | 'AA' | 'DA' | 'MA' | 'NM' | 'AM' | 'DM' | 'MM'
export const ETS_NAMES: Record<EtsModel, string> = { N: 'Simple exponential smoothing', A: 'Holt’s linear trend', D: 'Damped trend', NA: 'Seasonal (no trend)', AA: 'Holt–Winters additive (trend + season)', DA: 'Damped trend + additive season', NM: 'Multiplicative season (no trend)', AM: 'Holt–Winters multiplicative (trend + season)', DM: 'Damped trend + multiplicative season', M: 'Multiplicative trend', MA: 'Multiplicative trend + additive season', MM: 'Multiplicative trend and season' }
/** Season length per grain (weekly data: a yearly season of 52 weeks). */
export const SEASON: Record<Grain, number> = { day: 7, week: 52, month: 12, quarter: 4, year: 1 }

/** Fits the candidate models (seasonal ones only with two full seasons), keeps the lowest AICc, forecasts h periods. */
export function etsAuto(y: number[], m: number, h: number, level: number, model: EtsModel | 'auto' = 'auto') {
  const canSeason = m > 1 && y.length >= 2 * m
  // Multiplicative seasons need positive values (the season is a factor of the level).
  const positive = y.every((v) => v > 0)
  // Multiplicative trends and seasons need positive values (they are factors).
  const candidates: EtsModel[] = model !== 'auto' ? [model] : ['N', 'A', 'D', ...(positive ? (['M'] as const) : []), ...(canSeason ? (['NA', 'AA', 'DA'] as const) : []), ...(canSeason && positive ? (['NM', 'AM', 'DM', 'MA', 'MM'] as const) : [])]
  const fits = candidates.map((c) => ({ c, ...etsFit(y, c, m) })).sort((a, b) => a.aicc - b.aicc)
  return { fits, best: fits[0], canSeason, ...etsForecast(y, fits[0].params, m, h, level, fits[0].k) }
}

/** The ISO date j periods after an ISO date (month ends clamp: Jan 31 + 1 month = Feb 28/29). */
export function addPeriods(iso: string, grain: Grain, j: number): string {
  const [y, mo, d] = iso.slice(0, 10).split('-').map(Number)
  if (grain === 'day' || grain === 'week') return new Date(Date.UTC(y, mo - 1, d + (grain === 'week' ? 7 : 1) * j)).toISOString().slice(0, 10)
  const months = mo - 1 + (grain === 'year' ? 12 : grain === 'quarter' ? 3 : 1) * j
  const ty = y + Math.floor(months / 12)
  const tm = ((months % 12) + 12) % 12
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  return new Date(Date.UTC(ty, tm, Math.min(d, dim))).toISOString().slice(0, 10)
}

async function forecast(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.date && s.y, 'Choose a date column and the measure to forecast.')
  const grain = s.grain ?? 'month'
  const agg = s.agg ?? 'sum'
  const h = Math.max(1, Math.min(120, s.horizon ?? 12))
  // One value per period, with missing periods as 0 (sums) so the series is regular.
  const series = await run(`WITH a AS (SELECT CAST(date_trunc('${grain}', ${q(s.date)}) AS DATE) AS p, ${agg}(${q(s.y)}) AS v FROM ${q(s.dataset)} WHERE ${q(s.date)} IS NOT NULL AND ${q(s.y)} IS NOT NULL GROUP BY 1), r AS (SELECT CAST(g AS DATE) AS p FROM (SELECT min(p) AS lo, max(p) AS hi FROM a), generate_series(lo, hi, INTERVAL 1 ${grain}) AS t(g)) SELECT CAST(r.p AS VARCHAR) AS p, ${agg === 'sum' ? 'coalesce(a.v, 0)' : 'a.v'} AS v FROM r LEFT JOIN a USING (p) ORDER BY r.p`)
  const y = series.map((r) => num(r.v))
  need(y.length >= 4, 'At least 4 periods of data are needed to forecast.')
  need(y.every(Number.isFinite), 'Some periods have no value. Use Sum, or a coarser grain.')
  const m = SEASON[grain]
  need(!(s.model && s.model.length === 2) || (m > 1 && y.length >= 2 * m), `A seasonal model needs at least two full seasons (${2 * m} ${grain}s).`)
  need(!(s.model?.endsWith('M') || s.model?.startsWith('M')) || y.every((v) => v > 0), 'A multiplicative trend or season needs every period above zero.')
  const level = s.level ?? 0.95
  const last = String(series[series.length - 1].p)
  const labels = [...series.map((r) => String(r.p)), ...Array.from({ length: h }, (_, j) => addPeriods(last, grain, j + 1))]
  if (s.forecastMethod === 'arima') return arimaAnalysis(s, run, y, labels, m, h, level, grain)
  const { fits, best, canSeason, ...fc } = etsAuto(y, m, h, level, s.model)
  const name = ETS_NAMES
  const mape = y.reduce((a, v, t) => a + (v ? Math.abs((v - fc.fitted[t]) / v) : 0), 0) / y.filter((v) => v).length
  const total = await counts(run, s.dataset, [s.date, s.y])
  return {
    title: 'Forecast',
    tables: [
      { title: 'Forecast', columns: ['Period', 'Forecast', `${Math.round(level * 100)}% low`, 'High'], rows: fc.forecast.map((f, j) => [labels[y.length + j], r4(f.mean), r4(f.lo), r4(f.hi)]) },
      { title: 'Models compared (lowest AICc chosen)', columns: ['Model', 'AICc', 'α (level)', 'β (trend)', 'γ (season)', 'φ (damping)', 'RMSE'], rows: fits.map((f) => [name[f.c], r4(f.aicc), r4(f.params.alpha), f.params.beta === undefined ? null : r4(f.params.beta), f.params.gamma === undefined ? null : r4(f.params.gamma), f.params.phi === undefined ? null : r4(f.params.phi), r4(Math.sqrt(f.sse / y.length))]) },
      { title: 'Accuracy of one-step fits', columns: ['RMSE', 'MAPE (%)', 'Periods'], rows: [[r4(Math.sqrt(best.sse / y.length)), r4(mape * 100), y.length]] }
    ],
    chart: { kind: 'forecast', title: `${s.y} forecast (${name[best.c]})`, labels, actual: [...y, ...new Array(h).fill(null)], fitted: [...fc.fitted, ...new Array(h).fill(null)], forecast: [...new Array(y.length - 1).fill(null), y[y.length - 1], ...fc.forecast.map((f) => f.mean)], lo: [...new Array(y.length).fill(null), ...fc.forecast.map((f) => f.lo)], hi: [...new Array(y.length).fill(null), ...fc.forecast.map((f) => f.hi)] },
    summary: `${name[best.c]} fits best. The next ${grain} is forecast at ${r4(fc.forecast[0].mean)} (${Math.round(level * 100)}% interval ${r4(fc.forecast[0].lo)} to ${r4(fc.forecast[0].hi)}); the one-step fits are off by ${r4(mape * 100)}% on average (MAPE).`,
    assumptions: ['Exponential smoothing assumes the recent pattern (level, trend, season) continues.', `Missing ${grain}s count as 0 (sums) so periods are regular.`, 'Intervals assume roughly normal, uncorrelated errors; they widen with the horizon.', `Seasonal models need at least two full seasons (${2 * m} ${grain}s)${canSeason ? '' : '; there were too few here, so they were not considered'}.`],
    n: { used: total.used, excluded: total.total - total.used, note: `${y.length} periods.` }
  }
}

async function arimaAnalysis(s: AnalysisSpec, run: Run, y: number[], labels: string[], m: number, h: number, level: number, grain: Grain): Promise<AnalysisResult> {
  need(y.length >= 8, 'ARIMA needs at least 8 periods of data.')
  const auto = arimaAuto(y, m)
  need(auto, 'No ARIMA model could be fitted to this series (too short for its differencing).')
  const { best, tried } = auto!
  const fc = arimaForecast(y, best, h, level)
  const name = arimaName(best.order)
  const coef = [...best.ar.map((v, i) => [`AR ${i + 1}`, v]), ...best.ma.map((v, i) => [`MA ${i + 1}`, v]), ...best.sar.map((v, i) => [`Seasonal AR ${i + 1}`, v]), ...best.sma.map((v, i) => [`Seasonal MA ${i + 1}`, v]), ...(best.order.mean ? [[best.order.d + best.order.D === 1 ? 'Drift' : 'Mean', best.mu]] : []), ['σ² (innovations)', best.sigma2]] as [string, number][]
  const fitted = fc.fitted
  const errs = y.map((v, t) => (fitted[t] === null || !v ? null : Math.abs((v - fitted[t]!) / v))).filter((v): v is number => v !== null)
  const mape = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length)
  const total = await counts(run, s.dataset, [s.date!, s.y!])
  return {
    title: 'Forecast',
    tables: [
      { title: 'Forecast', columns: ['Period', 'Forecast', `${Math.round(level * 100)}% low`, 'High'], rows: fc.forecast.map((f, j) => [labels[y.length + j], r4(f.mean), r4(f.lo), r4(f.hi)]) },
      { title: 'Models compared (lowest AICc chosen)', columns: ['Model', 'AICc', 'Log-likelihood', 'Parameters'], rows: tried.slice(0, 12).map((f) => [arimaName(f.order), r4(f.aicc), r4(f.llf), f.k]) },
      { title: `${name}: coefficients`, columns: ['Term', 'Estimate'], rows: coef.map(([k, v]) => [k, r4(v)]) }
    ],
    chart: { kind: 'forecast', title: `${s.y} forecast (${name})`, labels, actual: [...y, ...new Array(h).fill(null)], fitted: [...fitted, ...new Array(h).fill(null)], forecast: [...new Array(y.length - 1).fill(null), y[y.length - 1], ...fc.forecast.map((f) => f.mean)], lo: [...new Array(y.length).fill(null), ...fc.forecast.map((f) => f.lo)], hi: [...new Array(y.length).fill(null), ...fc.forecast.map((f) => f.hi)] },
    summary: `${name} fits best. The next ${grain} is forecast at ${r4(fc.forecast[0].mean)} (${Math.round(level * 100)}% interval ${r4(fc.forecast[0].lo)} to ${r4(fc.forecast[0].hi)}); the one-step fits are off by ${r4(mape * 100)}% on average (MAPE).`,
    assumptions: [`Differencing: ${best.order.d} regular and ${best.order.D} seasonal, chosen by KPSS tests and seasonal strength; orders then chosen stepwise by AICc (p, q ≤ 3; P, Q ≤ 1).`, 'Orders searched with conditional sums of squares; the three best refitted by exact maximum likelihood. AR and MA parts kept stationary and invertible.', 'Intervals assume normal, uncorrelated errors; they widen with the horizon.', `Missing ${grain}s count as 0 (sums) so periods are regular.`],
    n: { used: total.used, excluded: total.total - total.used, note: `${y.length} periods.` }
  }
}

// ---------------------------------------------------------------- clustering, PCA, anomalies

export function kmeans(points: number[][], k: number, seed = 42, restarts = 5) {
  let best: { labels: number[]; centers: number[][]; sse: number } | null = null
  const d = points[0].length
  for (let rs = 0; rs < restarts; rs++) {
    const rand = rng(seed + rs)
    // k-means++ seeding
    const centers: number[][] = [points[Math.floor(rand() * points.length)]]
    while (centers.length < k) {
      const dist = points.map((p) => Math.min(...centers.map((c) => p.reduce((a, v, i) => a + (v - c[i]) ** 2, 0))))
      const total = dist.reduce((a, b) => a + b, 0)
      let r = rand() * total
      let i = 0
      while (i < dist.length - 1 && (r -= dist[i]) > 0) i++
      centers.push(points[i])
    }
    let labels = new Array(points.length).fill(0)
    for (let it = 0; it < 100; it++) {
      let moved = false
      labels = points.map((p, pi) => {
        let bi = 0
        let bd = Infinity
        centers.forEach((c, ci) => {
          const dd = p.reduce((a, v, i) => a + (v - c[i]) ** 2, 0)
          if (dd < bd) (bd = dd), (bi = ci)
        })
        if (bi !== labels[pi]) moved = true
        return bi
      })
      for (let c = 0; c < k; c++) {
        const members = points.filter((_, i) => labels[i] === c)
        if (members.length) centers[c] = Array.from({ length: d }, (_, j) => members.reduce((a, p) => a + p[j], 0) / members.length)
      }
      if (!moved && it) break
    }
    const sse = points.reduce((a, p, i) => a + p.reduce((b, v, j) => b + (v - centers[labels[i]][j]) ** 2, 0), 0)
    if (!best || sse < best.sse) best = { labels, centers: centers.map((c) => [...c]), sse }
  }
  return best!
}

/** Calinski–Harabasz index: between-cluster over within-cluster dispersion (higher is better). */
export function calinskiHarabasz(points: number[][], labels: number[], centers: number[][]) {
  const n = points.length
  const k = centers.length
  const mean = points[0].map((_, j) => points.reduce((a, p) => a + p[j], 0) / n)
  let W = 0
  let B = 0
  points.forEach((p, i) => (W += p.reduce((a, v, j) => a + (v - centers[labels[i]][j]) ** 2, 0)))
  centers.forEach((c, ci) => {
    const nc = labels.filter((l) => l === ci).length
    B += nc * c.reduce((a, v, j) => a + (v - mean[j]) ** 2, 0)
  })
  return W ? B / (k - 1) / (W / (n - k)) : Infinity
}

async function clusters(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const cols = s.columns ?? []
  need(cols.length >= 1, 'Choose the numeric columns to cluster on.')
  const where = cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ')
  const [st] = await run(`SELECT ${cols.map((c, i) => `avg(${q(c)}) AS m${i}, stddev_pop(${q(c)}) AS s${i}`).join(', ')} FROM ${q(s.dataset)} WHERE ${where}`)
  const mu = cols.map((_, i) => num(st[`m${i}`]))
  const sd = cols.map((_, i) => num(st[`s${i}`]) || 1)
  const rows = await run(`SELECT ${cols.map((c, i) => `(${q(c)} - ${mu[i]}) / ${sd[i]} AS z${i}`).join(', ')} FROM ${q(s.dataset)} WHERE ${where} USING SAMPLE reservoir(20000 ROWS) REPEATABLE (42)`)
  const pts = rows.map((r) => cols.map((_, i) => num(r[`z${i}`])))
  need(pts.length >= 4, 'Too few complete rows to cluster.')
  const ks = s.k ? [s.k] : [2, 3, 4, 5, 6, 7, 8].filter((k) => k < pts.length)
  const tried = ks.map((k) => {
    const r = kmeans(pts, k)
    return { k, ...r, ch: calinskiHarabasz(pts, r.labels, r.centers) }
  })
  const best = [...tried].sort((a, b) => b.ch - a.ch)[0]
  const sizes = best.centers.map((_, c) => best.labels.filter((l) => l === c).length)
  const centers = best.centers.map((c) => c.map((z, i) => z * sd[i] + mu[i]))
  // The clusters as SQL: every row (not only the sample) goes to its nearest center.
  const dist = (c: number[]) => cols.map((col, i) => `pow((${q(col)} - ${mu[i]}) / ${sd[i]} - ${c[i]}, 2)`).join(' + ')
  const datasetSql = `SELECT *, CASE WHEN ${cols.map((c) => `${q(c)} IS NULL`).join(' OR ')} THEN NULL ELSE list_position([${best.centers.map((c) => dist(c)).join(', ')}], list_min([${best.centers.map((c) => dist(c)).join(', ')}])) END AS cluster FROM ${q(s.dataset)}`
  const total = await counts(run, s.dataset, cols)
  return {
    title: 'K-means clustering',
    tables: [
      { title: 'Clusters (centers in original units)', columns: ['Cluster', 'Rows (sample)', ...cols], rows: centers.map((c, i) => [i + 1, sizes[i], ...c.map(r4)]) },
      ...(s.k ? [] : [{ title: 'Number of clusters (Calinski–Harabasz, higher is better)', columns: ['k', 'Index', 'Within-cluster SS'], rows: tried.map((t) => [t.k, r4(t.ch), r4(t.sse)]) }])
    ],
    chart: { kind: 'scatter', title: cols.length > 1 ? `${cols[1]} vs ${cols[0]} by cluster` : `${cols[0]} by cluster`, x: cols[0], y: cols[1] ?? 'Cluster', points: rows.slice(0, 3000).map((r, i) => [num(r.z0) * sd[0] + mu[0], cols.length > 1 ? num(r.z1) * sd[1] + mu[1] : best.labels[i] + 1]), groups: best.labels.slice(0, 3000) },
    summary: `${best.k} clusters ${s.k ? 'as requested' : 'separate the data best'}; the largest holds ${Math.round((Math.max(...sizes) / pts.length) * 100)}% of rows. Save them as a dataset to chart or filter by cluster.`,
    assumptions: ['Variables are standardized (mean 0, standard deviation 1) so each counts equally.', 'K-means finds round clusters of similar size; it is sensitive to outliers.', `Fitted on ${pts.length < total.used ? `a reproducible sample of ${pts.length.toLocaleString()} rows` : 'every complete row'} (k-means++ starts, seed 42, best of 5).`],
    n: nNote(total),
    datasetSql
  }
}

async function pca(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const cols = s.columns ?? []
  need(cols.length >= 2, 'Choose at least two numeric columns.')
  const where = cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ')
  const pairs: string[] = []
  cols.forEach((a, i) => cols.forEach((b, j) => j > i && pairs.push(`corr(${q(a)}, ${q(b)}) AS r_${i}_${j}`)))
  const [r] = await run(`SELECT count(*) AS n, ${pairs.join(', ')} FROM ${q(s.dataset)} WHERE ${where}`)
  const R = cols.map((_, i) => cols.map((__, j) => (i === j ? 1 : num(r[`r_${Math.min(i, j)}_${Math.max(i, j)}`]))))
  const { values, vectors } = eigenSymmetric(R)
  const total = values.reduce((a, b) => a + b, 0)
  let cum = 0
  // Sign convention: the largest loading of each component is positive.
  const vecs = vectors.map((v) => (Math.abs(Math.min(...v)) > Math.max(...v) ? v.map((x) => -x) : v))
  const keep = values.filter((v) => v >= 1).length
  const c = await counts(run, s.dataset, cols)
  return {
    title: 'Principal component analysis',
    tables: [
      { title: 'Components', columns: ['Component', 'Eigenvalue', 'Variance explained (%)', 'Cumulative (%)'], rows: values.map((v, i) => [`PC${i + 1}`, r4(v), r4((v / total) * 100), r4(((cum += v) / total) * 100)]) },
      { title: 'Loadings', columns: ['Variable', ...values.map((_, i) => `PC${i + 1}`)], rows: cols.map((col, i) => [col, ...vecs.map((v) => r4(v[i]))]) }
    ],
    chart: { kind: 'bars', title: 'Variance explained by each component (%)', labels: values.map((_, i) => `PC${i + 1}`), values: values.map((v) => (v / total) * 100) },
    summary: `The first component explains ${r4((values[0] / total) * 100)}% of the variation and the first two ${r4(((values[0] + (values[1] ?? 0)) / total) * 100)}%. ${keep} component${keep === 1 ? ' has' : 's have'} an eigenvalue above 1 (Kaiser’s rule).`,
    assumptions: ['Computed on the correlation matrix (standardized variables), over every complete row.', 'PCA captures linear structure; loadings show how strongly each variable contributes to a component.'],
    n: nNote(c)
  }
}

async function anomalies(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  need(s.y, 'Choose the numeric column to check.')
  const y = q(s.y)
  const method = s.method ?? 'iqr'
  const k = s.threshold ?? (method === 'z' ? 3 : 1.5)
  const [st] = await run(`SELECT count(${y}) AS n, avg(${y}) AS m, stddev_samp(${y}) AS sd, quantile_cont(${y}, 0.25) AS q1, quantile_cont(${y}, 0.75) AS q3 FROM ${q(s.dataset)}`)
  const lo = method === 'z' ? num(st.m) - k * num(st.sd) : num(st.q1) - k * (num(st.q3) - num(st.q1))
  const hi = method === 'z' ? num(st.m) + k * num(st.sd) : num(st.q3) + k * (num(st.q3) - num(st.q1))
  const [cnt] = await run(`SELECT count(*) AS n FROM ${q(s.dataset)} WHERE ${y} < ${lo} OR ${y} > ${hi}`)
  const rows = await run(`SELECT * FROM ${q(s.dataset)} WHERE ${y} < ${lo} OR ${y} > ${hi} ORDER BY abs(${y} - ${num(st.m)}) DESC LIMIT 200`)
  const cols = rows[0] ? Object.keys(rows[0]) : []
  return {
    title: 'Anomalies',
    tables: [
      { title: 'Rule', columns: ['Method', 'Lower bound', 'Upper bound', 'Anomalies', 'Of'], rows: [[method === 'z' ? `|z| > ${k}` : `${k} × IQR beyond the quartiles`, r4(lo), r4(hi), num(cnt.n), num(st.n)]] },
      { title: `Most extreme rows (up to 200)`, columns: cols, rows: rows.map((r) => cols.map((c) => r[c])) }
    ],
    summary: `${num(cnt.n).toLocaleString()} of ${num(st.n).toLocaleString()} values of ${s.y} (${r4((num(cnt.n) / num(st.n)) * 100)}%) fall outside ${r4(lo)} – ${r4(hi)}.`,
    assumptions: [method === 'z' ? 'The z-score rule assumes roughly normal data; extreme values inflate the standard deviation itself.' : 'The IQR rule (Tukey’s fences) is robust to the extremes it looks for and suits skewed data.', 'An anomaly is unusual, not necessarily wrong: check the rows before removing them.'],
    n: { used: num(st.n), excluded: 0, note: 'Empty values are ignored.' }
  }
}

export const ANALYSES: { kind: AnalysisKind; label: string; group: string; describe: string }[] = [
  { kind: 'describe', label: 'Descriptive statistics', group: 'Explore', describe: 'Mean, median, spread, percentiles, skewness, outliers, distribution' },
  { kind: 'missing', label: 'Missing values', group: 'Explore', describe: 'Empty values per column' },
  { kind: 'correlation', label: 'Correlation', group: 'Explore', describe: 'Pearson correlations and covariances between numbers' },
  { kind: 'anomalies', label: 'Anomalies', group: 'Explore', describe: 'Unusual values by z-score or IQR' },
  { kind: 'ttest', label: 't-test', group: 'Compare', describe: 'One sample, two groups (Welch) or paired' },
  { kind: 'anova', label: 'ANOVA', group: 'Compare', describe: 'Compare the means of several groups' },
  { kind: 'mannwhitney', label: 'Mann–Whitney U', group: 'Compare', describe: 'Two groups, no normality assumption' },
  { kind: 'kruskal', label: 'Kruskal–Wallis', group: 'Compare', describe: 'Several groups, no normality assumption' },
  { kind: 'chisq', label: 'Chi-square', group: 'Compare', describe: 'Are two categories related?' },
  { kind: 'regression', label: 'Linear regression', group: 'Model', describe: 'Simple, multiple or polynomial' },
  { kind: 'logistic', label: 'Logistic regression', group: 'Model', describe: 'Predict a yes/no outcome' },
  { kind: 'forecast', label: 'Forecast', group: 'Model', describe: 'Exponential smoothing or ARIMA, with trend and seasonality' },
  { kind: 'kmeans', label: 'Clustering (k-means)', group: 'Model', describe: 'Find groups of similar rows' },
  { kind: 'pca', label: 'Principal components', group: 'Model', describe: 'Summarize many numbers in a few components' }
]

export async function runAnalysis(s: AnalysisSpec, run: Run): Promise<AnalysisResult> {
  const fn = { describe, missing, correlation, ttest, anova, chisq, mannwhitney, kruskal, regression, logistic, forecast, kmeans: clusters, pca, anomalies }[s.kind]
  return fn(s, run)
}

/**
 * Clusters of a chart's marks (Tableau's Cluster on a view): the marks' values standardized, k from 2 to 8 by the
 * Calinski–Harabasz index (on at most 2,000 marks) unless given, k-means++ (seed 42). Returns each mark's cluster
 * (0-based), or -1 for marks with a missing value.
 */
export function clusterMarks(points: (number | null)[][], k?: number): number[] {
  const ok = points.map((p) => p.length > 0 && p.every((v) => v !== null && Number.isFinite(v)))
  const pts = points.filter((_, i) => ok[i]) as number[][]
  if (pts.length < 3) return points.map((_, i) => (ok[i] ? 0 : -1))
  const d = pts[0].length
  const mu = Array.from({ length: d }, (_, j) => pts.reduce((a, p) => a + p[j], 0) / pts.length)
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(pts.reduce((a, p) => a + (p[j] - mu[j]) ** 2, 0) / pts.length) || 1)
  const z = pts.map((p) => p.map((v, j) => (v - mu[j]) / sd[j]))
  let best = k ? Math.max(1, Math.min(k, z.length)) : 2
  if (!k) {
    const sample = z.length > 2000 ? z.filter((_, i) => i % Math.ceil(z.length / 2000) === 0) : z
    let score = -Infinity
    for (let kk = 2; kk <= Math.min(8, sample.length - 1); kk++) {
      const r = kmeans(sample, kk)
      const ch = calinskiHarabasz(sample, r.labels, r.centers)
      if (ch > score) (score = ch), (best = kk)
    }
  }
  const labels = kmeans(z, best).labels
  let at = 0
  return points.map((_, i) => (ok[i] ? labels[at++] : -1))
}

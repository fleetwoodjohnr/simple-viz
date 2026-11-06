// Numerical building blocks for the statistics module: small dense linear algebra, a symmetric eigen solver,
// Nelder–Mead (from Simple Cell's Solver), a seeded random generator, and distribution helpers built on Simple Cell's
// validated special functions (stats-core.ts: tCdf, fCdf, chiCdf, normCdf, normInv).

import { tCdf, fCdf, chiCdf, normCdf, normInv, invert } from '../sheets/engine/functions/stats-core'

export { normCdf, normInv }

/** Two-sided p-value of a t statistic. */
export const pT = (t: number, df: number) => (Number.isFinite(t) && df > 0 ? Math.min(1, 2 * (1 - tCdf(Math.abs(t), df))) : NaN)
/** Upper-tail p-values. */
export const pF = (f: number, d1: number, d2: number) => (Number.isFinite(f) ? Math.max(0, 1 - fCdf(f, d1, d2)) : NaN)
export const pChi = (x: number, df: number) => (Number.isFinite(x) ? Math.max(0, 1 - chiCdf(x, df)) : NaN)
export const pZ = (z: number) => Math.min(1, 2 * (1 - normCdf(Math.abs(z))))
/** Quantile of Student's t (e.g. 0.975 for a 95% interval). */
export const tQuantile = (p: number, df: number) => (df > 1e6 ? normInv(p) : invert((t) => tCdf(t, df), p, -1e3, 1e3))

/** Solves A x = b for a symmetric positive (semi)definite A by Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12 * (1 + Math.abs(M[c][c]))) throw new Error('The predictors are collinear (one is a combination of the others). Remove one of them.')
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

export function inverse(A: number[][]): number[][] {
  const n = A.length
  const cols = Array.from({ length: n }, (_, j) => solve(A, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))))
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cols[j][i]))
}

/** Eigenvalues and eigenvectors (columns) of a symmetric matrix, by cyclic Jacobi rotations; sorted descending. */
export function eigenSymmetric(S: number[][]): { values: number[]; vectors: number[][] } {
  const n = S.length
  const A = S.map((r) => [...r])
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2
    if (off < 1e-22) break
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = A[k][p]
          const akq = A[k][q]
          A[k][p] = c * akp - s * akq
          A[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k]
          const aqk = A[q][k]
          A[p][k] = c * apk - s * aqk
          A[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p]
          const vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
  }
  const order = A.map((r, i) => [r[i], i] as const).sort((a, b) => b[0] - a[0])
  return { values: order.map(([v]) => v), vectors: order.map(([, i]) => V.map((row) => row[i])) }
}

/** Nelder–Mead minimization of f from x0 (Simple Cell's Solver implementation). */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { maxEvals?: number; tol?: number } = {}): { x: number[]; fx: number } {
  const n = x0.length
  const maxEvals = opts.maxEvals ?? 400 * (n + 1)
  const tol = opts.tol ?? 1e-10
  let evals = 0
  const F = (x: number[]) => {
    evals++
    const v = f(x)
    return Number.isNaN(v) ? Infinity : v
  }
  const pts: { x: number[]; fx: number }[] = [{ x: [...x0], fx: F(x0) }]
  for (let i = 0; i < n; i++) {
    const x = [...x0]
    x[i] += Math.max(Math.abs(x[i]) * 0.1, 0.5)
    pts.push({ x, fx: F(x) })
  }
  while (evals < maxEvals) {
    pts.sort((a, b) => a.fx - b.fx)
    const spread = Math.abs(pts[n].fx - pts[0].fx)
    const size = Math.max(...pts.slice(1).map((p) => Math.max(...p.x.map((v, i) => Math.abs(v - pts[0].x[i])))))
    if (spread <= tol * (Math.abs(pts[0].fx) + tol) && size < 1e-9 * (1 + Math.max(...pts[0].x.map(Math.abs)))) break
    const centroid = new Array<number>(n).fill(0)
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) centroid[i] += pts[k].x[i] / n
    const along = (t: number) => centroid.map((c, i) => c + t * (pts[n].x[i] - c))
    const xr = along(-1)
    const fr = F(xr)
    if (fr < pts[0].fx) {
      const xe = along(-2)
      const fe = F(xe)
      pts[n] = fe < fr ? { x: xe, fx: fe } : { x: xr, fx: fr }
    } else if (fr < pts[n - 1].fx) pts[n] = { x: xr, fx: fr }
    else {
      const xc = fr < pts[n].fx ? along(-0.5) : along(0.5)
      const fc = F(xc)
      if (fc < Math.min(fr, pts[n].fx)) pts[n] = { x: xc, fx: fc }
      else
        for (let k = 1; k <= n; k++) {
          const x = pts[k].x.map((v, i) => pts[0].x[i] + 0.5 * (v - pts[0].x[i]))
          pts[k] = { x, fx: F(x) }
        }
    }
  }
  pts.sort((a, b) => a.fx - b.fx)
  return pts[0]
}

/** mulberry32: a small seeded generator, so clustering and sampling give the same answer every run. */
export function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

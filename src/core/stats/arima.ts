// Seasonal ARIMA(p,d,q)(P,D,Q)m, the model behind R's auto.arima and statsmodels' SARIMAX:
//   φ(B)Φ(B^m) (w_t − μ) = θ(B)Θ(B^m) e_t,   w = (1 − B)^d (1 − B^m)^D y
// fitted by exact maximum likelihood (a Kalman filter on Harvey's state-space form, started from the stationary
// covariance), with the orders chosen stepwise by AICc (Hyndman & Khandakar 2008). A mean (or drift, when d + D = 1)
// is included only when d + D ≤ 1. AR and MA parts are kept stationary and invertible by fitting partial
// autocorrelations (Jones 1980), as statsmodels does.

import { nelderMead, normInv } from './math'

export interface ArimaOrder {
  p: number
  d: number
  q: number
  P: number
  D: number
  Q: number
  m: number
  /** A mean of the differenced series (a drift in y when d + D = 1). */
  mean: boolean
}

export interface ArimaFit {
  order: ArimaOrder
  ar: number[]
  ma: number[]
  sar: number[]
  sma: number[]
  mu: number
  sigma2: number
  llf: number
  aicc: number
  /** Number of estimated parameters, σ² included. */
  k: number
}

/** Coefficients of a product of polynomials in B (index = power). */
export function polyMul(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0)
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] += x * y)))
  return out
}

/** 1 − Σ c_i B^(i·step), as coefficients. */
const lagPoly = (c: number[], step: number, sign: number) => {
  const out = new Array<number>(c.length * step + 1).fill(0)
  out[0] = 1
  c.forEach((v, i) => (out[(i + 1) * step] = sign * v))
  return out
}

/** The full AR coefficients (w_t = Σ φ*_i w_{t−i} + …) and MA coefficients (… + Σ θ*_j e_{t−j}). */
export function expand(ar: number[], ma: number[], sar: number[], sma: number[], m: number) {
  const a = polyMul(lagPoly(ar, 1, -1), lagPoly(sar, m, -1))
  const b = polyMul(lagPoly(ma, 1, 1), lagPoly(sma, m, 1))
  return { phi: a.slice(1).map((v) => -v), theta: b.slice(1) }
}

/** Coefficients of (1 − B)^d (1 − B^m)^D. */
export function diffPoly(d: number, D: number, m: number): number[] {
  let c = [1]
  for (let i = 0; i < d; i++) c = polyMul(c, [1, -1])
  for (let i = 0; i < D; i++) c = polyMul(c, lagPoly([1], m, -1))
  return c
}

export function difference(y: number[], d: number, D: number, m: number): number[] {
  const c = diffPoly(d, D, m)
  const k = c.length - 1
  const out: number[] = []
  for (let t = k; t < y.length; t++) out.push(c.reduce((a, ci, i) => a + ci * y[t - i], 0))
  return out
}

/** Partial autocorrelations (any real numbers, squashed into (−1, 1)) to stationary AR coefficients (Durbin–Levinson). */
export function constrain(x: number[]): number[] {
  let phi: number[] = []
  for (let k = 0; k < x.length; k++) {
    const r = x[k] / Math.sqrt(1 + x[k] * x[k])
    const next = [...phi, r]
    for (let j = 0; j < k; j++) next[j] = phi[j] - r * phi[k - 1 - j]
    phi = next
  }
  return phi
}

/** The inverse of `constrain`, for starting values. */
export function unconstrain(phi: number[]): number[] {
  const out = new Array<number>(phi.length)
  let cur = [...phi]
  for (let k = phi.length - 1; k >= 0; k--) {
    const r = Math.max(-0.999, Math.min(0.999, cur[k]))
    out[k] = r / Math.sqrt(1 - r * r)
    const prev: number[] = []
    for (let j = 0; j < k; j++) prev.push((cur[j] + r * cur[k - 1 - j]) / (1 - r * r))
    cur = prev
  }
  return out
}

/**
 * Kalman filter for a zero-mean ARMA in Harvey's form: state dimension r = max(p, q + 1), T = [φ | I; 0], R = (1, θ)'.
 * Started from the stationary covariance P = TPT' + RR' (σ² = 1), solved by doubling. Returns the sums the
 * likelihood needs, the one-step predictions, and the state after the last observation (for forecasting).
 * Flat typed arrays and O(r²) companion products: this runs thousands of times per fit.
 */
export function kalman(x: number[], phi: number[], theta: number[]) {
  const r = Math.max(phi.length, theta.length + 1, 1)
  const f = Float64Array.from({ length: r }, (_, i) => phi[i] ?? 0)
  const R = Float64Array.from({ length: r }, (_, i) => (i === 0 ? 1 : (theta[i - 1] ?? 0)))
  const rr = r * r
  const RR = new Float64Array(rr)
  for (let i = 0; i < r; i++) for (let j = 0; j < r; j++) RR[i * r + j] = R[i] * R[j]
  // Stationary covariance by doubling: P = Σ T^k RR' T'^k, with T^(2^k) squared each round.
  let P = Float64Array.from(RR)
  let Tk = new Float64Array(rr)
  for (let i = 0; i < r; i++) {
    Tk[i * r] = f[i]
    if (i + 1 < r) Tk[i * r + i + 1] = 1
  }
  const tmp = new Float64Array(rr)
  const tmp2 = new Float64Array(rr)
  for (let it = 0; it < 64; it++) {
    // tmp = Tk·P, tmp2 = tmp·Tk'
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) {
        let a = 0
        for (let k = 0; k < r; k++) a += Tk[i * r + k] * P[k * r + j]
        tmp[i * r + j] = a
      }
    let change = 0
    let size = 0
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) {
        let a = 0
        for (let k = 0; k < r; k++) a += tmp[i * r + k] * Tk[j * r + k]
        const v = P[i * r + j] + a
        P[i * r + j] = v
        change = Math.max(change, Math.abs(a))
        size = Math.max(size, Math.abs(v))
      }
    if (!(change > 1e-13 * size)) break
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) {
        let a = 0
        for (let k = 0; k < r; k++) a += Tk[i * r + k] * Tk[k * r + j]
        tmp2[i * r + j] = a
      }
    Tk.set(tmp2)
  }
  const a = new Float64Array(r)
  const att = new Float64Array(r)
  const Pt = new Float64Array(rr)
  const A = new Float64Array(rr)
  const Pc = new Float64Array(r)
  let sumLogF = 0
  let sumV2F = 0
  let steady = false
  let F = 0
  const pred: number[] = []
  for (let t = 0; t < x.length; t++) {
    if (!steady) F = P[0]
    const v = x[t] - a[0]
    pred.push(a[0])
    sumLogF += Math.log(F)
    sumV2F += (v * v) / F
    if (!steady) for (let i = 0; i < r; i++) Pc[i] = P[i * r]
    for (let i = 0; i < r; i++) att[i] = a[i] + (Pc[i] * v) / F
    for (let i = 0; i < r; i++) a[i] = f[i] * att[0] + (i + 1 < r ? att[i + 1] : 0)
    if (steady) continue
    // Pt = P − P[:,0]P[0,:]/F;  P = T·Pt·T' + RR'
    for (let i = 0; i < r; i++) for (let j = 0; j < r; j++) Pt[i * r + j] = P[i * r + j] - (Pc[i] * Pc[j]) / F
    for (let i = 0; i < r; i++) for (let j = 0; j < r; j++) A[i * r + j] = f[i] * Pt[j] + (i + 1 < r ? Pt[(i + 1) * r + j] : 0)
    let change = 0
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) {
        const v2 = f[j] * A[i * r] + (j + 1 < r ? A[i * r + j + 1] : 0) + RR[i * r + j]
        change = Math.max(change, Math.abs(v2 - P[i * r + j]))
        P[i * r + j] = v2
      }
    // Once the covariance stops changing, the gain does too (the filter is in its steady state).
    if (change < 1e-13 * Math.max(1, P[0])) steady = true
  }
  return { sumLogF, sumV2F, pred, a: [...a], f: [...f], n: x.length }
}

/** Conditional sum of squares (residuals given zero pre-sample errors), for fast order searches and starting values. */
export function css(x: number[], phi: number[], theta: number[]) {
  const p = phi.length
  const q = theta.length
  const e = new Float64Array(x.length)
  let sse = 0
  for (let t = p; t < x.length; t++) {
    let v = x[t]
    for (let i = 0; i < p; i++) v -= phi[i] * x[t - 1 - i]
    for (let j = 0; j < q && t - 1 - j >= p; j++) v -= theta[j] * e[t - 1 - j]
    e[t] = v
    sse += v * v
  }
  return { sse, n: x.length - p }
}

/** Exact Gaussian log-likelihood at a given σ² (or, without one, at its maximizing value). */
export function arimaLoglik(w: number[], phi: number[], theta: number[], mu: number, sigma2?: number) {
  const k = kalman(
    w.map((v) => v - mu),
    phi,
    theta
  )
  const n = w.length
  const s2 = sigma2 ?? k.sumV2F / n
  return { llf: -0.5 * n * Math.log(2 * Math.PI * s2) - 0.5 * k.sumLogF - k.sumV2F / (2 * s2), sigma2: s2, kalman: k }
}

/**
 * Fits one order: by conditional sum of squares ('css', fast, for the order search) or exact maximum likelihood
 * ('ml', from `start` when given, e.g. the CSS estimates).
 */
export function arimaFit(y: number[], order: ArimaOrder, method: 'css' | 'ml' = 'ml', start?: number[]): (ArimaFit & { x: number[] }) | null {
  const { p, q, P, Q, m } = order
  const w = difference(y, order.d, order.D, m)
  const n = w.length
  const mean = order.mean && order.d + order.D <= 1
  const k = p + q + P + Q + (mean ? 1 : 0) + 1
  const nAr = p + m * P
  const nEff = method === 'css' ? n - nAr : n
  if (nEff - k - 1 <= 0 || n < 3) return null
  // Standardize so the optimizer works on numbers near 1.
  const avg = w.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / n) || 1
  const z = w.map((v) => (v - (mean ? avg : 0)) / sd)
  const unpack = (v: number[]) => {
    let i = 0
    const take = (c: number) => v.slice(i, (i += c))
    const ar = constrain(take(p))
    const ma = constrain(take(q)).map((x) => -x)
    const sar = constrain(take(P))
    const sma = constrain(take(Q)).map((x) => -x)
    const mu = mean ? v[i] : 0
    return { ar, ma, sar, sma, mu }
  }
  const obj = (v: number[]) => {
    const u = unpack(v)
    const e = expand(u.ar, u.ma, u.sar, u.sma, m)
    const x = u.mu ? z.map((t) => t - u.mu) : z
    if (method === 'css') {
      const c = css(x, e.phi, e.theta)
      return 0.5 * c.n * Math.log(c.sse / c.n)
    }
    const r = arimaLoglik(x, e.phi, e.theta, 0)
    return Number.isFinite(r.llf) ? -r.llf : Infinity
  }
  const dim = p + q + P + Q + (mean ? 1 : 0)
  const x0 = start && start.length === dim ? start : new Array<number>(dim).fill(0)
  let best = dim ? nelderMead(obj, x0, { maxEvals: 200 * (dim + 1), tol: 1e-9 }) : { x: [], fx: obj([]) }
  // A restart from its own answer escapes Nelder–Mead's occasional early stop (not needed from CSS estimates).
  if (dim && !start) best = nelderMead(obj, best.x, { maxEvals: 200 * (dim + 1), tol: 1e-10 })
  if (!Number.isFinite(best.fx)) return null
  const u = unpack(best.x)
  const e = expand(u.ar, u.ma, u.sar, u.sma, m)
  const muW = (mean ? avg : 0) + sd * u.mu
  let llf: number
  let sigma2: number
  if (method === 'css') {
    const c = css(
      w.map((v) => v - muW),
      e.phi,
      e.theta
    )
    sigma2 = c.sse / c.n
    llf = -0.5 * c.n * (Math.log(2 * Math.PI * sigma2) + 1)
  } else ({ llf, sigma2 } = arimaLoglik(w, e.phi, e.theta, muW))
  const aicc = -2 * llf + 2 * k + (2 * k * (k + 1)) / (nEff - k - 1)
  return { order: { ...order, mean }, ar: u.ar, ma: u.ma, sar: u.sar, sma: u.sma, mu: muW, sigma2, llf, aicc, k, x: best.x }
}

/** One-step fitted values of y (null until enough history to undo the differencing) and h forecasts with intervals. */
export function arimaForecast(y: number[], f: ArimaFit, h: number, level: number) {
  const { d, D, m } = f.order
  const c = diffPoly(d, D, m)
  const K = c.length - 1
  const w = difference(y, d, D, m)
  const e = expand(f.ar, f.ma, f.sar, f.sma, m)
  const kf = kalman(
    w.map((v) => v - f.mu),
    e.phi,
    e.theta
  )
  const fitted: (number | null)[] = y.map((_, t) => (t < K ? null : f.mu + kf.pred[t - K] - c.slice(1).reduce((a, ci, i) => a + ci * y[t - 1 - i], 0)))
  // Forecasts of w from the state after the last observation, then undifferenced.
  const all = [...y]
  let a = kf.a
  const r = a.length
  for (let j = 0; j < h; j++) {
    const wj = f.mu + a[0]
    const t = all.length
    all.push(wj - c.slice(1).reduce((acc, ci, i) => acc + ci * all[t - 1 - i], 0))
    a = a.map((_, i) => kf.f[i] * a[0] + (i + 1 < r ? a[i + 1] : 0))
  }
  // Interval: ψ weights of the whole model, differencing included.
  const A = polyMul(
    [1, ...e.phi.map((v) => -v)],
    c
  )
  const psi = [1]
  for (let j = 1; j < h; j++) {
    let v = e.theta[j - 1] ?? 0
    for (let i = 1; i <= Math.min(j, A.length - 1); i++) v -= A[i] * psi[j - i]
    psi.push(v)
  }
  const z = normInv(1 - (1 - level) / 2)
  let acc = 0
  const forecast = all.slice(y.length).map((mean, j) => {
    acc += psi[j] * psi[j]
    const sd = Math.sqrt(f.sigma2 * acc)
    return { mean, lo: mean - z * sd, hi: mean + z * sd }
  })
  return { forecast, fitted }
}

/** KPSS statistic for level stationarity, Bartlett-weighted long-run variance over `lags` lags (forecast::ndiffs: ⌊3√n/13⌋). */
export function kpss(x: number[], lags = Math.trunc((3 * Math.sqrt(x.length)) / 13)): number {
  const n = x.length
  const mean = x.reduce((a, b) => a + b, 0) / n
  const e = x.map((v) => v - mean)
  let s = 0
  let eta = 0
  for (const v of e) {
    s += v
    eta += s * s
  }
  let lrv = e.reduce((a, v) => a + v * v, 0) / n
  for (let l = 1; l <= lags; l++) {
    let g = 0
    for (let t = l; t < n; t++) g += e[t] * e[t - l]
    lrv += (2 * (1 - l / (lags + 1)) * g) / n
  }
  return eta / (n * n * lrv)
}

/** How many differences make the series level-stationary by the KPSS test at 5% (critical value 0.463), at most 2. */
export function ndiffs(x: number[]): number {
  let d = 0
  let cur = x
  while (d < 2 && cur.length > 4 && !cur.every((v) => v === cur[0]) && kpss(cur) > 0.463) {
    cur = difference(cur, 1, 0, 1)
    d++
  }
  return d
}

/**
 * Seasonal strength (Wang, Smith & Hyndman 2006) from a classical decomposition: 1 − Var(remainder) / Var(season +
 * remainder). Above 0.64 the series is seasonally differenced, as auto.arima does.
 */
export function seasonalStrength(x: number[], m: number): number {
  const half = Math.floor(m / 2)
  const trend: (number | null)[] = x.map((_, t) => {
    if (t < half || t >= x.length - half) return null
    let s = 0
    for (let j = -half; j <= half; j++) s += (m % 2 === 0 && Math.abs(j) === half ? 0.5 : 1) * x[t + j]
    return s / m
  })
  const det = x.map((v, t) => (trend[t] === null ? null : v - trend[t]!))
  const idx = Array.from({ length: m }, (_, j) => {
    const vs = det.filter((v, t) => v !== null && t % m === j) as number[]
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0
  })
  const mean = idx.reduce((a, b) => a + b, 0) / m
  const seas = idx.map((v) => v - mean)
  const sr: number[] = []
  const rem: number[] = []
  det.forEach((v, t) => {
    if (v === null) return
    sr.push(v)
    rem.push(v - seas[t % m])
  })
  const variance = (xs: number[]) => {
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length
    return xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length
  }
  const vsr = variance(sr)
  return vsr > 0 ? Math.max(0, 1 - variance(rem) / vsr) : 0
}

export const arimaName = (o: ArimaOrder) => `ARIMA(${o.p},${o.d},${o.q})${o.m > 1 && o.P + o.D + o.Q > 0 ? `(${o.P},${o.D},${o.Q})[${o.m}]` : ''}${o.mean ? (o.d + o.D === 1 ? ' with drift' : ' with mean') : ''}`

/**
 * Stepwise order search (Hyndman & Khandakar 2008): d by KPSS tests, D by seasonal strength, then from four starting
 * models move p, q, P, Q by one (and the mean on/off) while AICc improves. Orders are capped at p, q ≤ 3 and P, Q ≤ 1.
 * The search uses conditional sums of squares (fast); the three best are refitted by exact maximum likelihood.
 */
export function arimaAuto(y: number[], m: number) {
  const seasonal = m > 1 && y.length >= 2 * m + 2
  const D = seasonal && seasonalStrength(y, m) > 0.64 ? 1 : 0
  const d = ndiffs(D ? difference(y, 0, 1, m) : y)
  const fits = new Map<string, (ArimaFit & { x: number[] }) | null>()
  const tryFit = (o: ArimaOrder) => {
    const key = arimaName(o)
    if (!fits.has(key)) fits.set(key, arimaFit(y, o, 'css'))
    return fits.get(key)!
  }
  const ok = (o: ArimaOrder) => o.p >= 0 && o.q >= 0 && o.P >= 0 && o.Q >= 0 && o.p <= 3 && o.q <= 3 && o.P <= (seasonal ? 1 : 0) && o.Q <= (seasonal ? 1 : 0)
  const mean = d + D <= 1
  const base = { d, D, m: seasonal ? m : 1, mean }
  const starts: ArimaOrder[] = [
    { ...base, p: 2, q: 2, P: seasonal ? 1 : 0, Q: seasonal ? 1 : 0 },
    { ...base, p: 0, q: 0, P: 0, Q: 0 },
    { ...base, p: 1, q: 0, P: seasonal ? 1 : 0, Q: 0 },
    { ...base, p: 0, q: 1, P: 0, Q: seasonal ? 1 : 0 }
  ]
  let best: ArimaFit | null = null
  for (const o of starts) {
    const f = tryFit(o)
    if (f && (!best || f.aicc < best.aicc)) best = f
  }
  if (!best) return null
  for (let step = 0; step < 50; step++) {
    const o = best.order
    const moves: Partial<ArimaOrder>[] = [{ p: o.p + 1 }, { p: o.p - 1 }, { q: o.q + 1 }, { q: o.q - 1 }, { p: o.p + 1, q: o.q + 1 }, { p: o.p - 1, q: o.q - 1 }, { P: o.P + 1 }, { P: o.P - 1 }, { Q: o.Q + 1 }, { Q: o.Q - 1 }, { P: o.P + 1, Q: o.Q + 1 }, { P: o.P - 1, Q: o.Q - 1 }, ...(d + D <= 1 ? [{ mean: !o.mean }] : [])]
    let improved = false
    for (const mv of moves) {
      const cand = { ...o, ...mv }
      if (!ok(cand)) continue
      const f = tryFit(cand)
      if (f && f.aicc < best.aicc - 1e-9) {
        best = f
        improved = true
        break
      }
    }
    if (!improved) break
  }
  // The three best by CSS, refitted by exact maximum likelihood (from their CSS estimates); the lowest exact AICc wins.
  const tried = [...fits.values()]
    .filter((f): f is ArimaFit & { x: number[] } => !!f)
    .sort((a, b) => a.aicc - b.aicc)
    .slice(0, 3)
    .map((f) => arimaFit(y, f.order, 'ml', f.x) ?? f)
    .sort((a, b) => a.aicc - b.aicc)
  return { best: tried[0], tried, searched: fits.size }
}

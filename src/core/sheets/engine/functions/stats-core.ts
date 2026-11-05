// Numerical building blocks: order statistics, special functions and probability distributions.
import { ERR, type CellError, type Scalar } from '../values'

export function sorted(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b)
}

export function median(xs: number[]): number | CellError {
  if (!xs.length) return ERR.NUM
  const s = sorted(xs)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Most frequent values in order of first appearance (MODE.MULT); empty if every value is unique. */
export function modes(xs: number[]): number[] {
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best = 1
  for (const c of counts.values()) best = Math.max(best, c)
  if (best < 2) return []
  const out: number[] = []
  for (const x of xs) if (counts.get(x) === best && !out.includes(x)) out.push(x)
  return out
}

export function percentileInc(xs: number[], p: number): number | CellError {
  if (!xs.length || p < 0 || p > 1) return ERR.NUM
  const s = sorted(xs)
  const h = (s.length - 1) * p
  const lo = Math.floor(h)
  return lo + 1 < s.length ? s[lo] + (h - lo) * (s[lo + 1] - s[lo]) : s[lo]
}

export function percentileExc(xs: number[], p: number): number | CellError {
  const n = xs.length
  if (!n || p <= 0 || p >= 1) return ERR.NUM
  const h = (n + 1) * p
  if (h < 1 || h > n) return ERR.NUM
  const s = sorted(xs)
  const lo = Math.floor(h)
  return lo >= n ? s[n - 1] : s[lo - 1] + (h - lo) * (s[lo] - s[lo - 1])
}

export function kth(xs: number[], k: number, largest: boolean): number | CellError {
  const i = Math.ceil(k)
  if (!xs.length || i < 1 || i > xs.length) return ERR.NUM
  const s = sorted(xs)
  return largest ? s[s.length - i] : s[i - 1]
}

export function aggregateStat(name: string, xs: number[], k?: number): Scalar {
  switch (name) {
    case 'MEDIAN':
      return median(xs)
    case 'MODE.SNGL': {
      const m = modes(xs)
      return m.length ? m[0] : ERR.NA
    }
    case 'LARGE':
      return k === undefined ? ERR.VALUE : kth(xs, k, true)
    case 'SMALL':
      return k === undefined ? ERR.VALUE : kth(xs, k, false)
    case 'PERCENTILE.INC':
      return k === undefined ? ERR.VALUE : percentileInc(xs, k)
    case 'PERCENTILE.EXC':
      return k === undefined ? ERR.VALUE : percentileExc(xs, k)
    case 'QUARTILE.INC':
      return k === undefined || k < 0 || k > 4 ? ERR.NUM : percentileInc(xs, Math.trunc(k) / 4)
    case 'QUARTILE.EXC':
      return k === undefined || k <= 0 || k >= 4 ? ERR.NUM : percentileExc(xs, Math.trunc(k) / 4)
  }
  return ERR.VALUE
}

// ---------- special functions ----------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]

export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x)
  x -= 1
  let a = LANCZOS[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

export function gamma(x: number): number {
  if (Number.isInteger(x) && x <= 0) return NaN
  if (Number.isInteger(x) && x <= 171) {
    let r = 1
    for (let i = 2; i < x; i++) r *= i
    return r
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x))
  return Math.exp(lnGamma(x))
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0
  if (x < a + 1) {
    let sum = 1 / a
    let del = sum
    for (let n = 1; n < 1000; n++) {
      del *= x / (a + n)
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a))
  }
  return 1 - gammaQcf(a, x)
}

function gammaQcf(a: number, x: number): number {
  let b = x + 1 - a
  let c = 1 / 1e-300
  let d = 1 / b
  let h = d
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-300) d = 1e-300
    c = b + an / c
    if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-16) break
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h
}

export const lnBeta = (a: number, b: number) => lnGamma(a) + lnGamma(b) - lnGamma(a + b)

/** Regularized incomplete beta I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta(a, b))
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCf(x, a, b)) / a
  return 1 - (bt * betaCf(1 - x, b, a)) / b
}

function betaCf(x: number, a: number, b: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < 1e-300) d = 1e-300
  d = 1 / d
  let h = d
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-300) d = 1e-300
    c = 1 + aa / c
    if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-300) d = 1e-300
    c = 1 + aa / c
    if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-16) break
  }
  return h
}

export function erf(x: number): number {
  // erf via the incomplete gamma function: erf(x) = sign(x)·P(1/2, x²)
  if (x === 0) return 0
  const r = gammaP(0.5, x * x)
  return x < 0 ? -r : r
}

export function erfc(x: number): number {
  if (x < 0.5) return 1 - erf(x)
  return gammaQcf(0.5, x * x)
}

export const normCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2)
export const normPdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)

/** Inverse standard normal (Acklam's algorithm, refined with one Halley step). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) return NaN
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  let x: number
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= 1 - lo) {
    const q = p - 0.5
    const r = q * q
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const e = normCdf(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

/** Invert a monotone increasing CDF on [lo, hi] by bisection + secant. */
export function invert(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  // Grow the bracket if needed.
  let a = lo
  let b = hi
  for (let i = 0; i < 200 && cdf(b) < p; i++) b = b * 2 + 1
  for (let i = 0; i < 200 && cdf(a) > p && a > -1e300; i++) a = a < 0 ? a * 2 - 1 : a / 2 - (a === 0 ? 1 : 0)
  for (let i = 0; i < 300; i++) {
    const m = (a + b) / 2
    const v = cdf(m)
    if (Math.abs(v - p) < 1e-15 || b - a < 1e-15 * Math.max(1, Math.abs(m))) return m
    if (v < p) a = m
    else b = m
  }
  return (a + b) / 2
}

export const tCdf = (t: number, df: number) => {
  const x = df / (df + t * t)
  const tail = 0.5 * betaI(x, df / 2, 0.5)
  return t >= 0 ? 1 - tail : tail
}
export const tPdf = (t: number, df: number) => Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (t * t) / df))
export const chiCdf = (x: number, df: number) => (x <= 0 ? 0 : gammaP(df / 2, x / 2))
export const chiPdf = (x: number, df: number) => (x < 0 ? 0 : x === 0 ? (df === 2 ? 0.5 : df < 2 ? Infinity : 0) : Math.exp((df / 2 - 1) * Math.log(x) - x / 2 - (df / 2) * Math.log(2) - lnGamma(df / 2)))
export const fCdf = (x: number, d1: number, d2: number) => (x <= 0 ? 0 : betaI((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2))
export const fPdf = (x: number, d1: number, d2: number) => (x < 0 ? 0 : Math.exp(0.5 * (d1 * Math.log(d1 * x) + d2 * Math.log(d2) - (d1 + d2) * Math.log(d1 * x + d2)) - Math.log(x) - lnBeta(d1 / 2, d2 / 2)))
export const gammaCdf = (x: number, a: number, b: number) => (x <= 0 ? 0 : gammaP(a, x / b))
export const gammaPdf = (x: number, a: number, b: number) => (x < 0 ? 0 : x === 0 ? (a === 1 ? 1 / b : a < 1 ? Infinity : 0) : Math.exp((a - 1) * Math.log(x) - x / b - lnGamma(a) - a * Math.log(b)))
export const betaPdf = (x: number, a: number, b: number) => (x < 0 || x > 1 ? 0 : Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnBeta(a, b)))
export const binomPmf = (k: number, n: number, p: number) => Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p))
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0
  if (k >= n) return 1
  return 1 - betaI(p, k + 1, n - k)
}

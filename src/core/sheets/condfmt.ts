// Conditional formatting: rules per sheet, evaluated for the cells on screen.
import type { Node } from './engine/parser'
import { evaluate, finalValue } from './engine/evaluate'
import { CellError, ERR, compareScalars, isArray, type Area, type Scalar } from './engine/values'
import type { Engine } from './engine/engine'
import type { Sheet } from './model/workbook'
import type { Style } from './model/styles'

export type CfType =
  | 'cellIs'
  | 'expression'
  | 'colorScale'
  | 'dataBar'
  | 'iconSet'
  | 'top10'
  | 'aboveAverage'
  | 'duplicateValues'
  | 'uniqueValues'
  | 'containsText'
  | 'notContainsText'
  | 'beginsWith'
  | 'endsWith'
  | 'containsBlanks'
  | 'notContainsBlanks'
  | 'containsErrors'
  | 'notContainsErrors'
  | 'timePeriod'

export type CfOperator = 'between' | 'notBetween' | 'equal' | 'notEqual' | 'greaterThan' | 'lessThan' | 'greaterThanOrEqual' | 'lessThanOrEqual'

/** A threshold of a colour scale, data bar or icon set. `val` is a number or a formula (without "="). */
export interface Cfvo {
  type: 'num' | 'percent' | 'max' | 'min' | 'formula' | 'percentile' | 'autoMin' | 'autoMax'
  val?: string
  /** Icon sets: the value must be ≥ (true, default) or > the threshold. */
  gte?: boolean
}

export interface CfRule {
  /** Stable id within the workbook session (for the Manage Rules dialog). */
  id: number
  type: CfType
  priority: number
  stopIfTrue?: boolean
  /** Formatting applied when the rule is true (only the properties it sets). */
  dxf?: Style
  operator?: CfOperator
  /** Formulas, relative to the top-left cell of the first range. */
  formulas?: Node[]
  text?: string
  rank?: number
  percent?: boolean
  bottom?: boolean
  aboveAverage?: boolean
  equalAverage?: boolean
  stdDev?: number
  timePeriod?: string
  colorScale?: { cfvo: Cfvo[]; colors: string[] }
  dataBar?: { cfvo: [Cfvo, Cfvo]; color: string; showValue?: boolean; minLength?: number; maxLength?: number }
  iconSet?: { set: string; cfvo: Cfvo[]; reverse?: boolean; showValue?: boolean }
  /** File details kept for round trips (dxf index and the dxf as read, x14 extension link). */
  carry?: { dxfId?: number; dxfKey?: string; ext?: string; attrs?: string }
}

export interface CondFormat {
  ranges: Area[]
  rules: CfRule[]
  pivot?: boolean
}

export interface CfResult {
  style?: Style
  bar?: { w: number; color: string }
  icon?: { set: string; i: number }
  hide?: boolean
}

let nextId = 1
export const newRuleId = () => nextId++

export const ICON_COUNTS: Record<string, number> = {
  '3Arrows': 3, '3ArrowsGray': 3, '3Flags': 3, '3TrafficLights1': 3, '3TrafficLights2': 3, '3Signs': 3, '3Symbols': 3, '3Symbols2': 3, '3Stars': 3, '3Triangles': 3,
  '4Arrows': 4, '4ArrowsGray': 4, '4RedToBlack': 4, '4Rating': 4, '4TrafficLights': 4,
  '5Arrows': 5, '5ArrowsGray': 5, '5Rating': 5, '5Quarters': 5, '5Boxes': 5
}

const contains = (a: Area, r: number, c: number) => r >= a.r0 && r <= a.r1 && c >= a.c0 && c <= a.c1

interface Stats {
  nums: number[]
  sorted: number[]
  min: number
  max: number
  avg: number
  sd: number
  counts: Map<string, number>
}

const dupKey = (v: Scalar) => (v === null || v === '' ? null : typeof v === 'string' ? 's' + v.toLowerCase() : typeof v === 'number' ? 'n' + v : typeof v === 'boolean' ? 'b' + v : 'e' + (v as CellError).code)

/** Evaluates a sheet's rules; stats over whole ranges are cached until the workbook changes. */
export class CfEvaluator {
  private cache = new WeakMap<CfRule, { version: number; stats: Stats; thresholds?: number[] }>()

  constructor(
    private engine: Engine,
    private version: () => number
  ) {}

  private value(sh: Sheet, r: number, c: number): Scalar {
    return sh.get(r, c)?.v ?? null
  }

  private evalAt(ast: Node, sheet: number, r: number, c: number): Scalar {
    try {
      const ctx = this.engine.contextAt(sheet, r, c)
      const v = finalValue(evaluate(ast, ctx), ctx, false)
      return isArray(v) ? (v.data[0] ?? null) : v
    } catch {
      return ERR.VALUE
    }
  }

  private stats(rule: CfRule, block: CondFormat, sh: Sheet): Stats {
    const v = this.version()
    const hit = this.cache.get(rule)
    if (hit && hit.version === v) return hit.stats
    const nums: number[] = []
    const counts = new Map<string, number>()
    const seen = new Set<number>()
    for (const a of block.ranges)
      sh.forEachIn(a, (r, c, cell) => {
        const k = r * 16384 + c
        if (seen.has(k)) return
        seen.add(k)
        if (typeof cell.v === 'number') nums.push(cell.v)
        const d = dupKey(cell.v)
        if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
      })
    const sorted = [...nums].sort((a, b) => a - b)
    const avg = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : 0
    // ponytail: population standard deviation for "n std dev above/below"; switch to sample if Excel files disagree.
    const sd = nums.length ? Math.sqrt(nums.reduce((s, x) => s + (x - avg) ** 2, 0) / nums.length) : 0
    const stats = { nums, sorted, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, avg, sd, counts }
    this.cache.set(rule, { version: v, stats })
    return stats
  }

  private threshold(cfvo: Cfvo, st: Stats, sheet: number, anchor: Area): number {
    const num = (): number => {
      const s = cfvo.val ?? '0'
      const n = Number(s)
      if (s.trim() !== '' && Number.isFinite(n)) return n
      const ast = this.parse(s, sheet, anchor)
      const v = ast ? this.evalAt(ast, sheet, anchor.r0, anchor.c0) : null
      return typeof v === 'number' ? v : 0
    }
    switch (cfvo.type) {
      case 'min':
      case 'autoMin':
        return cfvo.type === 'autoMin' ? Math.min(0, st.min) : st.min
      case 'max':
      case 'autoMax':
        return cfvo.type === 'autoMax' ? Math.max(0, st.max) : st.max
      case 'percent':
        return st.min + ((st.max - st.min) * num()) / 100
      case 'percentile': {
        const p = Math.min(1, Math.max(0, num() / 100))
        const s = st.sorted
        if (!s.length) return 0
        const h = (s.length - 1) * p
        const lo = Math.floor(h)
        return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]) - s[lo])
      }
      default:
        return num()
    }
  }

  private parsed = new Map<string, Node | null>()
  private parse(text: string, sheet: number, anchor: Area): Node | null {
    const key = `${sheet}:${anchor.r0}:${anchor.c0}:${text}`
    if (!this.parsed.has(key)) {
      try {
        this.parsed.set(key, this.engine.parseAt(text, sheet, anchor.r0, anchor.c0))
      } catch {
        this.parsed.set(key, null)
      }
    }
    return this.parsed.get(key)!
  }

  /** Whether a formatting (dxf) rule is true for the cell. */
  private test(rule: CfRule, block: CondFormat, sh: Sheet, r: number, c: number): boolean {
    const v = this.value(sh, r, c)
    const f = (i: number) => (rule.formulas?.[i] ? this.evalAt(rule.formulas[i], sh.id, r, c) : null)
    const truthy = (x: Scalar) => (typeof x === 'boolean' ? x : typeof x === 'number' ? x !== 0 : false)
    switch (rule.type) {
      case 'cellIs': {
        if (v instanceof CellError) return false
        const a = f(0)
        if (a instanceof CellError) return false
        const cmp = (x: Scalar) => compareScalars(v, x)
        switch (rule.operator) {
          case 'between':
          case 'notBetween': {
            const b = f(1)
            if (b instanceof CellError) return false
            const [lo, hi] = compareScalars(a, b) <= 0 ? [a, b] : [b, a]
            const inside = cmp(lo) >= 0 && cmp(hi) <= 0
            return rule.operator === 'between' ? inside : !inside
          }
          case 'equal':
            return cmp(a) === 0
          case 'notEqual':
            return cmp(a) !== 0
          case 'greaterThan':
            return cmp(a) > 0
          case 'lessThan':
            return cmp(a) < 0
          case 'greaterThanOrEqual':
            return cmp(a) >= 0
          case 'lessThanOrEqual':
            return cmp(a) <= 0
          default:
            return false
        }
      }
      case 'top10': {
        if (typeof v !== 'number') return false
        const st = this.stats(rule, block, sh)
        const n = st.sorted.length
        if (!n) return false
        let k = Math.max(1, Math.floor(rule.rank ?? 10))
        if (rule.percent) k = Math.max(1, Math.floor((n * (rule.rank ?? 10)) / 100))
        k = Math.min(k, n)
        return rule.bottom ? v <= st.sorted[k - 1] : v >= st.sorted[n - k]
      }
      case 'aboveAverage': {
        if (typeof v !== 'number') return false
        const st = this.stats(rule, block, sh)
        const above = rule.aboveAverage !== false
        const lim = st.avg + (above ? 1 : -1) * (rule.stdDev ?? 0) * st.sd
        if (rule.equalAverage) return above ? v >= lim : v <= lim
        return above ? v > lim : v < lim
      }
      case 'duplicateValues':
      case 'uniqueValues': {
        const k = dupKey(v)
        if (!k) return false
        const n = this.stats(rule, block, sh).counts.get(k) ?? 0
        return rule.type === 'duplicateValues' ? n > 1 : n === 1
      }
      case 'containsBlanks':
      case 'notContainsBlanks':
      case 'containsErrors':
      case 'notContainsErrors':
        if (!rule.formulas?.length) {
          const blank = v === null || (typeof v === 'string' && v.trim() === '')
          const err = v instanceof CellError
          return rule.type === 'containsBlanks' ? blank : rule.type === 'notContainsBlanks' ? !blank : rule.type === 'containsErrors' ? err : !err
        }
        return truthy(f(0))
      case 'containsText':
      case 'notContainsText':
      case 'beginsWith':
      case 'endsWith':
        if (!rule.formulas?.length) {
          const t = (v === null ? '' : v instanceof CellError ? v.code : String(v)).toLowerCase()
          const q = (rule.text ?? '').toLowerCase()
          return rule.type === 'containsText' ? t.includes(q) : rule.type === 'notContainsText' ? !t.includes(q) : rule.type === 'beginsWith' ? t.startsWith(q) : t.endsWith(q)
        }
        return truthy(f(0))
      default:
        return truthy(f(0))
    }
  }

  private scale(rule: CfRule, block: CondFormat, sh: Sheet): number[] {
    const st = this.stats(rule, block, sh)
    const hit = this.cache.get(rule)!
    if (!hit.thresholds) {
      const list = rule.colorScale?.cfvo ?? rule.dataBar?.cfvo ?? rule.iconSet?.cfvo ?? []
      hit.thresholds = list.map((x) => this.threshold(x, st, sh.id, block.ranges[0]))
    }
    return hit.thresholds
  }

  /** Conditional formatting for every cell of `win` that has any. Keys are r * 16384 + c. */
  forArea(sh: Sheet, blocks: CondFormat[], win: Area): Map<number, CfResult> {
    const out = new Map<number, CfResult>()
    const relevant = blocks.filter((b) => b.ranges.some((a) => a.r1 >= win.r0 && a.r0 <= win.r1 && a.c1 >= win.c0 && a.c0 <= win.c1))
    if (!relevant.length) return out
    const rules = relevant.flatMap((b) => b.rules.map((rule) => ({ rule, block: b }))).sort((x, y) => x.rule.priority - y.rule.priority)
    const u = sh.used()
    for (const { rule, block } of rules) {
      for (const a of block.ranges) {
        // Empty cells beyond the used area only matter to rules that can be true for blanks.
        const blankOk = rule.type === 'expression' || rule.type === 'containsBlanks' || rule.type === 'notContainsErrors' || rule.type === 'cellIs' || rule.type === 'notContainsText' || rule.type === 'timePeriod'
        const r1 = Math.min(a.r1, win.r1, blankOk ? win.r1 : u.r)
        const c1 = Math.min(a.c1, win.c1, blankOk ? win.c1 : u.c)
        for (let r = Math.max(a.r0, win.r0); r <= r1; r++)
          for (let c = Math.max(a.c0, win.c0); c <= c1; c++) {
            const k = r * 16384 + c
            // A cell in two ranges of one block is evaluated once.
            if (block.ranges.some((b) => b !== a && block.ranges.indexOf(b) < block.ranges.indexOf(a) && contains(b, r, c))) continue
            let res = out.get(k)
            if (res && (res as CfResult & { stop?: boolean }).stop) continue
            const apply = (fn: (x: CfResult) => void) => {
              if (!res) out.set(k, (res = {}))
              fn(res)
            }
            if (rule.type === 'colorScale' || rule.type === 'dataBar' || rule.type === 'iconSet') {
              const v = this.value(sh, r, c)
              if (typeof v !== 'number') continue
              const t = this.scale(rule, block, sh)
              if (rule.colorScale && !res?.style?.fill) {
                const color = scaleColor(v, t, rule.colorScale.colors)
                if (color) apply((x) => (x.style = { ...x.style, fill: color }))
              } else if (rule.dataBar && !res?.bar) {
                const [lo, hi] = t
                const frac = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : v >= hi ? 1 : 0
                const minL = (rule.dataBar.minLength ?? 10) / 100
                const maxL = (rule.dataBar.maxLength ?? 90) / 100
                apply((x) => {
                  x.bar = { w: minL + (maxL - minL) * frac, color: rule.dataBar!.color }
                  if (rule.dataBar!.showValue === false) x.hide = true
                })
              } else if (rule.iconSet && !res?.icon) {
                const set = rule.iconSet
                const n = ICON_COUNTS[set.set] ?? set.cfvo.length
                let i = 0
                for (let j = 1; j < set.cfvo.length; j++) if (set.cfvo[j].gte === false ? v > t[j] : v >= t[j]) i = j
                if (set.reverse) i = n - 1 - i
                apply((x) => {
                  x.icon = { set: set.set, i }
                  if (set.showValue === false) x.hide = true
                })
              }
              continue
            }
            if (!this.test(rule, block, sh, r, c)) continue
            apply((x) => {
              if (rule.dxf) {
                const merged: Style = { ...rule.dxf, ...x.style }
                x.style = merged
              }
              if (rule.stopIfTrue) (x as CfResult & { stop?: boolean }).stop = true
            })
          }
      }
    }
    for (const r of out.values()) delete (r as CfResult & { stop?: boolean }).stop
    return out
  }
}

function hexToRgb(h: string): [number, number, number] {
  const x = h.replace('#', '')
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]
}

/** Colour of a value on a 2- or 3-colour scale with thresholds `t`. */
export function scaleColor(v: number, t: number[], colors: string[]): string | null {
  if (t.length < 2 || colors.length < t.length) return null
  if (v <= t[0]) return colors[0]
  if (v >= t[t.length - 1]) return colors[t.length - 1]
  let i = 0
  while (i < t.length - 2 && v > t[i + 1]) i++
  const span = t[i + 1] - t[i]
  const f = span > 0 ? (v - t[i]) / span : 0
  const a = hexToRgb(colors[i])
  const b = hexToRgb(colors[i + 1])
  return '#' + a.map((x, k) => Math.round(x + (b[k] - x) * f).toString(16).padStart(2, '0')).join('')
}


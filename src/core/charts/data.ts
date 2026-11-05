// What a chart plugin receives: the compiled query's fields and rows, formatting, and the theme.

import type { ChartOptions } from '../../shared/charts'
import type { OutField } from '../query/compile'
import { formatValue } from '../sheets/numfmt/format'

export type Value = string | number | boolean | null

export interface Theme {
  dark: boolean
  text: string
  text2: string
  grid: string
  axis: string
  bg: string
  font: string
  palette: string[]
  seq: [string, string]
  accent: string
}

export interface ChartData {
  fields: OutField[]
  rows: Value[][]
  /** More rows exist than were drawn (the mark limit). */
  truncated: boolean
  options: ChartOptions
  /** Values selected by a dashboard action, keyed by field name: other marks are dimmed. */
  highlight?: Record<string, Value[]>
}

export const LIGHT: Theme = { dark: false, text: '#17171c', text2: '#55555f', grid: '#ececf0', axis: '#d6d6dc', bg: 'transparent', font: 'Inter Variable, system-ui, sans-serif', palette: ['#2f6fde', '#e8662a', '#1b9e77', '#c23f8c', '#7a46c9', '#b8860b', '#2697a6', '#d1414b'], seq: ['#fde7d8', '#9a3412'], accent: '#c2410c' }

/** Column index of a field key (d0, m1…). */
export const col = (d: ChartData, key: string) => d.fields.findIndex((f) => f.key === key)

export const dims = (d: ChartData, role?: OutField['role']) => d.fields.filter((f) => f.kind === 'dim' && (!role || f.role === role))
export const measures = (d: ChartData, role?: OutField['role']) => d.fields.filter((f) => f.kind === 'measure' && (!role || f.role === role))

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** A value for display: with the field's number format when it has one; dates as dates. */
export function fmt(v: Value, f?: OutField, mode: 'axis' | 'full' = 'full'): string {
  if (v === null || v === undefined) return 'Null'
  if (typeof v === 'number') {
    if (f?.ref.format) return formatValue(v, f.ref.format).text
    if (f?.ref.quick === 'pct_total' || f?.ref.quick === 'pct_diff_prev' || f?.ref.quick === 'yoy') return `${(v * 100).toFixed(1)}%`
    return mode === 'axis' && Math.abs(v) >= 10_000 ? compact.format(v) : full.format(v)
  }
  if (typeof v === 'string' && f && /^(DATE|TIMESTAMP)/.test(f.type) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.slice(0, 10).split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    switch (f.ref.grain) {
      case 'year':
        return String(y)
      case 'quarter':
        return `Q${Math.floor((m - 1) / 3) + 1} ${y}`
      case 'month':
        return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
      default:
        return v.length > 10 && f.ref.grain === 'hour' ? `${v.slice(0, 10)} ${v.slice(11, 16)}` : date.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    }
  }
  return String(v)
}

/** HTML-escapes text that ECharts puts into tooltips (data values are untrusted). */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * Long data → category × series matrix, keeping the order of first appearance (the query's sort order).
 * `seriesKey` null: one series per measure.
 */
export function pivot(d: ChartData, catKey: string | null, seriesKey: string | null, valueKeys: string[]) {
  const ci = catKey ? col(d, catKey) : -1
  const si = seriesKey ? col(d, seriesKey) : -1
  const cats: Value[] = []
  const catIdx = new Map<string, number>()
  const series: { name: string; key: Value; measure: string; values: (number | null)[] }[] = []
  const seriesIdx = new Map<string, number>()
  const k = (v: Value) => (v === null ? '\u0000null' : String(v))
  for (const row of d.rows) {
    const c = ci >= 0 ? row[ci] : ''
    if (!catIdx.has(k(c))) {
      catIdx.set(k(c), cats.length)
      cats.push(c)
    }
  }
  for (const row of d.rows) {
    const c = catIdx.get(k(ci >= 0 ? row[ci] : ''))!
    for (const vk of valueKeys) {
      const vf = d.fields.find((f) => f.key === vk)!
      const sv = si >= 0 ? row[si] : null
      const name = si >= 0 ? (valueKeys.length > 1 ? `${fmt(sv, d.fields[si])} · ${vf.title}` : fmt(sv, d.fields[si])) : vf.title
      const id = `${k(sv)}|${vk}`
      if (!seriesIdx.has(id)) {
        seriesIdx.set(id, series.length)
        series.push({ name, key: sv, measure: vk, values: new Array(cats.length).fill(null) })
      }
      const v = row[col(d, vk)]
      series[seriesIdx.get(id)!].values[c] = typeof v === 'number' ? v : v === null ? null : Number(v)
    }
  }
  return { cats, series }
}

/** Whether a row (or a category value) is outside the current highlight. */
export function dimmed(d: ChartData, row: Value[]): boolean {
  if (!d.highlight) return false
  return Object.entries(d.highlight).some(([field, vals]) => {
    const i = d.fields.findIndex((f) => f.kind === 'dim' && f.ref.field === field)
    return i >= 0 && !vals.some((v) => String(v) === String(row[i]))
  })
}

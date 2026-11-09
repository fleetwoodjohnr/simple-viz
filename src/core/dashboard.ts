// Dashboard logic without UI: which filters reach which chart, cross-filtering and highlighting from clicks,
// dynamic titles, and layout helpers (snap, align, distribute, templates).

import type { ChartFilter } from '../shared/charts'
import { GRID, type DashAction, type DashItem, type Dashboard, type Selections } from '../shared/dashboards'
import { isSafeExternalUrl } from '../shared/urls'

type Value = string | number | boolean | null

/** A click on a mark: the chart tile it came from and the dimension values of the mark. */
export interface MarkSelection {
  item: string
  values: Record<string, Value>
}

/** Fields a chart's data has (columns and calculated fields), lower case. */
export type FieldIndex = (itemId: string) => Set<string>

/**
 * The filters a chart tile receives from the dashboard: filter controls (every chart whose data has the field),
 * and the marks selected in other charts through filter actions. The clicked chart itself is not filtered.
 */
export function tileFilters(d: Dashboard, itemId: string, fieldsOf: FieldIndex, selections: Selections, marks: MarkSelection[]): ChartFilter[] {
  const fields = fieldsOf(itemId)
  const out: ChartFilter[] = []
  for (const [field, sel] of Object.entries(selections)) {
    if (!fields.has(field.toLowerCase())) continue
    if (sel.values) out.push({ id: `dash:${field}`, field, op: 'in', values: sel.values })
    else if ((sel.min ?? null) !== null || (sel.max ?? null) !== null) out.push({ id: `dash:${field}`, field, op: 'between', min: sel.min ?? null, max: sel.max ?? null })
  }
  for (const m of marks) {
    if (m.item === itemId) continue
    const a = actionFor(d, m.item, itemId, 'filter')
    if (!a) continue
    for (const [field, v] of Object.entries(m.values)) {
      if ((a.fields?.length && !a.fields.includes(field)) || !fields.has(field.toLowerCase())) continue
      out.push({ id: `mark:${m.item}:${field}`, field, op: 'in', values: [v] })
    }
  }
  return out
}

/** Values to highlight in a tile (highlight actions): other marks are dimmed. */
export function tileHighlight(d: Dashboard, itemId: string, fieldsOf: FieldIndex, marks: MarkSelection[]): Record<string, Value[]> | undefined {
  const out: Record<string, Value[]> = {}
  const fields = fieldsOf(itemId)
  for (const m of marks) {
    const a = m.item === itemId ? actionFor(d, m.item, itemId, 'filter') ?? actionFor(d, m.item, itemId, 'highlight') : actionFor(d, m.item, itemId, 'highlight')
    if (!a) continue
    for (const [field, v] of Object.entries(m.values)) if (fields.has(field.toLowerCase()) && (!a.fields?.length || a.fields.includes(field))) (out[field] ??= []).push(v)
  }
  return Object.keys(out).length ? out : undefined
}

function actionFor(d: Dashboard, source: string, target: string, kind: DashAction['kind']): DashAction | undefined {
  return d.actions.find((a) => a.kind === kind && (a.source === '*' || a.source === source) && (a.target === '*' || a.target === target || (source === target && kind !== 'highlight')))
}

/** A navigate action for clicks in this tile (drill-through to another dashboard). */
export function navigateAction(d: Dashboard, source: string): DashAction | undefined {
  return d.actions.find((a) => a.kind === 'navigate' && (a.source === '*' || a.source === source))
}

/** The web address of a URL action for a clicked mark, or null when it isn't a web or email address. */
export function actionUrl(template: string, values: Record<string, unknown>): string | null {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  const url = template.trim().replace(/\{([^{}]+)\}|<([^<>]+)>/g, (m, a: string | undefined, b: string | undefined) => {
    const k = (a ?? b ?? '').trim().toLowerCase()
    return lower.has(k) ? encodeURIComponent(String(lower.get(k) ?? '')) : m
  })
  return isSafeExternalUrl(url) ? url : null
}

/** Toggles a mark: clicking the selected mark again clears it; clicking another replaces the tile's selection. */
export function toggleMark(marks: MarkSelection[], m: MarkSelection): MarkSelection[] {
  const same = marks.find((x) => x.item === m.item && JSON.stringify(x.values) === JSON.stringify(m.values))
  const others = marks.filter((x) => x.item !== m.item)
  return same ? others : [...others, m]
}

/** Dynamic text: {field} becomes the current selection of that field ("All" when nothing is selected). */
export function dynamicText(text: string, selections: Selections, marks: MarkSelection[]): string {
  return text.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const field = name.trim()
    const mark = marks.find((m) => field in m.values)
    if (mark) return String(mark.values[field] ?? 'Null')
    const sel = Object.entries(selections).find(([k]) => k.toLowerCase() === field.toLowerCase())?.[1]
    if (sel?.values?.length) return sel.values.length <= 3 ? sel.values.map((v) => String(v ?? 'Null')).join(', ') : `${sel.values.length} values`
    if (sel && (sel.min != null || sel.max != null)) return `${sel.min ?? '…'} – ${sel.max ?? '…'}`
    return 'All'
  })
}

// ---------------------------------------------------------------- layout

export const snap = (v: number) => Math.round(v / GRID) * GRID

/** Keeps an item on the canvas and at least 2 grid cells large. */
export function clampItem(it: DashItem, w: number, h: number): DashItem {
  const iw = Math.max(GRID * 2, Math.min(it.w, w))
  const ih = Math.max(GRID * 2, Math.min(it.h, h))
  return { ...it, w: iw, h: ih, x: Math.max(0, Math.min(it.x, w - iw)), y: Math.max(0, Math.min(it.y, h - ih)) }
}

export type Align = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export function align(items: DashItem[], how: Align): DashItem[] {
  if (items.length < 2) return items
  const l = Math.min(...items.map((i) => i.x))
  const r = Math.max(...items.map((i) => i.x + i.w))
  const t = Math.min(...items.map((i) => i.y))
  const b = Math.max(...items.map((i) => i.y + i.h))
  return items.map((i) => {
    switch (how) {
      case 'left':
        return { ...i, x: l }
      case 'right':
        return { ...i, x: r - i.w }
      case 'center':
        return { ...i, x: snap((l + r) / 2 - i.w / 2) }
      case 'top':
        return { ...i, y: t }
      case 'bottom':
        return { ...i, y: b - i.h }
      default:
        return { ...i, y: snap((t + b) / 2 - i.h / 2) }
    }
  })
}

/** Equal gaps between items, horizontally or vertically (the outermost items stay put). */
export function distribute(items: DashItem[], axis: 'h' | 'v'): DashItem[] {
  if (items.length < 3) return items
  const pos = axis === 'h' ? 'x' : 'y'
  const size = axis === 'h' ? 'w' : 'h'
  const sorted = [...items].sort((a, b) => a[pos] - b[pos])
  const start = sorted[0][pos]
  const end = sorted[sorted.length - 1][pos] + sorted[sorted.length - 1][size]
  const gap = (end - start - sorted.reduce((a, i) => a + i[size], 0)) / (sorted.length - 1)
  let at = start
  const moved = new Map<string, number>()
  for (const i of sorted) {
    moved.set(i.id, snap(at))
    at += i[size] + gap
  }
  return items.map((i) => ({ ...i, [pos]: moved.get(i.id)! }))
}

/** Children of a layout container, laid out in a row or column with equal shares. */
export function layoutContainer(c: DashItem, children: DashItem[]): DashItem[] {
  const dir = c.container?.direction ?? 'row'
  const gap = c.container?.gap ?? GRID
  const n = children.length
  if (!n) return []
  const span = (dir === 'row' ? c.w : c.h) - gap * (n - 1)
  const each = span / n
  return children.map((ch, i) => (dir === 'row' ? { ...ch, x: c.x + i * (each + gap), y: c.y, w: each, h: c.h } : { ...ch, x: c.x, y: c.y + i * (each + gap), w: c.w, h: each }))
}

export interface Template {
  id: string
  label: string
  make: (w: number, h: number, charts: string[]) => Omit<DashItem, 'id'>[]
}

/** Starting layouts for a new dashboard: a title, KPI tiles, and chart slots. */
const RAW_TEMPLATES: Template[] = [
  {
    id: 'kpi-2',
    label: 'KPIs over two charts',
    make: (w, h, charts) => {
      const pad = 16
      const title: Omit<DashItem, 'id'> = { kind: 'text', x: pad, y: pad, w: w - 2 * pad, h: 40, text: 'Dashboard', textStyle: { size: 22, bold: true } }
      const kpiH = 120
      const kpiW = (w - 2 * pad - 2 * pad) / 3
      const kpis = [0, 1, 2].map((i): Omit<DashItem, 'id'> => ({ kind: 'chart', x: pad + i * (kpiW + pad), y: 72, w: kpiW, h: kpiH, chartId: charts[2 + i] }))
      const top = 72 + kpiH + pad
      const half = (w - 3 * pad) / 2
      return [title, ...kpis, { kind: 'chart', x: pad, y: top, w: half, h: h - top - pad, chartId: charts[0] }, { kind: 'chart', x: 2 * pad + half, y: top, w: half, h: h - top - pad, chartId: charts[1] }]
    }
  },
  {
    id: 'grid-4',
    label: 'Four charts',
    make: (w, h, charts) => {
      const pad = 16
      const cw = (w - 3 * pad) / 2
      const ch = (h - 3 * pad - 48) / 2
      return [{ kind: 'text', x: pad, y: pad, w: w - 2 * pad, h: 32, text: 'Dashboard', textStyle: { size: 20, bold: true } }, ...[0, 1, 2, 3].map((i): Omit<DashItem, 'id'> => ({ kind: 'chart', x: pad + (i % 2) * (cw + pad), y: 48 + pad + Math.floor(i / 2) * (ch + pad), w: cw, h: ch, chartId: charts[i] }))]
    }
  },
  {
    id: 'focus',
    label: 'One large chart with filters',
    make: (w, h, charts) => {
      const pad = 16
      return [
        { kind: 'text', x: pad, y: pad, w: w - 280 - 3 * pad, h: 40, text: 'Dashboard', textStyle: { size: 22, bold: true } },
        { kind: 'chart', x: pad, y: 72, w: w - 280 - 3 * pad, h: h - 72 - pad, chartId: charts[0] },
        { kind: 'chart', x: w - 280 - pad, y: 72, w: 280, h: 140, chartId: charts[1] }
      ]
    }
  }
]

export const TEMPLATES: Template[] = RAW_TEMPLATES.map((t) => ({ ...t, make: (w, h, charts) => t.make(w, h, charts).map((i) => ({ ...i, x: snap(i.x), y: snap(i.y), w: snap(i.w), h: snap(i.h) })) }))

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where a new w × h object goes: the first free spot scanning rows top to bottom, left to right (16 px apart from
 * others). If nothing fits, the object shrinks step by step; as a last resort it goes to the top left.
 */
export function findSlot(items: DashItem[], w: number, h: number, cw: number, ch: number, pad = 16): { x: number; y: number; w: number; h: number } {
  const taken = items.filter((i) => !i.parent && i.kind !== 'shape' && i.kind !== 'container').map((i) => ({ x: i.x - pad, y: i.y - pad, w: i.w + 2 * pad, h: i.h + 2 * pad }))
  for (let scale = 1; scale >= 0.4; scale -= 0.15) {
    const sw = snap(Math.min(w * scale, cw - 2 * pad))
    const sh = snap(Math.min(h * scale, ch - 2 * pad))
    for (let y = pad; y + sh <= ch - pad; y += GRID * 2)
      for (let x = pad; x + sw <= cw - pad; x += GRID * 2) {
        const r = { x: snap(x), y: snap(y), w: sw, h: sh }
        if (!taken.some((t) => overlaps(r, t))) return r
      }
  }
  return { x: pad, y: pad, w: snap(Math.min(w, cw - 2 * pad)), h: snap(Math.min(h, ch - 2 * pad)) }
}

// Dashboard logic without UI: which filters reach which chart, cross-filtering and highlighting from clicks,
// dynamic titles, and layout helpers (snap, align, distribute, templates).

import type { ChartFilter } from '../shared/charts'
import { GRID, type DashAction, type DashItem, type Dashboard, type Device, type DeviceLayout, type Selections } from '../shared/dashboards'
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

// ---------------------------------------------------------------- tiled layout, device layouts

const geometry = (i: { x: number; y: number; w: number; h: number }) => ({ x: i.x, y: i.y, w: i.w, h: i.h })
/** Items laid out on their own (not inside a container, not floating, not decoration). */
const tileable = (i: DashItem) => !i.parent && !i.floating && i.kind !== 'shape'

/**
 * Tiled layout (Tableau's tiled objects): the items fill the dashboard in rows, in reading order, without overlapping.
 * Rows are items whose vertical centres fall within the first item's band; each row's height and each item's width are
 * kept as proportions of the current ones, so moving an item reorders it and resizing one gives it a larger share.
 */
export function tileItems(items: DashItem[], W: number, H: number, pad = 16): DashItem[] {
  const tiles = items.filter(tileable).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x)
  if (!tiles.length) return items
  const rows: DashItem[][] = []
  for (const t of tiles) {
    const row = rows[rows.length - 1]
    const first = row?.[0]
    if (row && first && t.y + t.h / 2 < first.y + first.h) row.push(t)
    else rows.push([t])
  }
  const heights = rows.map((r) => Math.max(GRID * 2, ...r.map((i) => i.h)))
  const availH = H - pad * (rows.length + 1)
  const hSum = heights.reduce((a, b) => a + b, 0)
  const out = new Map<string, { x: number; y: number; w: number; h: number }>()
  let y = pad
  rows.forEach((row, ri) => {
    const rh = ri === rows.length - 1 ? H - pad - y : Math.max(GRID * 2, snap((heights[ri] / hSum) * availH))
    const sorted = [...row].sort((a, b) => a.x - b.x)
    const availW = W - pad * (sorted.length + 1)
    const wSum = sorted.reduce((a, i) => a + Math.max(GRID * 2, i.w), 0)
    let x = pad
    sorted.forEach((it, ci) => {
      const w = ci === sorted.length - 1 ? W - pad - x : Math.max(GRID * 2, snap((Math.max(GRID * 2, it.w) / wSum) * availW))
      out.set(it.id, { x, y, w, h: rh })
      x += w + pad
    })
    y += rh + pad
  })
  return items.map((i) => (out.has(i.id) ? { ...i, ...out.get(i.id)! } : i))
}

/**
 * A device layout generated from the default one. Phone: one column in reading order, full width (charts 260 px
 * high, other items their own height). Tablet: the default layout scaled to 1024 × 768.
 */
export function autoDeviceLayout(d: Dashboard, dev: 'tablet' | 'phone'): DeviceLayout {
  const pos: DeviceLayout['pos'] = {}
  if (dev === 'tablet') {
    const W = 1024
    const H = 768
    const sx = W / d.size.w
    const sy = H / d.size.h
    for (const i of d.items) pos[i.id] = { x: snap(i.x * sx), y: snap(i.y * sy), w: Math.max(GRID * 2, snap(i.w * sx)), h: Math.max(GRID * 2, snap(i.h * sy)) }
    return { w: W, h: H, pos }
  }
  const W = 390
  const pad = 12
  let y = pad
  const order = d.items.filter((i) => !i.parent && i.kind !== 'shape').sort((a, b) => a.y - b.y || a.x - b.x)
  for (const i of d.items) if (i.kind === 'shape') pos[i.id] = { ...geometry(i), hidden: true }
  for (const i of order) {
    const h = i.kind === 'chart' ? 260 : i.kind === 'container' ? 260 * Math.max(1, d.items.filter((c) => c.parent === i.id).length) : Math.min(i.h, 160)
    pos[i.id] = { x: pad, y, w: W - 2 * pad, h }
    y += h + pad
  }
  // Children of a row container become a column on a phone: their container lays them out.
  for (const i of d.items) if (i.parent) pos[i.id] = geometry(i)
  return { w: W, h: Math.max(y, 640), pos }
}

/** The dashboard as a device shows it: that layout's size and positions; hidden items left out. */
export function deviceView(d: Dashboard, dev: Device): Dashboard {
  const L = dev !== 'default' ? d.devices?.[dev] : undefined
  if (!L) return d
  const items = d.items
    .filter((i) => !L.pos[i.id]?.hidden)
    .map((i) => {
      const p = L.pos[i.id]
      const it = p ? { ...i, ...geometry(p) } : i
      return dev === 'phone' && it.kind === 'container' && it.container ? { ...it, container: { ...it.container, direction: 'column' as const } } : it
    })
    .map((i) => clampItem(i, L.w, L.h))
  return { ...d, tiled: false, size: { ...d.size, w: L.w, h: L.h }, items }
}

/**
 * An edit made in a device layout, written back: positions (and size) go to the layout; everything else (text, chart,
 * properties) to the items themselves; an item removed there is hidden there; a new item is added to every layout.
 */
export function applyDeviceEdit(d: Dashboard, dev: 'tablet' | 'phone', next: Dashboard): Dashboard {
  const L = d.devices?.[dev]
  if (!L) return next
  const pos = { ...L.pos }
  const byId = new Map(next.items.map((i) => [i.id, i]))
  const items = d.items.map((i) => {
    const n = byId.get(i.id)
    if (!n) {
      pos[i.id] = { ...(pos[i.id] ?? geometry(i)), hidden: true }
      return i
    }
    pos[i.id] = geometry(n)
    const keep = dev === 'phone' && i.kind === 'container' ? { container: i.container } : {}
    return { ...n, ...geometry(i), ...keep }
  })
  for (const n of next.items) if (!d.items.some((i) => i.id === n.id)) {
    items.push(clampItem({ ...n }, d.size.w, d.size.h))
    pos[n.id] = geometry(n)
  }
  return { ...next, tiled: d.tiled, size: d.size, items, devices: { ...d.devices, [dev]: { w: next.size.w, h: next.size.h, pos } } }
}

/** The layout for a window of this width: phone below 600 px, tablet below 1100 px, when the dashboard has them. */
export function deviceFor(d: Dashboard, width: number): Device {
  if (width < 600 && d.devices?.phone) return 'phone'
  if (width < 1100 && d.devices?.tablet) return 'tablet'
  return 'default'
}

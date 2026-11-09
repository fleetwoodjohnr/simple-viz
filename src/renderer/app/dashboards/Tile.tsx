// One dashboard object: a chart (filtered and highlighted by the dashboard), text with live values, a filter
// control, a button, an image or a shape.

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Search, AlertTriangle } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, toast } from '../../state/store'
import * as P from '../../state/project'
import { ChartView } from '../charts/ChartView'
import { distinctValues } from '../charts/FilterDialog'
import { useDash, setDash, setSelection, resetFilters, NO_SELECTIONS, NO_MARKS, NO_DRILL, type Drill } from './runtime'
import { tileFilters, tileHighlight, toggleMark, dynamicText, navigateAction, actionUrl, type MarkSelection } from '@/core/dashboard'
import type { Dashboard, DashItem } from '@/shared/dashboards'
import type { Chart, ChartFilter } from '@/shared/charts'
import { isDate, isNumeric } from '@/core/query/compile'
import { cx, inputCls } from '../../ui'
import { timeAgo } from '../RefreshStatus'

type Value = string | number | boolean | null

/** Lower-case field names each chart tile's data has (columns and calculated fields). */
export function useFieldIndex(d: Dashboard) {
  const { relations, charts, calcs } = useApp(useShallow((s) => ({ relations: s.relations, charts: s.project?.charts, calcs: s.project?.calcs })))
  return useMemo(() => {
    const byItem = new Map<string, Set<string>>()
    for (const it of d.items) {
      const c = charts?.find((x) => x.id === it.chartId)
      if (!c) continue
      const rel = relations.find((r) => r.name.toLowerCase() === c.dataset.toLowerCase())
      byItem.set(it.id, new Set([...(rel?.columns.map((x) => x.name.toLowerCase()) ?? []), ...(calcs ?? []).filter((x) => x.dataset.toLowerCase() === c.dataset.toLowerCase()).map((x) => x.name.toLowerCase())]))
    }
    return (id: string) => byItem.get(id) ?? new Set<string>()
  }, [d.items, charts, relations, calcs])
}

/** Sources behind a chart (through datasets), for its freshness badge. */
function useChartFreshness(chart: Chart | undefined) {
  const { relations, deps, sources } = useApp(useShallow((s) => ({ relations: s.relations, deps: s.deps, sources: s.sources })))
  return useMemo(() => {
    if (!chart) return null
    const seen = new Set<string>()
    const srcIds = new Set<string>()
    const walk = (name: string) => {
      const k = name.toLowerCase()
      if (seen.has(k)) return
      seen.add(k)
      const r = relations.find((x) => x.name.toLowerCase() === k)
      if (r?.source) srcIds.add(r.source)
      for (const d of deps[r?.name ?? name] ?? []) walk(d)
    }
    walk(chart.dataset)
    const st = [...srcIds].map((id) => sources[id]).filter(Boolean)
    if (!st.length) return null
    const bad = st.find((s) => s.state === 'error')
    const stale = st.some((s) => s.state === 'stale' || s.state === 'checking')
    return { error: bad?.error, stale, refreshedAt: Math.min(...st.map((s) => s.refreshedAt ?? 0)) }
  }, [chart, relations, deps, sources])
}

export function ChartTile({ d, item, interactive }: { d: Dashboard; item: DashItem; interactive: boolean }) {
  const chart = useApp((s) => s.project?.charts.find((c) => c.id === item.chartId))
  const selections = useDash((s) => s.selections[d.id] ?? NO_SELECTIONS)
  const marks = useDash((s) => s.marks[d.id] ?? NO_MARKS)
  const drill = useDash((s) => (s.drill[d.id] ?? NO_DRILL)[item.id])
  const fieldsOf = useFieldIndex(d)
  const fresh = useChartFreshness(chart)
  const extra = useMemo(() => tileFilters(d, item.id, fieldsOf, selections, marks), [d, item.id, fieldsOf, selections, marks])
  const highlight = useMemo(() => tileHighlight(d, item.id, fieldsOf, marks), [d, item.id, fieldsOf, marks])
  // Drill-down: the chart shows the current level's field, filtered by the values chosen above it.
  const { shown, drillFilters } = useMemo(() => drilled(chart, drill), [chart, drill])
  const allExtra = useMemo(() => [...extra, ...drillFilters], [extra, drillFilters])
  if (!chart) return <div className="flex h-full items-center justify-center text-[12px] text-text-3">Choose a chart for this tile</div>
  const path = chart.options.drill ?? []
  const onMark = (m: { values: Record<string, Value> }) => {
    if (!interactive) return
    const lvl = drill?.level ?? 0
    if (path.length > 1 && lvl < path.length - 1) {
      const v = m.values[path[lvl].field]
      setDash((s) => ({ drill: { ...s.drill, [d.id]: { ...(s.drill[d.id] ?? {}), [item.id]: { level: lvl + 1, path: [...(drill?.path ?? []), v] } } } }))
      return
    }
    // URL actions open their page; the click still filters and highlights.
    for (const a of d.actions) {
      if (a.kind !== 'url' || !a.target.trim() || (a.source !== '*' && a.source !== item.id)) continue
      const url = actionUrl(a.target, m.values)
      if (url) void window.simpleViz.openExternal(url)
      else toast('This action’s address isn’t a web or email address, so it wasn’t opened.', 'error')
    }
    const nav = navigateAction(d, item.id)
    const sel: MarkSelection = { item: item.id, values: m.values }
    if (nav) {
      // Drill-through: open the target dashboard filtered to the clicked mark.
      const vals = Object.fromEntries(Object.entries(m.values).filter(([f]) => !nav.fields?.length || nav.fields.includes(f)).map(([f, v]) => [f, { values: [v] }]))
      setDash((s) => ({ active: nav.target, selections: { ...s.selections, [nav.target]: { ...(s.selections[nav.target] ?? {}), ...vals } } }))
      return
    }
    setDash((s) => ({ marks: { ...s.marks, [d.id]: toggleMark(s.marks[d.id] ?? [], sel) } }))
  }
  return (
    <div className="flex h-full flex-col" data-testid={`tile-${item.id}`} data-chart={chart.name}>
      {(item.showTitle ?? true) && (
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 pt-1">
          {drill && drill.level > 0 && (
            <button aria-label="Drill up" onClick={() => setDash((s) => ({ drill: { ...s.drill, [d.id]: { ...(s.drill[d.id] ?? {}), [item.id]: { level: drill.level - 1, path: drill.path.slice(0, -1) } } } }))} className="flex size-6 items-center justify-center rounded text-text-2 hover:bg-hover" data-testid="drill-up">
              <ArrowLeft className="size-3.5" />
            </button>
          )}
          <span className="truncate text-[12.5px] font-semibold">{dynamicText(chart.options.title || chart.name, selections, marks)}</span>
          {drill && drill.level > 0 && <span className="truncate text-[11.5px] text-text-3">{drill.path.map((v) => String(v)).join(' › ')}</span>}
          <span className="flex-1" />
          {fresh?.error ? (
            <span className="flex items-center gap-1 text-[11px] font-medium text-danger" title={fresh.error} data-testid="tile-stale">
              <AlertTriangle className="size-3" /> Last good data {timeAgo(fresh.refreshedAt)}
            </span>
          ) : fresh?.stale ? (
            <span className="text-[11px] text-warn" data-testid="tile-stale">Cached · checking…</span>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1 px-1 pb-1">
        <ChartView chart={shown!} extra={allExtra} highlight={highlight} onMark={interactive ? onMark : undefined} testid="tile-chart" />
      </div>
    </div>
  )
}

function drilled(chart: Chart | undefined, drill: Drill | undefined): { shown: Chart | undefined; drillFilters: ChartFilter[] } {
  const path = chart?.options.drill ?? []
  if (!chart || !drill || drill.level === 0 || path.length < 2) return { shown: chart, drillFilters: [] }
  const lvl = Math.min(drill.level, path.length - 1)
  const shown: Chart = { ...chart, enc: { ...chart.enc, x: [path[lvl], ...chart.enc.x.slice(1)] } }
  const drillFilters: ChartFilter[] = drill.path.slice(0, lvl).map((v, i): ChartFilter => {
    const g = path[i].grain
    // A date at a grain (2025, Q1 2025, March 2025) means the whole period: [start, start of the next period).
    if (g && g !== 'exact' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return { id: `drill:${i}`, field: path[i].field, op: 'between', min: v.slice(0, 10), max: periodEnd(v.slice(0, 10), g), maxExclusive: true }
    return { id: `drill:${i}`, field: path[i].field, op: 'in', values: [v] }
  })
  return { shown, drillFilters }
}

/** The first day after the period starting at `start` (YYYY-MM-DD). */
export function periodEnd(start: string, grain: string): string {
  const [y, m, d] = start.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  if (grain === 'year') t.setUTCFullYear(y + 1)
  else if (grain === 'quarter') t.setUTCMonth(m - 1 + 3)
  else if (grain === 'month') t.setUTCMonth(m)
  else if (grain === 'week') t.setUTCDate(d + 7)
  else t.setUTCDate(d + 1)
  return t.toISOString().slice(0, 10)
}

export function TextTile({ d, item }: { d: Dashboard; item: DashItem }) {
  const selections = useDash((s) => s.selections[d.id] ?? NO_SELECTIONS)
  const marks = useDash((s) => s.marks[d.id] ?? NO_MARKS)
  const st = item.textStyle ?? { size: 14 }
  return (
    <div className="h-full overflow-hidden whitespace-pre-wrap px-2 py-1 leading-snug" style={{ fontSize: st.size, fontWeight: st.bold ? 650 : 400, textAlign: st.align ?? 'left', color: st.color }} data-testid="text-tile">
      {dynamicText(item.text ?? '', selections, marks)}
    </div>
  )
}

/** A filter control: every chart on the dashboard whose data has the field is filtered. */
export function FilterTile({ d, item }: { d: Dashboard; item: DashItem }) {
  const f = item.filter!
  const charts = useApp((s) => s.project?.charts)
  const relations = useApp((s) => s.relations)
  const dataVersion = useApp((s) => s.dataVersion)
  const sel = useDash((s) => (s.selections[d.id] ?? NO_SELECTIONS)[f.field])
  const [values, setValues] = useState<{ value: Value; n: number }[]>([])
  const [q, setQ] = useState('')
  // The first chart on the dashboard whose data has the field supplies the values.
  const source = useMemo(() => {
    for (const it of d.items) {
      const c = charts?.find((x) => x.id === it.chartId)
      const rel = c && relations.find((r) => r.name.toLowerCase() === c.dataset.toLowerCase())
      const col = rel?.columns.find((x) => x.name.toLowerCase() === f.field.toLowerCase())
      if (c && col) return { dataset: c.dataset, type: col.type }
    }
    return null
  }, [d.items, charts, relations, f.field])
  useEffect(() => {
    if (!source || f.mode === 'range' || f.mode === 'dates') return
    distinctValues(source.dataset, f.field).then(setValues, () => setValues([]))
  }, [source, f.field, f.mode, dataVersion])
  const title = f.title ?? f.field
  if (!source) return <div className="p-2 text-[12px] text-text-3">No chart on this dashboard has “{f.field}”.</div>
  const picked = new Set((sel?.values ?? []).map(String))
  const toggle = (v: Value) => {
    const k = String(v)
    const next = f.multi === false ? (picked.has(k) ? [] : [v]) : picked.has(k) ? (sel?.values ?? []).filter((x) => String(x) !== k) : [...(sel?.values ?? []), v]
    setSelection(d.id, f.field, next.length ? { values: next } : null)
  }
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden p-2" data-testid={`filter-control-${f.field}`} role="group" aria-label={`Filter: ${title}`}>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold">{title}</span>
        {sel && (
          <button className="text-[11.5px] text-accent-ink hover:underline" onClick={() => setSelection(d.id, f.field, null)}>
            Clear
          </button>
        )}
      </div>
      {f.mode === 'dropdown' ? (
        <select aria-label={title} className={cx(inputCls, 'h-8')} value={sel?.values?.[0] === undefined ? '' : String(sel.values[0])} onChange={(e) => setSelection(d.id, f.field, e.target.value === '' ? null : { values: [values.find((v) => String(v.value) === e.target.value)?.value ?? e.target.value] })} data-testid="filter-dropdown">
          <option value="">(All)</option>
          {values.map((v) => (
            <option key={String(v.value)} value={String(v.value)}>
              {v.value === null ? 'Null' : String(v.value)}
            </option>
          ))}
        </select>
      ) : f.mode === 'range' || f.mode === 'dates' ? (
        <div className="flex items-center gap-1.5">
          <input aria-label={`${title} from`} type={f.mode === 'dates' || isDate(source.type) ? 'date' : 'number'} className={cx(inputCls, 'h-8')} value={String(sel?.min ?? '')} onChange={(e) => setSelection(d.id, f.field, { ...sel, values: undefined, min: e.target.value === '' ? null : isNumeric(source.type) ? Number(e.target.value) : e.target.value })} />
          <span className="text-text-3">–</span>
          <input aria-label={`${title} to`} type={f.mode === 'dates' || isDate(source.type) ? 'date' : 'number'} className={cx(inputCls, 'h-8')} value={String(sel?.max ?? '')} onChange={(e) => setSelection(d.id, f.field, { ...sel, values: undefined, max: e.target.value === '' ? null : isNumeric(source.type) ? Number(e.target.value) : e.target.value })} />
        </div>
      ) : (
        <>
          {(f.mode === 'search' || values.length > 8) && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-3" />
              <input aria-label={`Search ${title}`} className={cx(inputCls, 'h-7 pl-7 text-[12px]')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {values
              .filter((v) => !q || String(v.value).toLowerCase().includes(q.toLowerCase()))
              .map((v) => (
                <li key={String(v.value)}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12.5px] hover:bg-hover">
                    <input type={f.multi === false ? 'radio' : 'checkbox'} name={item.id} className="size-3.5 accent-[var(--accent)]" checked={picked.has(String(v.value))} onChange={() => toggle(v.value)} />
                    <span className="truncate">{v.value === null ? 'Null' : String(v.value)}</span>
                  </label>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function ButtonTile({ d, item, interactive }: { d: Dashboard; item: DashItem; interactive: boolean }) {
  const b = item.button!
  const run = () => {
    if (!interactive) return
    if (b.action === 'navigate' && b.target) setDash({ active: b.target })
    else if (b.action === 'reset') resetFilters(d.id)
    else if (b.action === 'refresh') void P.refreshSources(undefined, true)
    else if (b.action === 'fullscreen') setDash({ presenting: true })
  }
  return (
    <button onClick={run} className="flex h-full w-full items-center justify-center rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:brightness-110" data-testid="dash-button">
      {b.label}
    </button>
  )
}

// Renders a chart: compiles its query, runs it in the engine, and draws the result with its plugin (ECharts, or a
// React view for tables, crosstabs and KPI cards). Charts follow the light/dark theme through CSS variables.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, TreemapChart, BoxplotChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent, TitleComponent, VisualMapComponent, MarkLineComponent, AriaComponent } from 'echarts/components'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useApp } from '../../state/store'
import * as E from '../../state/engine'
import { compileQuery, QueryError, type OutField } from '@/core/query/compile'
import { plugin } from '@/core/charts/plugins'
import { LIGHT, fmt, type ChartData, type Theme, type Value } from '@/core/charts/data'
import type { Chart, ChartFilter } from '@/shared/charts'
import { DataGrid } from '../../ui/DataGrid'
import { cx } from '../../ui'

echarts.use([BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, TreemapChart, BoxplotChart, GridComponent, LegendComponent, TooltipComponent, TitleComponent, VisualMapComponent, MarkLineComponent, AriaComponent, CanvasRenderer, SVGRenderer])

export const MAX_MARKS = 20_000

/** Chart colors from the CSS tokens (styles.css), so charts follow the theme and the accent. */
export function readTheme(dark: boolean): Theme {
  if (typeof document === 'undefined') return LIGHT
  const s = getComputedStyle(document.documentElement)
  const v = (n: string, d: string) => s.getPropertyValue(n).trim() || d
  return {
    dark,
    text: v('--text', LIGHT.text),
    text2: v('--chart-text', LIGHT.text2),
    grid: v('--chart-grid', LIGHT.grid),
    axis: v('--chart-axis', LIGHT.axis),
    bg: 'transparent',
    font: "'Inter Variable', system-ui, sans-serif",
    palette: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--chart-${i}`, LIGHT.palette[i - 1])),
    seq: [v('--chart-seq-lo', LIGHT.seq[0]), v('--chart-seq-hi', LIGHT.seq[1])],
    accent: v('--accent', LIGHT.accent)
  }
}

export interface ChartResult {
  data: ChartData | null
  error: string | null
  loading: boolean
  sql: string | null
}

/** Compiles and runs a chart's query; re-runs when the chart, its data or the dashboard filters change. */
export function useChartData(chart: Chart | null, extra?: ChartFilter[], highlight?: ChartData['highlight']): ChartResult {
  const relations = useApp((s) => s.relations)
  const project = useApp((s) => s.project)
  const dataVersion = useApp((s) => s.dataVersion)
  const [state, setState] = useState<ChartResult>({ data: null, error: null, loading: false, sql: null })
  const columns = useMemo(() => relations.find((r) => chart && r.name.toLowerCase() === chart.dataset.toLowerCase())?.columns, [relations, chart?.dataset])
  const calcs = project?.calcs
  const params = project?.params
  const key = JSON.stringify([chart?.dataset, chart?.type, chart?.enc, chart?.filters, chart?.options.sort, chart?.options.bins, extra, calcs?.filter((c) => c.dataset === chart?.dataset), params, dataVersion, !!columns])

  useEffect(() => {
    if (!chart) return
    if (!columns) {
      setState({ data: null, error: relations.length ? `The data “${chart.dataset}” isn’t available. Check the Data workspace.` : null, loading: !relations.length, sql: null })
      return
    }
    if (!chart.enc.x.length && !chart.enc.y.length && !chart.enc.color && !chart.enc.size && !chart.enc.detail.length) {
      setState({ data: null, error: null, loading: false, sql: null })
      return
    }
    let alive = true
    const p = plugin(chart.type)
    let compiled
    try {
      compiled = compileQuery({ chart, columns, calcs: (calcs ?? []).filter((c) => c.dataset.toLowerCase() === chart.dataset.toLowerCase()), params, extra, maxMarks: MAX_MARKS, mode: p.raw?.(chart.enc) ? 'raw' : 'aggregate' })
    } catch (e) {
      setState({ data: null, error: e instanceof QueryError ? e.message : `Couldn’t build this chart: ${(e as Error).message}`, loading: false, sql: null })
      return
    }
    const sql = p.wrap ? p.wrap(compiled.sql, { bins: chart.options.bins ?? 20, hasCat: compiled.fields.some((f) => f.kind === 'dim') }) : compiled.sql
    setState((s) => ({ ...s, loading: true, error: null, sql }))
    const { id, done } = E.runQuery(sql, { limit: MAX_MARKS + 1 })
    done.then(
      (r) => {
        if (!alive) return
        // Rows in field order (the query lists dimensions first); wrapped queries (bins, box stats) keep their own.
        const pos = compiled.fields.map((f) => r.columns.findIndex((c) => c.name === f.key))
        const rows = p.wrap || pos.some((x) => x < 0) ? r.rows : r.rows.map((row) => pos.map((i) => row[i]))
        setState({ data: { fields: compiled.fields, rows: rows.slice(0, MAX_MARKS), truncated: rows.length > MAX_MARKS, options: chart.options }, error: null, loading: false, sql })
      },
      (e: Error) => alive && setState({ data: null, error: e.message, loading: false, sql })
    )
    return () => {
      alive = false
      void E.cancel(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Formatting-only changes (title, labels, legend…) don't re-query.
  const data = useMemo(() => (state.data && chart ? { ...state.data, options: chart.options, highlight } : state.data), [state.data, chart?.options, highlight])
  return { ...state, data }
}

export interface MarkClick {
  /** Dimension field name → value of the clicked mark. */
  values: Record<string, Value>
}

export function ChartView({ chart, extra, highlight, onMark, className, testid }: { chart: Chart; extra?: ChartFilter[]; highlight?: ChartData['highlight']; onMark?: (m: MarkClick) => void; className?: string; testid?: string }) {
  const { data, error, loading } = useChartData(chart, extra, highlight)
  const p = plugin(chart.type)
  let body: ReactNode
  if (error) body = <Message icon={<AlertTriangle className="size-5 text-danger" />} text={error} />
  else if (!data) body = loading ? <Message icon={<Loader2 className="size-5 animate-spin text-text-3" />} text="Loading…" /> : <Message text="Drag fields onto the shelves to build a chart." />
  else if (!data.rows.length) body = <Message text="No data matches the filters." />
  else if (p.render === 'kpi') body = <Kpi data={data} />
  else if (p.render === 'table') body = <TableView data={data} />
  else if (p.render === 'crosstab') body = <Crosstab data={data} />
  else body = <EChart data={data} type={chart.type} onMark={onMark} />
  return (
    <div className={cx('relative flex h-full min-h-0 flex-col', className)} data-testid={testid ?? 'chart-view'} data-chart-state={error ? 'error' : loading ? 'loading' : data ? 'ready' : 'empty'}>
      {body}
      {data?.truncated && <div className="absolute bottom-1 left-2 rounded bg-warn/15 px-2 py-0.5 text-[11px] text-warn">Showing the first {MAX_MARKS.toLocaleString()} marks — add a filter to see the rest.</div>}
      {loading && data && <Loader2 className="absolute right-2 top-2 size-4 animate-spin text-text-3" aria-label="Updating" />}
    </div>
  )
}

function Message({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon}
      <p className="max-w-md select-text text-[12.5px] text-text-3">{text}</p>
    </div>
  )
}

/** Holds the live ECharts instances, for image export (PNG, SVG) and tests. */
export const liveCharts = new Set<echarts.ECharts>()

function EChart({ data, type, onMark }: { data: ChartData; type: string; onMark?: (m: MarkClick) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const dark = useApp((s) => s.dark)
  const accent = useApp((s) => s.settings.accent)
  const markRef = useRef(onMark)
  markRef.current = onMark
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => {
    const el = host.current!
    const chart = echarts.init(el, undefined, { renderer: 'canvas' })
    inst.current = chart
    liveCharts.add(chart)
    ;(el as HTMLDivElement & { __echart?: echarts.ECharts }).__echart = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    chart.on('click', (p) => {
      const row = (p.data as { row?: Value[] } | undefined)?.row
      if (!row || !markRef.current) return
      const values: Record<string, Value> = {}
      dataRef.current.fields.forEach((f, i) => f.kind === 'dim' && (values[f.ref.field] = row[i]))
      markRef.current({ values })
    })
    return () => {
      ro.disconnect()
      liveCharts.delete(chart)
      chart.dispose()
    }
    // the instance lives as long as the element; data updates go through setOption below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const opt = plugin(type).option?.(data, readTheme(dark))
    if (opt) inst.current?.setOption(opt as echarts.EChartsCoreOption, { notMerge: true })
  }, [data, type, dark, accent])

  return <div ref={host} className="min-h-0 flex-1" role="img" aria-label={describe(data)} data-testid="echart" />
}

/** A text alternative for screen readers: what the chart shows, in a sentence. */
function describe(d: ChartData): string {
  const ms = d.fields.filter((f) => f.kind === 'measure').map((f) => f.title)
  const ds = d.fields.filter((f) => f.kind === 'dim').map((f) => f.title)
  return `${ms.join(', ') || 'Values'}${ds.length ? ` by ${ds.join(' and ')}` : ''}, ${d.rows.length} marks.${d.options.title ? ` ${d.options.title}.` : ''}`
}

function Kpi({ data }: { data: ChartData }) {
  const ms = data.fields.filter((f) => f.kind === 'measure')
  const main = ms[0]
  const row = data.rows[0] ?? []
  const v = main ? row[data.fields.indexOf(main)] : null
  return (
    <div className="flex h-full flex-col justify-center gap-1 px-5 py-3" data-testid="kpi">
      {data.options.title && <div className="text-[12.5px] font-medium text-text-2">{data.options.title}</div>}
      <div className="truncate text-[34px] font-semibold tabular-nums tracking-tight" data-testid="kpi-value" data-value={typeof v === 'number' ? v : undefined}>
        {fmt(v, main)}
      </div>
      <div className="text-[12px] text-text-3">{main?.title}</div>
      {ms.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {ms.slice(1).map((m) => (
            <div key={m.key} className="text-[12px]">
              <span className="text-text-3">{m.title} </span>
              <b className="tabular-nums">{fmt(row[data.fields.indexOf(m)], m)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TableView({ data }: { data: ChartData }) {
  const source = useMemo(() => ({ columns: data.fields.map((f) => ({ name: f.title, type: f.kind === 'measure' ? 'DOUBLE' : f.type })), rowCount: data.rows.length, first: data.rows.map((r) => r.map((v, i) => (data.fields[i].kind === 'dim' ? (v === null ? null : fmt(v, data.fields[i])) : v))) }), [data])
  return (
    <div className="min-h-0 flex-1">
      <DataGrid source={source} label={data.options.title ?? 'Table'} />
    </div>
  )
}

/** Rows × columns with a measure in the cells, with totals for sums and counts. */
function Crosstab({ data }: { data: ChartData }) {
  const rowDims = data.fields.filter((f) => f.kind === 'dim' && f.role !== 'x')
  const colDim = data.fields.find((f) => f.kind === 'dim' && f.role === 'x')
  const m = data.fields.find((f) => f.kind === 'measure')
  const idx = (f: OutField) => data.fields.indexOf(f)
  const { rows, cols, cells } = useMemo(() => {
    const rk = (r: Value[]) => rowDims.map((f) => String(r[idx(f)])).join('\u0001')
    const rows = new Map<string, Value[]>()
    const cols = new Map<string, Value>()
    const cells = new Map<string, Value>()
    for (const r of data.rows) {
      const k = rk(r)
      if (!rows.has(k)) rows.set(k, rowDims.map((f) => r[idx(f)]))
      const c = colDim ? String(r[idx(colDim)]) : ''
      if (!cols.has(c)) cols.set(c, colDim ? r[idx(colDim)] : '')
      cells.set(`${k}\u0002${c}`, m ? r[idx(m)] : null)
    }
    return { rows, cols, cells }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  const additive = m && ['sum', 'count'].includes(m.ref.agg ?? '') && !m.ref.quick
  const num = (v: Value) => (typeof v === 'number' ? v : 0)
  const colKeys = [...cols.keys()]
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="crosstab">
      <table className="border-separate border-spacing-0 text-[12.5px]">
        <thead>
          <tr>
            {rowDims.map((f) => (
              <th key={f.key} className="sticky top-0 border-b border-border-strong bg-panel-2 px-3 py-1.5 text-left font-semibold">
                {f.title}
              </th>
            ))}
            {colKeys.map((c) => (
              <th key={c} className="sticky top-0 border-b border-border-strong bg-panel-2 px-3 py-1.5 text-right font-semibold">
                {colDim ? fmt(cols.get(c)!, colDim) : m?.title}
              </th>
            ))}
            {additive && colDim && <th className="sticky top-0 border-b border-border-strong bg-panel-2 px-3 py-1.5 text-right font-semibold">Total</th>}
          </tr>
        </thead>
        <tbody>
          {[...rows].map(([k, vals]) => (
            <tr key={k} className="hover:bg-hover">
              {vals.map((v, i) => (
                <td key={i} className="border-b border-border px-3 py-1">
                  {fmt(v, rowDims[i])}
                </td>
              ))}
              {colKeys.map((c) => (
                <td key={c} className="border-b border-border px-3 py-1 text-right tabular-nums">
                  {cells.has(`${k}\u0002${c}`) ? fmt(cells.get(`${k}\u0002${c}`)!, m) : ''}
                </td>
              ))}
              {additive && colDim && <td className="border-b border-border px-3 py-1 text-right font-semibold tabular-nums">{fmt(colKeys.reduce((a, c) => a + num(cells.get(`${k}\u0002${c}`) ?? null), 0), m)}</td>}
            </tr>
          ))}
          {additive && (
            <tr className="font-semibold">
              <td colSpan={rowDims.length || 1} className="border-t border-border-strong px-3 py-1">
                Total
              </td>
              {colKeys.map((c) => (
                <td key={c} className="border-t border-border-strong px-3 py-1 text-right tabular-nums">
                  {fmt([...rows.keys()].reduce((a, k) => a + num(cells.get(`${k}\u0002${c}`) ?? null), 0), m)}
                </td>
              ))}
              {colDim && <td className="border-t border-border-strong px-3 py-1 text-right tabular-nums">{fmt(data.rows.reduce((a, r) => a + num(r[idx(m!)]), 0), m)}</td>}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** PNG (data URL, at `scale`×) or SVG markup of a rendered chart element. */
export function exportChart(el: HTMLElement, kind: 'png' | 'svg', scale = 2, dark = false): string | null {
  const c = (el.querySelector('[data-testid=echart]') as (HTMLDivElement & { __echart?: echarts.ECharts }) | null)?.__echart
  if (!c) return null
  if (kind === 'png') return c.getDataURL({ type: 'png', pixelRatio: scale, backgroundColor: dark ? '#18181b' : '#ffffff' })
  // SVG: render the same option with the SVG renderer, off screen.
  const { width, height } = { width: c.getWidth(), height: c.getHeight() }
  const ssr = echarts.init(null as never, undefined, { renderer: 'svg', ssr: true, width, height })
  ssr.setOption(c.getOption() as echarts.EChartsCoreOption)
  const svg = ssr.renderToSVGString()
  ssr.dispose()
  return svg
}

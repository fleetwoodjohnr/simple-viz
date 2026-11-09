// The Analytics workspace: pick an analysis, the data and the variables; get result tables, a chart, a plain-language
// summary, the assumptions, and how many rows were used. Results export to CSV; clusters save as a dataset.

import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { FlaskConical, Play, Loader2, Download, Layers, Info } from 'lucide-react'
import { useApp, toast } from '../state/store'
import * as P from '../state/project'
import * as E from '../state/engine'
import { Btn, Segmented, cx, inputCls } from '../ui'
import { readTheme } from './charts/ChartView'
import { ANALYSES, runAnalysis, type AnalysisKind, type AnalysisResult, type AnalysisSpec, type StatChart } from '@/core/stats/analyses'
import { isDate, isNumeric } from '@/core/query/compile'

const run = async (sql: string) => {
  const r = await E.query(sql, { limit: 100_000 })
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))
}

export function Analytics() {
  const relations = useApp((s) => s.relations)
  const [kind, setKind] = useState<AnalysisKind>('describe')
  const [spec, setSpec] = useState<AnalysisSpec>({ kind: 'describe', dataset: relations.find((r) => r.kind === 'dataset')?.name ?? relations[0]?.name ?? '' })
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const rel = relations.find((r) => r.name === spec.dataset)
  const numeric = rel?.columns.filter((c) => isNumeric(c.type)) ?? []
  const all = rel?.columns ?? []
  const dates = rel?.columns.filter((c) => isDate(c.type)) ?? []
  const set = (p: Partial<AnalysisSpec>) => setSpec((s) => ({ ...s, ...p }))
  useEffect(() => {
    if (!spec.dataset && relations[0]) set({ dataset: relations[0].name })
  }, [relations, spec.dataset])

  const go = async () => {
    setBusy(true)
    setError('')
    try {
      setResult(await runAnalysis({ ...spec, kind }, run))
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const exportCsv = async () => {
    if (!result) return
    const path = await window.simpleViz.saveDialog(`${result.title}.csv`, ['csv'])
    if (!path) return
    const esc = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const text = result.tables.map((t) => [t.title ?? result.title, t.columns.map(esc).join(','), ...t.rows.map((r) => r.map(esc).join(','))].join('\n')).join('\n\n')
    await window.simpleViz.writeFile(path, new TextEncoder().encode(`${text}\n\n"Summary","${result.summary.replace(/"/g, '""')}"\n`))
    toast(`Exported ${path.split(/[\\/]/).pop()}`, 'success')
  }

  const pick = (label: string, value: string | undefined, options: { name: string }[], onChange: (v: string) => void, testid?: string) => (
    <label className="block text-[12px]">
      <span className="mb-1 block font-medium text-text-2">{label}</span>
      <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
        <option value="">Choose…</option>
        {options.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  )
  const multi = (label: string, value: string[] | undefined, options: { name: string }[], onChange: (v: string[]) => void, testid: string) => (
    <fieldset className="text-[12px]" data-testid={testid}>
      <legend className="mb-1 font-medium text-text-2">{label}</legend>
      <div className="flex max-h-[150px] flex-wrap gap-1 overflow-y-auto">
        {options.map((c) => {
          const on = value?.includes(c.name)
          return (
            <label key={c.name} className={cx('flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2', on ? 'border-accent bg-accent-soft' : 'border-border')}>
              <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={!!on} onChange={() => onChange(on ? value!.filter((x) => x !== c.name) : [...(value ?? []), c.name])} />
              {c.name}
            </label>
          )
        })}
      </div>
    </fieldset>
  )

  return (
    <div className="flex h-full" data-testid="analytics-view">
      <aside className="w-[220px] shrink-0 overflow-y-auto border-r border-border bg-panel p-2" aria-label="Analyses">
        {['Explore', 'Compare', 'Model'].map((g) => (
          <div key={g} className="mb-2">
            <div className="px-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">{g}</div>
            <div role="radiogroup" aria-label={g}>
              {ANALYSES.filter((a) => a.group === g).map((a) => (
                <div key={a.kind}>
                  <button role="radio" aria-checked={kind === a.kind} onClick={() => (setKind(a.kind), setResult(null), setError(''))} title={a.describe} className={cx('w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px]', kind === a.kind ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2 hover:bg-hover')} data-testid={`analysis-${a.kind}`}>
                    {a.label}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </aside>
      <section className="w-[290px] shrink-0 space-y-3 overflow-y-auto border-r border-border bg-panel p-3" aria-label="Analysis settings">
        <div className="text-[13px] font-semibold">{ANALYSES.find((a) => a.kind === kind)?.label}</div>
        <p className="text-[12px] leading-snug text-text-3">{ANALYSES.find((a) => a.kind === kind)?.describe}</p>
        {pick('Data', spec.dataset, relations, (v) => set({ dataset: v, columns: [], x: [], y: undefined, group: undefined }), 'analysis-dataset')}
        {['describe', 'correlation', 'kmeans', 'pca'].includes(kind) && multi('Numeric columns', spec.columns, numeric, (v) => set({ columns: v }), 'analysis-columns')}
        {kind === 'missing' && multi('Columns', spec.columns, all, (v) => set({ columns: v }), 'analysis-columns')}
        {kind === 'ttest' && (
          <Segmented value={spec.ttest ?? 'two'} onChange={(v) => set({ ttest: v })} label="Test" options={[{ value: 'one', label: 'One sample' }, { value: 'two', label: 'Two groups' }, { value: 'paired', label: 'Paired' }]} />
        )}
        {['ttest', 'anova', 'mannwhitney', 'kruskal', 'anomalies'].includes(kind) && pick(kind === 'anomalies' ? 'Column' : 'Values', spec.y, numeric, (v) => set({ y: v }), 'analysis-y')}
        {kind === 'ttest' && spec.ttest === 'one' && (
          <label className="block text-[12px]">
            <span className="mb-1 block font-medium text-text-2">Hypothesised mean</span>
            <input type="number" className={cx(inputCls, 'h-8 text-[12px]')} value={spec.mu ?? 0} onChange={(e) => set({ mu: Number(e.target.value) })} aria-label="Hypothesised mean" />
          </label>
        )}
        {kind === 'ttest' && spec.ttest === 'paired' && pick('Compared with', spec.x?.[0], numeric, (v) => set({ x: [v] }))}
        {((kind === 'ttest' && (spec.ttest ?? 'two') === 'two') || ['anova', 'mannwhitney', 'kruskal'].includes(kind)) && pick('Groups', spec.group, all.filter((c) => !isNumeric(c.type) || /id|code/i.test(c.name) === false), (v) => set({ group: v }), 'analysis-group')}
        {kind === 'chisq' && (
          <>
            {pick('Rows', spec.group, all, (v) => set({ group: v }), 'analysis-group')}
            {pick('Columns', spec.group2, all, (v) => set({ group2: v }), 'analysis-group2')}
          </>
        )}
        {(kind === 'regression' || kind === 'logistic') && (
          <>
            {pick(kind === 'logistic' ? 'Outcome (two values)' : 'Outcome (y)', spec.y, kind === 'logistic' ? all : numeric, (v) => set({ y: v }), 'analysis-y')}
            {multi('Predictors (x) — text columns become indicators', spec.x, all.filter((c) => c.name !== spec.y && !isDate(c.type)), (v) => set({ x: v }), 'analysis-x')}
          </>
        )}
        {kind === 'regression' && (
          <label className="block text-[12px]">
            <span className="mb-1 block font-medium text-text-2">Polynomial degree (one predictor)</span>
            <input type="number" min={1} max={6} className={cx(inputCls, 'h-8 text-[12px]')} value={spec.degree ?? 1} onChange={(e) => set({ degree: Number(e.target.value) || 1 })} aria-label="Polynomial degree" />
          </label>
        )}
        {kind === 'forecast' && (
          <>
            {pick('Date', spec.date, dates, (v) => set({ date: v }), 'analysis-date')}
            {pick('Measure', spec.y, numeric, (v) => set({ y: v }), 'analysis-y')}
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Each</span>
                <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Grain" value={spec.grain ?? 'month'} onChange={(e) => set({ grain: e.target.value as never })}>
                  {['day', 'week', 'month', 'quarter', 'year'].map((g) => <option key={g}>{g}</option>)}
                </select>
              </label>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Periods ahead</span>
                <input type="number" min={1} max={120} className={cx(inputCls, 'h-8 text-[12px]')} value={spec.horizon ?? 12} onChange={(e) => set({ horizon: Number(e.target.value) || 12 })} aria-label="Periods ahead" />
              </label>
            </div>
            <Segmented value={spec.agg ?? 'sum'} onChange={(v) => set({ agg: v })} label="Aggregation" options={[{ value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }]} />
          </>
        )}
        {kind === 'kmeans' && (
          <label className="block text-[12px]">
            <span className="mb-1 block font-medium text-text-2">Clusters (empty: choose 2–8 automatically)</span>
            <input type="number" min={2} max={20} className={cx(inputCls, 'h-8 text-[12px]')} value={spec.k ?? ''} onChange={(e) => set({ k: e.target.value ? Number(e.target.value) : undefined })} aria-label="Number of clusters" />
          </label>
        )}
        {kind === 'anomalies' && <Segmented value={spec.method ?? 'iqr'} onChange={(v) => set({ method: v })} label="Rule" options={[{ value: 'iqr', label: 'IQR (robust)' }, { value: 'z', label: 'z-score' }]} />}
        <Btn variant="primary" className="w-full" onClick={go} disabled={busy || !spec.dataset} data-testid="analysis-run">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run analysis
        </Btn>
      </section>
      <section className="min-w-0 flex-1 overflow-y-auto p-5" aria-label="Results" aria-live="polite">
        {error ? (
          <p className="select-text rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger" role="alert" data-testid="analysis-error">{error}</p>
        ) : !result ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-text-3">
            <FlaskConical className="mb-2 size-7" />
            <p className="max-w-sm text-[12.5px]">Choose an analysis and its variables, then Run. Everything is computed on this computer.</p>
          </div>
        ) : (
          <Results r={result} onExport={exportCsv} />
        )}
      </section>
    </div>
  )
}

function Results({ r, onExport }: { r: AnalysisResult; onExport: () => void }) {
  return (
    <div className="mx-auto max-w-[1000px] space-y-4" data-testid="analysis-result">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[17px] font-semibold">{r.title}</h2>
        {r.datasetSql && (
          <Btn size="sm" onClick={() => {
            const name = P.uniqueAlias('clusters', P.usedNames())
            P.saveDataset({ name, sql: r.datasetSql!, description: 'Rows with their k-means cluster' })
            toast(`Saved ${name}: every row with its cluster`, 'success')
          }} data-testid="save-clusters">
            <Layers className="size-3.5" /> Save clusters as dataset
          </Btn>
        )}
        <Btn size="sm" onClick={onExport} data-testid="analysis-export">
          <Download className="size-3.5" /> Export CSV
        </Btn>
      </div>
      <p className="select-text rounded-xl bg-accent-soft px-4 py-3 text-[13.5px] leading-relaxed" data-testid="analysis-summary">{r.summary}</p>
      {r.chart && <StatChartView c={r.chart} />}
      {r.tables.map((t, i) => (
        <div key={i} className="overflow-x-auto rounded-xl bg-panel shadow-[0_0_0_1px_var(--border)]" tabIndex={0} role="region" aria-label={t.title ?? r.title}>
          {t.title && <div className="border-b border-border px-3 py-2 text-[12.5px] font-semibold">{t.title}</div>}
          <table className="w-full text-[12.5px]" data-testid="analysis-table">
            <thead>
              <tr className="bg-panel-2 text-left text-[11.5px] text-text-3">
                {t.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap border-b border-border px-3 py-1.5 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, k) => (
                <tr key={k} className="border-b border-border last:border-0">
                  {row.map((v, j) => (
                    <td key={j} className={cx('select-text whitespace-nowrap px-3 py-1', typeof v === 'number' && 'text-right tabular-nums')}>
                      {v === null ? '' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl bg-panel p-3 shadow-[0_0_0_1px_var(--border)]">
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold"><Info className="size-3.5" /> Assumptions and limits</div>
          <ul className="list-disc space-y-1 pl-5 text-[12px] leading-snug text-text-2">
            {r.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-panel p-3 shadow-[0_0_0_1px_var(--border)]" data-testid="analysis-n">
          <div className="mb-1 text-[12px] font-semibold">Rows used</div>
          <p className="text-[12px] text-text-2">
            {r.n.used.toLocaleString()} used{r.n.excluded ? `, ${r.n.excluded.toLocaleString()} left out` : ''}. {r.n.note}
          </p>
        </div>
      </div>
    </div>
  )
}

function StatChartView({ c }: { c: StatChart }) {
  const host = useRef<HTMLDivElement>(null)
  const dark = useApp((s) => s.dark)
  const option = useMemo(() => statOption(c, readTheme(dark)), [c, dark])
  useEffect(() => {
    const chart = echarts.init(host.current!, undefined, { renderer: 'canvas' })
    chart.setOption(option as echarts.EChartsCoreOption)
    ;(host.current as HTMLDivElement & { __echart?: echarts.ECharts }).__echart = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(host.current!)
    return () => (ro.disconnect(), chart.dispose())
  }, [option])
  return <div ref={host} className="h-[320px] rounded-xl bg-panel shadow-[0_0_0_1px_var(--border)]" role="img" aria-label={c.title} data-testid="analysis-chart" />
}

function statOption(c: StatChart, t: ReturnType<typeof readTheme>): Record<string, unknown> {
  const axis = { axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text2 }, splitLine: { lineStyle: { color: t.grid } }, nameTextStyle: { color: t.text2 } }
  const base = { backgroundColor: 'transparent', animation: t.motion !== false, color: t.palette, textStyle: { fontFamily: t.font, color: t.text2 }, title: { text: c.title, left: 10, top: 6, textStyle: { color: t.text, fontSize: 13, fontWeight: 600 } }, grid: { left: 16, right: 24, top: 44, bottom: 16, containLabel: true }, tooltip: { trigger: c.kind === 'scatter' || c.kind === 'heatmap' ? 'item' : 'axis', confine: true } }
  switch (c.kind) {
    case 'histogram': {
      const w = c.bins[0] ? c.bins[0].hi - c.bins[0].lo : 1
      const curve = c.normal ? c.bins.map((b) => {
        const mid = (b.lo + b.hi) / 2
        return c.normal!.n * w * Math.exp(-0.5 * ((mid - c.normal!.mean) / c.normal!.sd) ** 2) / (c.normal!.sd * Math.sqrt(2 * Math.PI))
      }) : []
      return { ...base, xAxis: { type: 'category', data: c.bins.map((b) => b.lo.toPrecision(3)), ...axis }, yAxis: { type: 'value', ...axis }, series: [{ type: 'bar', name: 'Rows', barCategoryGap: '2%', data: c.bins.map((b) => b.n) }, ...(c.normal ? [{ type: 'line', name: 'Normal curve', smooth: true, showSymbol: false, lineStyle: { type: 'dashed', color: t.accent }, data: curve }] : [])] }
    }
    case 'bars':
      return { ...base, xAxis: { type: 'category', data: c.labels, ...axis }, yAxis: { type: 'value', ...axis }, series: [{ type: 'bar', barMaxWidth: 56, data: c.values }] }
    case 'scatter':
      return { ...base, xAxis: { type: 'value', name: c.x, nameLocation: 'middle', nameGap: 26, scale: true, ...axis }, yAxis: { type: 'value', name: c.y, nameLocation: 'middle', nameGap: 40, scale: true, ...axis }, series: [{ type: 'scatter', symbolSize: 5, itemStyle: { opacity: 0.7 }, data: c.points.map((p, i) => ({ value: p, itemStyle: c.groups ? { color: t.palette[c.groups[i] % t.palette.length] } : undefined })) }, ...(c.line ? [{ type: 'line', showSymbol: false, lineStyle: { color: t.accent, width: 2 }, data: c.line }] : [])] }
    case 'heatmap':
      return { ...base, grid: { ...base.grid, bottom: 56 }, xAxis: { type: 'category', data: c.labels, ...axis }, yAxis: { type: 'category', data: c.labels, ...axis }, visualMap: { min: -1, max: 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: [t.palette[0], t.dark ? '#2a2a30' : '#f4f4f6', t.palette[1]] }, textStyle: { color: t.text2 } }, series: [{ type: 'heatmap', label: { show: true, color: t.text, formatter: (p: { value: number[] }) => p.value[2].toFixed(2) }, data: c.values.flatMap((row, i) => row.map((v, j) => [j, i, v])) }] }
    case 'forecast':
      return {
        ...base,
        legend: { top: 6, right: 10, textStyle: { color: t.text2 } },
        xAxis: { type: 'category', data: c.labels, ...axis },
        yAxis: { type: 'value', scale: true, ...axis },
        series: [
          { name: 'Interval', type: 'line', stack: 'band', data: c.lo, lineStyle: { opacity: 0 }, showSymbol: false, silent: true },
          { name: 'Interval', type: 'line', stack: 'band', data: c.hi.map((h, i) => (h === null || c.lo[i] === null ? null : h - c.lo[i]!)), lineStyle: { opacity: 0 }, areaStyle: { color: t.accent, opacity: 0.15 }, showSymbol: false, silent: true },
          { name: 'Actual', type: 'line', data: c.actual, showSymbol: false, lineStyle: { color: t.palette[0], width: 2 } },
          { name: 'Fitted', type: 'line', data: c.fitted, showSymbol: false, lineStyle: { color: t.text2, type: 'dotted' } },
          { name: 'Forecast', type: 'line', data: c.forecast, showSymbol: false, lineStyle: { color: t.accent, width: 2, type: 'dashed' } }
        ]
      }
  }
}

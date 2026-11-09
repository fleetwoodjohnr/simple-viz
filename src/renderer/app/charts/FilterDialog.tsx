// Filters: pick values (searchable, include or exclude), a range, a relative date range, contains, or top N;
// measure filters apply to the aggregated value. A context filter applies before FIXED calculations and top N.

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useApp } from '../../state/store'
import * as E from '../../state/engine'
import { Btn, Field, Modal, Segmented, Switch, cx, inputCls } from '../../ui'
import { updateChart } from './ChartBuilder'
import { compileQuery, isDate, isNumeric, AGG_LABEL } from '@/core/query/compile'
import { newId } from '@/core/project/sviz'
import { emptyEncodings, type Agg, type Chart, type ChartFilter } from '@/shared/charts'
import type { FieldDef } from './fields'

type Value = string | number | boolean | null
type Mode = 'values' | 'range' | 'relative' | 'contains' | 'top'

/** Distinct values of a field in a relation (with calculated fields), most frequent first beyond 1,000. */
export async function distinctValues(dataset: string, field: string): Promise<{ value: Value; n: number }[]> {
  const s = useApp.getState()
  const model = s.project?.models.find((m) => m.name.toLowerCase() === dataset.toLowerCase())
  if (model) {
    // A model field (table.column): its values come from its own table.
    const dot = field.indexOf('.')
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`
    const r = await E.query(`SELECT ${q(field.slice(dot + 1))}, count(*) FROM ${q(field.slice(0, dot))} GROUP BY 1 ORDER BY 2 DESC LIMIT 1000`, { limit: 1000 })
    return r.rows.map(([value, n]) => ({ value, n: Number(n) })).sort((a, b) => String(a.value).localeCompare(String(b.value), undefined, { numeric: true }))
  }
  const rel = s.relations.find((r) => r.name.toLowerCase() === dataset.toLowerCase())
  if (!rel) return []
  const q = compileQuery({ chart: { dataset, type: 'table', enc: { ...emptyEncodings(), x: [{ field }], y: [{ field, agg: 'count' }] }, filters: [], options: {} }, columns: rel.columns, calcs: s.project?.calcs.filter((c) => c.dataset.toLowerCase() === dataset.toLowerCase()) ?? [], params: s.project?.params })
  const r = await E.query(`SELECT d0, m0 FROM (${q.sql.replace(/\nLIMIT \d+$/, '')}) ORDER BY m0 DESC LIMIT 1000`, { limit: 1000 })
  return r.rows.map(([value, n]) => ({ value, n: Number(n) })).sort((a, b) => String(a.value).localeCompare(String(b.value), undefined, { numeric: true }))
}

export function FilterDialog({ chart, field, filterId, measure, fields, onClose }: { chart: Chart; field: string; filterId?: string; measure?: boolean; fields: FieldDef[]; onClose: () => void }) {
  const existing = chart.filters.find((f) => f.id === filterId)
  const def = fields.find((f) => f.name === field)
  const type = def?.type ?? 'VARCHAR'
  const isMeasure = existing ? !!existing.agg : !!measure
  const modes: Mode[] = isMeasure ? ['range'] : isDate(type) ? ['range', 'relative', 'values'] : isNumeric(type) ? ['values', 'range', 'top'] : ['values', 'contains', 'top']
  const [mode, setMode] = useState<Mode>(existing ? (existing.op === 'in' || existing.op === 'not_in' ? 'values' : existing.op === 'between' ? 'range' : (existing.op as Mode)) : modes[0])
  const [values, setValues] = useState<{ value: Value; n: number }[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set((existing?.values ?? []).map(String)))
  const [exclude, setExclude] = useState(existing?.op === 'not_in')
  const [search, setSearch] = useState('')
  const [min, setMin] = useState(existing?.min ?? '')
  const [max, setMax] = useState(existing?.max ?? '')
  const [rel, setRel] = useState(existing?.relative ?? { n: 3, unit: 'month' as const, includeCurrent: true })
  const [contains, setContains] = useState(String(existing?.op === 'contains' ? (existing.values?.[0] ?? '') : ''))
  const measures = fields.filter((f) => f.role === 'measure')
  const [top, setTop] = useState(existing?.top ?? { n: 10, by: { field: measures[0]?.name ?? field, agg: 'sum' as Agg } })
  const [agg, setAgg] = useState<Agg>(existing?.agg ?? (def?.calcKind && def.calcKind !== 'row' ? 'none' : 'sum'))
  const [context, setContext] = useState(!!existing?.context)
  const [error, setError] = useState('')
  // Parameters the filter can follow instead of fixed values (Tableau: "Use a parameter").
  const [param, setParam] = useState(existing?.param ?? '')
  const [minParam, setMinParam] = useState(existing?.minParam ?? '')
  const [maxParam, setMaxParam] = useState(existing?.maxParam ?? '')
  const allParams = useApp((s) => s.project?.params) ?? []
  const numParams = allParams.filter((p) => p.type === 'number')
  const rangeParams = allParams.filter((p) => (isDate(type) && !isMeasure ? p.type === 'date' : p.type === 'number'))
  const pick = (value: string, set: (v: string) => void, list: typeof allParams, testid: string) =>
    list.length ? (
      <select aria-label="Or a parameter" className={cx(inputCls, 'mt-1 h-7 text-[12px]')} value={value} onChange={(e) => set(e.target.value)} data-testid={testid}>
        <option value="">a fixed value</option>
        {list.map((p) => (
          <option key={p.id} value={p.name}>
            parameter: {p.name}
          </option>
        ))}
      </select>
    ) : null

  useEffect(() => {
    if (mode !== 'values' || values) return
    distinctValues(chart.dataset, field).then(setValues, (e: Error) => setError(e.message))
  }, [mode, values, chart.dataset, field])

  const shown = useMemo(() => (values ?? []).filter((v) => !search || String(v.value ?? 'Null').toLowerCase().includes(search.toLowerCase())), [values, search])
  const save = () => {
    const base: ChartFilter = { id: existing?.id ?? newId(), field, op: 'in', context: context || undefined }
    let f: ChartFilter
    const ends = { ...(minParam ? { minParam } : {}), ...(maxParam ? { maxParam } : {}) }
    if (isMeasure) f = { ...base, agg, op: 'between', min: min === '' ? null : Number(min), max: max === '' ? null : Number(max), ...ends }
    else if (mode === 'values') f = { ...base, op: exclude ? 'not_in' : 'in', values: param ? [] : (values ?? []).filter((v) => picked.has(String(v.value))).map((v) => v.value), ...(param ? { param } : {}) }
    else if (mode === 'range') f = { ...base, op: 'between', min: min === '' ? null : isDate(type) ? String(min) : Number(min), max: max === '' ? null : isDate(type) ? String(max) : Number(max), ...ends }
    else if (mode === 'relative') f = { ...base, op: 'relative', relative: rel }
    else if (mode === 'contains') f = { ...base, op: 'contains', values: [contains], ...(param ? { param } : {}) }
    else f = { ...base, op: 'top', top, ...(param ? { param } : {}) }
    updateChart(chart.id, (c) => ({ ...c, filters: existing ? c.filters.map((x) => (x.id === existing.id ? f : x)) : [...c.filters, f] }))
    onClose()
  }
  const labels: Record<Mode, string> = { values: 'Values', range: 'Range', relative: 'Relative dates', contains: 'Contains', top: 'Top N' }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Filter ${isMeasure && agg !== 'none' ? `${AGG_LABEL[agg]} of ${field}` : field}`} width={480} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} data-testid="filter-apply">Apply</Btn></>}>
      {modes.length > 1 && (
        <div className="mb-3">
          <Segmented value={mode} onChange={setMode} label="Filter kind" options={modes.map((m) => ({ value: m, label: labels[m] }))} />
        </div>
      )}
      {error && <p className="mb-2 text-[12.5px] text-danger">{error}</p>}
      {isMeasure && def?.calcKind !== 'aggregate' && def?.calcKind !== 'tablecalc' && (
        <Field label="Aggregate">
          <select aria-label="Aggregate" className={inputCls} value={agg} onChange={(e) => setAgg(e.target.value as Agg)}>
            {(['sum', 'avg', 'min', 'max', 'count', 'countd', 'median'] as Agg[]).map((a) => (
              <option key={a} value={a}>
                {AGG_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {mode === 'values' && allParams.length > 0 && (
        <label className="mb-2 block text-[12px] text-text-2">
          Keep the value of
          {pick(param, setParam, allParams, 'filter-param')}
        </label>
      )}
      {mode === 'values' && !param && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <input aria-label="Search values" placeholder="Search values" className={inputCls} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Btn size="sm" onClick={() => setPicked(new Set([...picked, ...shown.map((v) => String(v.value))]))}>
              All
            </Btn>
            <Btn size="sm" onClick={() => setPicked(new Set([...picked].filter((p) => !shown.some((v) => String(v.value) === p))))}>
              None
            </Btn>
          </div>
          {!values ? (
            <div className="flex items-center gap-2 py-4 text-[12.5px] text-text-3">
              <Loader2 className="size-4 animate-spin" /> Loading values…
            </div>
          ) : (
            <ul className="max-h-[280px] overflow-y-auto rounded-lg border border-border" data-testid="filter-values">
              {shown.map((v) => (
                <li key={String(v.value)}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1 hover:bg-hover">
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={picked.has(String(v.value))} onChange={() => setPicked((s) => (s.has(String(v.value)) ? new Set([...s].filter((x) => x !== String(v.value))) : new Set([...s, String(v.value)])))} />
                    <span className={cx('flex-1 truncate text-[12.5px]', v.value === null && 'italic text-text-3')}>{v.value === null ? 'Null' : String(v.value)}</span>
                    <span className="text-[11px] tabular-nums text-text-3">{v.n.toLocaleString()}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-2 flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={exclude} onChange={(e) => setExclude(e.target.checked)} /> Exclude the selected values
          </label>
        </>
      )}
      {(mode === 'range' || isMeasure) && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="At least">
            {!minParam && <input aria-label="Minimum" type={isDate(type) && !isMeasure ? 'date' : 'number'} className={inputCls} value={String(min ?? '')} onChange={(e) => setMin(e.target.value)} data-testid="filter-min" />}
            {pick(minParam, setMinParam, rangeParams, 'filter-min-param')}
          </Field>
          <Field label="At most">
            {!maxParam && <input aria-label="Maximum" type={isDate(type) && !isMeasure ? 'date' : 'number'} className={inputCls} value={String(max ?? '')} onChange={(e) => setMax(e.target.value)} data-testid="filter-max" />}
            {pick(maxParam, setMaxParam, rangeParams, 'filter-max-param')}
          </Field>
        </div>
      )}
      {mode === 'relative' && (
        <div className="flex items-center gap-2 text-[13px]">
          Last
          <input aria-label="How many" type="number" min={1} className={cx(inputCls, 'w-20')} value={rel.n} onChange={(e) => setRel({ ...rel, n: Math.max(1, Number(e.target.value) || 1) })} />
          <select aria-label="Unit" className={cx(inputCls, 'w-28')} value={rel.unit} onChange={(e) => setRel({ ...rel, unit: e.target.value as typeof rel.unit })}>
            {['day', 'week', 'month', 'quarter', 'year'].map((u) => (
              <option key={u} value={u}>
                {u}s
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={rel.includeCurrent} onChange={(e) => setRel({ ...rel, includeCurrent: e.target.checked })} /> including the current one
          </label>
        </div>
      )}
      {mode === 'contains' && (
        <Field label="Text contains">
          {!param && <input aria-label="Text" className={inputCls} value={contains} onChange={(e) => setContains(e.target.value)} />}
          {pick(param, setParam, allParams.filter((p) => p.type === 'text'), 'filter-param')}
        </Field>
      )}
      {mode === 'top' && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <select aria-label="Top or bottom" className={cx(inputCls, 'w-24')} value={top.bottom ? 'bottom' : 'top'} onChange={(e) => setTop({ ...top, bottom: e.target.value === 'bottom' })}>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
          {!param && <input aria-label="How many" type="number" min={1} className={cx(inputCls, 'w-20')} value={top.n} onChange={(e) => setTop({ ...top, n: Math.max(1, Number(e.target.value) || 1) })} data-testid="filter-top-n" />}
          {numParams.length > 0 && <div className="w-44">{pick(param, setParam, numParams, 'filter-top-param')}</div>}
          by
          <select aria-label="Measure" className={cx(inputCls, 'w-36')} value={top.by.field} onChange={(e) => setTop({ ...top, by: { field: e.target.value, agg: fields.find((f) => f.name === e.target.value)?.calcKind === 'aggregate' ? 'none' : 'sum' } })}>
            {measures.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {!isMeasure && (
        <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-3">
          <div>
            <div className="text-[12.5px] font-medium">Context filter</div>
            <div className="text-[11.5px] text-text-3">Applies first: FIXED calculations and top N see only the remaining data.</div>
          </div>
          <Switch checked={context} onChange={setContext} label="Context filter" />
        </div>
      )}
    </Modal>
  )
}

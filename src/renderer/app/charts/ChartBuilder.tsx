// The Charts workspace: saved charts on the left, the fields of the chart's data, shelves to drop them on, the chart,
// and its type and format on the right. Every field can also be added from its menu, without dragging.

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import * as Icons from 'lucide-react'
import { BUILTIN_MAPS, checkGeoJson } from '@/core/charts/geo'
import { DEFAULT_TEMPLATE } from '@/core/charts/more'
import { BarChart3, Calculator, ChevronDown, Copy, Filter, Hash, Calendar, Type, Plus, Search, Star, Trash2, X, MoreHorizontal, Sparkles, Image, FileCode2, Table2 } from 'lucide-react'
import { useApp, set, get, toast } from '../../state/store'
import * as P from '../../state/project'
import * as E from '../../state/engine'
import { Btn, IconBtn, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, MenuLabel, SubMenu, MenuCheck, Segmented, Switch, Tip, cx, inputCls } from '../../ui'
import { ChartView, compileChart, exportChart, modelColumns } from './ChartView'
import { FilterDialog } from './FilterDialog'
import { askText } from '../Dialogs'
import { CalcDialog } from './CalcDialog'
import { GroupDialog } from './GroupDialog'
import { ParamDialog } from './ParamDialog'
import { fieldDefs, defaultRef, AGGS, GRAINS, type FieldDef } from './fields'
import { PLUGINS, plugin, recommend } from '@/core/charts/plugins'
import { AGG_LABEL, compileQuery, fieldTitle, isDate, isNumeric, type Role } from '@/core/query/compile'
import { newId } from '@/core/project/sviz'
import { emptyEncodings, type CalcField, type Chart, type ChartFilter, type ChartOptions, type FieldRef, type QuickCalc, type Parameter, type ReferenceLine } from '@/shared/charts'

// ---------------------------------------------------------------- state

const NO_TYPES: Record<string, string> = {}
const useCharts = create<{ active: string | null; calcTypes: Record<string, Record<string, string>> }>(() => ({ active: null, calcTypes: {} }))

export function newChart(dataset: string, name?: string): Chart {
  const charts = get().project?.charts ?? []
  return { id: newId(), name: name ?? `Chart ${charts.length + 1}`, dataset, type: 'bar', enc: emptyEncodings(), filters: [], options: {}, updatedAt: Date.now() }
}

export function updateChart(id: string, fn: (c: Chart) => Chart) {
  P.edit((p) => ({ ...p, charts: p.charts.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c)) }))
}

export function openChart(id: string) {
  useCharts.setState({ active: id })
  set({ workspace: 'charts' })
}

const SHELVES: { role: Role | 'filters'; label: string; multi: boolean; icon: ReactNode }[] = [
  { role: 'x', label: 'Columns', multi: true, icon: <Icons.Columns3 className="size-3.5" /> },
  { role: 'y', label: 'Rows', multi: true, icon: <Icons.Rows3 className="size-3.5" /> },
  { role: 'color', label: 'Color', multi: false, icon: <Icons.Palette className="size-3.5" /> },
  { role: 'size', label: 'Size', multi: false, icon: <Icons.Maximize2 className="size-3.5" /> },
  { role: 'label', label: 'Label', multi: false, icon: <Type className="size-3.5" /> },
  { role: 'detail', label: 'Detail', multi: true, icon: <Icons.Layers className="size-3.5" /> },
  { role: 'tooltip', label: 'Tooltip', multi: true, icon: <Icons.MessageSquare className="size-3.5" /> },
  { role: 'facet', label: 'Panels', multi: false, icon: <Icons.LayoutGrid className="size-3.5" /> },
  { role: 'filters', label: 'Filters', multi: true, icon: <Filter className="size-3.5" /> }
]

type ShelfRole = Role | 'filters'

const getRefs = (c: Chart, role: Role): FieldRef[] => {
  const v = (c.enc as unknown as Record<string, FieldRef | FieldRef[] | undefined>)[role]
  return Array.isArray(v) ? v : v ? [v] : []
}

function setRefs(c: Chart, role: Role, refs: FieldRef[]): Chart {
  const multi = role === 'x' || role === 'y' || role === 'detail' || role === 'tooltip'
  return { ...c, enc: { ...c.enc, [role]: multi ? refs : refs[refs.length - 1] } }
}

// ---------------------------------------------------------------- workspace

export function ChartBuilder() {
  const project = useApp((s) => s.project!)
  const relations = useApp((s) => s.relations)
  const active = useCharts((s) => s.active)
  const chart = project.charts.find((c) => c.id === active) ?? project.charts[0] ?? null
  const create = () => {
    // Datasets first (they are usually what charts are for), then source tables.
    const ds = relations.find((r) => r.kind === 'dataset')?.name ?? project.datasets[0]?.name ?? relations[0]?.name ?? project.sources[0]?.tables[0]?.alias
    if (!ds) return toast('Add data first: charts are built from your tables and datasets.', 'info')
    const c = newChart(ds)
    P.edit((p) => ({ ...p, charts: [...p.charts, c] }))
    useCharts.setState({ active: c.id })
  }
  return (
    <div className="flex h-full" data-testid="charts-view">
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Charts">
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <h2 className="text-[13px] font-semibold">Charts</h2>
          <IconBtn label="New chart" onClick={create} data-testid="new-chart">
            <Plus className="size-4" />
          </IconBtn>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {project.charts.map((c) => (
            <li key={c.id} className="group flex items-center rounded-lg hover:bg-hover">
              <button onClick={() => useCharts.setState({ active: c.id })} aria-current={chart?.id === c.id ? 'true' : undefined} className={cx('flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[12.5px]', chart?.id === c.id ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2')} data-testid="chart-item">
                <ChartIcon type={c.type} />
                <span className="truncate">{c.name}</span>
                {c.favorite && <Star className="size-3 shrink-0 fill-current" />}
              </button>
              <ChartMenu c={c} />
            </li>
          ))}
          {!project.charts.length && <li className="px-2 py-1 text-[12px] leading-relaxed text-text-3">No charts yet. Create one to explore your data.</li>}
        </ul>
      </aside>
      {chart ? <Builder key={chart.id} chart={chart} /> : (
        <div className="flex flex-1 items-center justify-center p-10 text-center">
          <div>
            <BarChart3 className="mx-auto mb-3 size-8 text-text-3" />
            <div className="text-[14px] font-semibold">Build your first chart</div>
            <p className="mt-1 max-w-sm text-[12.5px] text-text-3">Pick a table or dataset, then drag fields onto Columns and Rows. Simple Viz suggests a chart type that fits.</p>
            <Btn variant="primary" className="mt-4" onClick={create} data-testid="new-chart-empty">
              <Plus className="size-4" /> New chart
            </Btn>
          </div>
        </div>
      )}
    </div>
  )
}

export function ChartIcon({ type, className }: { type: string; className?: string }) {
  const I = (Icons as unknown as Record<string, typeof BarChart3>)[plugin(type).icon] ?? BarChart3
  return <I className={cx('size-3.5 shrink-0', className)} />
}

function ChartMenu({ c }: { c: Chart }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label={`Actions for ${c.name}`} className="mr-1 flex size-6 items-center justify-center rounded text-text-3 opacity-0 hover:bg-active focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
          <MoreHorizontal className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={<Copy />} onSelect={() => {
          const copy = { ...structuredClone(c), id: newId(), name: `${c.name} (copy)` }
          P.edit((p) => ({ ...p, charts: [...p.charts, copy] }))
          useCharts.setState({ active: copy.id })
        }}>
          Duplicate
        </MenuItem>
        <MenuItem icon={<Star />} onSelect={() => updateChart(c.id, (x) => ({ ...x, favorite: !x.favorite }))}>
          {c.favorite ? 'Remove from favorites' : 'Mark as reusable favorite'}
        </MenuItem>
        <MenuSep />
        <MenuItem icon={<Trash2 />} onSelect={() => P.edit((p) => ({ ...p, charts: p.charts.filter((x) => x.id !== c.id) }))}>
          Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function Builder({ chart }: { chart: Chart }) {
  const relations = useApp((s) => s.relations)
  const project = useApp((s) => s.project!)
  const dark = useApp((s) => s.dark)
  const calcTypes = useCharts((s) => s.calcTypes[chart.dataset.toLowerCase()] ?? NO_TYPES)
  const model = project.models.find((m) => m.name.toLowerCase() === chart.dataset.toLowerCase())
  const rel = model ? { name: model.name, kind: 'dataset' as const, columns: modelColumns(model, relations) } : relations.find((r) => r.name.toLowerCase() === chart.dataset.toLowerCase())
  const calcs = useMemo(() => project.calcs.filter((c) => c.dataset.toLowerCase() === chart.dataset.toLowerCase()), [project.calcs, chart.dataset])
  const fields = useMemo(() => fieldDefs(rel?.columns ?? [], calcs, calcTypes), [rel, calcs, calcTypes])
  const [filterFor, setFilterFor] = useState<{ field: string; id?: string; asMeasure?: boolean } | null>(null)
  const [calcEdit, setCalcEdit] = useState<CalcField | 'new' | null>(null)
  const [groupFor, setGroupFor] = useState<FieldDef | null>(null)
  const [autoType, setAutoType] = useState(() => !chart.enc.x.length && !chart.enc.y.length)
  const upd = (fn: (c: Chart) => Chart) => updateChart(chart.id, fn)

  // Types of row-level calculated fields come from the engine (a zero-row query).
  useEffect(() => {
    if (!rel) return
    for (const c of calcs) {
      const f = fields.find((x) => x.name === c.name)
      if (!f || f.calcKind !== 'row' || calcTypes[c.name]) continue
      try {
        const q = compileChart({ dataset: chart.dataset, type: 'table', enc: { ...emptyEncodings(), x: [{ field: c.name }] }, filters: [], options: {} }, project, get().relations)
        void E.query(`SELECT * FROM (${q.sql.replace(/\n?LIMIT \d+$/, '')}) LIMIT 0`).then((r) => useCharts.setState((s) => ({ calcTypes: { ...s.calcTypes, [chart.dataset.toLowerCase()]: { ...(s.calcTypes[chart.dataset.toLowerCase()] ?? {}), [c.name]: r.columns[0]?.type ?? 'VARCHAR' } } })), () => {})
      } catch {
        /* shown in the field list */
      }
    }
  }, [calcs, rel, fields, calcTypes, chart.dataset, project.params])

  const summary = useMemo(() => {
    const all = [...chart.enc.x.map((r) => ['x', r] as const), ...chart.enc.y.map((r) => ['y', r] as const), ...(chart.enc.color ? [['color', chart.enc.color] as const] : []), ...(chart.enc.size ? [['size', chart.enc.size] as const] : []), ...chart.enc.detail.map((r) => ['detail', r] as const)]
    return {
      dims: all.filter(([, r]) => !r.agg).map(([role, r]) => ({ role: role as Role, type: fields.find((f) => f.name === r.field)?.type ?? 'VARCHAR' })),
      measures: all.filter(([, r]) => !!r.agg).length
    }
  }, [chart.enc, fields])
  const ranked = useMemo(() => recommend(summary), [summary])

  const add = (role: ShelfRole, f: FieldDef, at?: number) => {
    if (role === 'filters') return setFilterFor({ field: f.name, asMeasure: f.role === 'measure' && !!f.calcKind && f.calcKind !== 'row' })
    const measureShelf = role === 'size' || (role === 'color' && chart.type === 'heatmap')
    const ref = defaultRef(f, measureShelf ? true : undefined)
    upd((c) => {
      const refs = getRefs(c, role)
      const next = role === 'x' || role === 'y' || role === 'detail' || role === 'tooltip' ? [...refs.slice(0, at ?? refs.length), ref, ...refs.slice(at ?? refs.length)] : [ref]
      let out = setRefs(c, role, next)
      if (autoType) {
        const s = {
          dims: [...out.enc.x, ...out.enc.y, ...(out.enc.color ? [out.enc.color] : []), ...out.enc.detail].filter((r) => !r.agg).map((r) => ({ role: 'x' as Role, type: fields.find((x) => x.name === r.field)?.type ?? 'VARCHAR' })),
          measures: [...out.enc.x, ...out.enc.y, ...(out.enc.size ? [out.enc.size] : [])].filter((r) => !!r.agg).length
        }
        out = { ...out, type: recommend(s)[0].id }
      }
      return out
    })
  }

  const move = (from: { role: Role; index: number }, to: ShelfRole, at?: number) => {
    if (to === 'filters') return
    upd((c) => {
      const ref = getRefs(c, from.role)[from.index]
      let out = setRefs(c, from.role, getRefs(c, from.role).filter((_, i) => i !== from.index))
      const refs = getRefs(out, to)
      out = setRefs(out, to, to === 'x' || to === 'y' || to === 'detail' || to === 'tooltip' ? [...refs.slice(0, at ?? refs.length), ref, ...refs.slice(at ?? refs.length)] : [ref])
      return out
    })
  }

  const exportImage = async (kind: 'png' | 'svg') => {
    const el = document.querySelector<HTMLElement>('[data-testid=chart-canvas]')
    const out = el && exportChart(el, kind, 3, dark)
    if (!out) return toast('This chart type has no image export; use a table export instead.', 'info')
    const path = await window.simpleViz.saveDialog(`${chart.name}.${kind}`, [kind])
    if (!path) return
    const bytes = kind === 'png' ? Uint8Array.from(atob(out.split(',')[1]), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(out)
    await window.simpleViz.writeFile(path, bytes)
    toast(`Saved ${path.split(/[\\/]/).pop()}`, 'success')
  }

  return (
    <div className="flex min-w-0 flex-1">
      <FieldsPanel chart={chart} fields={fields} onAdd={add} onDataset={(name) => upd((c) => ({ ...c, dataset: name, enc: emptyEncodings(), filters: [] }))} onCalc={setCalcEdit} onGroup={setGroupFor} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
          <input aria-label="Chart name" className="h-8 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[14px] font-semibold outline-none hover:border-border focus:border-accent" defaultValue={chart.name} key={chart.name} onBlur={(e) => e.target.value.trim() && e.target.value !== chart.name && upd((c) => ({ ...c, name: e.target.value.trim() }))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid="chart-name" />
          <Menu>
            <MenuTrigger asChild>
              <Btn size="sm" variant="ghost">
                <Icons.Download className="size-3.5" /> Export
              </Btn>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Image />} onSelect={() => void exportImage('png')}>
                PNG image (high resolution)
              </MenuItem>
              <MenuItem icon={<FileCode2 />} onSelect={() => void exportImage('svg')}>
                SVG image
              </MenuItem>
              <MenuItem icon={<Table2 />} onSelect={() => void exportData(chart)}>
                Chart data (CSV)
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <div className="border-b border-border bg-panel-2 px-3 py-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {SHELVES.filter((s) => s.role === 'x' || s.role === 'y').map((s) => (
              <Shelf key={s.role} shelf={s} chart={chart} fields={fields} onAdd={add} onMove={move} onFilter={setFilterFor} />
            ))}
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1.5">
            {SHELVES.filter((s) => s.role !== 'x' && s.role !== 'y').map((s) => (
              <Shelf key={s.role} shelf={s} chart={chart} fields={fields} onAdd={add} onMove={move} onFilter={setFilterFor} compact />
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-panel p-3" data-testid="chart-canvas">
          <ChartView chart={chart} />
        </div>
      </div>
      <FormatPanel chart={chart} fields={fields} ranked={ranked.map((p) => p.id)} onType={(t) => (setAutoType(false), upd((c) => ({ ...c, type: t })))} upd={upd} />
      {filterFor && <FilterDialog chart={chart} field={filterFor.field} filterId={filterFor.id} measure={filterFor.asMeasure || (fields.find((f) => f.name === filterFor.field)?.role === 'measure' && filterFor.asMeasure !== false)} fields={fields} onClose={() => setFilterFor(null)} />}
      {calcEdit && <CalcDialog dataset={chart.dataset} calc={calcEdit === 'new' ? null : calcEdit} onClose={() => setCalcEdit(null)} onCreated={(c) => {
        const f = fieldDefs(rel?.columns ?? [], [...calcs, c], calcTypes).find((x) => x.name === c.name)
        if (f) add('y', f)
      }} />}
      {groupFor && <GroupDialog dataset={chart.dataset} field={groupFor.name} type={groupFor.type} onClose={() => setGroupFor(null)} />}
    </div>
  )
}

async function exportData(chart: Chart) {
  const rel = get().relations.find((r) => r.name.toLowerCase() === chart.dataset.toLowerCase())
  if (!rel) return
  const p = get().project!
  const q = compileQuery({ chart, columns: rel.columns, calcs: p.calcs.filter((c) => c.dataset.toLowerCase() === chart.dataset.toLowerCase()), params: p.params, maxMarks: 1_000_000 })
  const path = await window.simpleViz.saveDialog(`${chart.name}.csv`, ['csv'])
  if (!path) return
  // Named columns instead of d0/m0.
  const named = `SELECT ${q.fields.map((f) => `${f.key} AS "${f.title.replace(/"/g, '""')}"`).join(', ')} FROM (${q.sql.replace(/\nLIMIT \d+$/, '')})`
  try {
    await window.simpleViz.engineExport(named, 'csv', path)
    toast(`Exported ${path.split(/[\\/]/).pop()}`, 'success')
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error')
  }
}

// ---------------------------------------------------------------- fields

const DRAG = 'application/x-simple-viz-field'

function FieldsPanel({ chart, fields, onAdd, onDataset, onCalc, onGroup }: { chart: Chart; fields: FieldDef[]; onAdd: (r: ShelfRole, f: FieldDef) => void; onDataset: (n: string) => void; onCalc: (c: CalcField | 'new') => void; onGroup: (f: FieldDef) => void }) {
  const relations = useApp((s) => s.relations)
  const models = useApp((s) => s.project!.models)
  const hierarchies = useApp((s) => s.project!.hierarchies)
  const params = useApp((s) => s.project!.params)
  const [paramEdit, setParamEdit] = useState<Parameter | 'new' | null>(null)
  const [q, setQ] = useState('')
  const shown = fields.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()))
  const group = (role: 'dim' | 'measure') => shown.filter((f) => f.role === role && !f.calc)
  return (
    <aside className="flex w-[230px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Fields">
      <div className="space-y-2 border-b border-border p-2.5">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-3">Data</span>
          <select aria-label="Data for this chart" className={cx(inputCls, 'h-8 font-mono text-[12px]')} value={chart.dataset} onChange={(e) => onDataset(e.target.value)} data-testid="chart-dataset">
            {!relations.some((r) => r.name === chart.dataset) && <option value={chart.dataset}>{chart.dataset} (missing)</option>}
            {relations.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
                {r.kind === 'dataset' ? ' (dataset)' : ''}
              </option>
            ))}
            {models.map((m) => (
              <option key={m.id} value={m.name}>
                {m.name} (model)
              </option>
            ))}
          </select>
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-3" />
          <input aria-label="Search fields" placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} className={cx(inputCls, 'h-7 pl-7 text-[12px]')} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <FieldGroup title="Dimensions" fields={group('dim')} onAdd={onAdd} onGroup={onGroup} />
        <FieldGroup title="Measures" fields={group('measure')} onAdd={onAdd} />
        {hierarchies.some((h) => h.dataset.toLowerCase() === chart.dataset.toLowerCase()) && (
          <>
            <div className="px-1.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-3">Hierarchies</div>
            <ul>
              {hierarchies.filter((h) => h.dataset.toLowerCase() === chart.dataset.toLowerCase()).map((h) => (
                <li key={h.id}>
                  <button onClick={() => updateChart(chart.id, (c) => ({ ...c, enc: { ...c.enc, x: [h.levels[0], ...c.enc.x.slice(1)] }, options: { ...c.options, drill: h.levels } }))} className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] hover:bg-hover" title={h.levels.map((l) => fieldTitle(l)).join(' › ')} data-testid={`hierarchy-${h.name}`}>
                    <Icons.ListTree className="size-3.5 text-[color:var(--chart-1)]" />
                    <span className="truncate">{h.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex items-center justify-between px-1.5 pb-1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Calculated fields</span>
          <IconBtn size="sm" label="New calculated field" onClick={() => onCalc('new')} data-testid="new-calc">
            <Plus className="size-3.5" />
          </IconBtn>
        </div>
        <ul>
          {shown.filter((f) => f.calc).map((f) => (
            <FieldItem key={f.name} f={f} onAdd={onAdd} onEdit={() => onCalc(f.calc!)} />
          ))}
        </ul>
        <div className="flex items-center justify-between px-1.5 pb-1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Parameters</span>
          <IconBtn size="sm" label="New parameter" onClick={() => setParamEdit('new')} data-testid="new-param">
            <Plus className="size-3.5" />
          </IconBtn>
        </div>
        <ul>
          {params.map((p) => (
            <li key={p.id}>
              <button onClick={() => setParamEdit(p)} className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] hover:bg-hover" data-testid={`param-${p.name}`} title={`In a formula: [Parameters].[${p.name}]`}>
                <Icons.SlidersHorizontal className="size-3.5 text-[color:var(--chart-1)]" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="truncate text-[11.5px] text-text-3">{p.value === null ? '—' : String(p.value)}</span>
              </button>
            </li>
          ))}
        </ul>
        {paramEdit && <ParamDialog param={paramEdit === 'new' ? null : paramEdit} onClose={() => setParamEdit(null)} />}
      </div>
    </aside>
  )
}

function FieldGroup({ title, fields, onAdd, onGroup }: { title: string; fields: FieldDef[]; onAdd: (r: ShelfRole, f: FieldDef) => void; onGroup?: (f: FieldDef) => void }) {
  if (!fields.length) return null
  return (
    <>
      <div className="px-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">{title}</div>
      <ul>
        {fields.map((f) => (
          <FieldItem key={f.name} f={f} onAdd={onAdd} onGroup={onGroup && !isDate(f.type) ? () => onGroup(f) : undefined} />
        ))}
      </ul>
    </>
  )
}

function FieldItem({ f, onAdd, onEdit, onGroup }: { f: FieldDef; onAdd: (r: ShelfRole, f: FieldDef) => void; onEdit?: () => void; onGroup?: () => void }) {
  const icon = f.calc ? <Calculator className="size-3.5" /> : isDate(f.type) ? <Calendar className="size-3.5" /> : isNumeric(f.type) ? <Hash className="size-3.5" /> : <Type className="size-3.5" />
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG, JSON.stringify({ field: f.name }))
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      className="group flex h-7 cursor-grab items-center gap-2 rounded-md px-1.5 text-[12.5px] hover:bg-hover active:cursor-grabbing"
      data-testid={`field-${f.name}`}
      title={f.error ?? `${f.name} · ${f.type}`}
    >
      <span className={cx(f.role === 'measure' ? 'text-[color:var(--chart-3)]' : 'text-[color:var(--chart-1)]', f.error && 'text-danger')}>{icon}</span>
      <span className={cx('min-w-0 flex-1 truncate', f.error && 'text-danger')}>{f.name}</span>
      <Menu>
        <MenuTrigger asChild>
          <button aria-label={`Add ${f.name} to the chart`} className="flex size-5 items-center justify-center rounded text-text-3 opacity-0 hover:bg-active focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100" data-testid={`field-menu-${f.name}`}>
            <Plus className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuLabel>Add to</MenuLabel>
          {SHELVES.map((s) => (
            <MenuItem key={s.role} icon={s.icon as never} onSelect={() => onAdd(s.role, f)} data-testid={`add-to-${s.role}`}>
              {s.label}
            </MenuItem>
          ))}
          {onEdit && (
            <>
              <MenuSep />
              <MenuItem icon={<Calculator />} onSelect={onEdit}>
                Edit calculation…
              </MenuItem>
            </>
          )}
          {onGroup && (
            <>
              <MenuSep />
              <MenuItem icon={<Icons.Group />} onSelect={onGroup} data-testid={`group-${f.name}`}>
                Create group…
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </li>
  )
}

// ---------------------------------------------------------------- shelves

function Shelf({ shelf, chart, fields, onAdd, onMove, onFilter, compact }: { shelf: (typeof SHELVES)[number]; chart: Chart; fields: FieldDef[]; onAdd: (r: ShelfRole, f: FieldDef, at?: number) => void; onMove: (from: { role: Role; index: number }, to: ShelfRole, at?: number) => void; onFilter: (f: { field: string; id?: string; asMeasure?: boolean }) => void; compact?: boolean }) {
  const [over, setOver] = useState(false)
  const hint = shelf.role !== 'filters' ? plugin(chart.type).shelves[shelf.role] : 'Limit the data'
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const raw = e.dataTransfer.getData(DRAG)
    if (!raw) return
    const d = JSON.parse(raw) as { field: string; from?: { role: Role; index: number } }
    if (d.from) onMove(d.from, shelf.role)
    else {
      const f = fields.find((x) => x.name === d.field)
      if (f) onAdd(shelf.role, f)
    }
  }
  const refs = shelf.role === 'filters' ? [] : getRefs(chart, shelf.role)
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cx('flex min-h-[32px] min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border px-1.5 py-1 transition-colors', over ? 'border-accent bg-accent-soft' : 'border-border bg-panel', !hint && shelf.role !== 'filters' && 'border-dashed')}
      data-testid={`shelf-${shelf.role}`}
      aria-label={`${shelf.label} shelf`}
    >
      <Tip label={hint ?? `${shelf.label} isn’t used by this chart type`}>
        <span className={cx('flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-text-3', compact ? 'w-[64px]' : 'w-[72px]')}>
          {shelf.icon}
          {shelf.label}
        </span>
      </Tip>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1">
        {shelf.role === 'filters'
          ? chart.filters.map((f) => <FilterPill key={f.id} f={f} chart={chart} onEdit={() => onFilter({ field: f.field, id: f.id, asMeasure: !!f.agg })} />)
          : refs.map((r, i) => <Pill key={`${r.field}-${i}`} r={r} role={shelf.role as Role} index={i} chart={chart} field={fields.find((f) => f.name === r.field)} />)}
        {!refs.length && !(shelf.role === 'filters' && chart.filters.length) && <span className="truncate px-1 text-[11.5px] text-text-3">{compact ? 'Drop a field' : 'Drop fields here'}</span>}
      </div>
    </div>
  )
}

function Pill({ r, role, index, chart, field }: { r: FieldRef; role: Role; index: number; chart: Chart; field?: FieldDef }) {
  const measure = !!r.agg
  const date = field && isDate(field.type) && !measure
  const patch = (p: Partial<FieldRef>) => updateChart(chart.id, (c) => setRefs(c, role, getRefs(c, role).map((x, i) => (i === index ? { ...x, ...p } : x))))
  const remove = () => updateChart(chart.id, (c) => setRefs(c, role, getRefs(c, role).filter((_, i) => i !== index)))
  const quick: [QuickCalc | undefined, string][] = [[undefined, 'None'], ['running_sum', 'Running total'], ['running_avg', 'Running average'], ['pct_total', 'Percent of total'], ['rank', 'Rank'], ['diff_prev', 'Difference from previous'], ['pct_diff_prev', 'Percent difference from previous'], ['moving_avg_3', 'Moving average (3)'], ['yoy', 'Year-over-year growth']]
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          draggable
          onDragStart={(e) => e.dataTransfer.setData(DRAG, JSON.stringify({ field: r.field, from: { role, index } }))}
          className={cx('flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-[12px] font-medium shadow-sm', !field ? 'bg-danger-strong text-white' : measure ? 'bg-[color:var(--pill-measure)] text-[color:var(--pill-text)]' : 'bg-[color:var(--pill-dim)] text-[color:var(--pill-text)]')}
          data-testid={`pill-${role}-${index}`}
          title={!field ? `${r.field} is not in this data` : undefined}
        >
          <span className="truncate">{fieldTitle(r)}</span>
          {r.quick && <span className="opacity-80">△</span>}
          <ChevronDown className="size-3 shrink-0 opacity-80" />
        </button>
      </MenuTrigger>
      <MenuContent>
        {measure && r.agg !== 'none' && (
          <SubMenu label={`Aggregate: ${AGG_LABEL[r.agg!]}`}>
            {AGGS.map((a) => (
              <MenuCheck key={a} checked={r.agg === a} onCheckedChange={() => patch({ agg: a })}>
                {AGG_LABEL[a]}
              </MenuCheck>
            ))}
          </SubMenu>
        )}
        {date && (
          <SubMenu label={`Date: ${r.grain ?? 'exact'}`}>
            {GRAINS.map((g) => (
              <MenuCheck key={g} checked={(r.grain ?? 'exact') === g} onCheckedChange={() => patch({ grain: g })}>
                {g === 'exact' ? 'Exact date' : g[0].toUpperCase() + g.slice(1)}
              </MenuCheck>
            ))}
          </SubMenu>
        )}
        {measure && (
          <SubMenu label="Quick calculation">
            {quick.map(([q, label]) => (
              <MenuCheck key={label} checked={r.quick === q} onCheckedChange={() => patch({ quick: q })}>
                {label}
              </MenuCheck>
            ))}
          </SubMenu>
        )}
        {(r.quick || field?.calcKind === 'tablecalc') && (
          <SubMenu label="Compute using">
            <MenuCheck checked={!r.computeUsing?.length} onCheckedChange={() => patch({ computeUsing: undefined })}>
              Along the x axis (default)
            </MenuCheck>
            {chartDims(chart).map((f) => (
              <MenuCheck key={f} checked={r.computeUsing?.[0] === f} onCheckedChange={() => patch({ computeUsing: [f] })} data-testid={`compute-using-${f}`}>
                Along {f}
              </MenuCheck>
            ))}
          </SubMenu>
        )}
        {measure && (
          <SubMenu label="Number format">
            {[[undefined, 'Automatic'], ['#,##0', 'Number (1,234)'], ['#,##0.00', 'Number (1,234.56)'], ['$#,##0', 'Currency ($1,234)'], ['$#,##0.00', 'Currency ($1,234.56)'], ['0%', 'Percent (12%)'], ['0.0%', 'Percent (12.3%)'], ['#,##0.0,,"M"', 'Millions (1.2M)'], ['#,##0.0,"K"', 'Thousands (1.2K)']].map(([code, label]) => (
              <MenuCheck key={label} checked={r.format === code} onCheckedChange={() => patch({ format: code })}>
                {label}
              </MenuCheck>
            ))}
          </SubMenu>
        )}
        {!measure && field && isNumeric(field.type) && <MenuItem onSelect={() => patch({ agg: 'sum' })}>Use as measure (Sum)</MenuItem>}
        {measure && r.agg !== 'none' && field && <MenuItem onSelect={() => patch({ agg: undefined, quick: undefined, format: undefined })}>Use as dimension</MenuItem>}
        <MenuItem
          onSelect={async () => {
            const label = await askText('Rename field', 'Name shown in the chart', fieldTitle(r))
            if (label !== null) patch({ label: label.trim() || undefined })
          }}
        >
          Rename…
        </MenuItem>
        <MenuSep />
        <MenuItem icon={<X />} onSelect={remove} data-testid="pill-remove">
          Remove
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function filterSummary(f: ChartFilter): string {
  const field = f.agg ? `${AGG_LABEL[f.agg]} of ${f.field}` : f.field
  switch (f.op) {
    case 'in':
      return `${field}: ${f.values?.length === 1 ? String(f.values[0]) : `${f.values?.length ?? 0} values`}`
    case 'not_in':
      return `${field}: not ${f.values?.length ?? 0} values`
    case 'between':
      return `${field}: ${f.min ?? '…'} – ${f.max ?? '…'}`
    case 'top':
      return `${field}: ${f.top?.bottom ? 'bottom' : 'top'} ${f.top?.n}`
    case 'relative':
      return `${field}: last ${f.relative?.n} ${f.relative?.unit}s`
    case 'contains':
      return `${field} contains “${f.values?.[0]}”`
    default:
      return `${field}: ${f.op.replace('_', ' ')}`
  }
}

function FilterPill({ f, chart, onEdit }: { f: ChartFilter; chart: Chart; onEdit: () => void }) {
  return (
    <span className="flex h-6 min-w-0 max-w-full items-center rounded-md bg-text-2 text-[12px] font-medium text-bg">
      <button onClick={onEdit} className="truncate px-2" data-testid="filter-pill" title={filterSummary(f)}>
        {f.context && <span className="mr-1 opacity-70">⦿</span>}
        {filterSummary(f)}
      </button>
      <button aria-label={`Remove filter on ${f.field}`} onClick={() => updateChart(chart.id, (c) => ({ ...c, filters: c.filters.filter((x) => x.id !== f.id) }))} className="flex h-6 w-5 items-center justify-center opacity-70 hover:opacity-100">
        <X className="size-3" />
      </button>
    </span>
  )
}

// ---------------------------------------------------------------- type and format

function FormatPanel({ chart, fields, ranked, onType, upd }: { chart: Chart; fields: FieldDef[]; ranked: string[]; onType: (t: string) => void; upd: (fn: (c: Chart) => Chart) => void }) {
  const o = chart.options
  const setO = (p: Partial<ChartOptions>) => upd((c) => ({ ...c, options: { ...c.options, ...p } }))
  const best = ranked[0]
  const type = plugin(chart.type)
  const cartesian = ['bar', 'line', 'area', 'combo'].includes(chart.type)
  const lines = o.refLines ?? []
  const toggleLine = (kind: 'average' | 'median' | 'trend' | 'max' | 'min' | 'band') => setO({ refLines: lines.some((l) => l.kind === kind) ? lines.filter((l) => l.kind !== kind) : [...lines, { id: kind, kind }] })
  return (
    <aside className="w-[236px] shrink-0 overflow-y-auto border-l border-border bg-panel p-3" aria-label="Chart type and format">
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-3">
        <span>Chart type</span>
        {best && best !== chart.type && (
          <button onClick={() => onType(best)} className="flex items-center gap-1 normal-case tracking-normal text-accent-ink hover:underline" data-testid="use-recommended">
            <Sparkles className="size-3" /> Use {plugin(best).label}
          </button>
        )}
      </div>
      {(['main', 'more'] as const).map((g) => (
      <div key={g}>
      {g === 'more' && <div className="mb-1 mt-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">More types</div>}
      <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label={g === 'more' ? 'More chart types' : 'Chart type'}>
        {PLUGINS.filter((p) => (p.group === 'more') === (g === 'more')).map((p) => (
          <Tip key={p.id} label={`${p.label}${p.id === best ? ' — recommended for these fields' : ''}`}>
            <button role="radio" aria-checked={chart.type === p.id} aria-label={p.label} onClick={() => onType(p.id)} data-testid={`type-${p.id}`} className={cx('relative flex aspect-square items-center justify-center rounded-lg border text-text-2 transition-colors hover:bg-hover', chart.type === p.id ? 'border-accent bg-accent-soft text-accent-ink' : 'border-border')}>
              <ChartIcon type={p.id} className="size-[18px]" />
              {p.id === best && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent" aria-hidden="true" />}
            </button>
          </Tip>
        ))}
      </div>
      </div>
      ))}
      <p className="mt-1.5 text-[11.5px] text-text-3">{type.label}</p>

      <div className="mt-4 space-y-3 border-t border-border pt-3">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-text-2">Title</span>
          <input className={cx(inputCls, 'h-7 text-[12px]')} defaultValue={o.title ?? ''} key={`t${o.title}`} onBlur={(e) => e.target.value !== (o.title ?? '') && setO({ title: e.target.value || undefined })} aria-label="Chart title" data-testid="chart-title" />
        </label>
        {cartesian && (
          <>
            <Row label="Stacking">
              <Segmented value={o.stack ?? 'none'} onChange={(v) => setO({ stack: v })} label="Stacking" options={[{ value: 'none', label: 'Off' }, { value: 'stacked', label: 'Stack' }, { value: 'percent', label: '100%' }]} />
            </Row>
            {chart.type === 'bar' && (
              <Row label="Horizontal">
                <Switch checked={!!o.horizontal} onChange={(v) => setO({ horizontal: v })} label="Horizontal bars" />
              </Row>
            )}
            {chart.type !== 'bar' && (
              <Row label="Smooth lines">
                <Switch checked={!!o.smooth} onChange={(v) => setO({ smooth: v })} label="Smooth lines" />
              </Row>
            )}
          </>
        )}
        {chart.type === 'pie' && (
          <Row label="Donut">
            <Switch checked={!!o.donut} onChange={(v) => setO({ donut: v })} label="Donut" />
          </Row>
        )}
        {chart.type === 'histogram' && (
          <Row label="Bins">
            <input type="number" min={2} max={200} aria-label="Number of bins" className={cx(inputCls, 'h-7 w-20 text-[12px]')} value={o.bins ?? 20} onChange={(e) => setO({ bins: Math.max(2, Math.min(200, Number(e.target.value) || 20)) })} />
          </Row>
        )}
        <Row label="Value labels">
          <Switch checked={!!o.labels} onChange={(v) => setO({ labels: v })} label="Value labels" />
        </Row>
        <Row label="Legend">
          <select aria-label="Legend position" className={cx(inputCls, 'h-7 w-24 text-[12px]')} value={o.legend ?? 'auto'} onChange={(e) => setO({ legend: e.target.value as ChartOptions['legend'] })}>
            {['auto', 'top', 'right', 'bottom', 'none'].map((v) => (
              <option key={v} value={v}>
                {v[0].toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Sort">
          <select aria-label="Sort" className={cx(inputCls, 'h-7 w-28 text-[12px]')} value={o.sort ? `${o.sort.by}-${o.sort.dir}` : 'category-asc'} onChange={(e) => {
            const [by, dir] = e.target.value.split('-') as ['category' | 'value', 'asc' | 'desc']
            setO({ sort: { by, dir } })
          }} data-testid="chart-sort">
            <option value="category-asc">A → Z</option>
            <option value="category-desc">Z → A</option>
            <option value="value-desc">Largest first</option>
            <option value="value-asc">Smallest first</option>
          </select>
        </Row>
        {chart.enc.x[0] && !chart.enc.x[0].agg && <DrillPath chart={chart} fields={fields} setO={setO} />}
        {chart.type === 'gauge' && (
          <Row label="Scale">
            <div className="flex items-center gap-1">
              <input type="number" aria-label="Gauge minimum" placeholder="0" className={cx(inputCls, 'h-7 w-14 px-1.5 text-[12px]')} value={o.gauge?.min ?? ''} onChange={(e) => setO({ gauge: { ...o.gauge, min: e.target.value === '' ? undefined : Number(e.target.value) } })} />
              <span className="text-text-3">–</span>
              <input type="number" aria-label="Gauge maximum" placeholder="auto" className={cx(inputCls, 'h-7 w-16 px-1.5 text-[12px]')} value={o.gauge?.max ?? ''} onChange={(e) => setO({ gauge: { ...o.gauge, max: e.target.value === '' ? undefined : Number(e.target.value) } })} />
            </div>
          </Row>
        )}
        {(chart.type === 'map' || chart.type === 'pointmap') && <MapPicker chart={chart} setO={setO} />}
        {chart.type === 'custom' && <TemplateEditor key={chart.id} value={o.template} onChange={(template) => setO({ template })} />}
        {(cartesian || chart.type === 'scatter') && (
          <div>
            <span className="mb-1 block text-[12px] font-medium text-text-2">Analytics</span>
            <div className="flex flex-wrap gap-1">
              {(chart.type === 'scatter' ? (['trend'] as const) : (['average', 'median', 'max', 'min', 'trend', 'band'] as const)).map((k) => (
                <button key={k} onClick={() => toggleLine(k)} aria-pressed={lines.some((l) => l.kind === k)} className={cx('h-6 rounded-md border px-2 text-[11.5px] capitalize', lines.some((l) => l.kind === k) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-border text-text-2 hover:bg-hover')} data-testid={`refline-${k}`}>
                  {k === 'trend' ? 'Trend line' : k === 'band' ? '±1 SD band' : `${k} line`}
                </button>
              ))}
            </div>
            {cartesian && <ParamLine lines={lines} setLines={(refLines) => setO({ refLines })} />}
            {cartesian && chart.enc.x.length === 1 && chart.enc.x[0].grain && chart.enc.x[0].grain !== 'exact' && (
              <label className="mt-2 flex items-center gap-2 text-[12px] text-text-2" title="Every period from the first to the last; table calculations run over the empty ones">
                <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={!!o.showMissing} onChange={(e) => setO({ showMissing: e.target.checked || undefined })} data-testid="show-missing" />
                Show missing dates
              </label>
            )}
            {(chart.type === 'line' || chart.type === 'area') && chart.enc.x[0]?.grain && chart.enc.x[0].grain !== 'exact' && (
              <label className="mt-2 flex items-center gap-2 text-[12px] text-text-2">
                <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={!!o.forecast} onChange={(e) => setO({ forecast: e.target.checked ? { periods: 6 } : undefined })} data-testid="forecast-toggle" />
                Forecast
                {o.forecast && (
                  <input type="number" min={1} max={120} aria-label="Periods to forecast" className={cx(inputCls, 'h-6 w-14 px-1.5 text-[12px]')} value={o.forecast.periods} onChange={(e) => setO({ forecast: { ...o.forecast, periods: Math.max(1, Number(e.target.value) || 1) } })} data-testid="forecast-periods" />
                )}
                {o.forecast && <span className="text-text-3">periods</span>}
              </label>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

/** Which map a map chart draws on; custom maps are GeoJSON files kept in the project. */
function MapPicker({ chart, setO }: { chart: Chart; setO: (p: Partial<ChartOptions>) => void }) {
  const maps = useApp((s) => s.project?.maps) ?? NO_MAPS
  const addMap = async () => {
    const [file] = await window.simpleViz.openDialog({ name: 'GeoJSON', extensions: ['geojson', 'json'] })
    if (!file) return
    try {
      if (file.data.byteLength > 25 * 2 ** 20) throw new Error('The file is over 25 MB. Simplify it first (for example with mapshaper).')
      const { fc, nameProps } = checkGeoJson(new TextDecoder().decode(file.data))
      const nameProp = nameProps[0]
      // Areas are matched on "name": keep the naming property under that key (and nothing else, to stay small).
      const geojson = { ...fc, features: fc.features.map((f) => ({ ...f, properties: { name: String(f.properties![nameProp]) } })) }
      const m = { id: newId(), name: file.name.replace(/\.(geo)?json$/i, ''), nameProp, geojson }
      P.edit((p) => ({ ...p, maps: [...(p.maps ?? []), m] }))
      setO({ map: m.id })
      toast(`Added the map “${m.name}”: ${geojson.features.length} areas named by “${nameProp}”`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <div>
      <span className="mb-1 block text-[12px] font-medium text-text-2">Map</span>
      <select aria-label="Map" className={cx(inputCls, 'h-7 w-full text-[12px]')} value={chart.options.map ?? ''} onChange={(e) => setO({ map: e.target.value || undefined })} data-testid="chart-map">
        {chart.type === 'map' && <option value="">Automatic (best match)</option>}
        {BUILTIN_MAPS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {maps.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <button className="mt-1 text-[11.5px] text-accent-ink hover:underline" onClick={addMap} data-testid="add-map">
        Add a map (GeoJSON)…
      </button>
    </div>
  )
}
const NO_MAPS: never[] = []

/** The custom visual's ECharts option, as JSON with data placeholders. Checked as it's typed; saved when valid. */
function TemplateEditor({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const [text, setText] = useState(value ?? DEFAULT_TEMPLATE)
  const [error, setError] = useState('')
  return (
    <div>
      <span className="mb-1 block text-[12px] font-medium text-text-2">ECharts option (JSON)</span>
      <textarea aria-label="Custom visual JSON" spellCheck={false} className={cx(inputCls, 'h-56 w-full resize-y py-1.5 font-mono text-[11px] leading-snug')} value={text} data-testid="custom-template" onChange={(e) => {
        setText(e.target.value)
        try {
          const v = JSON.parse(e.target.value)
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('It must be a JSON object.')
          setError('')
          onChange(e.target.value)
        } catch (err) {
          setError((err as Error).message)
        }
      }} />
      {error ? <p className="mt-1 text-[11.5px] text-danger" role="alert">{error}</p> : <p className="mt-1 text-[11px] leading-snug text-text-3">Placeholders: "$categories", "$values" ("$values:1"…), "$series" ("$series:line"), "$items", "$rows". Tooltips show plain text.</p>}
    </div>
  )
}

/** Drill-down: in a dashboard, clicking a mark shows the next field of the path, filtered to the clicked value. */
function DrillPath({ chart, fields, setO }: { chart: Chart; fields: FieldDef[]; setO: (p: Partial<ChartOptions>) => void }) {
  const path = chart.options.drill?.length ? chart.options.drill : [chart.enc.x[0]]
  const options = fields.filter((f) => f.role === 'dim').flatMap((f) => (isDate(f.type) ? GRAINS.filter((g) => g !== 'exact').map((g) => ({ key: `${f.name}|${g}`, label: `${f.name} (${g})`, ref: { field: f.name, grain: g } as FieldRef })) : [{ key: f.name, label: f.name, ref: { field: f.name } as FieldRef }]))
  return (
    <div>
      <span className="mb-1 block text-[12px] font-medium text-text-2">Drill down (dashboards)</span>
      <div className="flex flex-wrap items-center gap-1 text-[11.5px]" data-testid="drill-path">
        {path.map((r, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-text-3">›</span>}
            <span className="rounded bg-hover px-1.5 py-0.5">{fieldTitle(r)}</span>
            {i > 0 && i === path.length - 1 && (
              <button aria-label="Remove level" className="text-text-3 hover:text-text" onClick={() => setO({ drill: path.length > 2 ? path.slice(0, -1) : undefined })}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {path.length > 1 && (
        <button className="mt-1 text-[11.5px] text-accent-ink hover:underline" onClick={async () => {
          const name = await askText('Save as a hierarchy', 'Name (reuse it on other charts of this data)', path.map((r) => r.field).join(' › '))
          if (name?.trim()) P.edit((p) => ({ ...p, hierarchies: [...p.hierarchies, { id: newId(), name: name.trim(), dataset: chart.dataset, levels: path }] }))
        }} data-testid="save-hierarchy">
          Save as hierarchy…
        </button>
      )}
      <select aria-label="Add a drill-down level" className={cx(inputCls, 'mt-1.5 h-7 text-[12px]')} value="" onChange={(e) => {
        const o = options.find((x) => x.key === e.target.value)
        if (o) setO({ drill: [...path, o.ref] })
      }} data-testid="drill-add">
        <option value="">Add a level…</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] font-medium text-text-2">{label}</span>
      {children}
    </div>
  )
}

/** A reference line at a number parameter's value (it moves when the parameter changes). */
function ParamLine({ lines, setLines }: { lines: ReferenceLine[]; setLines: (l: ReferenceLine[]) => void }) {
  const params = useApp((s) => s.project!.params).filter((p) => p.type === 'number')
  if (!params.length) return null
  const cur = lines.find((l) => l.kind === 'param')
  return (
    <label className="mt-2 flex items-center gap-2 text-[12px] text-text-2">
      Line at
      <select className={cx(inputCls, 'h-6 flex-1 px-1 text-[12px]')} aria-label="Line at parameter" value={cur?.param ?? ''} onChange={(e) => setLines([...lines.filter((l) => l.kind !== 'param'), ...(e.target.value ? [{ id: 'param', kind: 'param' as const, param: e.target.value }] : [])])}>
        <option value="">no parameter</option>
        {params.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The dimensions in a chart's view (each once), for "compute using". */
function chartDims(c: Chart): string[] {
  const e = c.enc
  const refs = [...e.x, ...e.y, ...[e.color, e.size, e.label, e.facet].filter((r): r is FieldRef => !!r), ...e.detail]
  return [...new Set(refs.filter((r) => !r.agg).map((r) => r.field))]
}

// The Dashboards workspace: dashboards on the left with the objects to add, the canvas (edit: move, resize, snap,
// align, group, lock; view: filters, cross-filtering, drill-down), and the selected object's properties.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import * as Icons from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, set, get, toast } from '../../state/store'
import * as P from '../../state/project'
import { Btn, IconBtn, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, Segmented, Switch, Tip, cx, inputCls } from '../../ui'
import { useDash, setDash, getDash, resetFilters, NO_SELECTIONS, NO_MARKS } from './runtime'
import { ChartTile, TextTile, FilterTile, ButtonTile } from './Tile'
import { ChartIcon, openChart } from '../charts/ChartBuilder'
import { askText } from '../Dialogs'
import { exportDashboardPdf, exportDashboardPng } from './export'
import { align, distribute, clampItem, snap, layoutContainer, findSlot, TEMPLATES, type Align } from '@/core/dashboard'
import { newId } from '@/core/project/sviz'
import { GRID, SIZES, type DashAction, type DashItem, type Dashboard } from '@/shared/dashboards'

const { LayoutDashboard, Plus, Copy, Star, Trash2, MoreHorizontal, Type, Filter, MousePointerClick, Image, Square, Columns3, Rows3, Lock, Unlock, Group, Ungroup, Eye, Pencil, Maximize, Download, RotateCcw, AlignLeft, AlignCenterHorizontal, AlignRight, AlignStartHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignHorizontalSpaceAround, AlignVerticalSpaceAround, X, FileText } = Icons

export function newDashboard(name: string, items: DashItem[] = []): Dashboard {
  return { id: newId(), name, size: { mode: 'fit', w: 1366, h: 768 }, items, actions: [{ id: newId(), kind: 'filter', source: '*', target: '*' }], updatedAt: Date.now() }
}

export function updateDash(id: string, fn: (d: Dashboard) => Dashboard) {
  P.edit((p) => ({ ...p, dashboards: p.dashboards.map((d) => (d.id === id ? { ...fn(d), updatedAt: Date.now() } : d)) }))
}

const editItems = (id: string, fn: (items: DashItem[]) => DashItem[]) => updateDash(id, (d) => ({ ...d, items: fn(d.items) }))

export function DashboardsView() {
  const project = useApp((s) => s.project!)
  const { active, mode, presenting } = useDash(useShallow((s) => ({ active: s.active, mode: s.mode, presenting: s.presenting })))
  const d = project.dashboards.find((x) => x.id === active) ?? project.dashboards[0] ?? null
  useEffect(() => {
    if (d && d.id !== active) setDash({ active: d.id })
  }, [d, active])
  useEffect(() => {
    window.simpleViz.setFullScreen(presenting)
    const off = (e: KeyboardEvent) => e.key === 'Escape' && getDash().presenting && setDash({ presenting: false })
    window.addEventListener('keydown', off)
    return () => window.removeEventListener('keydown', off)
  }, [presenting])
  // Per-dashboard automatic refresh while it is shown.
  useEffect(() => {
    if (!d?.refreshEveryMin) return
    const t = setInterval(() => void P.refreshSources(), d.refreshEveryMin * 60_000)
    return () => clearInterval(t)
  }, [d?.id, d?.refreshEveryMin])

  const create = (template?: (typeof TEMPLATES)[number]) => {
    const charts = project.charts.map((c) => c.id)
    const items = template ? template.make(1366, 768, charts).map((i) => ({ ...i, id: newId() })) : []
    const nd = newDashboard(`Dashboard ${project.dashboards.length + 1}`, items)
    P.edit((p) => ({ ...p, dashboards: [...p.dashboards, nd] }))
    setDash({ active: nd.id, selected: [], mode: 'edit' })
  }

  if (presenting && d) return <Presentation d={d} />
  return (
    <div className="flex h-full" data-testid="dashboards-view">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Dashboards">
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <h2 className="text-[13px] font-semibold">Dashboards</h2>
          <Menu>
            <MenuTrigger asChild>
              <IconBtn label="New dashboard" data-testid="new-dashboard">
                <Plus className="size-4" />
              </IconBtn>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<LayoutDashboard />} onSelect={() => create()} data-testid="new-dashboard-blank">
                Blank dashboard
              </MenuItem>
              <MenuSep />
              {TEMPLATES.map((t) => (
                <MenuItem key={t.id} icon={<FileText />} onSelect={() => create(t)} data-testid={`template-${t.id}`}>
                  {t.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
        <ul className="space-y-0.5 px-2" aria-label="Dashboards">
          {project.dashboards.map((x) => (
            <li key={x.id} className="group flex items-center rounded-lg hover:bg-hover">
              <button aria-current={d?.id === x.id ? 'page' : undefined} onClick={() => setDash({ active: x.id, selected: [] })} className={cx('flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[12.5px]', d?.id === x.id ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2')} data-testid="dashboard-item">
                <LayoutDashboard className="size-3.5 shrink-0" />
                <span className="truncate">{x.name}</span>
                {x.favorite && <Star className="size-3 shrink-0 fill-current" />}
              </button>
              <DashMenu d={x} />
            </li>
          ))}
          {!project.dashboards.length && <li className="px-2 text-[12px] leading-relaxed text-text-3">No dashboards yet. Start blank or from a layout.</li>}
        </ul>
        {d && mode === 'edit' && <Palette d={d} />}
      </aside>
      {d ? <Workspace d={d} /> : (
        <div className="flex flex-1 items-center justify-center p-10 text-center">
          <div>
            <LayoutDashboard className="mx-auto mb-3 size-8 text-text-3" />
            <div className="text-[14px] font-semibold">Put your charts together</div>
            <p className="mt-1 max-w-sm text-[12.5px] text-text-3">A dashboard combines charts, KPIs, text and filters. Clicking a chart filters the others.</p>
            <div className="mt-4 flex justify-center gap-2">
              <Btn variant="primary" onClick={() => create()} data-testid="new-dashboard-empty">
                <Plus className="size-4" /> Blank dashboard
              </Btn>
              <Btn onClick={() => create(TEMPLATES[0])}>From a layout</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DashMenu({ d }: { d: Dashboard }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label={`Actions for ${d.name}`} className="mr-1 flex size-6 items-center justify-center rounded text-text-3 opacity-0 hover:bg-active focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
          <MoreHorizontal className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={<Pencil />} onSelect={async () => {
          const n = await askText('Rename dashboard', 'Name', d.name)
          if (n?.trim()) updateDash(d.id, (x) => ({ ...x, name: n.trim() }))
        }}>
          Rename…
        </MenuItem>
        <MenuItem icon={<Copy />} onSelect={() => {
          const copy = { ...structuredClone(d), id: newId(), name: `${d.name} (copy)` }
          P.edit((p) => ({ ...p, dashboards: [...p.dashboards, copy] }))
          setDash({ active: copy.id })
        }}>
          Duplicate
        </MenuItem>
        <MenuItem icon={<Star />} onSelect={() => updateDash(d.id, (x) => ({ ...x, favorite: !x.favorite }))}>
          {d.favorite ? 'Remove from favorites' : 'Add to favorites'}
        </MenuItem>
        <MenuSep />
        <MenuItem icon={<Trash2 />} onSelect={() => P.edit((p) => ({ ...p, dashboards: p.dashboards.filter((x) => x.id !== d.id) }))}>
          Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** Objects to add: saved charts (drag or click), text, filter controls, buttons, images, shapes, containers. */
function Palette({ d }: { d: Dashboard }) {
  const charts = useApp((s) => s.project!.charts)
  const add = (item: Omit<DashItem, 'id' | 'x' | 'y'>) => {
    const id = newId()
    // Into free space, so a new object never covers an existing one.
    const it: DashItem = { ...item, id, ...findSlot(d.items, item.w, item.h, d.size.w, d.size.h) }
    editItems(d.id, (items) => [...items, it])
    setDash({ selected: [id] })
  }
  const chartSize = (type: string) => (type === 'kpi' ? { w: 320, h: 144 } : { w: 560, h: 320 })
  const ordered = [...charts].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite))
  return (
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-border px-2 pb-3 pt-2">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">Charts</div>
      <ul>
        {ordered.map((c) => (
          <li key={c.id}>
            <button draggable onDragStart={(e) => e.dataTransfer.setData('application/x-sv-chart', c.id)} onClick={() => add({ kind: 'chart', chartId: c.id, ...chartSize(c.type) })} className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] hover:bg-hover" data-testid={`palette-chart-${c.name}`}>
              <ChartIcon type={c.type} className="text-text-3" />
              <span className="truncate">{c.name}</span>
              {c.favorite && <Star className="ml-auto size-3 shrink-0 fill-current text-accent-ink" />}
            </button>
          </li>
        ))}
        {!charts.length && <li className="px-1.5 text-[12px] text-text-3">Build charts in the Charts workspace first.</li>}
      </ul>
      <div className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-3">Objects</div>
      <div className="grid grid-cols-2 gap-1">
        <PaletteBtn icon={<Type />} label="Text" onClick={() => add({ kind: 'text', w: 320, h: 48, text: 'Title', textStyle: { size: 20, bold: true } })} testid="add-text" />
        <PaletteBtn icon={<Filter />} label="Filter" onClick={async () => {
          const field = await askText('Add a filter control', 'Field to filter by (every chart that has it is filtered)', 'region')
          if (field?.trim()) add({ kind: 'filter', w: 220, h: 200, filter: { field: field.trim(), mode: 'list', multi: true } })
        }} testid="add-filter" />
        <PaletteBtn icon={<MousePointerClick />} label="Button" onClick={() => add({ kind: 'button', w: 160, h: 40, button: { label: 'Reset filters', action: 'reset' } })} testid="add-button" />
        <PaletteBtn icon={<Image />} label="Image" onClick={async () => {
          const [f] = await window.simpleViz.openDialog({ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] })
          if (!f) return
          if (f.data.length > 4 * 1024 * 1024) return toast('Images up to 4 MB can be embedded.', 'error')
          const ext = f.name.split('.').pop()!.toLowerCase()
          const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
          let bin = ''
          f.data.forEach((b) => (bin += String.fromCharCode(b)))
          add({ kind: 'image', w: 240, h: 160, image: `data:${mime};base64,${btoa(bin)}` })
        }} testid="add-image" />
        <PaletteBtn icon={<Square />} label="Shape" onClick={() => add({ kind: 'shape', w: 240, h: 160, shape: { fill: 'var(--accent-soft)', radius: 12 } })} testid="add-shape" />
        <PaletteBtn icon={<Columns3 />} label="Row layout" onClick={() => add({ kind: 'container', w: 640, h: 280, container: { direction: 'row', gap: GRID * 2 } })} testid="add-row" />
        <PaletteBtn icon={<Rows3 />} label="Column layout" onClick={() => add({ kind: 'container', w: 320, h: 480, container: { direction: 'column', gap: GRID * 2 } })} testid="add-column" />
      </div>
    </div>
  )
}

function PaletteBtn({ icon, label, onClick, testid }: { icon: ReactNode; label: string; onClick: () => void; testid: string }) {
  return (
    <button onClick={onClick} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-text-2 hover:bg-hover [&>svg]:size-3.5" data-testid={testid}>
      {icon}
      {label}
    </button>
  )
}

// ---------------------------------------------------------------- canvas

function Workspace({ d }: { d: Dashboard }) {
  const { mode, selected } = useDash(useShallow((s) => ({ mode: s.mode, selected: s.selected })))
  const dirtyFilters = useDash((s) => Object.keys(s.selections[d.id] ?? NO_SELECTIONS).length + (s.marks[d.id] ?? NO_MARKS).length > 0)
  const canvasRef = useRef<HTMLDivElement>(null)
  const sel = d.items.filter((i) => selected.includes(i.id))
  const dark = useApp((s) => s.dark)
  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Wraps: with a selection, the arrange tools would not fit a narrow window on one line. */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5">
          <span className="mr-2 truncate text-[14px] font-semibold" data-testid="dashboard-name">{d.name}</span>
          <Segmented value={mode} onChange={(m) => setDash({ mode: m, selected: [] })} label="Mode" options={[{ value: 'edit', label: <span className="flex items-center gap-1"><Pencil className="size-3.5" /> Edit</span> }, { value: 'view', label: <span className="flex items-center gap-1" data-testid="mode-view"><Eye className="size-3.5" /> View</span> }]} />
          {mode === 'edit' && sel.length > 0 && <Arrange d={d} sel={sel} />}
          <div className="flex-1" />
          {dirtyFilters && (
            <Btn size="sm" variant="ghost" onClick={() => resetFilters(d.id)} data-testid="reset-filters">
              <RotateCcw className="size-3.5" /> Reset filters
            </Btn>
          )}
          <Tip label="Present full screen (Esc to leave)">
            <IconBtn label="Present" onClick={() => setDash({ presenting: true, selected: [] })} data-testid="present">
              <Maximize className="size-4" />
            </IconBtn>
          </Tip>
          <Menu>
            <MenuTrigger asChild>
              <Btn size="sm" variant="ghost" data-testid="dashboard-export">
                <Download className="size-3.5" /> Export
              </Btn>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<FileText />} onSelect={() => void exportDashboardPdf(d, canvasRef.current, dark)} data-testid="export-pdf">
                PDF
              </MenuItem>
              <MenuItem icon={<Image />} onSelect={() => void exportDashboardPng(d, canvasRef.current)} data-testid="export-png">
                PNG image
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <Canvas d={d} edit={mode === 'edit'} canvasRef={canvasRef} />
      </div>
      {mode === 'edit' && <Properties d={d} sel={sel} />}
    </div>
  )
}

function Arrange({ d, sel }: { d: Dashboard; sel: DashItem[] }) {
  const apply = (fn: (items: DashItem[]) => DashItem[]) => {
    const moved = new Map(fn(sel).map((i) => [i.id, i]))
    editItems(d.id, (items) => items.map((i) => moved.get(i.id) ?? i))
  }
  const al = (a: Align) => apply((s) => align(s, a))
  const one = sel.length === 1 ? sel[0] : null
  return (
    <div className="ml-2 flex flex-wrap items-center gap-0.5 border-l border-border pl-2" role="toolbar" aria-label="Arrange">
      {sel.length > 1 && (
        <>
          <IconBtn label="Align left" onClick={() => al('left')} data-testid="align-left"><AlignLeft className="size-4" /></IconBtn>
          <IconBtn label="Align centers" onClick={() => al('center')}><AlignCenterHorizontal className="size-4" /></IconBtn>
          <IconBtn label="Align right" onClick={() => al('right')}><AlignRight className="size-4" /></IconBtn>
          <IconBtn label="Align top" onClick={() => al('top')} data-testid="align-top"><AlignStartHorizontal className="size-4" /></IconBtn>
          <IconBtn label="Align middles" onClick={() => al('middle')}><AlignCenterVertical className="size-4" /></IconBtn>
          <IconBtn label="Align bottom" onClick={() => al('bottom')}><AlignEndHorizontal className="size-4" /></IconBtn>
          <IconBtn label="Distribute horizontally" disabled={sel.length < 3} onClick={() => apply((s) => distribute(s, 'h'))}><AlignHorizontalSpaceAround className="size-4" /></IconBtn>
          <IconBtn label="Distribute vertically" disabled={sel.length < 3} onClick={() => apply((s) => distribute(s, 'v'))}><AlignVerticalSpaceAround className="size-4" /></IconBtn>
          <IconBtn label="Group" onClick={() => { const g = newId(); apply((s) => s.map((i) => ({ ...i, group: g }))) }} data-testid="group"><Group className="size-4" /></IconBtn>
        </>
      )}
      {sel.some((i) => i.group) && <IconBtn label="Ungroup" onClick={() => apply((s) => s.map((i) => ({ ...i, group: undefined })))}><Ungroup className="size-4" /></IconBtn>}
      <IconBtn label={sel.every((i) => i.locked) ? 'Unlock' : 'Lock position'} active={sel.every((i) => i.locked)} onClick={() => apply((s) => s.map((i) => ({ ...i, locked: !sel.every((x) => x.locked) })))} data-testid="lock">
        {sel.every((i) => i.locked) ? <Lock className="size-4" /> : <Unlock className="size-4" />}
      </IconBtn>
      <IconBtn label="Duplicate" shortcut="Mod-d" onClick={() => duplicate(d, sel)}><Copy className="size-4" /></IconBtn>
      <IconBtn label="Delete" onClick={() => remove(d, sel)} data-testid="delete-item"><Trash2 className="size-4" /></IconBtn>
      {one?.kind === 'chart' && one.chartId && (
        <Btn size="sm" variant="ghost" onClick={() => openChart(one.chartId!)}>
          Edit chart
        </Btn>
      )}
    </div>
  )
}

function duplicate(d: Dashboard, sel: DashItem[]) {
  const copies = sel.map((i) => clampItem({ ...i, id: newId(), x: i.x + GRID * 3, y: i.y + GRID * 3, locked: false, group: undefined }, d.size.w, d.size.h))
  editItems(d.id, (items) => [...items, ...copies])
  setDash({ selected: copies.map((c) => c.id) })
}

function remove(d: Dashboard, sel: DashItem[]) {
  const ids = new Set(sel.map((i) => i.id))
  editItems(d.id, (items) => items.filter((i) => !ids.has(i.id) && !ids.has(i.parent ?? '')))
  setDash({ selected: [] })
}

/** Items with their positions resolved (children of layout containers are laid out by the container). */
function resolved(items: DashItem[]): DashItem[] {
  const out = items.filter((i) => !i.parent || !items.some((c) => c.id === i.parent))
  for (const c of items.filter((i) => i.kind === 'container')) out.push(...layoutContainer(c, items.filter((i) => i.parent === c.id)))
  return out
}

function Canvas({ d, edit, canvasRef }: { d: Dashboard; edit: boolean; canvasRef: React.RefObject<HTMLDivElement | null> }) {
  const host = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 1000, h: 700 })
  const selected = useDash((s) => s.selected)
  const [drag, setDrag] = useState<{ ids: string[]; dx: number; dy: number; resize?: string; id?: string } | null>(null)
  useEffect(() => {
    const el = host.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = d.size.mode === 'fixed' && !edit ? 1 : Math.min(1, (box.w - 32) / d.size.w, edit ? (box.h - 32) / d.size.h : Infinity)
  const items = resolved(d.items)
  const show = (i: DashItem) => {
    if (!drag || !drag.ids.includes(i.id)) return i
    if (drag.resize) {
      const r = drag.resize
      let { x, y, w, h } = i
      if (r.includes('e')) w += drag.dx
      if (r.includes('s')) h += drag.dy
      if (r.includes('w')) (x += drag.dx), (w -= drag.dx)
      if (r.includes('n')) (y += drag.dy), (h -= drag.dy)
      return clampItem({ ...i, x: snap(x), y: snap(y), w: snap(w), h: snap(h) }, d.size.w, d.size.h)
    }
    return clampItem({ ...i, x: snap(i.x + drag.dx), y: snap(i.y + drag.dy) }, d.size.w, d.size.h)
  }

  const start = (e: RPointerEvent, it: DashItem, resize?: string) => {
    if (!edit || e.button !== 0) return
    e.stopPropagation()
    const multi = e.shiftKey || e.metaKey || e.ctrlKey
    let sel = selected.includes(it.id) ? selected : multi ? [...selected, it.id] : [it.id]
    if (!resize && it.group) sel = [...new Set([...sel, ...d.items.filter((x) => x.group === it.group).map((x) => x.id)])]
    setDash({ selected: sel })
    if (it.locked || (it.parent && !resize)) return
    const x0 = e.clientX
    const y0 = e.clientY
    const ids = resize ? [it.id] : sel.filter((id) => !d.items.find((x) => x.id === id)?.locked)
    const move = (ev: PointerEvent) => setDrag({ ids, dx: (ev.clientX - x0) / scale, dy: (ev.clientY - y0) / scale, resize, id: it.id })
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      const dx = (ev.clientX - x0) / scale
      const dy = (ev.clientY - y0) / scale
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
      const final = { ids, dx, dy, resize }
      editItems(d.id, (all) =>
        all.map((i) => {
          if (!final.ids.includes(i.id)) return i
          if (resize) {
            let { x, y, w, h } = i
            if (resize.includes('e')) w += dx
            if (resize.includes('s')) h += dy
            if (resize.includes('w')) (x += dx), (w -= dx)
            if (resize.includes('n')) (y += dy), (h -= dy)
            return clampItem({ ...i, x: snap(x), y: snap(y), w: snap(w), h: snap(h) }, d.size.w, d.size.h)
          }
          return clampItem({ ...i, x: snap(i.x + dx), y: snap(i.y + dy) }, d.size.w, d.size.h)
        })
      )
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Keyboard: arrows move (Shift: farther), Delete removes, Ctrl/⌘+D duplicates, Escape clears the selection.
  const onKey = (e: React.KeyboardEvent) => {
    if (!edit || !selected.length) return
    const sel = d.items.filter((i) => selected.includes(i.id))
    const step = e.shiftKey ? GRID * 5 : GRID
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (delta[e.key]) {
      e.preventDefault()
      const [dx, dy] = delta[e.key]
      editItems(d.id, (all) => all.map((i) => (selected.includes(i.id) && !i.locked ? clampItem({ ...i, x: i.x + dx, y: i.y + dy }, d.size.w, d.size.h) : i)))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(d, sel)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      duplicate(d, sel)
    } else if (e.key === 'Escape') setDash({ selected: [] })
  }

  const dropChart = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('application/x-sv-chart')
    if (!id || !edit) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const size = get().project?.charts.find((c) => c.id === id)?.type === 'kpi' ? { w: 320, h: 144 } : { w: 560, h: 320 }
    const it = clampItem({ id: newId(), kind: 'chart', chartId: id, x: snap((e.clientX - r.left) / scale - size.w / 2), y: snap((e.clientY - r.top) / scale - size.h / 2), ...size }, d.size.w, d.size.h)
    editItems(d.id, (all) => [...all, it])
    setDash({ selected: [it.id] })
  }

  return (
    <div ref={host} className="relative min-h-0 flex-1 overflow-auto bg-workspace p-4" onPointerDown={() => edit && setDash({ selected: [] })}>
      <div style={{ width: d.size.w * scale, height: d.size.h * scale }} className="mx-auto">
        <div
          ref={canvasRef}
          tabIndex={edit ? 0 : -1}
          onKeyDown={onKey}
          onDragOver={(e) => edit && e.dataTransfer.types.includes('application/x-sv-chart') && e.preventDefault()}
          onDrop={dropChart}
          aria-label={`Dashboard ${d.name}${edit ? ', editing' : ''}`}
          className={cx('relative origin-top-left rounded-xl bg-bg shadow-[0_0_0_1px_var(--border),0_8px_30px_-12px_rgb(0_0_0/0.25)] outline-none', edit && 'bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]')}
          style={{ width: d.size.w, height: d.size.h, transform: `scale(${scale})`, background: !edit ? d.background : undefined }}
          data-testid="dashboard-canvas"
          data-scale={scale}
        >
          {items.map((raw) => {
            const it = show(raw)
            const isSel = edit && selected.includes(it.id)
            return (
              <div
                key={it.id}
                onPointerDown={(e) => start(e, raw)}
                className={cx('absolute overflow-hidden rounded-xl', it.kind === 'chart' || it.kind === 'filter' ? 'bg-panel shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]' : '', it.kind === 'container' && edit && 'border-2 border-dashed border-border-strong', isSel && 'ring-2 ring-accent', edit && !it.locked && 'cursor-move')}
                style={{ left: it.x, top: it.y, width: it.w, height: it.h, background: it.kind === 'shape' ? it.shape?.fill : undefined, borderRadius: it.kind === 'shape' ? it.shape?.radius : undefined, zIndex: isSel ? 3 : it.kind === 'shape' || it.kind === 'container' ? 0 : 1 }}
                data-testid={`item-${it.kind}`}
                data-item={it.id}
              >
                <div className={cx('h-full', edit && it.kind !== 'filter' && 'pointer-events-none')}>
                  <ItemBody d={d} it={it} interactive={!edit} />
                </div>
                {edit && it.locked && <Lock className="absolute right-1.5 top-1.5 size-3.5 text-text-3" aria-label="Locked" />}
                {isSel && !it.locked && selected.length === 1 && (
                  <>
                    {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((h) => (
                      <span
                        key={h}
                        onPointerDown={(e) => start(e, raw, h)}
                        data-testid={`handle-${h}`}
                        className="absolute size-3 rounded-sm border border-accent bg-elev"
                        style={{ cursor: `${h}-resize`, left: h.includes('w') ? -2 : h.includes('e') ? 'calc(100% - 10px)' : 'calc(50% - 6px)', top: h.includes('n') ? -2 : h.includes('s') ? 'calc(100% - 10px)' : 'calc(50% - 6px)' }}
                      />
                    ))}
                  </>
                )}
              </div>
            )
          })}
          {!d.items.length && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-text-3">{edit ? 'Drag charts here from the left, or click them to add.' : 'This dashboard is empty.'}</div>}
        </div>
      </div>
    </div>
  )
}

function ItemBody({ d, it, interactive }: { d: Dashboard; it: DashItem; interactive: boolean }) {
  switch (it.kind) {
    case 'chart':
      return <ChartTile d={d} item={it} interactive={interactive} />
    case 'text':
      return <TextTile d={d} item={it} />
    case 'filter':
      return <FilterTile d={d} item={it} />
    case 'button':
      return <ButtonTile d={d} item={it} interactive={interactive} />
    case 'image':
      return it.image ? <img src={it.image} alt="" className="h-full w-full object-contain" /> : null
    default:
      return null
  }
}

// ---------------------------------------------------------------- properties

function Properties({ d, sel }: { d: Dashboard; sel: DashItem[] }) {
  const project = useApp((s) => s.project!)
  const one = sel.length === 1 ? sel[0] : null
  const setItem = (p: Partial<DashItem>) => one && editItems(d.id, (items) => items.map((i) => (i.id === one.id ? { ...i, ...p } : i)))
  const containers = d.items.filter((i) => i.kind === 'container' && i.id !== one?.id)
  return (
    <aside className="w-[260px] shrink-0 space-y-4 overflow-y-auto border-l border-border bg-panel p-3" aria-label="Properties">
      {!one ? (
        <>
          <Section title="Dashboard">
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-text-2">Size</span>
              <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Dashboard size" value={SIZES.find((s) => s.w === d.size.w && s.h === d.size.h)?.id ?? 'custom'} onChange={(e) => {
                const s = SIZES.find((x) => x.id === e.target.value)
                if (s) updateDash(d.id, (x) => ({ ...x, size: { ...x.size, w: s.w, h: s.h }, items: x.items.map((i) => clampItem(i, s.w, s.h)) }))
              }} data-testid="dashboard-size">
                {SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
                {!SIZES.some((s) => s.w === d.size.w && s.h === d.size.h) && <option value="custom">Custom ({d.size.w} × {d.size.h})</option>}
              </select>
            </label>
            <Line label="Fit to window">
              <Switch checked={d.size.mode === 'fit'} onChange={(v) => updateDash(d.id, (x) => ({ ...x, size: { ...x.size, mode: v ? 'fit' : 'fixed' } }))} label="Fit to window" />
            </Line>
            <Line label="Refresh every">
              <select className={cx(inputCls, 'h-7 w-24 text-[12px]')} aria-label="Refresh every" value={d.refreshEveryMin ?? 0} onChange={(e) => updateDash(d.id, (x) => ({ ...x, refreshEveryMin: Number(e.target.value) || undefined }))}>
                {[0, 1, 5, 15, 60].map((m) => (
                  <option key={m} value={m}>
                    {m ? `${m} min` : 'Off'}
                  </option>
                ))}
              </select>
            </Line>
          </Section>
          <Actions d={d} />
        </>
      ) : (
        <Section title={{ chart: 'Chart', text: 'Text', filter: 'Filter control', button: 'Button', image: 'Image', shape: 'Shape', container: 'Layout container' }[one.kind]}>
          {one.kind === 'chart' && (
            <>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Chart</span>
                <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Chart in this tile" value={one.chartId ?? ''} onChange={(e) => setItem({ chartId: e.target.value })}>
                  <option value="">Choose…</option>
                  {project.charts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <Line label="Show title">
                <Switch checked={one.showTitle ?? true} onChange={(v) => setItem({ showTitle: v })} label="Show title" />
              </Line>
            </>
          )}
          {one.kind === 'text' && (
            <>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Text</span>
                <textarea className={cx(inputCls, 'h-20 py-1.5 text-[12px]')} aria-label="Text" defaultValue={one.text} key={one.id} onBlur={(e) => setItem({ text: e.target.value })} data-testid="text-edit" />
                <span className="mt-1 block text-[11px] text-text-3">{'{region}'} shows the current filter value: dynamic titles.</span>
              </label>
              <Line label="Size">
                <input type="number" min={8} max={72} aria-label="Font size" className={cx(inputCls, 'h-7 w-20 text-[12px]')} value={one.textStyle?.size ?? 14} onChange={(e) => setItem({ textStyle: { ...(one.textStyle ?? { size: 14 }), size: Number(e.target.value) || 14 } })} />
              </Line>
              <Line label="Bold">
                <Switch checked={!!one.textStyle?.bold} onChange={(v) => setItem({ textStyle: { ...(one.textStyle ?? { size: 14 }), bold: v } })} label="Bold" />
              </Line>
              <Line label="Align">
                <Segmented value={one.textStyle?.align ?? 'left'} onChange={(v) => setItem({ textStyle: { ...(one.textStyle ?? { size: 14 }), align: v } })} label="Align" options={[{ value: 'left', label: 'L' }, { value: 'center', label: 'C' }, { value: 'right', label: 'R' }]} />
              </Line>
            </>
          )}
          {one.kind === 'filter' && one.filter && (
            <>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Field</span>
                <input className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Filter field" defaultValue={one.filter.field} key={one.id} onBlur={(e) => e.target.value.trim() && setItem({ filter: { ...one.filter!, field: e.target.value.trim() } })} />
              </label>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Style</span>
                <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Filter style" value={one.filter.mode} onChange={(e) => setItem({ filter: { ...one.filter!, mode: e.target.value as never } })}>
                  <option value="list">Checkbox list</option>
                  <option value="dropdown">Dropdown (one value)</option>
                  <option value="search">Search list</option>
                  <option value="range">Number range</option>
                  <option value="dates">Date range</option>
                </select>
              </label>
              <Line label="Several values">
                <Switch checked={one.filter.multi !== false} onChange={(v) => setItem({ filter: { ...one.filter!, multi: v } })} label="Allow several values" />
              </Line>
            </>
          )}
          {one.kind === 'button' && one.button && (
            <>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Label</span>
                <input className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Button label" defaultValue={one.button.label} key={one.id} onBlur={(e) => setItem({ button: { ...one.button!, label: e.target.value } })} />
              </label>
              <label className="block text-[12px]">
                <span className="mb-1 block font-medium text-text-2">Action</span>
                <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Button action" value={one.button.action === 'navigate' ? `nav:${one.button.target}` : one.button.action} onChange={(e) => setItem({ button: e.target.value.startsWith('nav:') ? { ...one.button!, action: 'navigate', target: e.target.value.slice(4) } : { ...one.button!, action: e.target.value as never, target: undefined } })}>
                  <option value="reset">Reset filters</option>
                  <option value="refresh">Refresh data</option>
                  <option value="fullscreen">Present full screen</option>
                  {project.dashboards.filter((x) => x.id !== d.id).map((x) => (
                    <option key={x.id} value={`nav:${x.id}`}>
                      Go to {x.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {one.kind === 'shape' && (
            <Line label="Color">
              <input type="color" aria-label="Shape color" value={one.shape?.fill?.startsWith('#') ? one.shape.fill : '#f3d9cb'} onChange={(e) => setItem({ shape: { ...(one.shape ?? { radius: 12 }), fill: e.target.value } })} />
            </Line>
          )}
          {one.kind === 'container' && (
            <Line label="Direction">
              <Segmented value={one.container?.direction ?? 'row'} onChange={(v) => setItem({ container: { ...(one.container ?? { gap: GRID * 2 }), direction: v } })} label="Direction" options={[{ value: 'row', label: 'Row' }, { value: 'column', label: 'Column' }]} />
            </Line>
          )}
          {one.kind !== 'container' && containers.length > 0 && (
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-text-2">Inside layout</span>
              <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Layout container" value={one.parent ?? ''} onChange={(e) => setItem({ parent: e.target.value || undefined })}>
                <option value="">None (free position)</option>
                {containers.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {c.container?.direction === 'column' ? 'Column' : 'Row'} layout {i + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid grid-cols-4 gap-1.5 pt-1 text-[11px] text-text-3">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <label key={k} className="block">
                {k.toUpperCase()}
                <input type="number" step={GRID} aria-label={`Item ${k}`} className={cx(inputCls, 'h-7 px-1.5 text-[11.5px]')} value={Math.round(one[k])} onChange={(e) => setItem(clampItem({ ...one, [k]: snap(Number(e.target.value) || 0) }, d.size.w, d.size.h))} />
              </label>
            ))}
          </div>
        </Section>
      )}
    </aside>
  )
}

function Actions({ d }: { d: Dashboard }) {
  const charts = useApp((s) => s.project!.charts)
  const project = useApp((s) => s.project!)
  const chartItems = d.items.filter((i) => i.kind === 'chart')
  const name = (id: string) => (id === '*' ? 'Any chart' : charts.find((c) => c.id === chartItems.find((i) => i.id === id)?.chartId)?.name ?? 'Chart')
  const setActions = (fn: (a: DashAction[]) => DashAction[]) => updateDash(d.id, (x) => ({ ...x, actions: fn(x.actions) }))
  return (
    <Section title="Actions">
      <p className="text-[11.5px] leading-relaxed text-text-3">What happens when someone clicks a mark in View mode.</p>
      <ul className="space-y-1.5">
        {d.actions.map((a) => (
          <li key={a.id} className="rounded-lg bg-panel-2 p-2 text-[12px] shadow-[0_0_0_1px_var(--border)]">
            <div className="flex items-center gap-1.5">
              <select aria-label="Action kind" className="h-7 flex-1 rounded-md border border-border bg-panel px-1 text-[12px]" value={a.kind} onChange={(e) => setActions((all) => all.map((x) => (x.id === a.id ? { ...x, kind: e.target.value as DashAction['kind'], target: e.target.value === 'navigate' ? (project.dashboards.find((y) => y.id !== d.id)?.id ?? '') : '*' } : x)))}>
                <option value="filter">Filter</option>
                <option value="highlight">Highlight</option>
                <option value="navigate">Go to dashboard</option>
              </select>
              <IconBtn size="sm" label="Remove action" onClick={() => setActions((all) => all.filter((x) => x.id !== a.id))}>
                <X className="size-3.5" />
              </IconBtn>
            </div>
            <div className="mt-1 text-text-3">
              From{' '}
              <select aria-label="Source" className="h-6 rounded border border-border bg-panel px-0.5 text-[11.5px]" value={a.source} onChange={(e) => setActions((all) => all.map((x) => (x.id === a.id ? { ...x, source: e.target.value } : x)))}>
                <option value="*">any chart</option>
                {chartItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {name(i.id)}
                  </option>
                ))}
              </select>{' '}
              {a.kind === 'navigate' ? 'to ' : 'to '}
              {a.kind === 'navigate' ? (
                <select aria-label="Target dashboard" className="h-6 rounded border border-border bg-panel px-0.5 text-[11.5px]" value={a.target} onChange={(e) => setActions((all) => all.map((x) => (x.id === a.id ? { ...x, target: e.target.value } : x)))}>
                  {project.dashboards.filter((x) => x.id !== d.id).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              ) : (
                <select aria-label="Target" className="h-6 rounded border border-border bg-panel px-0.5 text-[11.5px]" value={a.target} onChange={(e) => setActions((all) => all.map((x) => (x.id === a.id ? { ...x, target: e.target.value } : x)))}>
                  <option value="*">every other chart</option>
                  {chartItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {name(i.id)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Btn size="sm" variant="ghost" onClick={() => setActions((all) => [...all, { id: newId(), kind: 'highlight', source: '*', target: '*' }])}>
        <Plus className="size-3.5" /> Add action
      </Btn>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-3">{title}</h3>
      {children}
    </section>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <span className="font-medium text-text-2">{label}</span>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- presentation

function Presentation({ d }: { d: Dashboard }) {
  const dashboards = useApp((s) => s.project!.dashboards)
  const ref = useRef<HTMLDivElement>(null)
  const i = dashboards.findIndex((x) => x.id === d.id)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && i < dashboards.length - 1) setDash({ active: dashboards[i + 1].id })
      if (e.key === 'ArrowLeft' && i > 0) setDash({ active: dashboards[i - 1].id })
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [i, dashboards])
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-workspace" data-testid="presentation">
      <div className="min-h-0 flex-1">
        <Canvas d={{ ...d, size: { ...d.size, mode: 'fit' } }} edit={false} canvasRef={ref} />
      </div>
      <div className="flex h-11 items-center gap-1 border-t border-border bg-panel px-3" role="tablist" aria-label="Dashboards">
        {dashboards.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === d.id} onClick={() => setDash({ active: x.id })} className={cx('h-8 rounded-lg px-3 text-[12.5px]', x.id === d.id ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2 hover:bg-hover')}>
            {x.name}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[11.5px] text-text-3">Esc to leave · ← → to switch</span>
        <IconBtn label="Leave presentation" onClick={() => setDash({ presenting: false })} data-testid="leave-presentation">
          <X className="size-4" />
        </IconBtn>
      </div>
    </div>
  )
}


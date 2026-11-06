// The Data workspace: sources and datasets on the left; the selected table's rows and column profile on the right.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Database, FileSpreadsheet, FileText, FolderSearch, Layers, MoreHorizontal, Pencil, Plus, RefreshCw, Server, SquareTerminal, Trash2, Globe2, Network, Wand2, CalendarDays } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, set, get, toast } from '../state/store'
import * as P from '../state/project'
import * as E from '../state/engine'
import { pickDataFiles, runCommand } from './commands'
import { SourceBadge, timeAgo } from './RefreshStatus'
import { Btn, IconBtn, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, MenuCheck, SubMenu, Modal, Field, cx, inputCls } from '../ui'
import { DataGrid, typeLabel, type GridSource } from '../ui/DataGrid'
import { profileSql, readProfile, type Profile } from '@/core/profile'
import type { Source } from '@/shared/project'
import type { RelationInfo } from '@/shared/engine-protocol'
import { openInSql } from './SqlEditor'
import { ModelEditor } from './ModelEditor'
import { TransformEditor } from './TransformEditor'
import { askText } from './Dialogs'
import { dateTableSql } from '@/core/transform'
import { newId } from '@/core/project/sviz'

const q = (s: string) => `"${s.replace(/"/g, '""')}"`

function sourceIcon(s: Source) {
  if (s.kind === 'postgres') return <Server className="size-4" />
  if (s.kind === 'sqlite' || s.kind === 'duckdb') return <Database className="size-4" />
  if (s.kind === 'file' && ['xlsx', 'ods', 'xml2003'].includes(s.format)) return <FileSpreadsheet className="size-4" />
  return <FileText className="size-4" />
}

export function DataView() {
  const { project, relations, sources, focus, datasetErrors } = useApp(useShallow((s) => ({ project: s.project!, relations: s.relations, sources: s.sources, focus: s.focusRelation, datasetErrors: s.datasetErrors })))
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<{ kind: 'table' | 'dataset'; id: string; old: string } | null>(null)
  useEffect(() => {
    if (focus) {
      setSelected(focus)
      set({ focusRelation: null })
    }
  }, [focus])
  const relByName = useMemo(() => new Map(relations.map((r) => [r.name.toLowerCase(), r])), [relations])
  const current = selected ? relByName.get(selected.toLowerCase()) : undefined
  const selectedModel = selected?.startsWith('model:') ? project.models.find((m) => `model:${m.id}` === selected) : undefined
  const selectedTransform = project.datasets.find((d) => d.name === selected && d.steps)
  // Default selection: the first relation that exists.
  useEffect(() => {
    if (!selected && relations.length) setSelected(relations[0].name)
  }, [relations, selected])

  return (
    <div className="flex h-full" data-testid="data-view">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Sources and datasets">
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <h2 className="text-[13px] font-semibold">Data</h2>
          <div className="flex items-center gap-0.5">
            <IconBtn label="Refresh all data" onClick={() => runCommand('data.refresh')} disabled={!project.sources.length}>
              <RefreshCw className="size-4" />
            </IconBtn>
            <Menu>
              <MenuTrigger asChild>
                <Btn size="sm" variant="soft" data-testid="add-data">
                  <Plus className="size-3.5" /> Add
                </Btn>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon={<FileSpreadsheet />} onSelect={() => void pickDataFiles()} data-testid="add-file">
                  File (Excel, CSV, Parquet…)
                </MenuItem>
                <MenuItem icon={<Server />} onSelect={() => runCommand('data.connect')} data-testid="add-postgres">
                  PostgreSQL database
                </MenuItem>
                <MenuSep />
                <MenuItem icon={<SquareTerminal />} onSelect={() => openInSql('', { asDataset: true })}>
                  Dataset from SQL
                </MenuItem>
                <MenuItem icon={<Wand2 />} onSelect={() => setSelected(newTransform())} data-testid="add-transform">
                  Visual transform
                </MenuItem>
                <MenuItem icon={<Network />} onSelect={() => setSelected(`model:${newModel()}`)} data-testid="add-model">
                  Model (related tables)
                </MenuItem>
                <MenuItem icon={<CalendarDays />} onSelect={() => void addDateTable().then((n) => n && setSelected(n))}>
                  Date table
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <div className="px-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">Sources</div>
          {!project.sources.length && (
            <div className="mx-1 rounded-lg border border-dashed border-border-strong p-3 text-[12px] leading-relaxed text-text-3">
              No data yet. Add an Excel, CSV or other file, connect to PostgreSQL, or drop a file anywhere in the window.
            </div>
          )}
          <ul className="space-y-0.5">
            {project.sources.map((s) => {
              const st = sources[s.id]
              const expanded = open[s.id] ?? true
              return (
                <li key={s.id} data-testid="source-item">
                  <div className="group flex h-8 items-center gap-1.5 rounded-lg px-1.5 hover:bg-hover">
                    <button onClick={() => setOpen((o) => ({ ...o, [s.id]: !expanded }))} aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${s.name}`} className="flex size-5 items-center justify-center text-text-3">
                      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    <span className={cx('text-text-3', st?.state === 'error' && 'text-danger')}>{sourceIcon(s)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={s.kind === 'postgres' ? `${s.user}@${s.host}:${s.port}/${s.database}` : s.path}>
                      {s.name}
                    </span>
                    {st?.state === 'checking' ? <RefreshCw className="size-3.5 animate-spin text-text-3" /> : st?.state === 'error' ? <AlertTriangle className="size-3.5 text-danger" aria-label="Refresh failed" /> : null}
                    <SourceMenu s={s} />
                  </div>
                  {expanded && (
                    <ul className="ml-6 border-l border-border pl-1.5">
                      {s.tables.map((t) => {
                        const rel = relByName.get(t.alias.toLowerCase())
                        return (
                          <li key={t.alias}>
                            <button
                              onClick={() => setSelected(t.alias)}
                              onDoubleClick={() => setRenaming({ kind: 'table', id: s.id, old: t.alias })}
                              aria-current={selected?.toLowerCase() === t.alias.toLowerCase() ? 'true' : undefined}
                              data-testid={`relation-${t.alias}`}
                              className={cx('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]', selected?.toLowerCase() === t.alias.toLowerCase() ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2 hover:bg-hover', !rel && 'opacity-60')}
                              title={t.ref ? `${t.alias} ← ${t.ref}` : t.alias}
                            >
                              <span className="flex-1 truncate font-mono text-[12px]">{t.alias}</span>
                              {rel ? <span className="text-[10.5px] text-text-3">{rel.kind === 'live' ? 'live' : `${rel.columns.length} cols`}</span> : <span className="text-[10.5px] text-text-3">not loaded</span>}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="flex items-center justify-between px-1.5 pb-1 pt-4">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Datasets</span>
            <IconBtn size="sm" label="New dataset from SQL" onClick={() => openInSql('', { asDataset: true })}>
              <Plus className="size-3.5" />
            </IconBtn>
          </div>
          {!project.datasets.length && <p className="px-2 text-[12px] leading-relaxed text-text-3">Save a SQL query as a dataset to reuse it in charts — for example a join with calculated columns.</p>}
          <ul className="space-y-0.5">
            {project.datasets.map((d) => {
              const err = datasetErrors[d.name]
              return (
                <li key={d.id} className="group flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-hover">
                  <button onClick={() => setSelected(d.name)} aria-current={selected?.toLowerCase() === d.name.toLowerCase() ? 'true' : undefined} data-testid={`relation-${d.name}`} className={cx('flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12.5px]', selected?.toLowerCase() === d.name.toLowerCase() ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2')} title={err ?? d.description ?? d.name}>
                    {d.steps ? <Wand2 className="size-3.5 shrink-0" /> : <Layers className="size-3.5 shrink-0" />}
                    <span className="flex-1 truncate font-mono text-[12px]">{d.name}</span>
                    {err && <AlertTriangle className="size-3.5 text-danger" aria-label="Dataset has an error" />}
                  </button>
                  <Menu>
                    <MenuTrigger asChild>
                      <button aria-label={`Actions for ${d.name}`} className="flex size-6 items-center justify-center rounded text-text-3 opacity-0 hover:bg-active focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      {!d.steps && (
                        <MenuItem icon={<SquareTerminal />} onSelect={() => openInSql(d.sql, { datasetId: d.id })}>
                          Edit SQL
                        </MenuItem>
                      )}
                      <MenuItem icon={<Pencil />} onSelect={() => setRenaming({ kind: 'dataset', id: d.id, old: d.name })}>
                        Rename
                      </MenuItem>
                      <MenuSep />
                      <MenuItem icon={<Trash2 />} onSelect={() => P.removeDataset(d.id)}>
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </li>
              )
            })}
          </ul>
          <div className="px-1.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-text-3">Models</div>
          {!project.models.length && <p className="px-2 text-[12px] leading-relaxed text-text-3">Relate tables by shared fields to chart them together without duplicating totals.</p>}
          <ul className="space-y-0.5">
            {project.models.map((m) => (
              <li key={m.id} className="group flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-hover">
                <button onClick={() => setSelected(`model:${m.id}`)} aria-current={selected === `model:${m.id}` ? 'true' : undefined} className={cx('flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12.5px]', selected === `model:${m.id}` ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2')} data-testid={`model-${m.name}`}>
                  <Network className="size-3.5 shrink-0" />
                  <span className="flex-1 truncate">{m.name}</span>
                </button>
                <IconBtn size="sm" label={`Delete ${m.name}`} className="opacity-0 group-hover:opacity-100" onClick={() => P.edit((p) => ({ ...p, models: p.models.filter((x) => x.id !== m.id) }))}>
                  <Trash2 className="size-3.5" />
                </IconBtn>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Table preview">
        {selectedModel ? <ModelEditor model={selectedModel} /> : selectedTransform ? <TransformEditor ds={selectedTransform} /> : current ? <RelationPane rel={current} /> : <EmptyPane name={selected} />}
      </section>
      {renaming && <RenameDialog r={renaming} onClose={() => setRenaming(null)} onDone={(n) => setSelected(n)} />}
    </div>
  )
}

function newTransform(): string {
  const p = get().project!
  const name = P.uniqueAlias('transform', P.usedNames())
  const input = get().relations[0]?.name ?? ''
  P.saveDataset({ name, sql: input ? `SELECT * FROM "${input}"` : '', input, steps: [] })
  void p
  return name
}

function newModel(): string {
  const id = newId()
  const p = get().project!
  P.edit((x) => ({ ...x, models: [...x.models, { id, name: `Model ${p.models.length + 1}`, tables: [], relationships: [] }] }))
  return id
}

async function addDateTable(): Promise<string | null> {
  const y = new Date().getFullYear()
  const range = await askText('Add a date table', 'From and to (YYYY-MM-DD YYYY-MM-DD)', `${y - 2}-01-01 ${y + 1}-12-31`)
  const m = range && /^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/.exec(range.trim())
  if (!m) return range === null ? null : (toast('Write two dates, like 2024-01-01 2026-12-31.', 'error'), null)
  const name = P.uniqueAlias('dates', P.usedNames())
  P.saveDataset({ name, sql: dateTableSql(m[1], m[2]), description: 'One row per day' })
  return name
}

function EmptyPane({ name }: { name: string | null }) {
  const err = useApp((s) => (name ? s.datasetErrors[name] : undefined))
  const project = useApp((s) => s.project!)
  const src = project.sources.find((s) => s.tables.some((t) => t.alias === name))
  const st = useApp((s) => (src ? s.sources[src.id] : undefined))
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center">
      <div className="max-w-md">
        {err ? (
          <>
            <AlertTriangle className="mx-auto mb-2 size-6 text-danger" />
            <div className="text-[14px] font-semibold">{name} can’t be loaded</div>
            <p className="mt-1 select-text text-[12.5px] text-text-2">{err}</p>
          </>
        ) : st?.state === 'error' ? (
          <>
            <AlertTriangle className="mx-auto mb-2 size-6 text-danger" />
            <div className="text-[14px] font-semibold">{src!.name} isn’t available</div>
            <p className="mt-1 select-text text-[12.5px] text-text-2">{st.error}</p>
            {src?.path && (
              <Btn className="mt-3" onClick={() => set({ dialog: { kind: 'relink', sourceId: src.id } })}>
                <FolderSearch className="size-4" /> Find the file…
              </Btn>
            )}
          </>
        ) : st?.state === 'checking' ? (
          <p className="text-[13px] text-text-3">Loading {name}…</p>
        ) : (
          <p className="text-[13px] text-text-3">{project.sources.length ? 'Choose a table on the left.' : 'Add data to get started.'}</p>
        )}
      </div>
    </div>
  )
}

function RelationPane({ rel }: { rel: RelationInfo }) {
  const dataVersion = useApp((s) => s.dataVersion)
  const previewRows = useApp((s) => s.settings.previewRows)
  const src = useApp((s) => s.project!.sources.find((x) => x.id === rel.source))
  const st = useApp((s) => (rel.source ? s.sources[rel.source] : undefined))
  const [tab, setTab] = useState<'rows' | 'columns'>('rows')
  const [grid, setGrid] = useState<GridSource | null>(null)
  const [error, setError] = useState('')
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    let resultId: string | undefined
    let alive = true
    setError('')
    setGrid(null)
    E.query(`SELECT * FROM ${q(rel.name)}`, { keep: true, limit: Math.min(previewRows, 1000) }).then(
      (r) => {
        resultId = r.resultId
        if (!alive) return void (resultId && E.release(resultId))
        setGrid({ columns: r.columns, rowCount: r.rowCount, first: r.rows, fetch: async (o, l) => (await E.page(r.resultId!, o, l)).rows })
      },
      (e: Error) => alive && setError(e.message)
    )
    return () => {
      alive = false
      if (resultId) void E.release(resultId)
    }
  }, [rel.name, dataVersion, previewRows])

  useEffect(() => {
    if (tab !== 'columns' || !rel.columns.length) return
    let alive = true
    setProfile(null)
    E.query(profileSql(rel.name, rel.columns), { limit: 1 }).then(
      (r) => alive && setProfile(readProfile(rel.columns, Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0][i]])))),
      (e: Error) => alive && setError(e.message)
    )
    return () => {
      alive = false
    }
  }, [tab, rel, dataVersion])

  const setType = (col: string, type: string | null) => {
    if (!src) return
    P.updateSource(src.id, {
      tables: src.tables.map((t) => {
        if (t.alias !== rel.name) return t
        const types = { ...(t.types ?? {}) }
        if (type) types[col] = type
        else delete types[col]
        return { ...t, types }
      })
    })
  }
  const overrides = src?.tables.find((t) => t.alias === rel.name)?.types ?? {}

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-mono text-[14px] font-semibold" data-testid="relation-title">
              {rel.name}
            </h2>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-text-2">{rel.kind === 'dataset' ? 'Dataset' : rel.kind === 'live' ? 'Live' : 'Extract'}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-text-3">
            <span data-testid="relation-rows">{grid ? `${grid.rowCount.toLocaleString()} rows` : '…'}</span>·<span>{rel.columns.length} columns</span>
            {src && (
              <>
                · <span className="truncate">{src.name}</span> · <SourceBadge s={st} />
              </>
            )}
          </div>
        </div>
        <div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-hover p-0.5">
          {(['rows', 'columns'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx('h-7 rounded-md px-3 text-[12px] font-medium capitalize text-text-2', tab === t && 'bg-panel text-text shadow-[0_1px_2px_rgb(0_0_0/0.1)]')}>
              {t === 'rows' ? 'Rows' : 'Columns'}
            </button>
          ))}
        </div>
        <Btn size="sm" onClick={() => openInSql(`SELECT *\nFROM ${rel.name}\nLIMIT 100`)} data-testid="query-in-sql">
          <SquareTerminal className="size-3.5" /> Query
        </Btn>
      </header>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="select-text p-6 text-[13px] text-danger">{error}</p>
        ) : tab === 'rows' ? (
          grid ? <DataGrid source={grid} label={`Rows of ${rel.name}`} /> : <div className="p-6 text-[13px] text-text-3">Loading…</div>
        ) : (
          <ColumnsTable rel={rel} profile={profile} overrides={overrides} onType={src ? setType : undefined} />
        )}
      </div>
    </>
  )
}

const TYPE_CHOICES: [string, string][] = [
  ['VARCHAR', 'Text'],
  ['BIGINT', 'Whole number'],
  ['DOUBLE', 'Decimal number'],
  ['CURRENCY', 'Number from currency text'],
  ['DATE', 'Date'],
  ['DATE_MDY', 'Date (month/day/year text)'],
  ['DATE_DMY', 'Date (day/month/year text)'],
  ['TIMESTAMP', 'Date and time'],
  ['BOOLEAN', 'True/false']
]

function ColumnsTable({ rel, profile, overrides, onType }: { rel: RelationInfo; profile: Profile | null; overrides: Record<string, string>; onType?: (col: string, t: string | null) => void }) {
  return (
    <div className="h-full overflow-auto p-4">
      {profile && (
        <div className="mb-3 flex gap-3 text-[12.5px]" data-testid="profile-summary">
          <span className="rounded-lg bg-panel px-3 py-1.5 shadow-[0_0_0_1px_var(--border)]">{profile.rows.toLocaleString()} rows</span>
          <span className={cx('rounded-lg bg-panel px-3 py-1.5 shadow-[0_0_0_1px_var(--border)]', profile.duplicateRows > 0 && 'text-warn')}>{profile.duplicateRows ? `${profile.duplicateRows.toLocaleString()} duplicated rows` : 'No duplicate rows'}</span>
        </div>
      )}
      <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-xl bg-panel text-[12.5px] shadow-[0_0_0_1px_var(--border)]">
        <thead>
          <tr className="bg-panel-2 text-left text-[11.5px] text-text-3">
            {['Column', 'Type', 'Empty', 'Distinct', 'Range', 'Role / suggestion'].map((h) => (
              <th key={h} className="border-b border-border px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rel.columns.map((c, i) => {
            const p = profile?.columns[i]
            return (
              <tr key={c.name} className="border-b border-border">
                <td className="border-b border-border px-3 py-1.5 font-mono">{c.name}</td>
                <td className="border-b border-border px-3 py-1.5">
                  {onType ? (
                    <select aria-label={`Type of ${c.name}`} value={overrides[c.name] ?? ''} onChange={(e) => onType(c.name, e.target.value || null)} className="h-7 rounded-md border border-border bg-panel px-1.5 text-[12px]">
                      <option value="">{`${typeLabel(c.type)} · ${c.type}`}</option>
                      {TYPE_CHOICES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-text-2">{c.type}</span>
                  )}
                </td>
                <td className={cx('border-b border-border px-3 py-1.5 tabular-nums', p && p.nulls > 0 && 'text-warn')}>{p ? `${p.nulls.toLocaleString()}${profile!.rows ? ` (${Math.round((p.nulls / profile!.rows) * 100)}%)` : ''}` : '…'}</td>
                <td className="border-b border-border px-3 py-1.5 tabular-nums">{p ? p.distinct.toLocaleString() : '…'}</td>
                <td className="border-b border-border px-3 py-1.5 text-text-2">{p?.min !== undefined ? `${p.min} – ${p.max}` : ''}</td>
                <td className="border-b border-border px-3 py-1.5">
                  {p?.geo && (
                    <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] capitalize text-text-2">
                      <Globe2 className="size-3" /> {p.geo}
                    </span>
                  )}
                  {p?.suggest && onType && !overrides[c.name] && (
                    <button className="text-[11.5px] font-medium text-accent-ink hover:underline" onClick={() => onType(c.name, p.suggest!.why === 'Looks like currency' ? 'CURRENCY' : p.suggest!.type)}>
                      {p.suggest.why} — use {p.suggest.type === 'DATE' ? 'Date' : 'Number'}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SourceMenu({ s }: { s: Source }) {
  const setPolicy = (patch: Partial<Source['refresh']>) => P.updateSource(s.id, { refresh: { ...s.refresh, ...patch } })
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label={`Actions for ${s.name}`} className="flex size-6 items-center justify-center rounded text-text-3 opacity-0 hover:bg-active focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100" data-testid="source-menu">
          <MoreHorizontal className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={<RefreshCw />} onSelect={() => P.refreshSources([s.id], true)}>
          Refresh now
        </MenuItem>
        <SubMenu label="Refresh automatically" icon={<RefreshCw />}>
          <MenuCheck checked={s.refresh.onOpen} onCheckedChange={(v) => setPolicy({ onOpen: !!v })}>
            When the project opens
          </MenuCheck>
          {s.kind !== 'postgres' && (
            <MenuCheck checked={s.refresh.watch} onCheckedChange={(v) => setPolicy({ watch: !!v })}>
              When the file changes
            </MenuCheck>
          )}
          <MenuCheck checked={s.refresh.onFocus} onCheckedChange={(v) => setPolicy({ onFocus: !!v })}>
            When I come back to Simple Viz
          </MenuCheck>
          <MenuSep />
          {[0, 5, 15, 60].map((m) => (
            <MenuCheck key={m} checked={s.refresh.everyMin === m} onCheckedChange={() => setPolicy({ everyMin: m })}>
              {m ? `Every ${m} minutes` : 'Not on a timer'}
            </MenuCheck>
          ))}
        </SubMenu>
        {s.kind === 'postgres' && (
          <MenuItem icon={<Server />} onSelect={() => P.updateSource(s.id, { mode: s.mode === 'live' ? 'extract' : 'live' })}>
            {s.mode === 'live' ? 'Switch to extract (local copy)' : 'Switch to live queries'}
          </MenuItem>
        )}
        {s.path && (
          <MenuItem icon={<FolderSearch />} onSelect={() => set({ dialog: { kind: 'relink', sourceId: s.id } })}>
            Change file location…
          </MenuItem>
        )}
        {s.path && (
          <MenuItem icon={<FolderSearch />} onSelect={() => window.simpleViz.showInFolder(s.path!)}>
            Show in folder
          </MenuItem>
        )}
        <MenuSep />
        <MenuItem icon={<Trash2 />} onSelect={() => P.removeSource(s.id)}>
          Remove source
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function RenameDialog({ r, onClose, onDone }: { r: { kind: 'table' | 'dataset'; id: string; old: string }; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(r.old)
  const taken = P.usedNames()
  taken.delete(r.old.toLowerCase())
  const valid = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)
  const clash = taken.has(name.toLowerCase())
  const ok = valid && !clash && name !== r.old
  const apply = () => {
    if (!ok) return
    if (r.kind === 'table') {
      const s = get().project!.sources.find((x) => x.id === r.id)!
      P.updateSource(s.id, { tables: s.tables.map((t) => (t.alias === r.old ? { ...t, alias: name } : t)) })
    } else {
      const d = get().project!.datasets.find((x) => x.id === r.id)!
      P.saveDataset({ ...d, name })
    }
    toast(`Renamed to ${name}. Update queries that use ${r.old}.`, 'info')
    onDone(name)
    onClose()
  }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Rename ${r.old}`} description="The name SQL and charts use for this table." width={420} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!ok} onClick={apply}>Rename</Btn></>}>
      <Field label="Name" hint={!valid ? 'Letters, digits and _ only, not starting with a digit.' : clash ? 'Another table or dataset has this name.' : undefined}>
        <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} aria-label="Name" />
      </Field>
    </Modal>
  )
}

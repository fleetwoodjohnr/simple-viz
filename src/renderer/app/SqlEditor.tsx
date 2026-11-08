// The SQL workspace: query any source, file or database with DuckDB SQL; save queries and datasets.

import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { linter, type Diagnostic } from '@codemirror/lint'
import { format as formatSql } from 'sql-formatter'
import { Play, Square, Wand2, Plus, X, Save, Layers, Download, ListTree, History, Bookmark, Table2, Loader2, ChevronRight, Trash2 } from 'lucide-react'
import { useApp, set, get, toast } from '../state/store'
import * as P from '../state/project'
import * as E from '../state/engine'
import { Btn, IconBtn, Menu, MenuContent, MenuItem, MenuTrigger, Modal, Field, Tip, cx, inputCls } from '../ui'
import { DataGrid, typeLabel, type GridSource } from '../ui/DataGrid'
import { errorPosition } from '@/core/errors'
import { paramValue, sqlParams, statementAt } from '@/core/sql/text'
import { rowsToXlsx, XLSX_MAX_ROWS } from '@/core/sheets/fromRows'
import type { QueryResult } from '@/shared/engine-protocol'
import { formatShortcut } from './commands'

interface Tab {
  id: string
  title: string
  sql: string
  /** Editing this dataset's SQL. */
  datasetId?: string
  /** Opened to create a dataset: Save offers "Save as dataset". */
  asDataset?: boolean
  result?: QueryResult & { sql: string }
  error?: string
  plan?: string
  running?: number
  params: Record<string, string>
}

interface SqlState {
  tabs: Tab[]
  active: string
}

let tabSeq = 0
const newTab = (sqlText = '', extra: Partial<Tab> = {}): Tab => ({ id: `t${++tabSeq}`, title: extra.title ?? `Query ${tabSeq}`, sql: sqlText, params: {}, ...extra })
const first = newTab()
const useSql = create<SqlState>(() => ({ tabs: [first], active: first.id }))
const setSql = useSql.setState
const updTab = (id: string, patch: Partial<Tab>) => setSql((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))

/** Opens SQL in a new editor tab and switches to the SQL workspace. */
export function openInSql(sqlText: string, opts: { datasetId?: string; asDataset?: boolean } = {}) {
  const ds = opts.datasetId ? get().project?.datasets.find((d) => d.id === opts.datasetId) : undefined
  const existing = ds && useSql.getState().tabs.find((t) => t.datasetId === ds.id)
  if (existing) setSql({ active: existing.id })
  else {
    const t = newTab(sqlText || (opts.asDataset ? '-- A dataset is a saved query other charts and queries can use by name.\nSELECT *\nFROM ' : ''), { title: ds ? ds.name : opts.asDataset ? 'New dataset' : undefined, datasetId: ds?.id, asDataset: opts.asDataset })
    setSql((s) => ({ tabs: [...s.tabs, t], active: t.id }))
  }
  set({ workspace: 'sql' })
}

// ---------------------------------------------------------------- history (per project, kept in this computer's profile)

interface HistoryEntry {
  sql: string
  at: number
  ms?: number
  rows?: number
  error?: string
}
const historyKey = () => `sv-history-${get().project?.id}`
const loadHistory = (): HistoryEntry[] => {
  try {
    return JSON.parse(localStorage.getItem(historyKey()) ?? '[]') as HistoryEntry[]
  } catch {
    return []
  }
}
function addHistory(e: HistoryEntry) {
  const list = [e, ...loadHistory().filter((h) => h.sql !== e.sql)].slice(0, 100)
  localStorage.setItem(historyKey(), JSON.stringify(list))
}

// ---------------------------------------------------------------- running

async function run(tabId: string, text: string) {
  const tab = useSql.getState().tabs.find((t) => t.id === tabId)
  if (!tab || tab.running) return
  const sqlText = text.trim()
  if (!sqlText) return
  const params: Record<string, string | number | boolean | null> = {}
  for (const name of sqlParams(sqlText)) params[name] = paramValue(tab.params[name] ?? '')
  const { id, done } = E.runQuery(sqlText, { keep: true, limit: get().settings.previewRows, params })
  if (tab.result?.resultId) void E.release(tab.result.resultId)
  updTab(tabId, { running: id, error: undefined, plan: undefined })
  try {
    const r = await done
    updTab(tabId, { result: { ...r, sql: sqlText }, running: undefined })
    addHistory({ sql: sqlText, at: Date.now(), ms: r.ms, rows: r.rowCount })
  } catch (e) {
    updTab(tabId, { error: (e as Error).message, running: undefined, result: undefined })
    addHistory({ sql: sqlText, at: Date.now(), error: (e as Error).message })
  }
}

async function explainTab(tabId: string, text: string) {
  try {
    updTab(tabId, { plan: await E.explain(text), error: undefined })
  } catch (e) {
    updTab(tabId, { error: (e as Error).message, plan: undefined })
  }
}

// ---------------------------------------------------------------- the editor

const DUCKDB_KEYWORDS =
  'qualify pivot unpivot using sample asof positional exclude replace columns struct list map union_by_name summarize describe ilike glob similar any_value arg_max arg_min count_if list_agg string_agg median mode quantile_cont quantile_disc regr_slope regr_intercept regr_r2 corr covar_samp covar_pop stddev_samp stddev_pop var_samp var_pop skewness kurtosis approx_count_distinct date_trunc date_part datediff date_diff strftime strptime epoch make_date try_cast coalesce ifnull nullif greatest least zn iif countd attr dateadd'

function Editor({ tab, onRun }: { tab: Tab; onRun: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const relations = useApp((s) => s.relations)
  const runRef = useRef(onRun)
  runRef.current = onRun

  const schema = useMemo(() => Object.fromEntries(relations.map((r) => [r.name, r.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type }))])), [relations])

  useEffect(() => {
    const runSel = (v: EditorView) => {
      const sel = v.state.selection.main
      const doc = v.state.doc.toString()
      runRef.current(sel.empty ? statementAt(doc, sel.head).text : doc.slice(sel.from, sel.to))
      return true
    }
    const fmt = (v: EditorView) => {
      try {
        const out = formatSql(v.state.doc.toString(), { language: 'duckdb', keywordCase: 'upper', tabWidth: 2 })
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: out } })
      } catch (e) {
        toast(`Couldn’t format: ${(e as Error).message.split('\n')[0]}`, 'error')
      }
      return true
    }
    const check = linter(
      async (v) => {
        const doc = v.state.doc.toString()
        if (!doc.trim() || sqlParams(doc).length) return []
        const st = statementAt(doc, v.state.selection.main.head)
        if (!st.text.trim()) return []
        try {
          await E.validate(st.text)
          return []
        } catch (e) {
          const msg = (e as Error).message
          const pos = errorPosition(msg, st.text)
          const from = st.from + (pos ?? 0)
          const d: Diagnostic = { from: Math.min(from, doc.length), to: Math.min(doc.length, pos === null ? st.from + st.text.length : from + 1), severity: 'error', message: msg.split('\n')[0] }
          return [d]
        }
      },
      { delay: 700 }
    )
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: tab.sql,
        extensions: [
          basicSetup,
          lang.current.of(sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true })),
          check,
          placeholder('Write SQL. Tables: see the list on the left. Ctrl+Enter runs.'),
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: runSel },
              { key: 'Shift-Enter', run: runSel },
              { key: 'Mod-Shift-f', run: fmt },
              {
                key: 'Escape',
                run: () => {
                  const t = useSql.getState().tabs.find((x) => x.id === tab.id)
                  if (t?.running) void E.cancel(t.running)
                  return !!t?.running
                }
              }
            ])
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) updTab(tab.id, { sql: u.state.doc.toString() })
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL query', 'data-testid': 'sql-input' }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--panel)', color: 'var(--text)' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', caretColor: 'var(--accent)' },
            '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--text-3)', borderRight: '1px solid var(--border)' },
            '.cm-activeLine': { backgroundColor: 'var(--hover)' },
            '.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' },
            '.cm-tooltip': { backgroundColor: 'var(--elev)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '8px' },
            '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--accent-ink)' },
            '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
            '.cm-placeholder': { color: 'var(--text-2)' }
          })
        ]
      })
    })
    view.current = v
    ;(window as unknown as { __svEditor?: EditorView }).__svEditor = v
    return () => v.destroy()
    // The editor is created once per tab; schema updates go through the compartment below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true, keywords: DUCKDB_KEYWORDS } as never)) })
  }, [schema])

  // Text replaced from outside (format button, history, dataset reopen).
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== tab.sql) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: tab.sql } })
  }, [tab.sql])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}

export function SqlEditor() {
  const { tabs, active } = useSql()
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  const [side, setSide] = useState<'schema' | 'saved' | 'history'>('schema')
  const [saving, setSaving] = useState<'query' | 'dataset' | null>(null)
  const params = useMemo(() => sqlParams(tab.sql), [tab.sql])
  const currentText = () => {
    const v = (window as unknown as { __svEditor?: EditorView }).__svEditor
    if (!v) return tab.sql
    const sel = v.state.selection.main
    return sel.empty ? statementAt(v.state.doc.toString(), sel.head).text : v.state.sliceDoc(sel.from, sel.to)
  }
  const close = (id: string) =>
    setSql((s) => {
      const t = s.tabs.find((x) => x.id === id)
      if (t?.result?.resultId) void E.release(t.result.resultId)
      const rest = s.tabs.filter((x) => x.id !== id)
      const tabsNext = rest.length ? rest : [newTab()]
      return { tabs: tabsNext, active: s.active === id ? tabsNext[Math.max(0, s.tabs.findIndex((x) => x.id === id) - 1)].id : s.active }
    })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        const t = newTab()
        setSql((s) => ({ tabs: [...s.tabs, t], active: t.id }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full" data-testid="sql-view">
      <aside className="flex w-[250px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Schema, saved queries and history">
        <div role="tablist" aria-label="Side panel" className="flex gap-0.5 border-b border-border p-1.5">
          {(
            [
              ['schema', 'Tables', ListTree],
              ['saved', 'Saved', Bookmark],
              ['history', 'History', History]
            ] as const
          ).map(([id, label, Icon]) => (
            <button key={id} role="tab" aria-selected={side === id} onClick={() => setSide(id)} className={cx('flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium', side === id ? 'bg-accent-soft text-accent-ink' : 'text-text-2 hover:bg-hover')}>
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">{side === 'schema' ? <SchemaTree /> : side === 'saved' ? <SavedList /> : <HistoryList />}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border bg-bg px-2 pt-1.5">
          <div className="flex min-w-0 items-center gap-1" role="tablist" aria-label="Query tabs">
          {tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === tab.id} tabIndex={0} title={`${t.title} — Delete closes the tab`} onClick={() => setSql({ active: t.id })} onKeyDown={(e) => (e.key === 'Enter' ? setSql({ active: t.id }) : e.key === 'Delete' && close(t.id))} className={cx('group flex h-8 max-w-[200px] cursor-default items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-[12.5px]', t.id === tab.id ? 'border-border bg-panel font-medium' : 'border-transparent text-text-2 hover:bg-hover')}>
              {t.datasetId || t.asDataset ? <Layers className="size-3.5 shrink-0 text-text-3" /> : null}
              <span className="truncate">{t.title}</span>
              {t.running && <Loader2 className="size-3 animate-spin text-text-3" />}
              {/* A mouse affordance: from the keyboard, Delete on the tab closes it (no control inside a tab). */}
              <span aria-hidden="true" onClick={(e) => (e.stopPropagation(), close(t.id))} className="-mr-1.5 flex size-5 items-center justify-center rounded text-text-3 opacity-0 hover:bg-active group-hover:opacity-100">
                <X className="size-3" />
              </span>
            </div>
          ))}
          </div>
          <IconBtn label="New query tab" shortcut="Mod-t" onClick={() => {
            const t = newTab()
            setSql((s) => ({ tabs: [...s.tabs, t], active: t.id }))
          }}>
            <Plus className="size-4" />
          </IconBtn>
        </div>
        <div className="flex items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5">
          {tab.running ? (
            <Btn size="sm" variant="danger" onClick={() => void E.cancel(tab.running!)} data-testid="sql-cancel">
              <Square className="size-3.5" /> Cancel
            </Btn>
          ) : (
            <Tip label="Run the statement at the cursor, or the selection" shortcut="Mod-Enter">
              <Btn size="sm" variant="primary" onClick={() => void run(tab.id, currentText())} data-testid="sql-run">
                <Play className="size-3.5" /> Run
              </Btn>
            </Tip>
          )}
          <Tip label="Format SQL" shortcut="Mod-Shift-f">
            <Btn size="sm" variant="ghost" onClick={() => {
              try {
                updTab(tab.id, { sql: formatSql(tab.sql, { language: 'duckdb', keywordCase: 'upper', tabWidth: 2 }) })
              } catch (e) {
                toast(`Couldn’t format: ${(e as Error).message.split('\n')[0]}`, 'error')
              }
            }}>
              <Wand2 className="size-3.5" /> Format
            </Btn>
          </Tip>
          <Tip label="Show how the query runs: which sources are read, what is pushed to databases">
            <Btn size="sm" variant="ghost" onClick={() => void explainTab(tab.id, currentText())} data-testid="sql-explain">
              <ListTree className="size-3.5" /> Plan
            </Btn>
          </Tip>
          <div className="flex-1" />
          <Btn size="sm" variant="ghost" onClick={() => setSaving('query')} disabled={!tab.sql.trim()}>
            <Bookmark className="size-3.5" /> Save query
          </Btn>
          <Btn size="sm" variant={tab.datasetId || tab.asDataset ? 'primary' : 'soft'} onClick={() => setSaving('dataset')} disabled={!tab.sql.trim()} data-testid="save-dataset">
            <Layers className="size-3.5" /> {tab.datasetId ? 'Update dataset' : 'Save as dataset'}
          </Btn>
        </div>
        {params.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel-2 px-3 py-1.5" aria-label="Query parameters">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-text-3">Parameters</span>
            {params.map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-[12px]">
                <span className="font-mono text-text-2">${p}</span>
                <input aria-label={`Value of ${p}`} className={cx(inputCls, 'h-7 w-32 text-[12px]')} value={tab.params[p] ?? ''} onChange={(e) => updTab(tab.id, { params: { ...tab.params, [p]: e.target.value } })} />
              </label>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="h-[42%] min-h-[120px] border-b border-border">
            <Editor key={tab.id} tab={tab} onRun={(text) => void run(tab.id, text)} />
          </div>
          <ResultPane tab={tab} />
        </div>
      </div>
      {saving && <SaveDialog tab={tab} kind={saving} onClose={() => setSaving(null)} />}
    </div>
  )
}

function ResultPane({ tab }: { tab: Tab }) {
  const r = tab.result
  const grid: GridSource | null = useMemo(() => (r ? { columns: r.columns, rowCount: r.rowCount, first: r.rows, fetch: r.resultId ? async (o, l) => (await E.page(r.resultId!, o, l)).rows : undefined } : null), [r])
  const exportAs = async (fmt: 'csv' | 'xlsx' | 'parquet') => {
    if (!r) return
    const path = await window.simpleViz.saveDialog(`${tab.title}.${fmt}`, [fmt])
    if (!path) return
    try {
      if (fmt === 'xlsx') {
        if (r.rowCount > XLSX_MAX_ROWS) toast(`Excel holds ${XLSX_MAX_ROWS.toLocaleString()} rows; the rest were left out. Use CSV or Parquet for all ${r.rowCount.toLocaleString()}.`, 'info')
        const all = r.resultId ? await E.page(r.resultId, 0, Math.min(r.rowCount, XLSX_MAX_ROWS)) : r
        await window.simpleViz.writeFile(path, rowsToXlsx(r.columns, all.rows, tab.title))
      } else await window.simpleViz.engineExport(r.sql, fmt, path)
      toast(`Exported ${path.split(/[\\/]/).pop()}`, 'success')
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, 'error')
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" aria-label="Results">
      <div className="flex h-9 items-center gap-3 border-b border-border px-3 text-[12px] text-text-3" role="status" data-testid="sql-status">
        {tab.running ? (
          <span className="flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Running… (Esc cancels)</span>
        ) : tab.error ? (
          <span className="font-medium text-danger">Error</span>
        ) : r ? (
          <span>
            <b className="font-semibold text-text-2" data-testid="sql-rowcount">{r.rowCount.toLocaleString()}</b> rows · {r.ms < 1000 ? `${Math.round(r.ms)} ms` : `${(r.ms / 1000).toFixed(2)} s`}
          </span>
        ) : tab.plan ? (
          <span>Execution plan</span>
        ) : (
          <span>Run a query to see results. {formatShortcut('Mod-Enter')} runs the statement at the cursor.</span>
        )}
        <div className="flex-1" />
        {r && (
          <Menu>
            <MenuTrigger asChild>
              <Btn size="sm" variant="ghost" data-testid="sql-export">
                <Download className="size-3.5" /> Export
              </Btn>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void exportAs('csv')}>CSV</MenuItem>
              <MenuItem onSelect={() => void exportAs('xlsx')}>Excel workbook (.xlsx)</MenuItem>
              <MenuItem onSelect={() => void exportAs('parquet')}>Parquet</MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {tab.error ? (
          <pre className="select-text whitespace-pre-wrap p-4 font-mono text-[12.5px] leading-relaxed text-danger" data-testid="sql-error">{tab.error}</pre>
        ) : tab.plan ? (
          <pre className="select-text h-full overflow-auto whitespace-pre p-4 font-mono text-[11.5px] leading-snug text-text-2" data-testid="sql-plan">{tab.plan}</pre>
        ) : grid ? (
          <DataGrid source={grid} label="Query results" />
        ) : null}
      </div>
    </div>
  )
}

function SchemaTree() {
  const { relations, project } = useApp(useShallow((s) => ({ relations: s.relations, project: s.project })))
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const insert = (text: string) => {
    const v = (window as unknown as { __svEditor?: EditorView }).__svEditor
    if (!v) return
    v.dispatch(v.state.replaceSelection(text))
    v.focus()
  }
  const sourceName = (id?: string) => project?.sources.find((s) => s.id === id)?.name
  if (!relations.length) return <p className="p-2 text-[12px] leading-relaxed text-text-3">No tables yet. Add data in the Data workspace; each sheet, file or database table appears here by name.</p>
  return (
    <ul className="space-y-0.5 text-[12.5px]" data-testid="schema-tree">
      {relations.map((r) => (
        <li key={r.name}>
          <div className="group flex h-7 items-center gap-1 rounded-md px-1 hover:bg-hover">
            <button aria-label={`${open[r.name] ? 'Hide' : 'Show'} columns of ${r.name}`} aria-expanded={!!open[r.name]} onClick={() => setOpen((o) => ({ ...o, [r.name]: !o[r.name] }))} className="flex size-5 items-center justify-center text-text-3">
              <ChevronRight className={cx('size-3.5 transition-transform', open[r.name] && 'rotate-90')} />
            </button>
            {r.kind === 'dataset' ? <Layers className="size-3.5 text-text-3" /> : <Table2 className="size-3.5 text-text-3" />}
            <button className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" title={`${r.name} — ${r.kind === 'dataset' ? 'dataset' : `${r.kind} of ${sourceName(r.source) ?? ''}`}. Click to insert.`} onClick={() => insert(r.name)}>
              {r.name}
            </button>
            <span className="text-[10px] text-text-3">{r.kind === 'live' ? 'live' : ''}</span>
          </div>
          {open[r.name] && (
            <ul className="ml-7 border-l border-border pl-1">
              {r.columns.map((c) => (
                <li key={c.name}>
                  <button onClick={() => insert(/^[a-z_][a-z0-9_]*$/.test(c.name) ? c.name : `"${c.name}"`)} className="flex h-6 w-full items-center gap-2 rounded px-1.5 text-left hover:bg-hover" title={`${c.name} · ${c.type}`}>
                    <span className="w-7 shrink-0 font-mono text-[9.5px] text-text-2">{typeLabel(c.type)}</span>
                    <span className="truncate font-mono text-[11.5px] text-text-2">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

const NO_QUERIES: { id: string; name: string; sql: string }[] = []

function SavedList() {
  const queries = useApp((s) => s.project?.queries ?? NO_QUERIES)
  if (!queries.length) return <p className="p-2 text-[12px] leading-relaxed text-text-3">Saved queries are kept in the project file. Use “Save query” above.</p>
  return (
    <ul className="space-y-0.5">
      {queries.map((qr) => (
        <li key={qr.id} className="group flex items-center rounded-md hover:bg-hover">
          <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => {
            const t = newTab(qr.sql, { title: qr.name })
            setSql((s) => ({ tabs: [...s.tabs, t], active: t.id }))
          }}>
            <div className="truncate text-[12.5px] font-medium">{qr.name}</div>
            <div className="truncate font-mono text-[11px] text-text-3">{qr.sql.replace(/\s+/g, ' ')}</div>
          </button>
          <IconBtn size="sm" label={`Delete ${qr.name}`} className="mr-1 opacity-0 group-hover:opacity-100" onClick={() => P.edit((p) => ({ ...p, queries: p.queries.filter((x) => x.id !== qr.id) }))}>
            <Trash2 className="size-3.5" />
          </IconBtn>
        </li>
      ))}
    </ul>
  )
}

function HistoryList() {
  const [list, setList] = useState(loadHistory)
  useEffect(() => {
    const t = setInterval(() => setList(loadHistory()), 1500)
    return () => clearInterval(t)
  }, [])
  if (!list.length) return <p className="p-2 text-[12px] text-text-3">Queries you run appear here.</p>
  return (
    <ul className="space-y-0.5" data-testid="sql-history">
      {list.map((h) => (
        <li key={h.at}>
          <button className="w-full rounded-md px-2 py-1.5 text-left hover:bg-hover" onClick={() => {
            const s = useSql.getState()
            updTab(s.active, { sql: h.sql })
          }}>
            <div className="truncate font-mono text-[11.5px]">{h.sql.replace(/\s+/g, ' ')}</div>
            <div className={cx('text-[10.5px]', h.error ? 'text-danger' : 'text-text-3')}>{h.error ? 'Failed' : `${h.rows?.toLocaleString()} rows · ${Math.round(h.ms ?? 0)} ms`} · {new Date(h.at).toLocaleTimeString()}</div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function SaveDialog({ tab, kind, onClose }: { tab: Tab; kind: 'query' | 'dataset'; onClose: () => void }) {
  const project = useApp((s) => s.project!)
  const existing = tab.datasetId ? project.datasets.find((d) => d.id === tab.datasetId) : undefined
  const [name, setName] = useState(existing?.name ?? (kind === 'dataset' ? P.uniqueAlias(tab.title === 'New dataset' || /^Query \d+$/.test(tab.title) ? 'my_dataset' : tab.title, P.usedNames()) : tab.title))
  const [description, setDescription] = useState(existing?.description ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const taken = P.usedNames()
  if (existing) taken.delete(existing.name.toLowerCase())
  const valid = kind === 'query' ? name.trim().length > 0 : /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) && !taken.has(name.toLowerCase())
  const save = async () => {
    if (!valid) return
    if (kind === 'query') {
      P.edit((p) => ({ ...p, queries: [...p.queries, { id: crypto.randomUUID().slice(0, 12), name: name.trim(), sql: tab.sql }] }))
      updTab(tab.id, { title: name.trim() })
      toast('Query saved in the project', 'success')
      return onClose()
    }
    const sqlText = tab.sql.trim().replace(/;\s*$/, '')
    if (sqlParams(sqlText).length) return setError('Datasets can’t use $parameters. Replace them with values, or use a chart filter instead.')
    setBusy(true)
    try {
      // Check it first, so a broken dataset isn't saved into the project.
      await E.validate(sqlText)
    } catch (e) {
      setBusy(false)
      return setError((e as Error).message)
    }
    const ds = P.saveDataset({ id: existing?.id, name, sql: sqlText, description: description || undefined })
    updTab(tab.id, { title: ds.name, datasetId: ds.id, asDataset: false })
    toast(`Dataset ${ds.name} saved. Its columns are available in charts.`, 'success')
    setBusy(false)
    onClose()
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind === 'dataset' ? (existing ? `Update ${existing.name}` : 'Save as dataset') : 'Save query'}
      description={kind === 'dataset' ? 'A dataset is this query, saved by name. Charts, dashboards and other queries can use it like a table, and it recalculates whenever its sources refresh.' : 'Saved queries are kept in the project file.'}
      width={480}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!valid || busy} onClick={save} data-testid="save-dataset-confirm">{busy && <Loader2 className="size-4 animate-spin" />}<Save className="size-4" /> Save</Btn></>}
    >
      <div className="space-y-3">
        <Field label="Name" hint={kind === 'dataset' ? (valid ? `Use it in SQL as: SELECT * FROM ${name}` : taken.has(name.toLowerCase()) ? 'A table or dataset already has this name.' : 'Letters, digits and _ only, not starting with a digit.') : undefined}>
          <input autoFocus className={inputCls} value={name} onChange={(e) => (setName(e.target.value), setError(''))} onKeyDown={(e) => e.key === 'Enter' && void save()} aria-label="Name" data-testid="dataset-name" />
        </Field>
        {kind === 'dataset' && (
          <Field label="Description (optional)">
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
          </Field>
        )}
        {error && <p className="select-text rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

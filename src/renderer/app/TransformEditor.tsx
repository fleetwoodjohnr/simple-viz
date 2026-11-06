// Visual transforms: a list of steps on the left (each one a form), a live preview of the data after the selected
// step, and the equivalent SQL. "Edit as SQL" turns the transform into a SQL dataset (undo brings the steps back).

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Code2, ListOrdered, Plus, Trash2 } from 'lucide-react'
import { useApp, toast } from '../state/store'
import * as P from '../state/project'
import * as E from '../state/engine'
import { Btn, IconBtn, Menu, MenuContent, MenuItem, MenuTrigger, cx, inputCls } from '../ui'
import { DataGrid, type GridSource } from '../ui/DataGrid'
import { STEP_LABELS, transformSql, transformSqlUntil } from '@/core/transform'
import { newId } from '@/core/project/sviz'
import type { Dataset, TransformStep } from '@/shared/project'
import type { ColumnInfo } from '@/shared/engine-protocol'

const NEW: { [K in TransformStep['kind']]: Omit<Extract<TransformStep, { kind: K }>, 'id' | 'kind'> } = {
  select: { columns: [] },
  rename: { from: '', to: '' },
  filter: { column: '', op: '=', value: '' },
  calc: { name: 'new_column', expr: '' },
  cast: { column: '', type: 'DOUBLE' },
  fill: { column: '', value: '0' },
  text: { column: '', fn: 'trim' },
  split: { column: '', sep: ',', into: ['part_1', 'part_2'] },
  dedupe: { columns: [] },
  sort: { column: '', dir: 'asc' },
  group: { by: [], aggs: [{ column: '', fn: 'sum', as: 'total' }] },
  join: { with: '', type: 'left', on: [{ left: '', right: '' }] },
  union: { with: '' },
  pivot: { column: '', value: '', fn: 'sum', values: [] },
  unpivot: { columns: [], name: 'name', value: 'value' },
  sql: { sql: 'SELECT * FROM previous' }
}

export function TransformEditor({ ds }: { ds: Dataset }) {
  const relations = useApp((s) => s.relations)
  const dataVersion = useApp((s) => s.dataVersion)
  const steps = ds.steps ?? []
  const [sel, setSel] = useState(steps.length - 1)
  const [view, setView] = useState<'preview' | 'sql'>('preview')
  const [grid, setGrid] = useState<GridSource | null>(null)
  const [cols, setCols] = useState<ColumnInfo[]>([])
  const [error, setError] = useState('')
  const input = ds.input ?? ''

  const save = (next: TransformStep[], inputName = input) => {
    P.saveDataset({ ...ds, input: inputName, steps: next, sql: transformSql(inputName, next) })
  }
  const setStep = (i: number, patch: Partial<TransformStep>) => save(steps.map((s, k) => (k === i ? ({ ...s, ...patch } as TransformStep) : s)))
  const addStep = (kind: TransformStep['kind']) => {
    const s = { id: newId(), kind, ...structuredClone(NEW[kind]) } as TransformStep
    save([...steps.slice(0, sel + 1), s, ...steps.slice(sel + 1)])
    setSel(sel + 1)
  }

  // Preview: the data after the selected step (or the input, before any step).
  const previewSql = useMemo(() => (input ? transformSqlUntil(input, steps, sel) : ''), [input, steps, sel])
  useEffect(() => {
    if (!previewSql) return
    let alive = true
    let rid: string | undefined
    setError('')
    E.query(previewSql, { keep: true, limit: 200 }).then(
      (r) => {
        rid = r.resultId
        if (!alive) return void (rid && E.release(rid))
        setGrid({ columns: r.columns, rowCount: r.rowCount, first: r.rows, fetch: async (o, l) => (await E.page(r.resultId!, o, l)).rows })
      },
      (e: Error) => alive && (setError(e.message), setGrid(null))
    )
    return () => {
      alive = false
      if (rid) void E.release(rid)
    }
  }, [previewSql, dataVersion])
  // Columns available to the selected step: the output of the step before it.
  useEffect(() => {
    if (!input) return
    const sql = sel <= 0 ? transformSql(input, []) : transformSqlUntil(input, steps, sel - 1)
    E.query(`SELECT * FROM (${sql}) LIMIT 0`).then((r) => setCols(r.columns), () => setCols([]))
  }, [input, steps, sel])

  const editAsSql = () => {
    P.saveDataset({ ...ds, sql: ds.sql, steps: undefined, input: undefined })
    toast('Now a SQL dataset. Undo (Ctrl+Z) brings the steps back.', 'info')
  }

  const s = steps[sel]
  return (
    <div className="flex min-h-0 flex-1" data-testid="transform-editor">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Transform steps">
        <div className="space-y-2 border-b border-border p-2.5">
          <label className="block text-[12px]">
            <span className="mb-1 block font-medium text-text-2">Start from</span>
            <select className={cx(inputCls, 'h-8 font-mono text-[12px]')} aria-label="Input table" value={input} onChange={(e) => save(steps, e.target.value)} data-testid="transform-input">
              <option value="">Choose a table…</option>
              {relations.filter((r) => r.name !== ds.name).map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          <li>
            <button onClick={() => setSel(-1)} className={cx('w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px]', sel === -1 ? 'bg-accent-soft text-accent-ink' : 'text-text-2 hover:bg-hover')}>
              Source: <span className="font-mono">{input || '—'}</span>
            </button>
          </li>
          {steps.map((st, i) => (
            <li key={st.id} className={cx('group flex items-center rounded-lg', sel === i ? 'bg-accent-soft' : 'hover:bg-hover')}>
              <button onClick={() => setSel(i)} className={cx('min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-[12.5px]', sel === i ? 'font-medium text-accent-ink' : 'text-text')} data-testid="transform-step">
                {i + 1}. {STEP_LABELS[st.kind]}
              </button>
              <IconBtn size="sm" label="Move up" disabled={i === 0} onClick={() => (save(steps.map((x, k) => (k === i - 1 ? steps[i] : k === i ? steps[i - 1] : x))), setSel(i - 1))}>
                <ChevronUp className="size-3.5" />
              </IconBtn>
              <IconBtn size="sm" label="Move down" disabled={i === steps.length - 1} onClick={() => (save(steps.map((x, k) => (k === i + 1 ? steps[i] : k === i ? steps[i + 1] : x))), setSel(i + 1))}>
                <ChevronDown className="size-3.5" />
              </IconBtn>
              <IconBtn size="sm" label="Remove step" className="mr-1" onClick={() => (save(steps.filter((_, k) => k !== i)), setSel(Math.min(i, steps.length - 2)))}>
                <Trash2 className="size-3.5" />
              </IconBtn>
            </li>
          ))}
        </ol>
        <div className="border-t border-border p-2">
          <Menu>
            <MenuTrigger asChild>
              <Btn size="sm" variant="soft" className="w-full" disabled={!input} data-testid="add-step">
                <Plus className="size-3.5" /> Add step
              </Btn>
            </MenuTrigger>
            <MenuContent align="start">
              {(Object.keys(STEP_LABELS) as TransformStep['kind'][]).map((k) => (
                <MenuItem key={k} onSelect={() => addStep(k)} data-testid={`step-${k}`}>
                  {STEP_LABELS[k]}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {s && (
          <div className="border-b border-border bg-panel p-3" data-testid="step-form">
            <div className="mb-2 text-[12.5px] font-semibold">
              {sel + 1}. {STEP_LABELS[s.kind]}
            </div>
            <StepForm s={s} cols={cols} relations={relations.map((r) => r.name).filter((n) => n !== ds.name)} onChange={(p) => setStep(sel, p)} input={input} steps={steps} sel={sel} />
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-border bg-panel-2 px-3 py-1.5">
          <div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-hover p-0.5">
            {(['preview', 'sql'] as const).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cx('flex h-7 items-center gap-1 rounded-md px-3 text-[12px] font-medium text-text-2', view === v && 'bg-panel text-text shadow-[0_1px_2px_rgb(0_0_0/0.1)]')} data-testid={`transform-tab-${v}`}>
                {v === 'preview' ? <ListOrdered className="size-3.5" /> : <Code2 className="size-3.5" />} {v === 'preview' ? 'Preview' : 'SQL'}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-text-3">{grid && view === 'preview' ? `${grid.rowCount.toLocaleString()} rows after ${sel >= 0 ? `step ${sel + 1}` : 'the source'}` : ''}</span>
          <div className="flex-1" />
          {view === 'sql' && (
            <Btn size="sm" onClick={editAsSql} data-testid="edit-as-sql">
              Edit as SQL
            </Btn>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {view === 'sql' ? (
            <pre className="select-text h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] text-text-2" data-testid="transform-sql">{transformSql(input, steps)}</pre>
          ) : error ? (
            <p className="select-text p-4 text-[12.5px] text-danger" data-testid="transform-error">{error}</p>
          ) : grid ? (
            <DataGrid source={grid} label="Transform preview" />
          ) : (
            <p className="p-4 text-[12.5px] text-text-3">{input ? 'Loading…' : 'Choose the table to start from.'}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function StepForm({ s, cols, relations, onChange, input, steps, sel }: { s: TransformStep; cols: ColumnInfo[]; relations: string[]; onChange: (p: Partial<TransformStep>) => void; input: string; steps: TransformStep[]; sel: number }) {
  const col = (value: string, set: (v: string) => void, label = 'Column') => (
    <select aria-label={label} className={cx(inputCls, 'h-8 w-48 text-[12px]')} value={value} onChange={(e) => set(e.target.value)}>
      <option value="">{label}…</option>
      {cols.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  )
  const text = (value: string, set: (v: string) => void, label: string, w = 'w-48') => <input aria-label={label} placeholder={label} className={cx(inputCls, 'h-8 text-[12px]', w)} defaultValue={value} key={`${s.id}-${label}`} onBlur={(e) => e.target.value !== value && set(e.target.value)} />
  const multi = (values: string[], set: (v: string[]) => void) => (
    <div className="flex max-h-[96px] flex-wrap gap-1 overflow-y-auto">
      {cols.map((c) => (
        <label key={c.name} className={cx('flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px]', values.includes(c.name) ? 'border-accent bg-accent-soft' : 'border-border')}>
          <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={values.includes(c.name)} onChange={() => set(values.includes(c.name) ? values.filter((x) => x !== c.name) : [...values, c.name])} />
          {c.name}
        </label>
      ))}
    </div>
  )
  const row = (...children: React.ReactNode[]) => <div className="flex flex-wrap items-center gap-2 text-[12.5px]">{children}</div>
  switch (s.kind) {
    case 'select':
      return multi(s.columns, (columns) => onChange({ columns }))
    case 'dedupe':
      return <>{multi(s.columns, (columns) => onChange({ columns }))}<p className="mt-1 text-[11.5px] text-text-3">Rows count as duplicates when the chosen columns match (all columns if none is chosen).</p></>
    case 'rename':
      return row(col(s.from, (from) => onChange({ from })), 'to', text(s.to, (to) => onChange({ to }), 'New name'))
    case 'filter':
      return row(
        col(s.column, (column) => onChange({ column })),
        <select key="op" aria-label="Condition" className={cx(inputCls, 'h-8 w-36 text-[12px]')} value={s.op} onChange={(e) => onChange({ op: e.target.value as never })}>
          {[['=', 'equals'], ['<>', 'is not'], ['>', 'greater than'], ['>=', 'at least'], ['<', 'less than'], ['<=', 'at most'], ['contains', 'contains'], ['starts', 'starts with'], ['in', 'is one of (a, b)'], ['null', 'is empty'], ['not_null', 'is not empty']].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>,
        s.op !== 'null' && s.op !== 'not_null' ? text(s.value ?? '', (value) => onChange({ value }), 'Value') : null
      )
    case 'calc':
      return row(text(s.name, (name) => onChange({ name }), 'Column name', 'w-40'), '=', text(s.expr, (expr) => onChange({ expr }), 'SQL expression, e.g. revenue - cost', 'w-[420px] font-mono'))
    case 'cast':
      return row(col(s.column, (column) => onChange({ column })), 'to', <select key="t" aria-label="Type" className={cx(inputCls, 'h-8 w-40 text-[12px]')} value={s.type} onChange={(e) => onChange({ type: e.target.value })}>{['VARCHAR', 'BIGINT', 'DOUBLE', 'DATE', 'TIMESTAMP', 'BOOLEAN'].map((t) => <option key={t}>{t}</option>)}</select>)
    case 'fill':
      return row(col(s.column, (column) => onChange({ column })), 'empty values with', text(s.value, (value) => onChange({ value }), 'Value'))
    case 'text':
      return row(col(s.column, (column) => onChange({ column })), <select key="f" aria-label="Cleaning" className={cx(inputCls, 'h-8 w-48 text-[12px]')} value={s.fn} onChange={(e) => onChange({ fn: e.target.value as never })}><option value="trim">Trim spaces</option><option value="upper">UPPER CASE</option><option value="lower">lower case</option><option value="title">Title Case</option></select>)
    case 'split':
      return row(col(s.column, (column) => onChange({ column })), 'at', text(s.sep, (sep) => onChange({ sep }), 'Separator', 'w-20'), 'into', text(s.into.join(', '), (v) => onChange({ into: v.split(',').map((x) => x.trim()).filter(Boolean) }), 'Column names, comma separated', 'w-64'))
    case 'sort':
      return row(col(s.column, (column) => onChange({ column })), <select key="d" aria-label="Direction" className={cx(inputCls, 'h-8 w-36 text-[12px]')} value={s.dir} onChange={(e) => onChange({ dir: e.target.value as never })}><option value="asc">Ascending</option><option value="desc">Descending</option></select>)
    case 'group':
      return (
        <div className="space-y-2">
          <div className="text-[12px] text-text-2">Group by</div>
          {multi(s.by, (by) => onChange({ by }))}
          {s.aggs.map((a, i) =>
            row(
              <select key="fn" aria-label="Summary" className={cx(inputCls, 'h-8 w-32 text-[12px]')} value={a.fn} onChange={(e) => onChange({ aggs: s.aggs.map((x, k) => (k === i ? { ...x, fn: e.target.value as never } : x)) })}>{['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'median'].map((f) => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}</select>,
              'of',
              col(a.column, (column) => onChange({ aggs: s.aggs.map((x, k) => (k === i ? { ...x, column } : x)) })),
              'as',
              text(a.as, (as) => onChange({ aggs: s.aggs.map((x, k) => (k === i ? { ...x, as } : x)) }), 'Name', 'w-32'),
              <IconBtn key="x" size="sm" label="Remove" onClick={() => onChange({ aggs: s.aggs.filter((_, k) => k !== i) })}><Trash2 className="size-3.5" /></IconBtn>
            )
          )}
          <Btn size="sm" variant="ghost" onClick={() => onChange({ aggs: [...s.aggs, { column: '', fn: 'sum', as: `value_${s.aggs.length + 1}` }] })}><Plus className="size-3.5" /> Add a summary</Btn>
        </div>
      )
    case 'join':
    case 'union':
      return (
        <div className="space-y-2">
          {row(
            s.kind === 'join' ? <select key="type" aria-label="Join type" className={cx(inputCls, 'h-8 w-36 text-[12px]')} value={s.type} onChange={(e) => onChange({ type: e.target.value as never })}><option value="left">Left (keep all)</option><option value="inner">Inner (matches only)</option><option value="right">Right</option><option value="full">Full outer</option></select> : 'Append',
            <select key="w" aria-label="Other table" className={cx(inputCls, 'h-8 w-48 font-mono text-[12px]')} value={s.with} onChange={(e) => onChange({ with: e.target.value })}><option value="">Table…</option>{relations.map((r) => <option key={r}>{r}</option>)}</select>
          )}
          {s.kind === 'join' && <JoinKeys s={s} cols={cols} onChange={onChange} />}
        </div>
      )
    case 'pivot':
      return (
        <div className="space-y-2">
          {row('Columns from', col(s.column, (column) => onChange({ column })), 'values', <select key="fn" aria-label="Summary" className={cx(inputCls, 'h-8 w-24 text-[12px]')} value={s.fn} onChange={(e) => onChange({ fn: e.target.value as never })}>{['sum', 'avg', 'count', 'min', 'max'].map((f) => <option key={f}>{f}</option>)}</select>, 'of', col(s.value, (value) => onChange({ value })))}
          {row(<Btn key="load" size="sm" disabled={!s.column} onClick={async () => {
            const prev = sel <= 0 ? transformSql(input, []) : transformSqlUntil(input, steps, sel - 1)
            const r = await E.query(`SELECT DISTINCT CAST("${s.column.replace(/"/g, '""')}" AS VARCHAR) FROM (${prev}) ORDER BY 1 LIMIT 100`)
            onChange({ values: r.rows.map((x) => String(x[0])) })
          }}>Use the column’s values</Btn>, <span key="v" className="text-[11.5px] text-text-3">{s.values.length ? s.values.join(', ') : 'No values yet'}</span>)}
        </div>
      )
    case 'unpivot':
      return <div className="space-y-2">{multi(s.columns, (columns) => onChange({ columns }))}{row('into', text(s.name, (name) => onChange({ name }), 'Name column', 'w-36'), 'and', text(s.value, (value) => onChange({ value }), 'Value column', 'w-36'))}</div>
    case 'sql':
      return <textarea aria-label="SQL" className={cx(inputCls, 'h-24 py-1.5 font-mono text-[12px]')} defaultValue={s.sql} key={s.id} onBlur={(e) => onChange({ sql: e.target.value })} />
  }
}

function JoinKeys({ s, cols, onChange }: { s: Extract<TransformStep, { kind: 'join' }>; cols: ColumnInfo[]; onChange: (p: Partial<TransformStep>) => void }) {
  const relations = useApp((st) => st.relations)
  const other = relations.find((r) => r.name === s.with)?.columns ?? []
  return (
    <div className="space-y-1.5">
      {s.on.map((o, i) => (
        <div key={i} className="flex items-center gap-2 text-[12.5px]">
          <select aria-label="Key" className={cx(inputCls, 'h-8 w-44 text-[12px]')} value={o.left} onChange={(e) => onChange({ on: s.on.map((x, k) => (k === i ? { ...x, left: e.target.value } : x)) })}>
            <option value="">This table…</option>
            {cols.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
          =
          <select aria-label="Other key" className={cx(inputCls, 'h-8 w-44 text-[12px]')} value={o.right} onChange={(e) => onChange({ on: s.on.map((x, k) => (k === i ? { ...x, right: e.target.value } : x)) })}>
            <option value="">{s.with || 'Other table'}…</option>
            {other.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}

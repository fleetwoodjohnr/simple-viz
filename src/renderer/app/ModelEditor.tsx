// The model canvas: tables as cards you can drag, relationships as lines between them, suggested relationships,
// warnings for loops and unrelated tables, and a preview of how well each relationship matches.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Link2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useApp, toast } from '../state/store'
import * as P from '../state/project'
import * as E from '../state/engine'
import { Btn, IconBtn, cx, inputCls } from '../ui'
import { modelProblems, suggestRelationships } from '@/core/query/model'
import { newId } from '@/core/project/sviz'
import type { Model, Relationship } from '@/shared/project'

const CARD_W = 200

export function updateModel(id: string, fn: (m: Model) => Model) {
  P.edit((p) => ({ ...p, models: p.models.map((m) => (m.id === id ? fn(m) : m)) }))
}

export function ModelEditor({ model }: { model: Model }) {
  const relations = useApp((s) => s.relations)
  const [drag, setDrag] = useState<{ name: string; dx: number; dy: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [linking, setLinking] = useState<{ left: string; right: string; leftField: string; rightField: string } | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const cols = (t: string) => relations.find((r) => r.name.toLowerCase() === t.toLowerCase())?.columns ?? []
  const pos = (t: string) => {
    const p = model.tables.find((x) => x.name === t)!
    return drag?.name === t ? { x: p.x + drag.dx, y: p.y + drag.dy } : p
  }
  const height = (t: string) => 40 + Math.min(cols(t).length, 10) * 22

  const problems = useMemo(() => modelProblems(model), [model])
  const suggestions = useMemo(() => {
    const out: (Omit<Relationship, 'id'> & { why: string })[] = []
    for (let i = 0; i < model.tables.length; i++)
      for (let j = i + 1; j < model.tables.length; j++) {
        const a = model.tables[i].name
        const b = model.tables[j].name
        if (model.relationships.some((r) => (r.left === a && r.right === b) || (r.left === b && r.right === a))) continue
        for (const s of suggestRelationships({ name: a, columns: cols(a) }, { name: b, columns: cols(b) }).slice(0, 1)) out.push({ left: a, right: b, ...s })
      }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, relations])

  const addTable = (name: string) => {
    if (!name || model.tables.some((t) => t.name === name)) return
    const x = 40 + (model.tables.length % 4) * (CARD_W + 80)
    const y = 40 + Math.floor(model.tables.length / 4) * 300
    updateModel(model.id, (m) => ({ ...m, tables: [...m.tables, { name, x, y }] }))
  }
  const addRel = (r: Omit<Relationship, 'id'>) => updateModel(model.id, (m) => ({ ...m, relationships: [...m.relationships, { ...r, id: newId() }] }))

  const startDrag = (e: React.PointerEvent, name: string) => {
    const x0 = e.clientX
    const y0 = e.clientY
    const move = (ev: PointerEvent) => setDrag({ name, dx: ev.clientX - x0, dy: ev.clientY - y0 })
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      const dx = ev.clientX - x0
      const dy = ev.clientY - y0
      if (Math.abs(dx) + Math.abs(dy) > 2) updateModel(model.id, (m) => ({ ...m, tables: m.tables.map((t) => (t.name === name ? { ...t, x: Math.max(0, t.x + dx), y: Math.max(0, t.y + dy) } : t)) }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex min-h-0 flex-1" data-testid="model-editor">
      <div ref={host} className="relative min-w-0 flex-1 overflow-auto bg-workspace bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]">
        <svg className="pointer-events-none absolute left-0 top-0" width={3000} height={2000} aria-hidden="true">
          {model.relationships.map((r) => {
            if (!model.tables.some((t) => t.name === r.left) || !model.tables.some((t) => t.name === r.right)) return null
            const a = pos(r.left)
            const b = pos(r.right)
            const [x1, x2] = a.x < b.x ? [a.x + CARD_W, b.x] : [a.x, b.x + CARD_W]
            const y1 = a.y + 24
            const y2 = b.y + 24
            const mid = (x1 + x2) / 2
            return (
              <g key={r.id}>
                <path d={`M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} fill="none" stroke={selected === r.id ? 'var(--accent)' : 'var(--text-3)'} strokeWidth={selected === r.id ? 2.5 : 1.5} />
                <circle cx={x1} cy={y1} r={3.5} fill="var(--text-3)" />
                <circle cx={x2} cy={y2} r={3.5} fill="var(--text-3)" />
              </g>
            )
          })}
        </svg>
        {model.tables.map((t) => {
          const p = pos(t.name)
          const c = cols(t.name)
          return (
            <div key={t.name} className="absolute rounded-xl bg-panel shadow-[0_0_0_1px_var(--border),0_6px_18px_-10px_rgb(0_0_0/0.3)]" style={{ left: p.x, top: p.y, width: CARD_W, height: height(t.name) }} data-testid={`model-table-${t.name}`}>
              <div onPointerDown={(e) => startDrag(e, t.name)} className="flex h-9 cursor-move items-center gap-1.5 rounded-t-xl border-b border-border bg-panel-2 px-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold">{t.name}</span>
                <IconBtn size="sm" label={`Relate ${t.name} to another table`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setLinking({ left: t.name, right: model.tables.find((x) => x.name !== t.name)?.name ?? '', leftField: c[0]?.name ?? '', rightField: '' })} data-testid={`relate-${t.name}`}>
                  <Link2 className="size-3.5" />
                </IconBtn>
                <IconBtn size="sm" label={`Remove ${t.name} from the model`} onPointerDown={(e) => e.stopPropagation()} onClick={() => updateModel(model.id, (m) => ({ ...m, tables: m.tables.filter((x) => x.name !== t.name), relationships: m.relationships.filter((r) => r.left !== t.name && r.right !== t.name) }))}>
                  <X className="size-3.5" />
                </IconBtn>
              </div>
              <ul className="px-2.5 py-1 text-[11.5px]">
                {c.slice(0, 10).map((col) => (
                  <li key={col.name} className="flex h-[22px] items-center justify-between gap-2">
                    <span className="truncate font-mono">{col.name}</span>
                    <span className="shrink-0 text-[10px] text-text-3">{col.type.split('(')[0].toLowerCase()}</span>
                  </li>
                ))}
                {c.length > 10 && <li className="text-[10.5px] text-text-3">+{c.length - 10} more</li>}
              </ul>
            </div>
          )
        })}
        {!model.tables.length && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-text-3">Add tables from the panel on the right, then relate them by a shared field.</div>}
      </div>
      <aside className="w-[300px] shrink-0 space-y-4 overflow-y-auto border-l border-border bg-panel p-3" aria-label="Model">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">Tables</div>
          <select className={cx(inputCls, 'h-8 text-[12px]')} aria-label="Add a table" value="" onChange={(e) => addTable(e.target.value)} data-testid="model-add-table">
            <option value="">Add a table…</option>
            {relations.filter((r) => !model.tables.some((t) => t.name === r.name)).map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        {problems.length > 0 && (
          <ul className="space-y-1.5" data-testid="model-problems">
            {problems.map((p) => (
              <li key={p} className="flex gap-2 rounded-lg bg-warn/10 px-2.5 py-2 text-[12px] text-warn">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {p}
              </li>
            ))}
          </ul>
        )}
        {suggestions.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">Suggested</div>
            <ul className="space-y-1.5">
              {suggestions.map((s) => (
                <li key={`${s.left}.${s.leftField}-${s.right}.${s.rightField}`} className="rounded-lg bg-accent-soft px-2.5 py-2 text-[12px]">
                  <div className="flex items-center gap-1.5 font-mono text-[11.5px]">
                    <Sparkles className="size-3.5 shrink-0 text-accent-ink" /> {s.left}.{s.leftField} ↔ {s.right}.{s.rightField}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-text-2">
                    <span>{s.why}</span>
                    <Btn size="sm" variant="primary" onClick={() => addRel(s)} data-testid="accept-suggestion">
                      Add
                    </Btn>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">Relationships</div>
          {!model.relationships.length && <p className="text-[12px] text-text-3">None yet.</p>}
          <ul className="space-y-1.5">
            {model.relationships.map((r) => (
              <li key={r.id}>
                <RelationshipRow r={r} selected={selected === r.id} onSelect={() => setSelected(selected === r.id ? null : r.id)} onRemove={() => updateModel(model.id, (m) => ({ ...m, relationships: m.relationships.filter((x) => x.id !== r.id) }))} />
              </li>
            ))}
          </ul>
        </div>
        {linking && (
          <div className="space-y-2 rounded-lg bg-panel-2 p-2.5 shadow-[0_0_0_1px_var(--border)]" data-testid="relate-form">
            <div className="text-[12px] font-semibold">New relationship</div>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="flex gap-1.5">
                <select aria-label={`${side} table`} className={cx(inputCls, 'h-7 text-[11.5px]')} value={linking[side]} onChange={(e) => setLinking({ ...linking, [side]: e.target.value, [`${side}Field`]: cols(e.target.value)[0]?.name ?? '' })}>
                  {model.tables.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select aria-label={`${side} field`} className={cx(inputCls, 'h-7 text-[11.5px]')} value={linking[`${side}Field`]} onChange={(e) => setLinking({ ...linking, [`${side}Field`]: e.target.value })}>
                  <option value="">Field…</option>
                  {cols(linking[side]).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="flex justify-end gap-1.5">
              <Btn size="sm" onClick={() => setLinking(null)}>
                Cancel
              </Btn>
              <Btn size="sm" variant="primary" disabled={!linking.left || !linking.right || linking.left === linking.right || !linking.leftField || !linking.rightField} onClick={() => (addRel(linking), setLinking(null))}>
                <Plus className="size-3.5" /> Add
              </Btn>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

/** A relationship with how well it matches: rows matched on each side, and whether each side's keys are unique. */
function RelationshipRow({ r, selected, onSelect, onRemove }: { r: Relationship; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  const dataVersion = useApp((s) => s.dataVersion)
  const [stats, setStats] = useState<{ total: number; matched: number; leftUnique: boolean; rightUnique: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`
    const L = `${q(r.left)}.${q(r.leftField)}`
    const R = `${q(r.right)}.${q(r.rightField)}`
    E.query(`SELECT (SELECT count(*) FROM ${q(r.left)}) AS total, (SELECT count(*) FROM ${q(r.left)} WHERE ${L} IN (SELECT ${R} FROM ${q(r.right)})) AS matched, (SELECT count(*) = count(DISTINCT ${q(r.leftField)}) FROM ${q(r.left)}) AS lu, (SELECT count(*) = count(DISTINCT ${q(r.rightField)}) FROM ${q(r.right)}) AS ru`).then(
      (res) => alive && setStats({ total: Number(res.rows[0][0]), matched: Number(res.rows[0][1]), leftUnique: !!res.rows[0][2], rightUnique: !!res.rows[0][3] }),
      (e: Error) => alive && toast(e.message, 'error')
    )
    return () => {
      alive = false
    }
  }, [r, dataVersion])
  const card = stats ? `${stats.leftUnique ? 'one' : 'many'}-to-${stats.rightUnique ? 'one' : 'many'}` : ''
  return (
    <div className={cx('rounded-lg px-2.5 py-2 text-[12px] shadow-[0_0_0_1px_var(--border)]', selected ? 'bg-accent-soft' : 'bg-panel-2')} data-testid="relationship">
      <div className="flex items-start gap-1">
        <button onClick={onSelect} className="min-w-0 flex-1 text-left font-mono text-[11.5px]">
          {r.left}.{r.leftField}
          <br />↔ {r.right}.{r.rightField}
        </button>
        <IconBtn size="sm" label="Remove relationship" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconBtn>
      </div>
      {stats && (
        <div className="mt-1 text-[11px] text-text-3" data-testid="relationship-stats">
          {card} · {stats.matched.toLocaleString()} of {stats.total.toLocaleString()} {r.left} rows match{stats.matched < stats.total && <span className="text-warn"> ({(stats.total - stats.matched).toLocaleString()} unmatched)</span>}
        </div>
      )}
    </div>
  )
}

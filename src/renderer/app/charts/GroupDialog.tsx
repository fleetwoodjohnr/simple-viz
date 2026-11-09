// Create a group (Tableau's "Create Group"): tick values of a dimension, name the group, repeat. Saved as a calculated
// field "<field> (group)" with a CASE formula, so it works everywhere a field does and can be edited as a formula.

import { useEffect, useState } from 'react'
import { get, toast } from '../../state/store'
import * as P from '../../state/project'
import * as E from '../../state/engine'
import { Btn, Modal, Segmented, cx, inputCls } from '../../ui'
import { distinctValues } from './FilterDialog'
import { compileChart, modelColumns } from './ChartView'
import { groupFormula, setFormula, computedSetFormula, combinedSetFormula } from '@/core/calc/compile'
import { isNumeric } from '@/core/query/compile'
import { newId } from '@/core/project/sviz'
import { emptyEncodings, type Agg, type CalcField, type SetDef } from '@/shared/charts'

type SetKind = 'members' | 'condition' | 'top' | 'combine'

type Value = string | number | boolean

/** mode 'set': the ticked values are a set's members (Tableau's sets: In or Out), no group names. */
export function GroupDialog({ dataset, field, type, mode = 'group', onClose }: { dataset: string; field: string; type: string; mode?: 'group' | 'set'; onClose: () => void }) {
  const isSet = mode === 'set'
  const [values, setValues] = useState<Value[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [groups, setGroups] = useState<{ name: string; values: Value[] }[]>([])
  const [other, setOther] = useState(false)
  const [error, setError] = useState('')
  // Sets: listed members, or computed (a condition, the top N), or two sets combined.
  const [kind, setKind] = useState<SetKind>('members')
  const [condition, setCondition] = useState('')
  const [top, setTop] = useState<{ n: number; by: string; agg: Agg; bottom: boolean }>({ n: 10, by: '', agg: 'sum', bottom: false })
  const [comb, setComb] = useState<{ a: string; b: string; op: 'union' | 'intersect' | 'except' }>({ a: '', b: '', op: 'union' })
  const project = get().project!
  const relations = get().relations
  const model = project.models.find((m) => m.name.toLowerCase() === dataset.toLowerCase())
  const numericCols = (model ? modelColumns(model, relations) : (relations.find((r) => r.name.toLowerCase() === dataset.toLowerCase())?.columns ?? [])).filter((c) => isNumeric(c.type)).map((c) => c.name)
  const sameDataset = project.calcs.filter((c) => c.dataset.toLowerCase() === dataset.toLowerCase())
  const otherSets = sameDataset.filter((c) => c.set && c.set.field === field)

  useEffect(() => {
    distinctValues(dataset, field).then((v) => setValues(v.map((x) => x.value).filter((x): x is Value => x !== null)), (e: Error) => setError(e.message))
  }, [dataset, field])

  const grouped = new Set(groups.flatMap((g) => g.values.map(String)))
  const addGroup = () => {
    const vs = (values ?? []).filter((v) => picked.has(String(v)))
    if (!vs.length) return
    setGroups((g) => [...g, { name: name.trim() || vs.map(String).join(', '), values: vs }])
    setPicked(new Set())
    setName('')
  }
  const save = async () => {
    const taken = new Set(get().project?.calcs.map((c) => c.name.toLowerCase()))
    const base = `${field} (${isSet ? (kind === 'top' ? `${top.bottom ? 'bottom' : 'top'} ${top.n}` : 'set') : 'group'}`
    let nm = `${base})`
    for (let i = 2; taken.has(nm.toLowerCase()); i++) nm = `${base} ${i})`
    const members = (values ?? []).filter((v) => picked.has(String(v)))
    const id = newId()
    let c: CalcField
    if (!isSet) c = { id, dataset, name: nm, formula: groupFormula(field, groups, other, !isNumeric(type)) }
    else if (kind === 'members') c = { id, dataset, name: nm, formula: setFormula(field, members), set: { field, values: members } }
    else {
      const set: SetDef = kind === 'condition' ? { field, values: [], condition } : kind === 'top' ? { field, values: [], top } : { field, values: [], combine: comb }
      c = { id, dataset, name: nm, formula: kind === 'combine' ? combinedSetFormula(comb.a, comb.b, comb.op) : computedSetFormula(field, id), set }
      // Check it computes (a zero-row query) before saving: a condition must aggregate, the measure must exist.
      try {
        const q = compileChart({ dataset, type: 'table', enc: { ...emptyEncodings(), x: [{ field: nm }] }, filters: [], options: {} }, { ...project, calcs: [...project.calcs, c] }, relations)
        await E.query(`SELECT * FROM (${q.sql.replace(/\nLIMIT \d+$/, '')}) LIMIT 0`)
      } catch (e) {
        return setError((e as Error).message)
      }
    }
    P.edit((p) => ({ ...p, calcs: [...p.calcs, c] }))
    toast(`Created “${nm}”`, 'success')
    onClose()
  }
  const ready = !isSet ? groups.length > 0 : kind === 'members' || (kind === 'condition' ? !!condition.trim() : kind === 'top' ? !!top.by && top.n > 0 : !!comb.a && !!comb.b && comb.a !== comb.b)

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isSet ? `Set of ${field}` : `Group ${field}`}
      description={isSet ? 'The set field is In for its members and Out for the rest. Members are ticked, or computed after context filters from a condition or a ranking.' : 'Tick values, name the group and add it; repeat for more groups.'}
      width={520}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!ready} onClick={save} data-testid="group-save">
            {isSet ? 'Create set' : 'Create field'}
          </Btn>
        </>
      }
    >
      {error && <p className="mb-2 select-text text-[12.5px] text-danger" role="alert" data-testid="set-error">{error}</p>}
      {isSet && (
        <div className="mb-3">
          <Segmented value={kind} onChange={(k) => (setKind(k), setError(''))} label="Members" options={[{ value: 'members', label: 'Pick members' }, { value: 'condition', label: 'Condition' }, { value: 'top', label: 'Top N' }, ...(otherSets.length >= 2 ? [{ value: 'combine' as const, label: 'Combine sets' }] : [])]} />
        </div>
      )}
      {isSet && kind === 'condition' && (
        <label className="block text-[12.5px]">
          <span className="mb-1 block font-medium text-text-2">Members whose values meet</span>
          <input className={cx(inputCls, 'h-8 font-mono text-[12.5px]')} placeholder="SUM([revenue]) > 1000" value={condition} onChange={(e) => setCondition(e.target.value)} aria-label="Condition" data-testid="set-condition" />
          <span className="mt-1 block text-[11.5px] text-text-3">An aggregate formula, computed for each {field}.</span>
        </label>
      )}
      {isSet && kind === 'top' && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <select className={cx(inputCls, 'h-8 w-24')} aria-label="Top or bottom" value={top.bottom ? 'bottom' : 'top'} onChange={(e) => setTop({ ...top, bottom: e.target.value === 'bottom' })}>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
          <input type="number" min={1} className={cx(inputCls, 'h-8 w-20')} aria-label="How many" value={top.n} onChange={(e) => setTop({ ...top, n: Math.max(1, Number(e.target.value) || 1) })} data-testid="set-top-n" />
          by
          <select className={cx(inputCls, 'h-8 w-24')} aria-label="Aggregation" value={top.agg} onChange={(e) => setTop({ ...top, agg: e.target.value as Agg })}>
            {(['sum', 'avg', 'min', 'max', 'count', 'countd'] as const).map((a) => (
              <option key={a} value={a}>
                {a === 'countd' ? 'count distinct' : a === 'avg' ? 'average' : a}
              </option>
            ))}
          </select>
          <select className={cx(inputCls, 'h-8 flex-1')} aria-label="Measure" value={top.by} onChange={(e) => setTop({ ...top, by: e.target.value })} data-testid="set-top-by">
            <option value="">Choose a field…</option>
            {[...numericCols, ...sameDataset.filter((c) => !c.set).map((c) => c.name)].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      {isSet && kind === 'combine' && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <select className={cx(inputCls, 'h-8 flex-1')} aria-label="First set" value={comb.a} onChange={(e) => setComb({ ...comb, a: e.target.value })} data-testid="set-combine-a">
            <option value="">First set…</option>
            {otherSets.map((c) => <option key={c.id}>{c.name}</option>)}
          </select>
          <select className={cx(inputCls, 'h-8 w-48')} aria-label="Combine as" value={comb.op} onChange={(e) => setComb({ ...comb, op: e.target.value as typeof comb.op })} data-testid="set-combine-op">
            <option value="union">members of either</option>
            <option value="intersect">members of both</option>
            <option value="except">in the first, not the second</option>
          </select>
          <select className={cx(inputCls, 'h-8 flex-1')} aria-label="Second set" value={comb.b} onChange={(e) => setComb({ ...comb, b: e.target.value })} data-testid="set-combine-b">
            <option value="">Second set…</option>
            {otherSets.map((c) => <option key={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}
      {(!isSet || kind === 'members') && (
      <ul className="max-h-56 overflow-auto rounded-lg border border-border" aria-label="Values">
        {(values ?? []).map((v) => (
          <li key={String(v)}>
            <label className={cx('flex cursor-pointer items-center gap-2.5 px-3 py-1 hover:bg-hover', grouped.has(String(v)) && 'text-text-3')}>
              <input type="checkbox" className="size-4 accent-[var(--accent)]" disabled={grouped.has(String(v))} checked={picked.has(String(v))} onChange={() => setPicked((s) => (s.has(String(v)) ? new Set([...s].filter((x) => x !== String(v))) : new Set([...s, String(v)])))} />
              <span className="flex-1 truncate text-[12.5px]">{String(v)}</span>
              {grouped.has(String(v)) && <span className="text-[11px]">in {groups.find((g) => g.values.map(String).includes(String(v)))?.name}</span>}
            </label>
          </li>
        ))}
      </ul>
      )}
      {!isSet && (
        <>
      <div className="mt-2 flex gap-2">
        <input aria-label="Group name" placeholder="Group name" className={cx(inputCls, 'h-8 flex-1')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addGroup()} />
        <Btn disabled={!picked.size} onClick={addGroup} data-testid="group-add">
          Add group
        </Btn>
      </div>
      {groups.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12.5px]" aria-label="Groups">
          {groups.map((g, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="font-medium">{g.name}</span>
              <span className="min-w-0 flex-1 truncate text-text-3">{g.values.map(String).join(', ')}</span>
              <Btn size="sm" variant="ghost" onClick={() => setGroups((all) => all.filter((_, j) => j !== i))}>
                Remove
              </Btn>
            </li>
          ))}
        </ul>
      )}
      <label className="mt-3 flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={other} onChange={(e) => setOther(e.target.checked)} /> Put the other values in “Other”
      </label>
        </>
      )}
    </Modal>
  )
}

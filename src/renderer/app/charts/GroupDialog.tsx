// Create a group (Tableau's "Create Group"): tick values of a dimension, name the group, repeat. Saved as a calculated
// field "<field> (group)" with a CASE formula, so it works everywhere a field does and can be edited as a formula.

import { useEffect, useState } from 'react'
import { get, toast } from '../../state/store'
import * as P from '../../state/project'
import { Btn, Modal, cx, inputCls } from '../../ui'
import { distinctValues } from './FilterDialog'
import { groupFormula } from '@/core/calc/compile'
import { isNumeric } from '@/core/query/compile'
import { newId } from '@/core/project/sviz'
import type { CalcField } from '@/shared/charts'

type Value = string | number | boolean

export function GroupDialog({ dataset, field, type, onClose }: { dataset: string; field: string; type: string; onClose: () => void }) {
  const [values, setValues] = useState<Value[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [groups, setGroups] = useState<{ name: string; values: Value[] }[]>([])
  const [other, setOther] = useState(false)
  const [error, setError] = useState('')

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
  const save = () => {
    const taken = new Set(get().project?.calcs.map((c) => c.name.toLowerCase()))
    let nm = `${field} (group)`
    for (let i = 2; taken.has(nm.toLowerCase()); i++) nm = `${field} (group ${i})`
    const c: CalcField = { id: newId(), dataset, name: nm, formula: groupFormula(field, groups, other, !isNumeric(type)) }
    P.edit((p) => ({ ...p, calcs: [...p.calcs, c] }))
    toast(`Created “${nm}”`, 'success')
    onClose()
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Group ${field}`}
      description="Tick values, name the group and add it; repeat for more groups."
      width={520}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!groups.length} onClick={save} data-testid="group-save">
            Create field
          </Btn>
        </>
      }
    >
      {error && <p className="mb-2 text-[12.5px] text-danger">{error}</p>}
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
    </Modal>
  )
}

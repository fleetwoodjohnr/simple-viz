// Create or edit a parameter: a value the reader picks (a number, text, date or yes/no, optionally from a list),
// used in formulas as [Parameters].[Name] or $Name, in reference lines, dashboard controls and parameter actions.

import { useState } from 'react'
import { useApp, toast } from '../../state/store'
import * as P from '../../state/project'
import { Btn, Modal, cx, inputCls } from '../../ui'
import { newId } from '@/core/project/sviz'
import { coerceParam, type Parameter } from '@/shared/charts'

const NO_PARAMS: Parameter[] = []

export function ParamDialog({ param, onClose }: { param: Parameter | null; onClose: () => void }) {
  const params = useApp((s) => s.project?.params ?? NO_PARAMS)
  const [name, setName] = useState(param?.name ?? `Parameter ${params.length + 1}`)
  const [type, setType] = useState<Parameter['type']>(param?.type ?? 'number')
  const [value, setValue] = useState(param?.value === null || param?.value === undefined ? '' : String(param.value))
  const [choices, setChoices] = useState((param?.choices ?? []).join(', '))
  const [range, setRange] = useState({ min: param?.min ?? '', max: param?.max ?? '', step: param?.step ?? '' })
  const num = (v: number | string) => (v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))
  const nm = name.trim()
  const error = !/^[A-Za-z_][\w ]*$/.test(nm)
    ? 'Use letters, digits, spaces and underscores, starting with a letter.'
    : params.some((p) => p.id !== param?.id && p.name.toLowerCase() === nm.toLowerCase())
      ? 'Another parameter has this name.'
      : ''
  const save = () => {
    if (error) return
    const list = choices.split(',').map((c) => c.trim()).filter(Boolean)
    const allowed = type === 'number' ? list.map(Number).filter(Number.isFinite) : list
    const limits = type === 'number' && !allowed.length ? Object.fromEntries(Object.entries({ min: num(range.min), max: num(range.max), step: num(range.step) }).filter(([, v]) => v !== undefined)) : {}
    const next: Parameter = { id: param?.id ?? newId(), name: nm, type, value: coerceParam({ type, ...limits }, value), ...(allowed.length && type !== 'boolean' ? { choices: allowed } : {}), ...limits }
    P.edit((p) => ({ ...p, params: param ? p.params.map((x) => (x.id === param.id ? next : x)) : [...p.params, next] }))
    toast(param ? `Saved “${nm}”` : `Created “${nm}”: use it in a formula as [Parameters].[${nm}]`, 'success')
    onClose()
  }
  const remove = () => {
    if (param) P.edit((p) => ({ ...p, params: p.params.filter((x) => x.id !== param.id) }))
    onClose()
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={param ? `Parameter ${param.name}` : 'New parameter'}
      width={420}
      footer={
        <>
          {param && (
            <Btn variant="ghost" className="mr-auto" onClick={remove}>
              Delete
            </Btn>
          )}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!!error} onClick={save} data-testid="param-save">
            Save
          </Btn>
        </>
      }
    >
      <div className="space-y-3 text-[12.5px]">
        <label className="block">
          <span className="mb-1 block font-medium text-text-2">Name</span>
          <input className={cx(inputCls, 'h-8')} aria-label="Parameter name" value={name} onChange={(e) => setName(e.target.value)} />
          {error && <span className="mt-1 block text-danger">{error}</span>}
        </label>
        <label className="block">
          <span className="mb-1 block font-medium text-text-2">Type</span>
          <select className={cx(inputCls, 'h-8')} aria-label="Parameter type" value={type} onChange={(e) => setType(e.target.value as Parameter['type'])}>
            <option value="number">Number</option>
            <option value="text">Text</option>
            <option value="date">Date</option>
            <option value="boolean">Yes / no</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-medium text-text-2">Current value</span>
          <input className={cx(inputCls, 'h-8')} aria-label="Parameter value" type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {type !== 'boolean' && (
          <label className="block">
            <span className="mb-1 block font-medium text-text-2">Allowed values (optional, separated by commas)</span>
            <input className={cx(inputCls, 'h-8')} aria-label="Allowed values" value={choices} onChange={(e) => setChoices(e.target.value)} />
          </label>
        )}
        {type === 'number' && !choices.trim() && (
          <div>
            <span className="mb-1 block font-medium text-text-2">Range (optional: the control becomes a slider)</span>
            <div className="grid grid-cols-3 gap-2">
              {(['min', 'max', 'step'] as const).map((k) => (
                <input key={k} type="number" className={cx(inputCls, 'h-8')} aria-label={`Range ${k}`} placeholder={{ min: 'Minimum', max: 'Maximum', step: 'Step' }[k]} value={range[k]} onChange={(e) => setRange({ ...range, [k]: e.target.value })} data-testid={`param-${k}`} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

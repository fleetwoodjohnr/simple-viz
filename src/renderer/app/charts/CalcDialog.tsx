// The calculated-field editor: a formula with field references, Tableau functions, LOD and table calculations,
// checked as you type (syntax here, meaning by the engine).

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react'
import { useApp, toast } from '../../state/store'
import * as P from '../../state/project'
import * as E from '../../state/engine'
import { Btn, Field, Modal, cx, inputCls } from '../../ui'
import { compileCalc, CalcError } from '@/core/calc/compile'
import { compileQuery } from '@/core/query/compile'
import { newId } from '@/core/project/sviz'
import { emptyEncodings, type CalcField } from '@/shared/charts'

const REFERENCE: [string, string, string][] = [
  ['Logic', 'IF [x] > 0 THEN … ELSEIF … ELSE … END', 'IF THEN  END'],
  ['Logic', 'IIF(condition, then, else)', 'IIF(, , )'],
  ['Logic', 'CASE WHEN … THEN … ELSE … END', 'CASE WHEN  THEN  ELSE  END'],
  ['Logic', 'ZN(x) — null as zero', 'ZN()'],
  ['Logic', 'IFNULL(x, alternative)', 'IFNULL(, )'],
  ['Aggregate', 'SUM, AVG, MIN, MAX, MEDIAN', 'SUM()'],
  ['Aggregate', 'COUNT, COUNTD (distinct)', 'COUNTD()'],
  ['Aggregate', 'STDEV, VAR, PERCENTILE(x, 0.9)', 'PERCENTILE(, 0.9)'],
  ['Level of detail', '{FIXED [dim] : SUM([x])}', '{FIXED  : SUM()}'],
  ['Level of detail', '{INCLUDE [dim] : SUM([x])}', '{INCLUDE  : SUM()}'],
  ['Level of detail', '{EXCLUDE [dim] : SUM([x])}', '{EXCLUDE  : SUM()}'],
  ['Table calculation', 'RUNNING_SUM(SUM([x]))', 'RUNNING_SUM(SUM())'],
  ['Table calculation', 'WINDOW_AVG(SUM([x]), -2, 0)', 'WINDOW_AVG(SUM(), -2, 0)'],
  ['Table calculation', 'RANK(SUM([x]))', 'RANK(SUM())'],
  ['Table calculation', 'LOOKUP(SUM([x]), -1) — previous value', 'LOOKUP(SUM(), -1)'],
  ['Table calculation', 'SUM([x]) / TOTAL(SUM([x])) — share', 'SUM() / TOTAL(SUM())'],
  ['Date', "DATETRUNC('month', [date])", "DATETRUNC('month', )"],
  ['Date', "DATEDIFF('day', [start], [end])", "DATEDIFF('day', , )"],
  ['Date', "DATEADD('month', 3, [date])", "DATEADD('month', 3, )"],
  ['Date', 'YEAR, QUARTER, MONTH, DAY, TODAY()', 'YEAR()'],
  ['Text', 'CONTAINS(text, part), STARTSWITH, ENDSWITH', 'CONTAINS(, )'],
  ['Text', 'UPPER, LOWER, TRIM, LEFT(text, n), MID(text, start, n)', 'UPPER()'],
  ['Text', "a || ' ' || b — join text", " || ' ' || "],
  ['Number', 'ROUND(x, 2), ABS, FLOOR, CEIL, POWER(x, 2), SQRT, LN', 'ROUND(, 2)']
]

export function CalcDialog({ dataset, calc, onClose, onCreated }: { dataset: string; calc: CalcField | null; onClose: () => void; onCreated?: (c: CalcField) => void }) {
  const project = useApp((s) => s.project!)
  const relations = useApp((s) => s.relations)
  const rel = relations.find((r) => r.name.toLowerCase() === dataset.toLowerCase())
  const others = project.calcs.filter((c) => c.dataset.toLowerCase() === dataset.toLowerCase() && c.id !== calc?.id)
  const [name, setName] = useState(calc?.name ?? '')
  const [formula, setFormula] = useState(calc?.formula ?? '')
  const [status, setStatus] = useState<{ ok: boolean; msg: string; kind?: string } | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const columns = rel?.columns ?? []

  const nameProblem = !name.trim() ? 'Give the field a name.' : columns.some((c) => c.name.toLowerCase() === name.trim().toLowerCase()) || others.some((c) => c.name.toLowerCase() === name.trim().toLowerCase()) ? 'A field with this name already exists.' : /[[\]]/.test(name) ? 'Names can’t contain [ or ].' : ''

  // Syntax here; meaning (types, unknown functions) by the engine, on a zero-row query.
  const check = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return (text: string, nm: string) => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        if (!text.trim() || !rel) return setStatus(null)
        const me = { id: 'x', dataset, name: nm.trim() || '__new', formula: text }
        let kind: string
        try {
          kind = compileCalc(text, columns.map((c) => c.name), [...others, me], 'v').kind
        } catch (e) {
          return setStatus({ ok: false, msg: e instanceof CalcError ? e.message : (e as Error).message })
        }
        try {
          const enc = kind === 'row' ? { ...emptyEncodings(), x: [{ field: me.name }] } : { ...emptyEncodings(), y: [{ field: me.name, agg: 'none' as const }] }
          const q = compileQuery({ chart: { dataset, type: 'table', enc, filters: [], options: {} }, columns, calcs: [...others, me], params: project.params })
          const r = await E.query(`SELECT * FROM (${q.sql.replace(/\nLIMIT \d+$/, '')}) LIMIT 0`)
          const kindLabel = kind === 'row' ? 'Row-level' : kind === 'aggregate' ? 'Aggregate' : 'Table calculation'
          setStatus({ ok: true, msg: `${kindLabel} · ${r.columns[0]?.type ?? ''}`, kind })
        } catch (e) {
          setStatus({ ok: false, msg: (e as Error).message.replace(/__new|"__v_\w+"/g, (m) => (m === '__new' ? 'this field' : m)) })
        }
      }, 350)
    }
  }, [rel, columns, others, dataset, project.params])
  useEffect(() => check(formula, name), [formula, name, check])

  const insert = (text: string) => {
    const el = area.current
    if (!el) return setFormula((f) => f + text)
    const s = el.selectionStart
    const next = formula.slice(0, s) + text + formula.slice(el.selectionEnd)
    setFormula(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = s + (text.indexOf('(') >= 0 ? text.indexOf('(') + 1 : text.length)
      el.setSelectionRange(pos, pos)
    })
  }

  const save = () => {
    if (nameProblem || !status?.ok) return
    const c: CalcField = { id: calc?.id ?? newId(), dataset, name: name.trim(), formula }
    P.edit((p) => ({ ...p, calcs: calc ? p.calcs.map((x) => (x.id === calc.id ? c : x)) : [...p.calcs, c] }))
    toast(calc ? `Updated ${c.name}` : `Created ${c.name}`, 'success')
    if (!calc) onCreated?.(c)
    onClose()
  }
  const remove = () => {
    if (!calc) return
    P.edit((p) => ({ ...p, calcs: p.calcs.filter((x) => x.id !== calc.id) }))
    onClose()
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={calc ? `Edit ${calc.name}` : 'New calculated field'}
      description={`On ${dataset}. Write a formula with [Field] references; SQL functions and Tableau functions both work.`}
      width={760}
      footer={
        <>
          {calc && (
            <Btn variant="ghost" className="mr-auto text-danger" onClick={remove}>
              <Trash2 className="size-4" /> Delete
            </Btn>
          )}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!!nameProblem || !status?.ok} onClick={save} data-testid="calc-save">
            Save
          </Btn>
        </>
      }
    >
      <div className="flex gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          <Field label="Name" hint={nameProblem && name ? nameProblem : undefined}>
            <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} aria-label="Field name" data-testid="calc-name" />
          </Field>
          <Field label="Formula">
            <textarea ref={area} value={formula} onChange={(e) => setFormula(e.target.value)} spellCheck={false} rows={7} aria-label="Formula" className={cx(inputCls, 'h-auto select-text py-2 font-mono text-[12.5px] leading-relaxed')} placeholder="SUM([revenue] - [cost]) / SUM([revenue])" data-testid="calc-formula" />
          </Field>
          <div className={cx('flex min-h-[36px] items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]', !status ? 'text-text-3' : status.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')} role="status" data-testid="calc-status">
            {status ? status.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : null}
            <span className="select-text">{status ? (status.ok ? `Valid. ${status.msg}` : status.msg) : 'The formula is checked as you type.'}</span>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-text-2">Fields</div>
            <div className="flex max-h-[96px] flex-wrap gap-1 overflow-y-auto">
              {[...columns.map((c) => c.name), ...others.map((c) => c.name)].map((n) => (
                <button key={n} onClick={() => insert(`[${n}]`)} className="h-6 rounded-md border border-border px-2 font-mono text-[11.5px] hover:bg-hover">
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="w-[260px] shrink-0">
          <div className="mb-1 text-[12px] font-medium text-text-2">Functions</div>
          <ul className="max-h-[360px] overflow-y-auto rounded-lg border border-border">
            {REFERENCE.map(([group, label, text], i) => (
              <li key={label}>
                {(i === 0 || REFERENCE[i - 1][0] !== group) && <div className="bg-panel-2 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">{group}</div>}
                <button onClick={() => insert(text)} className="w-full px-2.5 py-1 text-left font-mono text-[11.5px] hover:bg-hover">
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  )
}

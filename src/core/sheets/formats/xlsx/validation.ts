// Data validation in SpreadsheetML (<dataValidations>).
import type { DataValidation, DvOperator, DvType } from '../../validation'
import { parseFormula, printFormula } from '../../engine/parser'
import { areaName, parseArea } from '../../refs'
import { esc, escText } from '../opc'
import { attr, boolAttr, elements, kids, parseXml, textOf, type El } from '../xml'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const KEEP = ['imeMode']

/** A <dataValidations> element → rules, or null when it holds something Simple Cell doesn't model (kept as is). */
export function readValidations(xml: string, sheet: number, sheetId: (n: string) => number | null): DataValidation[] | null {
  let root: El
  try {
    root = parseXml(`<w ${NS}>${xml}</w>`).documentElement.firstChild as El
  } catch {
    return null
  }
  if (elements(root).some((e) => e.localName !== 'dataValidation')) return null
  const out: DataValidation[] = []
  for (const el of kids(root, 'dataValidation')) {
    const ranges = (attr(el, 'sqref') ?? '').split(/\s+/).filter(Boolean).map((r) => parseArea(r, sheet))
    if (!ranges.length || ranges.some((r) => !r)) return null
    const a = ranges[0]!
    const dv: DataValidation = {
      ranges: ranges as NonNullable<(typeof ranges)[number]>[],
      type: (attr(el, 'type') ?? 'none') as DvType,
      allowBlank: boolAttr(el, 'allowBlank'),
      showInput: boolAttr(el, 'showInputMessage'),
      showError: boolAttr(el, 'showErrorMessage')
    }
    const op = attr(el, 'operator')
    if (op) dv.operator = op as DvOperator
    if (boolAttr(el, 'showDropDown')) dv.noDropdown = true
    const style = attr(el, 'errorStyle')
    if (style === 'warning' || style === 'information') dv.errorStyle = style
    for (const k of ['errorTitle', 'error', 'promptTitle', 'prompt'] as const) {
      const v = attr(el, k)
      if (v !== null) dv[k] = v
    }
    const carry: Record<string, string> = {}
    for (const k of KEEP) if (attr(el, k) !== null) carry[k] = attr(el, k)!
    if (Object.keys(carry).length) dv.carry = carry
    const formulas = ['formula1', 'formula2'].map((n) => kids(el, n)[0]).filter((f): f is El => !!f).map((f) => textOf(f))
    if (formulas.length) {
      try {
        dv.formulas = formulas.map((f) => parseFormula('=' + f, { row: a.r0, col: a.c0, sheetId }))
      } catch {
        return null
      }
    }
    out.push(dv)
  }
  return out
}

export function validationsXml(list: DataValidation[], sheetName: (id: number) => string | null, fname: (n: string) => string): string {
  if (!list.length) return ''
  const items = list.map((dv) => {
    const a = dv.ranges[0]
    const at: string[] = []
    if (dv.type !== 'none') at.push(`type="${dv.type}"`)
    if (dv.errorStyle && dv.errorStyle !== 'stop') at.push(`errorStyle="${dv.errorStyle}"`)
    for (const [k, v] of Object.entries(dv.carry ?? {})) at.push(`${k}="${esc(v)}"`)
    if (dv.operator && dv.operator !== 'between') at.push(`operator="${dv.operator}"`)
    if (dv.allowBlank !== false) at.push('allowBlank="1"')
    if (dv.noDropdown) at.push('showDropDown="1"')
    if (dv.showInput !== false) at.push('showInputMessage="1"')
    if (dv.showError !== false) at.push('showErrorMessage="1"')
    for (const k of ['errorTitle', 'error', 'promptTitle', 'prompt'] as const) if (dv[k] !== undefined) at.push(`${k}="${esc(dv[k]!)}"`)
    at.push(`sqref="${dv.ranges.map((x) => areaName(x)).join(' ')}"`)
    const f = (dv.formulas ?? []).map((n, i) => `<formula${i + 1}>${escText(printFormula(n, { row: a.r0, col: a.c0, sheetName, fileNames: fname }))}</formula${i + 1}>`).join('')
    return `<dataValidation ${at.join(' ')}${f ? `>${f}</dataValidation>` : '/>'}`
  })
  return `<dataValidations count="${items.length}">${items.join('')}</dataValidations>`
}

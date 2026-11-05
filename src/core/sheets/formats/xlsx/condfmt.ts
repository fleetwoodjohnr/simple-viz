// Conditional formatting and differential formats (dxfs) in SpreadsheetML.
import type { CfRule, CfType, Cfvo, CondFormat } from '../../condfmt'
import { newRuleId } from '../../condfmt'
import { parseFormula, printFormula } from '../../engine/parser'
import type { BorderSide, Style } from '../../model/styles'
import { areaName, parseArea } from '../../refs'
import { esc, escText } from '../opc'
import { attr, boolAttr, kid, kids, numAttr, parseXml, serialize, textOf, type El } from '../xml'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

type ColorFn = (el: El | null) => string | undefined

/** A differential format: only the properties it sets. */
export function readDxf(el: El, color: ColorFn): Style {
  const s: Style = {}
  const f = kid(el, 'font')
  if (f) {
    const on = (n: string) => {
      const e = kid(f, n)
      return !!e && attr(e, 'val') !== '0' && attr(e, 'val') !== 'false'
    }
    if (on('b')) s.bold = true
    if (on('i')) s.italic = true
    if (on('strike')) s.strike = true
    const u = kid(f, 'u')
    if (u && attr(u, 'val') !== 'none') s.underline = (attr(u, 'val') ?? 'single') as Style['underline']
    const c = color(kid(f, 'color'))
    if (c) s.color = c
  }
  const nf = kid(el, 'numFmt')
  if (nf && attr(nf, 'formatCode')) s.numFmt = attr(nf, 'formatCode')!
  const p = kid(kid(el, 'fill'), 'patternFill')
  if (p && attr(p, 'patternType') !== 'none') {
    // In a dxf, a solid fill's colour is the background colour.
    const c = color(kid(p, 'bgColor')) ?? color(kid(p, 'fgColor'))
    if (c) s.fill = c
  }
  const b = kid(el, 'border')
  if (b) {
    const side = (n: string): BorderSide | undefined => {
      const e = kid(b, n)
      const st = attr(e, 'style')
      return e && st && st !== 'none' ? { style: st as BorderSide['style'], color: color(kid(e, 'color')) } : undefined
    }
    const sides = { borderLeft: side('left') ?? side('start'), borderRight: side('right') ?? side('end'), borderTop: side('top'), borderBottom: side('bottom') }
    for (const [k, v] of Object.entries(sides)) if (v) (s as Record<string, unknown>)[k] = v
  }
  return s
}

const argb = (c: string) => `FF${c.replace('#', '').toUpperCase()}`

export function dxfXml(s: Style, numFmtId: (code: string) => number): string {
  const font = [s.bold && '<b/>', s.italic && '<i/>', s.strike && '<strike/>', s.underline && (s.underline === 'single' ? '<u/>' : `<u val="${s.underline}"/>`), s.color && `<color rgb="${argb(s.color)}"/>`].filter(Boolean).join('')
  const side = (n: string, b?: BorderSide) => (b ? `<${n} style="${b.style}">${b.color ? `<color rgb="${argb(b.color)}"/>` : '<color auto="1"/>'}</${n}>` : '')
  const border = side('left', s.borderLeft) + side('right', s.borderRight) + side('top', s.borderTop) + side('bottom', s.borderBottom)
  return (
    '<dxf>' +
    (font ? `<font>${font}</font>` : '') +
    (s.numFmt ? `<numFmt numFmtId="${numFmtId(s.numFmt)}" formatCode="${esc(s.numFmt)}"/>` : '') +
    (s.fill ? `<fill><patternFill><bgColor rgb="${argb(s.fill)}"/></patternFill></fill>` : '') +
    (border ? `<border>${border}</border>` : '') +
    '</dxf>'
  )
}

function readCfvo(el: El): Cfvo {
  const v: Cfvo = { type: (attr(el, 'type') ?? 'num') as Cfvo['type'] }
  const val = attr(el, 'val')
  if (val !== null) v.val = val
  if (attr(el, 'gte') === '0') v.gte = false
  return v
}

/** One <conditionalFormatting> element → model, or null when it can't be modelled (it is then kept as is). */
export function readCondFormat(xml: string, sheet: number, dxfs: Style[], color: ColorFn, sheetId: (n: string) => number | null): CondFormat | null {
  let root: El
  try {
    root = parseXml(`<w ${NS}>${xml}</w>`).documentElement.firstChild as El
  } catch {
    return null
  }
  const ranges = (attr(root, 'sqref') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((r) => parseArea(r, sheet))
  if (!ranges.length || ranges.some((r) => !r)) return null
  const anchor = ranges[0]!
  const rules: CfRule[] = []
  for (const el of kids(root, 'cfRule')) {
    const type = attr(el, 'type') as CfType | null
    if (!type) return null
    const rule: CfRule = { id: newRuleId(), type, priority: numAttr(el, 'priority') ?? rules.length + 1 }
    if (boolAttr(el, 'stopIfTrue')) rule.stopIfTrue = true
    const dxfId = numAttr(el, 'dxfId')
    if (dxfId !== null && dxfs[dxfId]) {
      rule.dxf = dxfs[dxfId]
      rule.carry = { dxfId, dxfKey: JSON.stringify(dxfs[dxfId]) }
    }
    const op = attr(el, 'operator')
    if (op && type === 'cellIs') rule.operator = op as CfRule['operator']
    if (attr(el, 'text') !== null) rule.text = attr(el, 'text')!
    if (numAttr(el, 'rank') !== null) rule.rank = numAttr(el, 'rank')!
    if (boolAttr(el, 'percent')) rule.percent = true
    if (boolAttr(el, 'bottom')) rule.bottom = true
    if (attr(el, 'aboveAverage') === '0') rule.aboveAverage = false
    if (boolAttr(el, 'equalAverage')) rule.equalAverage = true
    if (numAttr(el, 'stdDev') !== null) rule.stdDev = numAttr(el, 'stdDev')!
    if (attr(el, 'timePeriod')) rule.timePeriod = attr(el, 'timePeriod')!
    const formulas = kids(el, 'formula').map((f) => textOf(f))
    if (formulas.length) {
      try {
        rule.formulas = formulas.map((f) => parseFormula('=' + f, { row: anchor.r0, col: anchor.c0, sheetId }))
      } catch {
        return null
      }
    }
    const cs = kid(el, 'colorScale')
    if (cs) rule.colorScale = { cfvo: kids(cs, 'cfvo').map(readCfvo), colors: kids(cs, 'color').map((c) => color(c) ?? '#ffffff') }
    const db = kid(el, 'dataBar')
    if (db) {
      const [lo, hi] = kids(db, 'cfvo').map(readCfvo)
      rule.dataBar = { cfvo: [lo ?? { type: 'min' }, hi ?? { type: 'max' }], color: color(kid(db, 'color')) ?? '#638ec6' }
      if (attr(db, 'showValue') === '0') rule.dataBar.showValue = false
      if (numAttr(db, 'minLength') !== null) rule.dataBar.minLength = numAttr(db, 'minLength')!
      if (numAttr(db, 'maxLength') !== null) rule.dataBar.maxLength = numAttr(db, 'maxLength')!
    }
    const is = kid(el, 'iconSet')
    if (is) {
      rule.iconSet = { set: attr(is, 'iconSet') ?? '3TrafficLights1', cfvo: kids(is, 'cfvo').map(readCfvo) }
      if (boolAttr(is, 'reverse')) rule.iconSet.reverse = true
      if (attr(is, 'showValue') === '0') rule.iconSet.showValue = false
    }
    const ext = kid(el, 'extLst')
    if (ext) rule.carry = { ...rule.carry, ext: serialize(ext) }
    rules.push(rule)
  }
  if (!rules.length) return null
  const b: CondFormat = { ranges: ranges as NonNullable<(typeof ranges)[number]>[], rules }
  if (boolAttr(root, 'pivot')) b.pivot = true
  return b
}

const cfvoXml = (v: Cfvo) => `<cfvo type="${v.type}"${v.val !== undefined ? ` val="${esc(v.val)}"` : ''}${v.gte === false ? ' gte="0"' : ''}/>`

/** <conditionalFormatting> elements for a sheet. `dxf` returns the dxf index for a rule. */
export function condFormatsXml(blocks: CondFormat[], dxf: (r: CfRule) => number | undefined, sheetName: (id: number) => string | null, fname: (n: string) => string): string {
  return blocks
    .map((b) => {
      const a = b.ranges[0]
      const rules = b.rules
        .map((r) => {
          const attrs = [`type="${r.type}"`]
          const d = r.dxf ? dxf(r) : undefined
          if (d !== undefined) attrs.push(`dxfId="${d}"`)
          attrs.push(`priority="${r.priority}"`)
          if (r.stopIfTrue) attrs.push('stopIfTrue="1"')
          if (r.aboveAverage === false) attrs.push('aboveAverage="0"')
          if (r.equalAverage) attrs.push('equalAverage="1"')
          if (r.stdDev !== undefined) attrs.push(`stdDev="${r.stdDev}"`)
          if (r.percent) attrs.push('percent="1"')
          if (r.bottom) attrs.push('bottom="1"')
          if (r.rank !== undefined) attrs.push(`rank="${r.rank}"`)
          const op = r.type === 'cellIs' ? r.operator : r.type === 'containsText' || r.type === 'notContainsText' || r.type === 'beginsWith' || r.type === 'endsWith' ? ({ containsText: 'containsText', notContainsText: 'notContains', beginsWith: 'beginsWith', endsWith: 'endsWith' } as Record<string, string>)[r.type] : undefined
          if (op) attrs.push(`operator="${op}"`)
          if (r.text !== undefined) attrs.push(`text="${esc(r.text)}"`)
          if (r.timePeriod) attrs.push(`timePeriod="${r.timePeriod}"`)
          let inner = (r.formulas ?? []).map((f) => `<formula>${escText(printFormula(f, { row: a.r0, col: a.c0, sheetName, fileNames: fname }))}</formula>`).join('')
          if (r.colorScale) inner += `<colorScale>${r.colorScale.cfvo.map(cfvoXml).join('')}${r.colorScale.colors.map((c) => `<color rgb="${argb(c)}"/>`).join('')}</colorScale>`
          if (r.dataBar) {
            const d = r.dataBar
            const da = [d.minLength !== undefined && `minLength="${d.minLength}"`, d.maxLength !== undefined && `maxLength="${d.maxLength}"`, d.showValue === false && 'showValue="0"'].filter(Boolean).join(' ')
            inner += `<dataBar${da ? ' ' + da : ''}>${d.cfvo.map(cfvoXml).join('')}<color rgb="${argb(d.color)}"/></dataBar>`
          }
          if (r.iconSet) inner += `<iconSet iconSet="${r.iconSet.set}"${r.iconSet.showValue === false ? ' showValue="0"' : ''}${r.iconSet.reverse ? ' reverse="1"' : ''}>${r.iconSet.cfvo.map(cfvoXml).join('')}</iconSet>`
          inner += r.carry?.ext ?? ''
          return `<cfRule ${attrs.join(' ')}${inner ? `>${inner}</cfRule>` : '/>'}`
        })
        .join('')
      return `<conditionalFormatting${b.pivot ? ' pivot="1"' : ''} sqref="${b.ranges.map((x) => areaName(x)).join(' ')}">${rules}</conditionalFormatting>`
    })
    .join('')
}

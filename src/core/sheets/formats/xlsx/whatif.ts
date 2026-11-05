// What-if analysis in SpreadsheetML: data tables (<f t="dataTable"> on a table's first result cell) and scenarios
// (<scenarios> in the worksheet). For a two-variable table r1 is the row input cell and r2 the column input cell (as
// LibreOffice reads them; the e2e and unit tests check LibreOffice computes our tables the same way).
import type { DataTable, ScenarioSet } from '../../model/workbook'
import { areaName, cellName, parseArea, parseCell } from '../../refs'
import { esc } from '../opc'
import { attr, kids, parseXml } from '../xml'

const on = (v: string | undefined) => v === '1' || v === 'true'

/** A data table from the attributes of a dataTable formula, or null if Excel marked an input deleted. */
export function readDataTable(fa: Record<string, string>): DataTable | null {
  const a = fa.ref ? parseArea(fa.ref) : null
  const p1 = fa.r1 ? parseCell(fa.r1) : null
  const p2 = fa.r2 ? parseCell(fa.r2) : null
  if (!a || !p1 || on(fa.del1)) return null
  const area = { r0: a.r0, c0: a.c0, r1: a.r1, c1: a.c1 }
  if (on(fa.dt2D)) return p2 && !on(fa.del2) ? { area, rowInput: p1, colInput: p2 } : null
  return on(fa.dtr) ? { area, rowInput: p1, colInput: null } : { area, rowInput: null, colInput: p1 }
}

export function dataTableFormulaXml(t: DataTable): string {
  const both = !!(t.rowInput && t.colInput)
  const r1 = both ? t.rowInput! : (t.rowInput ?? t.colInput)!
  const attrs = [`t="dataTable"`, `ref="${areaName(t.area)}"`, `dt2D="${both ? 1 : 0}"`, `dtr="${t.rowInput && !both ? 1 : both ? 1 : 0}"`, `r1="${cellName(r1.r, r1.c)}"`]
  if (both) attrs.push(`r2="${cellName(t.colInput!.r, t.colInput!.c)}"`)
  return `<f ${attrs.join(' ')}/>`
}

export function readScenarios(xml: string): ScenarioSet | null {
  const root = parseXml(xml).documentElement
  if (!root) return null
  const list = kids(root, 'scenario').map((s) => {
    const inputs = kids(s, 'inputCells')
    const cells = inputs.map((i) => parseCell(attr(i, 'r') ?? ''))
    if (cells.some((p) => !p)) return null
    return {
      name: attr(s, 'name') ?? '',
      cells: cells as { r: number; c: number }[],
      values: inputs.map((i) => attr(i, 'val') ?? ''),
      comment: attr(s, 'comment') ?? undefined,
      user: attr(s, 'user') ?? undefined,
      locked: on(attr(s, 'locked') ?? undefined) || undefined,
      hidden: on(attr(s, 'hidden') ?? undefined) || undefined
    }
  })
  if (!list.length || list.some((s) => !s)) return null
  const n = (k: string) => Number(attr(root, k) ?? 0) || 0
  const sq = attr(root, 'sqref')
  return { list: list as ScenarioSet['list'], current: n('current'), show: n('show'), resultCells: sq ? sq.trim().split(/\s+/).join(',') : undefined }
}

export function scenariosXml(set: ScenarioSet): string {
  const scen = set.list.map((s) => {
    const a = [`name="${esc(s.name)}"`]
    if (s.locked) a.push('locked="1"')
    if (s.hidden) a.push('hidden="1"')
    a.push(`count="${s.cells.length}"`)
    if (s.user) a.push(`user="${esc(s.user)}"`)
    if (s.comment) a.push(`comment="${esc(s.comment)}"`)
    return `<scenario ${a.join(' ')}>${s.cells.map((p, i) => `<inputCells r="${cellName(p.r, p.c)}" val="${esc(s.values[i])}"/>`).join('')}</scenario>`
  })
  const sq = set.resultCells ? ` sqref="${esc(set.resultCells.replace(/\$/g, '').replace(/,/g, ' '))}"` : ''
  return `<scenarios current="${set.current}" show="${set.show}"${sq}>${scen.join('')}</scenarios>`
}

// AutoFilter: criteria per column of a range (a sheet's AutoFilter or a table's), and which rows they hide.
import { CellError, type Area, type Scalar } from './engine/values'
import type { Sheet, Workbook } from './model/workbook'
import { formatValue } from './numfmt/format'

export type FilterOp = 'equal' | 'notEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual'

export interface FilterColumn {
  /** Column offset from the left of the filter range. */
  col: number
  /** Shown values to keep (the checklist). */
  values?: string[]
  /** Keep blank cells. */
  blanks?: boolean
  /** Up to two conditions; text conditions may use * and ? wildcards (contains = "*x*"). */
  custom?: { and?: boolean; conds: { op: FilterOp; val: string }[] }
  top10?: { top: boolean; percent: boolean; val: number }
  /** A filter Simple Cell doesn't evaluate (dates grouped by month, colours, dynamic): kept for saving. */
  raw?: string
}

export interface AutoFilter {
  /** Header row and data rows. */
  area: Area
  columns: FilterColumn[]
  /** Elements inside <autoFilter> we keep (sortState, extLst). */
  carry?: string
}

export const shownText = (wb: Workbook, sh: Sheet, r: number, c: number): string => {
  const cell = sh.get(r, c)
  if (!cell || cell.v === null) return ''
  return formatValue(cell.v, wb.styles.get(cell.s).numFmt, wb.date1904, 255).text
}

function wildcard(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '~' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'is')
}

function condition(v: Scalar, text: string, op: FilterOp, val: string): boolean {
  const n = Number(val)
  const numeric = val.trim() !== '' && Number.isFinite(n)
  if (numeric && typeof v === 'number') {
    switch (op) {
      case 'equal':
        return v === n
      case 'notEqual':
        return v !== n
      case 'greaterThan':
        return v > n
      case 'greaterThanOrEqual':
        return v >= n
      case 'lessThan':
        return v < n
      case 'lessThanOrEqual':
        return v <= n
    }
  }
  if (op === 'equal') return wildcard(val).test(text)
  if (op === 'notEqual') return !wildcard(val).test(text)
  const cmp = text.localeCompare(val, undefined, { sensitivity: 'base' })
  return op === 'greaterThan' ? cmp > 0 : op === 'greaterThanOrEqual' ? cmp >= 0 : op === 'lessThan' ? cmp < 0 : cmp <= 0
}

/** Rows of the filter range (excluding the header) that the criteria hide. */
export function hiddenRows(wb: Workbook, sh: Sheet, af: AutoFilter): Set<number> {
  const hidden = new Set<number>()
  const { area } = af
  const last = Math.min(area.r1, Math.max(area.r0, sh.used().r))
  for (const fc of af.columns) {
    if (fc.raw) continue
    const c = area.c0 + fc.col
    let limit: number | null = null
    if (fc.top10) {
      const nums: number[] = []
      for (let r = area.r0 + 1; r <= last; r++) {
        const v = sh.get(r, c)?.v
        if (typeof v === 'number') nums.push(v)
      }
      nums.sort((a, b) => (fc.top10!.top ? b - a : a - b))
      const k = fc.top10.percent ? Math.max(1, Math.floor((nums.length * fc.top10.val) / 100)) : Math.max(1, Math.floor(fc.top10.val))
      limit = nums[Math.min(k, nums.length) - 1] ?? null
    }
    const wanted = fc.values ? new Set(fc.values.map((x) => x.toLowerCase())) : null
    for (let r = area.r0 + 1; r <= area.r1; r++) {
      if (hidden.has(r)) continue
      const v = sh.get(r, c)?.v ?? null
      const text = shownText(wb, sh, r, c)
      const blank = v === null || v === ''
      let ok = true
      if (wanted) ok = blank ? !!fc.blanks : wanted.has(text.toLowerCase())
      else if (fc.blanks !== undefined && blank) ok = fc.blanks
      if (ok && fc.custom) {
        const results = fc.custom.conds.map((cd) => condition(v instanceof CellError ? null : v, text, cd.op, cd.val))
        ok = fc.custom.and ? results.every(Boolean) : results.some(Boolean)
      }
      if (ok && fc.top10) ok = typeof v === 'number' && limit !== null && (fc.top10.top ? v >= limit : v <= limit)
      if (!ok) hidden.add(r)
    }
  }
  return hidden
}

/** Distinct shown values of a column (data rows), sorted as Excel lists them: numbers, then text; and whether any are blank. */
export function columnValues(wb: Workbook, sh: Sheet, af: AutoFilter, col: number): { values: string[]; blanks: boolean } {
  const c = af.area.c0 + col
  const seen = new Map<string, { t: string; v: Scalar }>()
  let blanks = false
  const last = Math.min(af.area.r1, sh.used().r)
  // ponytail: checklists stop at 10,000 distinct values; a custom filter covers longer columns.
  for (let r = af.area.r0 + 1; r <= last && seen.size < 10_000; r++) {
    const v = sh.get(r, c)?.v ?? null
    if (v === null || v === '') {
      blanks = true
      continue
    }
    const t = shownText(wb, sh, r, c)
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), { t, v })
  }
  if (last < af.area.r1) blanks = true
  const values = [...seen.values()]
    .sort((a, b) => {
      const na = typeof a.v === 'number'
      const nb = typeof b.v === 'number'
      if (na && nb) return (a.v as number) - (b.v as number)
      if (na !== nb) return na ? -1 : 1
      return a.t.localeCompare(b.t)
    })
    .map((x) => x.t)
  return { values, blanks }
}

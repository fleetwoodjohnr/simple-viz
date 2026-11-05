// PivotTables: a pure engine from records (a header row and data rows) and a layout to a grid of cells.
import { CellError, ERR, compareScalars, type Scalar } from './engine/values'
import { serialToDate } from './numfmt/dates'

export type Agg = 'sum' | 'count' | 'average' | 'max' | 'min' | 'product' | 'countNums' | 'stdDev' | 'stdDevP' | 'var' | 'varP'

export interface PivotValue {
  field: string
  agg: Agg
  /** Show Values As. */
  showAs?: 'normal' | 'percentOfTotal' | 'percentOfRow' | 'percentOfCol'
  /** Display name ("Sum of Sales" by default). */
  name?: string
}

export interface PivotConfig {
  rows: string[]
  cols: string[]
  values: PivotValue[]
  /** Report filters and per-field item filters: the items to keep (absent = all). */
  filters: string[]
  include?: Record<string, string[]>
  /** Group a date field by years, quarters or months. */
  dateGroups?: Record<string, 'years' | 'quarters' | 'months'>
  grandRows?: boolean
  grandCols?: boolean
  subtotals?: boolean
  sort?: Record<string, 'asc' | 'desc'>
}

/** A PivotTable on a sheet: its source range, where its output starts, its layout, and the area it last filled. */
export interface PivotTable {
  id: number
  name: string
  /** The source range as a reference (no "="), e.g. Data!$A$1:$E$500. */
  source: string
  at: { r: number; c: number }
  config: PivotConfig
  area?: { r0: number; c0: number; r1: number; c1: number }
  /** From a file: its parts, kept for round trips. */
  carry?: Record<string, string>
}

let nextPivot = 1
export const newPivotId = () => nextPivot++

export const emptyPivot = (): PivotConfig => ({ rows: [], cols: [], values: [], filters: [], grandRows: true, grandCols: true, subtotals: true })

export const AGG_LABEL: Record<Agg, string> = { sum: 'Sum', count: 'Count', average: 'Average', max: 'Max', min: 'Min', product: 'Product', countNums: 'Count Numbers', stdDev: 'StdDev', stdDevP: 'StdDevp', var: 'Var', varP: 'Varp' }
export const valueName = (v: PivotValue) => v.name ?? `${AGG_LABEL[v.agg]} of ${v.field}`

/** One output cell: its value and its role (for formatting). */
export interface PivotCell {
  v: Scalar
  kind: 'header' | 'rowLabel' | 'colLabel' | 'value' | 'subtotal' | 'grand' | 'grandLabel' | 'filter' | 'blank'
  /** Number format for value cells (percent for Show Values As). */
  fmt?: string
}

export interface PivotOutput {
  cells: PivotCell[][]
  /** Distinct items per field (for the field list and item filters). */
  items: Record<string, string[]>
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The text a value is grouped under ("(blank)" for empty cells, as Excel). */
function itemText(v: Scalar, group: 'years' | 'quarters' | 'months' | undefined, date1904: boolean): string {
  if (v === null || v === '') return '(blank)'
  if (group && typeof v === 'number') {
    const d = serialToDate(v, date1904)
    return group === 'years' ? String(d.y) : group === 'quarters' ? `${d.y} Qtr${Math.floor((d.m - 1) / 3) + 1}` : `${d.y} ${MONTHS[d.m - 1]}`
  }
  if (v instanceof CellError) return v.code
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return typeof v === 'number' ? String(v) : v
}

function aggregate(agg: Agg, xs: Scalar[]): Scalar {
  // No records at an intersection: an empty cell, as in Excel.
  if (!xs.length) return null
  const nums = xs.filter((x): x is number => typeof x === 'number')
  const n = nums.length
  const mean = n ? nums.reduce((a, b) => a + b, 0) / n : 0
  const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0)
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'count':
      return xs.filter((x) => x !== null && x !== '').length
    case 'countNums':
      return n
    case 'average':
      return n ? mean : ERR.DIV0
    case 'max':
      return n ? Math.max(...nums) : 0
    case 'min':
      return n ? Math.min(...nums) : 0
    case 'product':
      return n ? nums.reduce((a, b) => a * b, 1) : 0
    case 'stdDev':
      return n > 1 ? Math.sqrt(ss / (n - 1)) : ERR.DIV0
    case 'stdDevP':
      return n ? Math.sqrt(ss / n) : ERR.DIV0
    case 'var':
      return n > 1 ? ss / (n - 1) : ERR.DIV0
    case 'varP':
      return n ? ss / n : ERR.DIV0
  }
}

/** Distinct items of a field, sorted as Excel sorts them (numbers, then text, then logicals; "(blank)" last). */
function sortedItems(values: { t: string; v: Scalar }[], dir: 'asc' | 'desc' = 'asc'): string[] {
  const seen = new Map<string, Scalar>()
  for (const x of values) if (!seen.has(x.t)) seen.set(x.t, x.v)
  const out = [...seen.entries()].sort(([at, av], [bt, bv]) => {
    if (at === '(blank)') return 1
    if (bt === '(blank)') return -1
    const c = av instanceof CellError || bv instanceof CellError ? at.localeCompare(bt) : compareScalars(av, bv)
    return dir === 'asc' ? c : -c
  })
  return out.map(([t]) => t)
}

/**
 * Lay out a PivotTable. `header` names the source columns; `rows` are the records. The output follows Excel's
 * compact-free "tabular" shape: row fields across the left, column items across the top, values in the body.
 */
export function pivot(header: string[], records: Scalar[][], cfg: PivotConfig, date1904 = false): PivotOutput {
  const idx = (f: string) => header.indexOf(f)
  const groupOf = (f: string) => cfg.dateGroups?.[f]
  const key = (rec: Scalar[], f: string) => itemText(rec[idx(f)] ?? null, groupOf(f), date1904)
  const items: Record<string, string[]> = {}
  for (const f of header) items[f] = sortedItems(records.map((r) => ({ t: key(r, f), v: groupOf(f) && typeof r[idx(f)] === 'number' ? (r[idx(f)] as number) : (r[idx(f)] ?? null) })), cfg.sort?.[f])
  // Filters (report filters and item filters on any field).
  const keep = records.filter((r) => Object.entries(cfg.include ?? {}).every(([f, list]) => idx(f) < 0 || list.includes(key(r, f))))
  const vals = cfg.values.filter((v) => idx(v.field) >= 0)
  const rowF = cfg.rows.filter((f) => idx(f) >= 0)
  const colF = cfg.cols.filter((f) => idx(f) >= 0 && f !== '∑ Values')
  const valuesAsCols = vals.length > 1
  // Group the records by row key path and column key path.
  const rowKeys = uniquePaths(keep, rowF, key, items)
  const colKeys = uniquePaths(keep, colF, key, items)
  const cell = (rp: string[], cp: string[], v: PivotValue): Scalar => {
    const xs: Scalar[] = []
    for (const r of keep) if (rp.every((k, i) => key(r, rowF[i]) === k) && cp.every((k, i) => key(r, colF[i]) === k)) xs.push(r[idx(v.field)] ?? null)
    return aggregate(v.agg, xs)
  }
  const out: PivotCell[][] = []
  const push = (row: PivotCell[]) => out.push(row)
  // Report filters above the table, then a blank row.
  for (const f of cfg.filters) {
    const inc = cfg.include?.[f]
    push([{ v: f, kind: 'filter' }, { v: !inc || inc.length === items[f]?.length ? '(All)' : inc.length === 1 ? inc[0] : '(Multiple Items)', kind: 'filter' }])
  }
  if (cfg.filters.length) push([])
  if (!vals.length && !rowF.length && !colF.length) return { cells: out, items }
  const showCol = (cp: string[], vi: number) => ({ cp, vi })
  // Column leaves: each column path × each value (values across when several).
  const colLeaves: { cp: string[]; vi: number; kind: 'value' | 'grand' }[] = []
  const vlist = vals.length ? vals : [null]
  for (const cp of colKeys.leaves) for (let vi = 0; vi < vlist.length; vi++) colLeaves.push({ ...showCol(cp, vi), kind: 'value' })
  if ((cfg.grandCols ?? true) && colF.length) for (let vi = 0; vi < vlist.length; vi++) colLeaves.push({ cp: [], vi, kind: 'grand' })
  const left = Math.max(1, rowF.length)
  // With column fields, a caption row first: the value name, then the column field over the column labels.
  if (colF.length) {
    const cap: PivotCell[] = [{ v: vals.length === 1 ? valueName(vals[0]) : '', kind: 'header' }, ...Array.from({ length: left - 1 + colLeaves.length }, () => ({ v: '', kind: 'blank' as const }))]
    cap[left] = { v: colF.join(' / '), kind: 'header' }
    push(cap)
  }
  // Header rows: column fields' items, then value names.
  const headRows = Math.max(1, colF.length + (valuesAsCols ? 1 : 0))
  for (let h = 0; h < headRows; h++) {
    const row: PivotCell[] = []
    for (let i = 0; i < left; i++) row.push(h === headRows - 1 ? { v: rowF[i] ?? (vals.length === 1 && !colF.length ? 'Row Labels' : ''), kind: 'header' } : { v: '', kind: 'blank' })
    for (const leaf of colLeaves) {
      if (h < colF.length) row.push({ v: leaf.kind === 'grand' ? (h === 0 ? (valuesAsCols ? `Total ${valueName(vals[leaf.vi])}` : 'Grand Total') : '') : leaf.cp[h], kind: leaf.kind === 'grand' ? 'grandLabel' : 'colLabel' })
      else row.push({ v: vals.length ? valueName(vals[leaf.vi]) : '', kind: 'header' })
    }
    if (!colF.length && !valuesAsCols && vals.length === 1) row[left] = { v: valueName(vals[0]), kind: 'header' }
    push(row)
  }
  const pct = (v: Scalar, vi: number, rp: string[] | null, cp: string[] | null): { v: Scalar; fmt?: string } => {
    const sv = vals[vi]?.showAs
    if (!sv || sv === 'normal' || typeof v !== 'number') return { v }
    const total = cell(sv === 'percentOfCol' || !rp ? [] : sv === 'percentOfRow' ? rp : [], sv === 'percentOfRow' || !cp ? [] : sv === 'percentOfCol' ? cp : [], vals[vi])
    return { v: typeof total === 'number' && total !== 0 ? v / total : ERR.DIV0, fmt: '0.00%' }
  }
  const valuesRow = (labels: PivotCell[], rp: string[], kind: 'value' | 'subtotal' | 'grand') => {
    const row = [...labels]
    for (const leaf of colLeaves) {
      if (!vals.length) {
        row.push({ v: '', kind: 'blank' })
        continue
      }
      const cp = leaf.kind === 'grand' ? [] : leaf.cp
      const r = pct(cell(rp, cp, vals[leaf.vi]), leaf.vi, rp, cp)
      row.push({ v: r.v, kind: kind === 'value' && leaf.kind === 'grand' ? 'grand' : kind, fmt: r.fmt })
    }
    push(row)
  }
  // Body: row paths in order, with subtotals after each group of an outer field.
  const subtotals = (cfg.subtotals ?? true) && rowF.length > 1
  let prev: string[] = []
  const closeGroups = (next: string[]) => {
    if (!subtotals) return
    for (let d = rowF.length - 2; d >= 0; d--) {
      if (prev.length && (next.length === 0 || next.slice(0, d + 1).join('\u0000') !== prev.slice(0, d + 1).join('\u0000'))) {
        const labels: PivotCell[] = Array.from({ length: left }, (_, i) => (i === d ? { v: `${prev[d]} Total`, kind: 'subtotal' as const } : { v: '', kind: 'blank' as const }))
        valuesRow(labels, prev.slice(0, d + 1), 'subtotal')
      }
    }
  }
  for (const rp of rowF.length ? rowKeys.leaves : [[]]) {
    closeGroups(rp)
    const labels: PivotCell[] = Array.from({ length: left }, (_, i) => (rowF.length && (i === rowF.length - 1 || rp[i] !== prev[i] || rp.slice(0, i).join('\u0000') !== prev.slice(0, i).join('\u0000')) ? { v: rp[i], kind: 'rowLabel' as const } : { v: '', kind: 'blank' as const }))
    if (!rowF.length) labels[0] = { v: vals.length === 1 && !colF.length ? 'Total' : '', kind: 'rowLabel' }
    valuesRow(labels, rp, 'value')
    prev = rp
  }
  closeGroups([])
  if ((cfg.grandRows ?? true) && rowF.length) valuesRow([{ v: 'Grand Total', kind: 'grandLabel' }, ...Array.from({ length: left - 1 }, () => ({ v: '', kind: 'blank' as const }))], [], 'grand')
  return { cells: out, items }
}

/** Distinct key paths over fields, in item order (only combinations that occur). */
function uniquePaths(recs: Scalar[][], fields: string[], key: (r: Scalar[], f: string) => string, items: Record<string, string[]>) {
  if (!fields.length) return { leaves: [[]] as string[][] }
  const seen = new Set<string>()
  const leaves: string[][] = []
  for (const r of recs) {
    const p = fields.map((f) => key(r, f))
    const k = p.join('\u0000')
    if (!seen.has(k)) {
      seen.add(k)
      leaves.push(p)
    }
  }
  const pos = (f: string, t: string) => items[f].indexOf(t)
  leaves.sort((a, b) => {
    for (let i = 0; i < fields.length; i++) {
      const d = pos(fields[i], a[i]) - pos(fields[i], b[i])
      if (d) return d
    }
    return 0
  })
  return { leaves }
}

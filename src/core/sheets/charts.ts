// Charts: a sheet's charts (type, series as references, layout) and the data they plot.
import type { Area, Scalar } from './engine/values'

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter'

export interface ChartSeries {
  /** Formula text (no "="): a reference such as Sheet1!$B$1, or a quoted name ("Sales"). */
  name?: string
  /** Category (x) values: a reference. */
  cat?: string
  /** The values: a reference. */
  val: string
  color?: string
}

/** Where the chart sits: a cell corner plus pixel offsets, for both corners (as DrawingML twoCellAnchor). */
export interface ChartAnchor {
  r0: number
  c0: number
  dx0: number
  dy0: number
  r1: number
  c1: number
  dx1: number
  dy1: number
}

export interface Chart {
  id: number
  type: ChartType
  grouping: 'clustered' | 'stacked' | 'percent'
  title?: string
  series: ChartSeries[]
  legend: 'right' | 'bottom' | 'top' | 'left' | 'none'
  dataLabels?: boolean
  xTitle?: string
  yTitle?: string
  anchor: ChartAnchor
  /** From a file: its chart part and drawing, and what it looked like when read (unchanged charts keep their XML). */
  carry?: { part?: string; drawing?: string; rid?: string; sig?: string; anchorSig?: string; note?: string }
}

export interface ChartData {
  categories: string[]
  series: { name: string; values: (number | null)[]; x?: (number | null)[]; color?: string }[]
}

let nextId = 1
export const newChartId = () => nextId++

/** What a chart's XML is generated from (the anchor is written separately). */
export const chartSig = (c: Chart) => JSON.stringify([c.type, c.grouping, c.title, c.series, c.legend, c.dataLabels, c.xTitle, c.yTitle])

export const ICON_FOR: Record<ChartType, string> = { column: 'Column', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', doughnut: 'Doughnut', scatter: 'Scatter' }

/** A value as a chart reads it: numbers; numeric text; everything else is a gap. */
export const plotNumber = (v: Scalar): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/**
 * The series Excel makes from a selected range: categories in the first column (or row) when it holds text, series
 * names in the first row (or column), one series per column when the range is taller than wide.
 */
export function seriesFromRange(a: Area, sheetName: string, text: (r: number, c: number) => string, isNum: (r: number, c: number) => boolean): ChartSeries[] {
  const q = /^[A-Za-z_][\w.]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`
  const ref = (r0: number, c0: number, r1: number, c1: number) => `${q}!${abs(r0, c0)}${r0 === r1 && c0 === c1 ? '' : ':' + abs(r1, c1)}`
  const rows = a.r1 - a.r0 + 1
  const cols = a.c1 - a.c0 + 1
  const byCols = rows >= cols
  // A header row/column: its cells (except the corner) aren't numbers.
  const firstRowText = cols > 1 && [...Array(cols).keys()].slice(1).every((j) => !isNum(a.r0, a.c0 + j)) && [...Array(cols).keys()].slice(1).some((j) => text(a.r0, a.c0 + j))
  const firstColText = rows > 1 && [...Array(rows).keys()].slice(1).every((i) => !isNum(a.r0 + i, a.c0)) && [...Array(rows).keys()].slice(1).some((i) => text(a.r0 + i, a.c0))
  const hr = firstRowText ? 1 : 0
  const hc = firstColText ? 1 : 0
  const out: ChartSeries[] = []
  if (byCols) {
    for (let c = a.c0 + hc; c <= a.c1; c++)
      out.push({ name: hr ? ref(a.r0, c, a.r0, c) : undefined, cat: hc ? ref(a.r0 + hr, a.c0, a.r1, a.c0) : undefined, val: ref(a.r0 + hr, c, a.r1, c) })
  } else {
    for (let r = a.r0 + hr; r <= a.r1; r++)
      out.push({ name: hc ? ref(r, a.c0, r, a.c0) : undefined, cat: hr ? ref(a.r0, a.c0 + hc, a.r0, a.c1) : undefined, val: ref(r, a.c0 + hc, r, a.c1) })
  }
  return out.filter((s) => s.val)
}

function abs(r: number, c: number) {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return `$${s}$${r + 1}`
}

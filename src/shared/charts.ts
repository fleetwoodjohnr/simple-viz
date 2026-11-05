// Charts, calculated fields, filters and parameters as stored in a project (project.json → charts, calcs, params).

export type Agg = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countd' | 'median' | 'stdev' | 'var' | 'p25' | 'p75' | 'p90' | 'none'
export type DateGrain = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'exact'
/** Quick table calculations applied to a measure (Tableau's "quick table calculation"). */
export type QuickCalc = 'running_sum' | 'running_avg' | 'pct_total' | 'rank' | 'diff_prev' | 'pct_diff_prev' | 'moving_avg_3' | 'yoy'

export interface FieldRef {
  /** Column of the dataset, or the name of a calculated field. */
  field: string
  /** Aggregation for measures; absent for dimensions. 'none' for aggregate calculated fields. */
  agg?: Agg
  /** Dates used as dimensions: truncate to this grain. */
  grain?: DateGrain
  quick?: QuickCalc
  /** Display name override. */
  label?: string
  /** Number format code (Excel style, e.g. "$#,##0", "0.0%"); absent = automatic. */
  format?: string
}

export interface Encodings {
  /** Columns shelf: categories or values along the horizontal axis. */
  x: FieldRef[]
  /** Rows shelf: values (or categories) along the vertical axis. Several measures = several series / dual axis. */
  y: FieldRef[]
  color?: FieldRef
  size?: FieldRef
  label?: FieldRef
  /** Extra dimensions that split marks without a visual channel (Tableau's Detail). */
  detail: FieldRef[]
  tooltip: FieldRef[]
  /** Small multiples: one panel per value. */
  facet?: FieldRef
}

export type FilterOp = 'in' | 'not_in' | 'between' | 'gte' | 'lte' | 'contains' | 'relative' | 'top' | 'null' | 'not_null'

export interface ChartFilter {
  id: string
  field: string
  /** Filter on the aggregated value (measure filter, applied after grouping). */
  agg?: Agg
  op: FilterOp
  values?: (string | number | boolean | null)[]
  min?: number | string | null
  max?: number | string | null
  /** relative: last N units up to today (e.g. last 3 months), anchored on the current date. */
  relative?: { n: number; unit: 'day' | 'week' | 'month' | 'quarter' | 'year'; includeCurrent: boolean }
  /** top: keep the N dimension values with the highest (or lowest) `by` measure. */
  top?: { n: number; by: FieldRef; bottom?: boolean }
  /** Context filter: applied before FIXED level-of-detail calculations and top-N (Tableau semantics). */
  context?: boolean
  /** Bind to a parameter instead of a fixed value (op gte/lte/in use the parameter's value). */
  param?: string
}

export interface ReferenceLine {
  id: string
  kind: 'constant' | 'average' | 'median' | 'min' | 'max' | 'trend' | 'param'
  value?: number
  param?: string
  label?: string
  /** For trend lines: confidence band (0.95). */
  band?: number
}

export interface ChartOptions {
  title?: string
  subtitle?: string
  /** stacked bars/areas: none, stacked, or 100% stacked. */
  stack?: 'none' | 'stacked' | 'percent'
  horizontal?: boolean
  labels?: boolean
  legend?: 'auto' | 'none' | 'top' | 'right' | 'bottom'
  sort?: { by: 'category' | 'value'; dir: 'asc' | 'desc' }
  /** Palette name (categorical) or 'accent'. */
  palette?: string
  smooth?: boolean
  donut?: boolean
  /** Histogram bin count. */
  bins?: number
  refLines?: ReferenceLine[]
  /** Combo chart: series index (from y) drawn as lines instead of bars, and on the right axis. */
  lineSeries?: number[]
  rightAxis?: number[]
  /** KPI: compare with the previous period of this date field. */
  compareField?: string
  /** Gauge/bullet target value. */
  target?: number
  min?: number
  max?: number
}

export interface Chart {
  id: string
  name: string
  /** Relation the chart reads: a source alias or a dataset. */
  dataset: string
  type: string
  enc: Encodings
  filters: ChartFilter[]
  options: ChartOptions
  /** Reusable component: offered first when building dashboards. */
  favorite?: boolean
  updatedAt: number
}

export interface CalcField {
  id: string
  /** Relation it belongs to. */
  dataset: string
  name: string
  formula: string
  description?: string
}

export interface Parameter {
  id: string
  name: string
  type: 'number' | 'text' | 'date' | 'boolean'
  value: string | number | boolean | null
  /** Allowed values (list parameter) or range. */
  choices?: (string | number)[]
  min?: number
  max?: number
  step?: number
}

export const emptyEncodings = (): Encodings => ({ x: [], y: [], detail: [], tooltip: [] })

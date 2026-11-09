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
  /** Table calculations (quick or calculated): the view's dimensions they run along ("compute using"); the other
   *  dimensions partition. Absent = along the x axis, partitioned by the rest. */
  computeUsing?: string[]
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
  /** between: values must be below max (not equal), e.g. the start of the next period. */
  maxExclusive?: boolean
  /** relative: last N units up to today (e.g. last 3 months), anchored on the current date. */
  relative?: { n: number; unit: 'day' | 'week' | 'month' | 'quarter' | 'year'; includeCurrent: boolean }
  /** top: keep the N dimension values with the highest (or lowest) `by` measure. */
  top?: { n: number; by: FieldRef; bottom?: boolean }
  /** Context filter: applied before FIXED level-of-detail calculations and top-N (Tableau semantics). */
  context?: boolean
  /** Bind to a parameter instead of a fixed value (op gte/lte/in use the parameter's value). */
  param?: string
}

export type TrendModel = 'linear' | 'log' | 'exp' | 'power' | 'poly'

export interface ReferenceLine {
  id: string
  /**
   * band: shaded mean ± value standard deviations (default 1), Tableau's distribution band. percentile: a line at the
   * value-th percentile. ci: the 95% confidence interval of the mean. box: a reference box (quartiles, median,
   * whiskers at the furthest values within 1.5 IQR).
   */
  kind: 'constant' | 'average' | 'median' | 'min' | 'max' | 'trend' | 'param' | 'band' | 'percentile' | 'ci' | 'box'
  value?: number
  /** Trend lines: the model (Tableau's linear, logarithmic, exponential, power, polynomial) and polynomial degree. */
  model?: TrendModel
  degree?: number
  param?: string
  label?: string
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
  /** Gauge: scale (default 0 to a round number above the value). */
  gauge?: { min?: number; max?: number }
  /** Maps: 'world', 'us-states' or a custom map's id (Project.maps); absent = the map that matches most values. */
  map?: string
  /** Custom visual: an ECharts option as JSON; the strings $categories, $values[:N], $series[:type], $items[:N] and
   * $rows are replaced by the chart's data (core/charts/more.ts fillTemplate). */
  template?: string
  /** Line/area over a date axis: exponential-smoothing forecast of each series, with a prediction interval. */
  forecast?: { periods: number; level?: number }
  /** Densify a date axis: every period between the first and last, empty ones as null (Tableau's "Show Missing
   *  Values"); table calculations run over them. */
  showMissing?: boolean
  /** Viz in tooltip: another saved chart, shown filtered to the hovered mark, at this size (default 280 × 180). */
  tooltipChart?: string
  tooltipSize?: { w: number; h: number }
  /** Viz in tooltip: filter it by these fields only (default: every field the two charts share). */
  tooltipFields?: string[]
  /** Combo chart: series index (from y) drawn as lines instead of bars, and on the right axis. */
  lineSeries?: number[]
  rightAxis?: number[]
  /** KPI: compare with the previous period of this date field. */
  compareField?: string
  /** Drill-down path: the dimensions a click on a mark steps through (the first is the chart's own). */
  drill?: FieldRef[]
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

export interface SetDef {
  field: string
  values: (string | number | boolean)[]
  condition?: string
  top?: { n: number; by: string; agg: Agg; bottom?: boolean }
  combine?: { a: string; b: string; op: 'union' | 'intersect' | 'except' }
}

export interface CalcField {
  id: string
  /** Relation it belongs to. */
  dataset: string
  name: string
  formula: string
  description?: string
  /**
   * A set of a dimension's values, 'In' or 'Out' (Tableau's sets). Members are listed (`values`), or computed after
   * context filters: those meeting an aggregate `condition` (e.g. SUM([Sales]) > 1000), or the `top` n by a measure.
   * `combine` joins two sets of the same dimension. The formula is generated from these.
   */
  set?: SetDef
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

/** A value for a parameter, converted to its type (null when it can't be). */
export function coerceParam(p: Pick<Parameter, 'type'>, v: unknown): Parameter['value'] {
  if (v === null || v === undefined || v === '') return null
  if (p.type === 'number') return Number.isFinite(Number(v)) ? Number(v) : null
  if (p.type === 'boolean') return v === true || v === 'true' || v === 1
  if (p.type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null
  return String(v)
}

export const emptyEncodings = (): Encodings => ({ x: [], y: [], detail: [], tooltip: [] })

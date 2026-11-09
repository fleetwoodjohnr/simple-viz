// Dashboards as stored in a project (project.json → dashboards).

export type ItemKind = 'chart' | 'text' | 'filter' | 'button' | 'image' | 'shape' | 'container' | 'param'

export interface DashItem {
  id: string
  kind: ItemKind
  /** Position and size on the dashboard canvas, in px (snapped to the grid). */
  x: number
  y: number
  w: number
  h: number
  locked?: boolean
  /** Items with the same group move together. */
  group?: string
  /** Inside a layout container (its children are laid out in a row or column; x/y are ignored). */
  parent?: string
  chartId?: string
  /** Text: plain text with {field} placeholders for dynamic titles (e.g. "Sales for {region}"). */
  text?: string
  textStyle?: { size: number; bold?: boolean; align?: 'left' | 'center' | 'right'; color?: string }
  filter?: { field: string; mode: 'list' | 'dropdown' | 'range' | 'dates' | 'search'; title?: string; multi?: boolean }
  button?: { label: string; action: 'navigate' | 'reset' | 'refresh' | 'fullscreen'; target?: string }
  /** Image: a data URL (embedded in the project). */
  image?: string
  shape?: { fill: string; radius: number }
  /** Parameter control: the parameter's name. */
  param?: string
  container?: { direction: 'row' | 'column'; gap: number }
  /** Show the tile's title bar (charts). */
  showTitle?: boolean
  /** Tiled dashboards: a floating item keeps its own position, over the tiles. */
  floating?: boolean
}

export type Device = 'default' | 'tablet' | 'phone'

/** A device layout: its own size and item positions (items without one are placed automatically; hidden ones aren't shown). */
export interface DeviceLayout {
  w: number
  h: number
  pos: Record<string, { x: number; y: number; w: number; h: number; hidden?: boolean }>
}

export interface DashAction {
  id: string
  /** filter: selecting marks filters the targets; highlight: dims non-matching marks; navigate: opens a dashboard
   *  with the selection applied (drill-through); url: opens a web page for the clicked mark; param: sets a parameter
   *  to the clicked mark's value of `fields[0]` (or its first field). */
  kind: 'filter' | 'highlight' | 'navigate' | 'url' | 'param' | 'set'
  /** Source chart item id, or '*' for every chart. */
  source: string
  /** Target chart item ids, or '*' for every other chart; for navigate, a dashboard id; for url, the address, with
   *  {Field} (or Tableau's <Field>) replaced by the clicked mark's value; for param, the parameter's name; for set, the set's name (its members become the clicked marks' values). */
  target: string
  /** Fields carried by the action; empty = every dimension of the clicked mark. */
  fields?: string[]
}

export interface Dashboard {
  id: string
  name: string
  /** fixed: exactly w × h; fit: scaled to the window, keeping the proportions. */
  size: { mode: 'fixed' | 'fit'; w: number; h: number }
  items: DashItem[]
  actions: DashAction[]
  background?: string
  favorite?: boolean
  /** Minutes between automatic refreshes while the dashboard is shown (0 = off). */
  refreshEveryMin?: number
  /** Saved filter selections ("views"). */
  views?: { id: string; name: string; selections: Selections }[]
  /** Tiled layout: the items fill the dashboard without overlapping, in rows; their sizes are kept as proportions. */
  tiled?: boolean
  /** Layouts for smaller screens, shown when the window is narrow (or previewed). */
  devices?: Partial<Record<'tablet' | 'phone', DeviceLayout>>
  updatedAt: number
}

/** Current filter selections: field name → chosen values (or a range for range/date controls). */
export type Selections = Record<string, { values?: (string | number | boolean | null)[]; min?: number | string | null; max?: number | string | null }>

export const GRID = 8

export const SIZES: { id: string; label: string; w: number; h: number }[] = [
  { id: 'desktop', label: 'Desktop (1366 × 768)', w: 1366, h: 768 },
  { id: 'laptop', label: 'Laptop (1280 × 800)', w: 1280, h: 800 },
  { id: 'wide', label: 'Wide (1600 × 900)', w: 1600, h: 900 },
  { id: 'tablet', label: 'Tablet (1024 × 768)', w: 1024, h: 768 },
  { id: 'phone', label: 'Phone (390 × 844)', w: 390, h: 844 },
  { id: 'a4', label: 'A4 landscape (1123 × 794)', w: 1123, h: 794 },
  { id: 'letter', label: 'US Letter landscape (1056 × 816)', w: 1056, h: 816 }
]

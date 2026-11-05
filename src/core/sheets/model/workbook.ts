// The workbook model: sheets of sparse cells, styles, defined names and tables. It holds no UI state.
import { MAX_COLS, MAX_ROWS, type Area, type Scalar } from '../engine/values'
import type { Node } from '../engine/parser'
import { StyleTable } from './styles'
import type { CondFormat } from '../condfmt'
import type { DataValidation } from '../validation'
import type { AutoFilter, FilterColumn } from '../filter'
import { defaultPageSetup, type PageSetup } from '../print'
import type { Chart } from '../charts'
import type { SparklineGroup } from '../sparklines'
import type { PivotTable } from '../pivot'

export interface Formula {
  /** Parsed formula; references are relative to the cell (shared by every cell a formula was filled into). */
  ast: Node
  /** Entered as a legacy Ctrl+Shift+Enter array formula over this area (anchor is the top-left cell). */
  array?: Area
  /** Legacy formula (from a file without dynamic-array metadata): ranges in scalar positions use implicit intersection. */
  legacy?: boolean
  /** The formula uses something the engine can't calculate (an unsupported function or an external workbook). */
  unsupported?: string
}

export interface Cell {
  /** The value: a constant, or the latest result of the formula. */
  v: Scalar
  f?: Formula
  /** Style id in the workbook's StyleTable; 0 is the default style. */
  s?: number
  /** Value came from the file and was not recalculated (formula unsupported, or not yet calculated). */
  stale?: boolean
  /** Part of another cell's spilled array: key of the anchor. Such cells have no content of their own. */
  spillOf?: number
  /** Rich text runs from the file, kept for round trips (the plain text is `v`). */
  rich?: unknown
}

/** A note (Excel's classic comment). */
export interface Note {
  author: string
  text: string
  /** File details kept while the note is unchanged (rich text runs, shape). */
  carry?: Record<string, string>
}

/** A hyperlink: an address outside the workbook, or a place inside it ("Sheet2!A1", a name). */
export interface Link {
  url?: string
  location?: string
  tooltip?: string
}

/** A what-if data table. Formulas and input values sit in the row above the area and the column to its left. */
export interface DataTable {
  /** The result cells. */
  area: { r0: number; c0: number; r1: number; c1: number }
  /** The values across the top row go into this cell (null: none). */
  rowInput: { r: number; c: number } | null
  /** The values down the left column go into this cell (null: none). */
  colInput: { r: number; c: number } | null
}

export interface Scenario {
  name: string
  cells: { r: number; c: number }[]
  /** One value per changing cell, as typed (numbers as text). */
  values: string[]
  comment?: string
  user?: string
  locked?: boolean
  hidden?: boolean
}

export interface ScenarioSet {
  list: Scenario[]
  /** The scenario last selected and last shown (Excel keeps both). */
  current: number
  show: number
  /** Result cells last used for a summary report. */
  resultCells?: string
}

export interface ColInfo {
  width?: number
  hidden?: boolean
  style?: number
  outline?: number
  /** The summary column of a collapsed outline group. */
  collapsed?: boolean
}
export interface RowInfo {
  height?: number
  hidden?: boolean
  style?: number
  outline?: number
  collapsed?: boolean
  /** Height set by the user or the file rather than fitted to the content. */
  custom?: boolean
  /** Hidden by an AutoFilter (SUBTOTAL ignores filtered rows even with 1–11). */
  filtered?: boolean
}

export interface Table {
  id: number
  name: string
  displayName: string
  sheet: number
  area: Area
  headerRow: boolean
  totalsRow: boolean
  columns: { name: string; totalsFunction?: string; totalsLabel?: string; formula?: string }[]
  style?: string
  showRowStripes?: boolean
  showColumnStripes?: boolean
  showFirstColumn?: boolean
  showLastColumn?: boolean
  autoFilter?: boolean
  /** The table's filter criteria (its header buttons). */
  filter?: FilterColumn[]
  /** Original table XML parts we don't interpret, for round trips. */
  carry?: unknown
}

export interface DefinedName {
  name: string
  /** Sheet id for a sheet-scoped name, null for workbook scope. */
  scope: number | null
  /** Formula text without "=" as written (A1, relative to A1). */
  text: string
  ast?: Node
  hidden?: boolean
  comment?: string
  /** Built-in names such as _xlnm.Print_Area keep their prefix. */
  carry?: Record<string, string>
}

export const DEFAULT_COL_WIDTH = 64 // px, Excel's 8.43 characters of Calibri 11
export const DEFAULT_ROW_HEIGHT = 20 // px (15 pt)

export class Sheet {
  /** Rows of cells: row index → (column index → cell). */
  readonly rows = new Map<number, Map<number, Cell>>()
  readonly cols = new Map<number, ColInfo>()
  readonly rowInfo = new Map<number, RowInfo>()
  merges: Area[] = []
  /** Conditional formatting blocks (ranges + rules), in file order. */
  condFormats: CondFormat[] = []
  /** Data validation rules, in file order. */
  validations: DataValidation[] = []
  /** Notes and hyperlinks by cell (key r * 16384 + c). */
  notes = new Map<number, Note>()
  links = new Map<number, Link>()
  /** PivotTables whose output is on this sheet. */
  pivots: PivotTable[] = []
  /** Sparkline groups (tiny charts in cells). */
  sparklines: SparklineGroup[] = []
  /** Charts drawn over the sheet. */
  charts: Chart[] = []
  /** What-if data tables ({=TABLE()}): their result cells hold values the engine fills in. */
  dataTables: DataTable[] = []
  /** Scenario Manager: named sets of values for changing cells. */
  scenarios: ScenarioSet | null = null
  /** Page Layout: paper, margins, scaling, headers and footers, breaks. */
  pageSetup: PageSetup = defaultPageSetup()
  /** The sheet's AutoFilter (Ctrl+Shift+L), separate from tables' filters. */
  autoFilter: AutoFilter | null = null
  freeze = { rows: 0, cols: 0 }
  hidden: false | 'hidden' | 'veryHidden' = false
  tabColor: string | null = null
  defaultColWidth = DEFAULT_COL_WIDTH
  defaultRowHeight = DEFAULT_ROW_HEIGHT
  showGridlines = true
  zoom = 1
  /** Bounding box of cells with content, kept up to date lazily. */
  private extent: { r: number; c: number } | null = null
  /** Parts of the sheet we keep but don't interpret (file round trips). */
  carry: Record<string, unknown> = {}

  constructor(
    public id: number,
    public name: string
  ) {}

  get(r: number, c: number): Cell | undefined {
    return this.rows.get(r)?.get(c)
  }

  set(r: number, c: number, cell: Cell | undefined) {
    if (!cell) {
      const row = this.rows.get(r)
      if (row?.delete(c) && row.size === 0) this.rows.delete(r)
      this.extent = null
      return
    }
    let row = this.rows.get(r)
    if (!row) {
      row = new Map()
      this.rows.set(r, row)
    }
    row.set(c, cell)
    if (this.extent && (r > this.extent.r || c > this.extent.c)) this.extent = { r: Math.max(r, this.extent.r), c: Math.max(c, this.extent.c) }
  }

  /** Largest used row and column (-1 when the sheet is empty). */
  used(): { r: number; c: number } {
    if (!this.extent) {
      let r = -1
      let c = -1
      for (const [ri, row] of this.rows) {
        if (!row.size) continue
        if (ri > r) r = ri
        for (const ci of row.keys()) if (ci > c) c = ci
      }
      this.extent = { r, c }
    }
    return this.extent
  }

  invalidateExtent() {
    this.extent = null
  }

  /** Calls fn for every existing cell inside the area, in row-major order. */
  forEachIn(a: Area, fn: (r: number, c: number, cell: Cell) => void) {
    const u = this.used()
    const r1 = Math.min(a.r1, u.r)
    const c1 = Math.min(a.c1, u.c)
    if (a.r0 > r1 || a.c0 > c1) return
    const span = r1 - a.r0 + 1
    if (span <= this.rows.size * 2) {
      for (let r = a.r0; r <= r1; r++) {
        const row = this.rows.get(r)
        if (!row) continue
        eachCol(row, a.c0, c1, (c, cell) => fn(r, c, cell))
      }
    } else {
      const keys = [...this.rows.keys()].filter((r) => r >= a.r0 && r <= r1).sort((x, y) => x - y)
      for (const r of keys) eachCol(this.rows.get(r)!, a.c0, c1, (c, cell) => fn(r, c, cell))
    }
  }

  colWidth(c: number): number {
    const ci = this.cols.get(c)
    if (ci?.hidden) return 0
    return ci?.width ?? this.defaultColWidth
  }
  rowHeight(r: number): number {
    const ri = this.rowInfo.get(r)
    if (ri?.hidden) return 0
    return ri?.height ?? this.defaultRowHeight
  }

  mergeAt(r: number, c: number): Area | undefined {
    // ponytail: linear scan over merges; index them if sheets with thousands of merges get slow.
    for (const m of this.merges) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m
    return undefined
  }
}

function eachCol(row: Map<number, Cell>, c0: number, c1: number, fn: (c: number, cell: Cell) => void) {
  if (c1 - c0 + 1 <= row.size * 2) {
    for (let c = c0; c <= c1; c++) {
      const cell = row.get(c)
      if (cell) fn(c, cell)
    }
  } else {
    const cols = [...row.keys()].filter((c) => c >= c0 && c <= c1).sort((x, y) => x - y)
    for (const c of cols) fn(c, row.get(c)!)
  }
}

export interface CalcSettings {
  /** 'autoNoTable': automatic except data tables, which recalculate on F9 (Excel's option). */
  mode: 'auto' | 'autoNoTable' | 'manual'
  iterate: boolean
  maxIterations: number
  maxChange: number
  /** Excel's "precision as displayed" is not supported; kept for round trips. */
  fullPrecision: boolean
}

export class Workbook {
  sheets: Sheet[] = []
  names: DefinedName[] = []
  tables: Table[] = []
  styles = new StyleTable()
  /** 1904 date system (old Mac workbooks): serial 0 is 1904-01-01. */
  date1904 = false
  /** JavaScript macros stored with the workbook (never run on open). */
  macros: { name: string; code: string }[] = []
  /** Theme colours (lt1, dk1, lt2, dk2, accent1–6, links) as hex without #; used by table styles. */
  theme: string[] | null = null
  calc: CalcSettings = { mode: 'auto', iterate: false, maxIterations: 100, maxChange: 0.001, fullPrecision: true }
  activeSheet = 0
  props: Record<string, string> = {}
  /** File parts we keep but don't interpret, written back on save (format-specific). */
  carry: unknown = null
  private nextSheetId = 0

  addSheet(name?: string, index = this.sheets.length): Sheet {
    const s = this.createSheet(name ?? this.uniqueSheetName('Sheet'))
    this.sheets.splice(index, 0, s)
    return s
  }

  /** A new sheet with a fresh id, not yet in the workbook. */
  createSheet(name: string): Sheet {
    return new Sheet(this.nextSheetId++, name)
  }

  /** Re-creates a sheet with a known id (undo, file load). */
  restoreSheet(s: Sheet, index: number) {
    this.sheets.splice(index, 0, s)
    this.nextSheetId = Math.max(this.nextSheetId, s.id + 1)
  }

  uniqueSheetName(base: string): string {
    for (let n = 1; ; n++) {
      const name = `${base}${n}`
      if (!this.sheetByName(name)) return name
    }
  }

  sheetById(id: number): Sheet | undefined {
    // A plain loop: called several times per formula evaluation.
    for (const s of this.sheets) if (s.id === id) return s
    return undefined
  }
  sheetByName(name: string): Sheet | undefined {
    const n = name.toLowerCase()
    return this.sheets.find((s) => s.name.toLowerCase() === n)
  }
  sheetIndex(id: number): number {
    return this.sheets.findIndex((s) => s.id === id)
  }

  /** Name lookup: sheet scope first, then workbook scope (Excel's rule). */
  findName(name: string, sheet: number | null): DefinedName | undefined {
    const n = name.toLowerCase()
    return (sheet !== null ? this.names.find((d) => d.scope === sheet && d.name.toLowerCase() === n) : undefined) ?? this.names.find((d) => d.scope === null && d.name.toLowerCase() === n)
  }

  tableByName(name: string): Table | undefined {
    const n = name.toLowerCase()
    return this.tables.find((t) => t.name.toLowerCase() === n || t.displayName.toLowerCase() === n)
  }
  tableAt(sheet: number, r: number, c: number): Table | undefined {
    return this.tables.find((t) => t.sheet === sheet && r >= t.area.r0 && r <= t.area.r1 && c >= t.area.c0 && c <= t.area.c1)
  }
}

export const clampArea = (a: Area): Area => ({ sheet: a.sheet, r0: Math.max(0, a.r0), c0: Math.max(0, a.c0), r1: Math.min(MAX_ROWS - 1, a.r1), c1: Math.min(MAX_COLS - 1, a.c1) })

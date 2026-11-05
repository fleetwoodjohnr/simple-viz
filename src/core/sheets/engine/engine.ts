// Recalculation: dependency tracking, dirty marking, ordering, spilling and circular references.
//
// When a cell changes, every formula that depends on it (transitively) is marked dirty. Recalculation orders the dirty
// formulas so precedents come first (an iterative depth-first search over their static precedents), then evaluates them.
// A formula that reads a cell which is still dirty (INDIRECT, OFFSET, spilled ranges) computes that cell first.

import { KEY_SHEET, cellKey, fromKey } from '../refs'
import type { Cell, Formula, Workbook } from '../model/workbook'
import { evaluate, finalValue, getFunction, pick, type EvalContext } from './evaluate'
import { parseFormula, refCorner, walk, type Node } from './parser'
import { ERR, MAX_COLS, MAX_ROWS, isArray, isError, type Area, type ArrayValue, type Scalar } from './values'
import { isKnownExcelFunction } from './catalog'

interface Registration {
  areas: Area[]
  names: string[]
  tables: string[]
  volatile: boolean
  /** Uses SUBTOTAL or AGGREGATE, whose results depend on which rows are hidden. */
  rows?: boolean
}

/** Column-indexed set of range dependencies for one sheet. Wide ranges (many columns) are kept in a separate list. */
class RangeIndex {
  readonly byCol = new Map<number, Set<{ r0: number; r1: number; dep: number }>>()
  readonly wide = new Set<{ r0: number; r1: number; c0: number; c1: number; dep: number }>()
}

const WIDE = 64

export class Engine {
  readonly dirty = new Set<number>()
  /** Dirty formula rows per sheet and column, to find dirty cells inside a range quickly. */
  private dirtyIndex = new Map<number, Map<number, Set<number>>>()
  private computing = new Set<number>()
  /** Cells whose value changed since `takeChanged` was last called. */
  readonly changed = new Set<number>()
  /** Formulas found in a circular reference during the last recalculation. */
  readonly circular = new Set<number>()
  /** Spilled area per anchor cell key. */
  readonly spills = new Map<number, Area>()
  /** Anchors showing #SPILL! because something is in the way. */
  readonly blocked = new Set<number>()
  private single = new Map<number, Set<number>>()
  private ranges = new Map<number, RangeIndex>()
  private nameDeps = new Map<string, Set<number>>()
  private tableDeps = new Map<string, Set<number>>()
  private regs = new Map<number, Registration>()
  readonly volatile = new Set<number>()
  /** Formulas using SUBTOTAL/AGGREGATE (recalculated when rows are hidden or shown). */
  readonly rowSensitive = new Set<number>()
  /** Count of formula evaluations, for tests and benchmarks. */
  evaluations = 0

  // Shared by every evaluation context (one context per computed cell, so no closures are allocated per cell).
  private readonly readFn = (s: number, r: number, c: number) => this.read(s, r, c)
  private readonly ensureFn = (a: Area) => this.ensure(a)
  private readonly spillFn = (s: number, r: number, c: number) => this.spills.get(cellKey(s, r, c)) ?? null

  constructor(readonly wb: Workbook) {}

  // ---------- registration ----------

  /** Static precedents of a formula placed at (sheet, r, c). */
  private analyse(f: Formula, sheet: number, r: number, c: number): Registration {
    const reg: Registration = { areas: [], names: [], tables: [], volatile: false }
    const seen = new Set<string>()
    const visit = (ast: Node, depth: number) => {
      walk(ast, (n) => {
        if (n.t === 'ref') {
          const a = refCorner(n, { row: r, col: c })
          if (!a) return
          if (!n.sheet) reg.areas.push({ sheet, ...a })
          else if (n.sheet.id >= 0) {
            if (n.sheet.id2 === undefined) reg.areas.push({ sheet: n.sheet.id, ...a })
            else {
              const i0 = this.wb.sheetIndex(n.sheet.id)
              const i1 = this.wb.sheetIndex(n.sheet.id2)
              for (let i = Math.min(i0, i1); i >= 0 && i <= Math.max(i0, i1); i++) reg.areas.push({ sheet: this.wb.sheets[i].id, ...a })
            }
          }
        } else if (n.t === 'name') {
          const key = n.name.toLowerCase()
          reg.names.push(key)
          const def = this.wb.findName(n.name, n.sheet ? n.sheet.id : sheet)
          if (def?.ast && !seen.has(key) && depth < 32) {
            seen.add(key)
            visit(def.ast, depth + 1)
          }
        } else if (n.t === 'struct') {
          const t = n.table ? this.wb.tableByName(n.table) : this.wb.tableAt(sheet, r, c)
          if (t) {
            reg.tables.push(t.name.toLowerCase())
            reg.areas.push({ ...t.area })
          } else if (n.table) reg.tables.push(n.table.toLowerCase())
        } else if (n.t === 'func') {
          if (getFunction(n.name)?.volatile) reg.volatile = true
          if (n.name === 'SUBTOTAL' || n.name === 'AGGREGATE') reg.rows = true
          // A user-defined LAMBDA name used as a function
          if (!getFunction(n.name)) reg.names.push(n.name.toLowerCase())
        } else if (n.t === 'bin' && n.op === ':' && (n.a.t !== 'ref' || n.b.t !== 'ref')) {
          // ponytail: A1:INDEX(...) ranges are only known at run time, so such formulas recalculate every time.
          reg.volatile = true
        } else if (n.t === 'spill' || n.t === 'call') {
          // Spill references depend on the anchor (registered via its ref); its dependents are dirtied when it re-spills.
        }
      })
    }
    visit(f.ast, 0)
    return reg
  }

  register(sheet: number, r: number, c: number, f: Formula) {
    const key = cellKey(sheet, r, c)
    this.unregister(key)
    const reg = this.analyse(f, sheet, r, c)
    f.unsupported = unsupportedIn(f.ast, this.wb, sheet)
    this.regs.set(key, reg)
    for (const a of reg.areas) {
      if (a.r0 === a.r1 && a.c0 === a.c1) {
        const k = cellKey(a.sheet, a.r0, a.c0)
        let s = this.single.get(k)
        if (!s) this.single.set(k, (s = new Set()))
        s.add(key)
        continue
      }
      let idx = this.ranges.get(a.sheet)
      if (!idx) this.ranges.set(a.sheet, (idx = new RangeIndex()))
      if (a.c1 - a.c0 >= WIDE) idx.wide.add({ r0: a.r0, r1: a.r1, c0: a.c0, c1: a.c1, dep: key })
      else
        for (let col = a.c0; col <= a.c1; col++) {
          let s = idx.byCol.get(col)
          if (!s) idx.byCol.set(col, (s = new Set()))
          s.add({ r0: a.r0, r1: a.r1, dep: key })
        }
    }
    for (const n of reg.names) {
      let s = this.nameDeps.get(n)
      if (!s) this.nameDeps.set(n, (s = new Set()))
      s.add(key)
    }
    for (const t of reg.tables) {
      let s = this.tableDeps.get(t)
      if (!s) this.tableDeps.set(t, (s = new Set()))
      s.add(key)
    }
    if (reg.volatile) this.volatile.add(key)
    if (reg.rows) this.rowSensitive.add(key)
  }

  unregister(key: number) {
    const reg = this.regs.get(key)
    if (!reg) return
    this.regs.delete(key)
    this.volatile.delete(key)
    this.rowSensitive.delete(key)
    this.blocked.delete(key)
    for (const a of reg.areas) {
      if (a.r0 === a.r1 && a.c0 === a.c1) {
        const k = cellKey(a.sheet, a.r0, a.c0)
        const s = this.single.get(k)
        s?.delete(key)
        if (s && !s.size) this.single.delete(k)
        continue
      }
      const idx = this.ranges.get(a.sheet)
      if (!idx) continue
      if (a.c1 - a.c0 >= WIDE) {
        for (const e of idx.wide) if (e.dep === key && e.r0 === a.r0 && e.c0 === a.c0) idx.wide.delete(e)
      } else
        for (let col = a.c0; col <= a.c1; col++) {
          const s = idx.byCol.get(col)
          if (!s) continue
          for (const e of s) if (e.dep === key) s.delete(e)
          if (!s.size) idx.byCol.delete(col)
        }
    }
    for (const n of reg.names) this.nameDeps.get(n)?.delete(key)
    for (const t of reg.tables) this.tableDeps.get(t)?.delete(key)
  }

  /** Formulas that read this cell directly. */
  dependentsOf(key: number, out: (dep: number) => void) {
    this.single.get(key)?.forEach(out)
    const sheet = Math.floor(key / KEY_SHEET)
    const idx = this.ranges.get(sheet)
    if (!idx) return
    const rest = key - sheet * KEY_SHEET
    const r = Math.floor(rest / MAX_COLS)
    const c = rest - r * MAX_COLS
    idx.byCol.get(c)?.forEach((e) => {
      if (r >= e.r0 && r <= e.r1) out(e.dep)
    })
    for (const e of idx.wide) if (r >= e.r0 && r <= e.r1 && c >= e.c0 && c <= e.c1) out(e.dep)
  }

  // ---------- dirty tracking ----------

  private markDirty(key: number) {
    if (this.dirty.has(key)) return false
    this.dirty.add(key)
    const sheet = Math.floor(key / KEY_SHEET)
    const rest = key - sheet * KEY_SHEET
    const r = Math.floor(rest / MAX_COLS)
    const c = rest - r * MAX_COLS
    let cols = this.dirtyIndex.get(sheet)
    if (!cols) this.dirtyIndex.set(sheet, (cols = new Map()))
    let rows = cols.get(c)
    if (!rows) cols.set(c, (rows = new Set()))
    rows.add(r)
    return true
  }

  private clearDirty(key: number) {
    if (!this.dirty.delete(key)) return
    const sheet = Math.floor(key / KEY_SHEET)
    const rest = key - sheet * KEY_SHEET
    const r = Math.floor(rest / MAX_COLS)
    const c = rest - r * MAX_COLS
    const rows = this.dirtyIndex.get(sheet)?.get(c)
    rows?.delete(r)
    if (rows && !rows.size) this.dirtyIndex.get(sheet)!.delete(c)
  }

  /** A cell's content changed: it and everything depending on it must recalculate. */
  touch(sheet: number, r: number, c: number) {
    const key = cellKey(sheet, r, c)
    this.changed.add(key)
    const cell = this.wb.sheetById(sheet)?.get(r, c)
    if (cell?.f) this.markDirty(key)
    this.dirtyDependents(key)
  }

  /** Work queue of dirtyDependents, kept between calls (it runs once per changed value). */
  private queue: number[] = []
  private readonly enqueueDirty = (d: number) => {
    if (this.markDirty(d)) this.queue.push(d)
  }

  private dirtyDependents(start: number) {
    const queue = this.queue
    queue.push(start)
    while (queue.length) {
      const k = queue.pop()!
      this.dependentsOf(k, this.enqueueDirty)
      // Cells spilled from an anchor change with it.
      const sp = this.spills.get(k)
      if (sp) for (let r = sp.r0; r <= sp.r1; r++) for (let c = sp.c0; c <= sp.c1; c++) if (r !== sp.r0 || c !== sp.c0) this.dependentsOf(cellKey(sp.sheet, r, c), this.enqueueDirty)
    }
  }

  /** Rows were hidden or shown (filters, Hide/Unhide): SUBTOTAL and AGGREGATE results change. */
  rowsVisibilityChanged() {
    for (const k of this.rowSensitive) if (this.markDirty(k)) this.dirtyDependents(k)
  }

  /** A defined name was added, changed or removed. */
  nameChanged(name: string) {
    const deps = [...(this.nameDeps.get(name.toLowerCase()) ?? [])]
    for (const k of deps) this.reregister(k)
  }

  /** A table was resized, renamed or removed. */
  tableChanged(name: string) {
    const deps = [...(this.tableDeps.get(name.toLowerCase()) ?? [])]
    for (const k of deps) this.reregister(k)
  }

  private reregister(k: number) {
    const { sheet, r, c } = fromKey(k)
    const cell = this.wb.sheetById(sheet)?.get(r, c)
    if (cell?.f) {
      this.register(sheet, r, c, cell.f)
      this.markDirty(k)
      this.dirtyDependents(k)
    }
  }

  /** Register every formula and mark them all dirty (after loading a file). */
  rebuild() {
    this.single.clear()
    this.ranges.clear()
    this.nameDeps.clear()
    this.tableDeps.clear()
    this.regs.clear()
    this.volatile.clear()
    this.rowSensitive.clear()
    this.spills.clear()
    for (const sh of this.wb.sheets)
      for (const [r, row] of sh.rows)
        for (const [c, cell] of row) {
          if (cell.spillOf !== undefined) {
            const a = this.spills.get(cell.spillOf)
            const { sheet: _s, r: ar, c: ac } = fromKey(cell.spillOf)
            if (!a) this.spills.set(cell.spillOf, { sheet: sh.id, r0: ar, c0: ac, r1: r, c1: c })
            else this.spills.set(cell.spillOf, { ...a, r1: Math.max(a.r1, r), c1: Math.max(a.c1, c) })
          }
          if (cell.f) {
            this.register(sh.id, r, c, cell.f)
            this.markDirty(cellKey(sh.id, r, c))
          }
        }
  }

  // ---------- calculation ----------

  /** Recalculate everything that is dirty (plus volatile formulas). Returns the number of formulas evaluated. */
  recalc(opts: { volatile?: boolean } = {}): number {
    if (opts.volatile !== false) for (const k of this.volatile) if (this.markDirty(k)) this.dirtyDependents(k)
    this.circular.clear()
    const before = this.evaluations
    const order = this.order()
    for (const k of order) if (this.dirty.has(k)) this.compute(k)
    // Anything still dirty became dirty during this pass (a spill grew); compute it too.
    let guard = 0
    while (this.dirty.size && guard++ < 10) for (const k of [...this.dirty]) if (this.dirty.has(k)) this.compute(k)
    if (this.wb.calc.iterate && this.circular.size) this.iterate()
    return this.evaluations - before
  }

  /** Recalculate every formula in the workbook (F9 with Ctrl+Alt, or after loading). */
  recalcAll() {
    for (const sh of this.wb.sheets) for (const [r, row] of sh.rows) for (const [c, cell] of row) if (cell.f) this.markDirty(cellKey(sh.id, r, c))
    return this.recalc()
  }

  /** Dirty formulas inside an area (rows/cols clipped to the used range by the caller's sheet). */
  private dirtyIn(a: Area, fn: (k: number) => void) {
    const cols = this.dirtyIndex.get(a.sheet)
    // Per column, look up the area's rows when there are fewer of them than dirty rows (a chain of single-cell
    // references would otherwise scan every dirty row each time: quadratic).
    const inColumn = (c: number, rows: Set<number>) => {
      if (a.r1 - a.r0 + 1 <= rows.size) {
        for (let r = a.r0; r <= a.r1; r++) if (rows.has(r)) fn(cellKey(a.sheet, r, c))
      } else for (const r of rows) if (r >= a.r0 && r <= a.r1) fn(cellKey(a.sheet, r, c))
    }
    if (cols && cols.size) {
      if (a.c1 - a.c0 + 1 <= cols.size) {
        for (let c = a.c0; c <= a.c1; c++) {
          const rows = cols.get(c)
          if (rows) inColumn(c, rows)
        }
      } else
        for (const [c, rows] of cols) {
          if (c < a.c0 || c > a.c1) continue
          inColumn(c, rows)
        }
    }
    // Anchors whose spilled values lie in the area.
    for (const [k, s] of this.spills) if (this.dirty.has(k) && s.sheet === a.sheet && s.r0 <= a.r1 && s.r1 >= a.r0 && s.c0 <= a.c1 && s.c1 >= a.c0) fn(k)
  }

  /** Dirty formulas ordered so that each comes after the dirty formulas it reads (iterative DFS, post-order). */
  private order(): number[] {
    const out: number[] = []
    const state = new Map<number, 1 | 2>() // 1 = on stack, 2 = done
    // The stack in parallel arrays, and every stacked formula's dirty precedents in one shared buffer (a formula's
    // list sits above its parent's, so popping truncates it): no allocation per formula.
    const keys: number[] = []
    const next: number[] = []
    const end: number[] = []
    const pre: number[] = []
    let cur = 0
    const collect = (d: number) => {
      if (d !== cur) pre.push(d)
    }
    const push = (k: number) => {
      state.set(k, 1)
      const start = pre.length
      cur = k
      const reg = this.regs.get(k)
      if (reg) for (const a of reg.areas) this.dirtyIn(a, collect)
      keys.push(k)
      next.push(start)
      end.push(pre.length)
    }
    for (const startKey of this.dirty) {
      if (state.has(startKey)) continue
      push(startKey)
      while (keys.length) {
        const top = keys.length - 1
        if (next[top] < end[top]) {
          const d = pre[next[top]++]
          // Already on the stack: a cycle, which compute() detects when the value is read.
          if (!state.has(d)) push(d)
          continue
        }
        const k = keys.pop()!
        next.pop()
        end.pop()
        state.set(k, 2)
        out.push(k)
        // This formula's list began where its parent's ended.
        pre.length = top > 0 ? end[top - 1] : 0
      }
    }
    return out
  }

  private ctxFor(sheet: number, r: number, c: number, legacy: boolean): EvalContext {
    return {
      wb: this.wb,
      sheet,
      row: r,
      col: c,
      env: null,
      legacy,
      depth: 0,
      read: this.readFn,
      ensure: this.ensureFn,
      spillArea: this.spillFn
    }
  }

  /** Context for evaluating a formula that isn't in a cell (conditional formats, validation) as if it were at r, c. */
  contextAt(sheet: number, r: number, c: number): EvalContext {
    return this.ctxFor(sheet, r, c, false)
  }

  /** Parse formula text (with or without "=") as if entered at r, c of the sheet. */
  parseAt(text: string, sheet: number, r: number, c: number): Node {
    return parseFormula(text.startsWith('=') ? text : '=' + text, { row: r, col: c, sheetId: (n) => this.wb.sheetByName(n)?.id ?? null })
  }

  read(sheet: number, r: number, c: number): Scalar {
    const sh = this.wb.sheetById(sheet)
    if (!sh) return ERR.REF
    const key = cellKey(sheet, r, c)
    let cell = sh.get(r, c)
    if (this.computing.has(key)) {
      this.circular.add(key)
      return cell?.v ?? 0
    }
    if (this.dirty.has(key)) {
      this.compute(key)
      cell = sh.get(r, c)
    } else if (cell?.spillOf !== undefined && this.dirty.has(cell.spillOf)) {
      this.compute(cell.spillOf)
      cell = sh.get(r, c)
    }
    return cell ? cell.v : null
  }

  ensure(a: Area) {
    const sh = this.wb.sheetById(a.sheet)
    if (!sh) return
    const u = sh.used()
    const clip = { sheet: a.sheet, r0: a.r0, c0: a.c0, r1: Math.min(a.r1, u.r), c1: Math.min(a.c1, u.c) }
    const todo: number[] = []
    this.dirtyIn(clip, (k) => todo.push(k))
    for (const k of todo) {
      if (!this.dirty.has(k)) continue
      if (this.computing.has(k)) {
        this.circular.add(k)
        continue
      }
      this.compute(k)
    }
  }

  /** Evaluate one formula cell and store its result (spilling arrays). */
  compute(key: number) {
    const { sheet, r, c } = fromKey(key)
    const sh = this.wb.sheetById(sheet)
    const cell = sh?.get(r, c)
    this.clearDirty(key)
    if (!sh || !cell?.f) return
    const f = cell.f
    this.evaluations++
    // Formulas the engine can't calculate keep the result the file came with.
    if (f.unsupported && cell.stale) return
    this.computing.add(key)
    let result: Scalar | ArrayValue
    try {
      const ctx = this.ctxFor(sheet, r, c, !!f.legacy && !f.array)
      result = finalValue(evaluate(f.ast, ctx), ctx, true)
    } catch (e) {
      // ponytail: deep recursion (very long LAMBDA chains) surfaces as #CALC! instead of crashing the app.
      result = e instanceof RangeError ? ERR.CALC : ERR.VALUE
      if (!(e instanceof RangeError)) console.error('Formula evaluation failed', e)
    }
    this.computing.delete(key)
    cell.stale = false
    if (f.array) return this.fillArray(key, cell, f.array, result)
    if (isArray(result)) return this.spill(key, cell, result)
    this.blocked.delete(key)
    this.clearSpill(key)
    this.store(key, cell, result)
  }

  private store(key: number, cell: Cell, v: Scalar) {
    if (!sameValue(cell.v, v)) {
      cell.v = v
      this.changed.add(key)
      this.dirtyDependents(key)
    }
  }

  private fillArray(key: number, cell: Cell, a: Area, result: Scalar | ArrayValue) {
    const sh = this.wb.sheetById(a.sheet)!
    const arr = isArray(result) ? result : { kind: 'array' as const, rows: 1, cols: 1, data: [result] }
    for (let r = a.r0; r <= a.r1; r++)
      for (let c = a.c0; c <= a.c1; c++) {
        const v = pick(arr, r - a.r0, c - a.c0) ?? ERR.NA
        const k = cellKey(a.sheet, r, c)
        if (k === key) {
          this.store(key, cell, v)
          continue
        }
        let t = sh.get(r, c)
        if (!t) sh.set(r, c, (t = { v: null }))
        t.spillOf = key
        this.store(k, t, v)
      }
    this.spills.set(key, a)
  }

  private spill(key: number, cell: Cell, arr: ArrayValue) {
    const { sheet, r, c } = fromKey(key)
    const sh = this.wb.sheetById(sheet)!
    const area: Area = { sheet, r0: r, c0: c, r1: r + arr.rows - 1, c1: c + arr.cols - 1 }
    let blocked = area.r1 >= MAX_ROWS || area.c1 >= MAX_COLS
    if (!blocked)
      for (let rr = area.r0; rr <= area.r1 && !blocked; rr++) {
        const row = sh.rows.get(rr)
        for (let cc = area.c0; cc <= area.c1; cc++) {
          if (rr === r && cc === c) continue
          const t = row?.get(cc)
          if (t && ((t.spillOf === undefined && (t.v !== null || t.f)) || (t.spillOf !== undefined && t.spillOf !== key))) {
            blocked = true
            break
          }
          if (sh.merges.length && sh.mergeAt(rr, cc)) {
            blocked = true
            break
          }
        }
      }
    if (blocked) {
      this.clearSpill(key)
      this.blocked.add(key)
      this.store(key, cell, ERR.SPILL)
      return
    }
    this.blocked.delete(key)
    const old = this.spills.get(key)
    if (old) this.clearSpill(key, area)
    this.spills.set(key, area)
    for (let rr = area.r0; rr <= area.r1; rr++)
      for (let cc = area.c0; cc <= area.c1; cc++) {
        const v = arr.data[(rr - r) * arr.cols + (cc - c)]
        const k = cellKey(sheet, rr, cc)
        if (k === key) {
          this.store(key, cell, v)
          continue
        }
        let t = sh.get(rr, cc)
        if (!t) sh.set(rr, cc, (t = { v: null }))
        t.spillOf = key
        this.store(k, t, v)
      }
    if (!old || old.r1 !== area.r1 || old.c1 !== area.c1) {
      // The anchor's shape changed: A1# references to it must re-read.
      this.changed.add(key)
      this.dirtyDependents(key)
    }
  }

  /** Remove spilled values of an anchor (except those inside `keep`). */
  clearSpill(key: number, keep?: Area) {
    const old = this.spills.get(key)
    if (!old) return
    this.spills.delete(key)
    const sh = this.wb.sheetById(old.sheet)
    if (!sh) return
    for (let r = old.r0; r <= old.r1; r++)
      for (let c = old.c0; c <= old.c1; c++) {
        if (keep && r >= keep.r0 && r <= keep.r1 && c >= keep.c0 && c <= keep.c1) continue
        const k = cellKey(old.sheet, r, c)
        if (k === key) continue
        const t = sh.get(r, c)
        if (!t || t.spillOf !== key) continue
        delete t.spillOf
        if (t.v !== null) {
          t.v = null
          this.changed.add(k)
          this.dirtyDependents(k)
        }
        if (t.s === undefined && !t.f) sh.set(r, c, undefined)
      }
  }

  /** Iterative calculation for circular references (File → Options → Formulas → Enable iterative calculation). */
  private iterate() {
    const cells = [...this.circular]
    const { maxIterations, maxChange } = this.wb.calc
    for (let i = 0; i < maxIterations; i++) {
      let delta = 0
      for (const k of cells) {
        const { sheet, r, c } = fromKey(k)
        const before = this.wb.sheetById(sheet)?.get(r, c)?.v
        this.markDirty(k)
        this.compute(k)
        const after = this.wb.sheetById(sheet)?.get(r, c)?.v
        if (typeof before === 'number' && typeof after === 'number') delta = Math.max(delta, Math.abs(after - before))
        else if (before !== after) delta = Infinity
      }
      if (delta <= maxChange) break
    }
    for (const k of cells) this.clearDirty(k)
  }

  /** Changed cell keys since the last call. */
  takeChanged(): number[] {
    const out = [...this.changed]
    this.changed.clear()
    return out
  }

  /** Precedent areas of a formula cell (Trace Precedents). */
  precedents(sheet: number, r: number, c: number): Area[] {
    return this.regs.get(cellKey(sheet, r, c))?.areas ?? []
  }

  /** Formulas that read a cell (Trace Dependents). */
  dependents(sheet: number, r: number, c: number): number[] {
    const out = new Set<number>()
    this.dependentsOf(cellKey(sheet, r, c), (d) => out.add(d))
    return [...out]
  }
}

function sameValue(a: Scalar, b: Scalar) {
  if (a === b) return true
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)
}

/** Name of the first Excel function in the formula that Simple Cell does not implement, if any. */
export function unsupportedIn(ast: Node, wb: Workbook, sheet: number): string | undefined {
  let found: string | undefined
  walk(ast, (n) => {
    if (found) return
    if (n.t === 'func' && !getFunction(n.name) && isKnownExcelFunction(n.name) && !wb.findName(n.name, sheet)) found = n.name
    else if (n.t === 'xref') found = 'external workbook reference'
  })
  return found
}

export { isError }

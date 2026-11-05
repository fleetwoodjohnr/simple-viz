// Printing: page setup (Excel's model) and pagination of a sheet into pages of rows × columns.
import type { Area } from './engine/values'
import type { Sheet } from './model/workbook'

export interface PageSetup {
  orientation: 'portrait' | 'landscape'
  /** Excel's paperSize code: 1 Letter, 5 Legal, 9 A4, 8 A3, 11 A5, 3 Tabloid, 7 Executive. */
  paper: number
  /** Percent, when not fitting to pages. */
  scale: number
  fitToPage: boolean
  /** Pages wide / tall to fit to (0 = as many as needed). */
  fitWidth: number
  fitHeight: number
  /** Inches. */
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number }
  gridlines: boolean
  headings: boolean
  centerH: boolean
  centerV: boolean
  /** Excel header/footer code strings (&L&C&R sections, &P &N &D &T &F &A). */
  header: string
  footer: string
  order: 'downThenOver' | 'overThenDown'
  /** Manual page breaks: a new page starts at these rows / columns. */
  rowBreaks: number[]
  colBreaks: number[]
  /** File details kept for round trips (printer settings link, unknown attributes, other header variants). */
  carry?: Record<string, string>
}

export const defaultPageSetup = (): PageSetup => ({
  orientation: 'portrait',
  paper: 1,
  scale: 100,
  fitToPage: false,
  fitWidth: 1,
  fitHeight: 1,
  margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  gridlines: false,
  headings: false,
  centerH: false,
  centerV: false,
  header: '',
  footer: '',
  order: 'downThenOver',
  rowBreaks: [],
  colBreaks: []
})

/** Paper size in inches (portrait). */
export const PAPER: Record<number, { name: string; w: number; h: number }> = {
  1: { name: 'Letter', w: 8.5, h: 11 },
  5: { name: 'Legal', w: 8.5, h: 14 },
  3: { name: 'Tabloid', w: 11, h: 17 },
  7: { name: 'Executive', w: 7.25, h: 10.5 },
  9: { name: 'A4', w: 8.27, h: 11.69 },
  8: { name: 'A3', w: 11.69, h: 16.54 },
  11: { name: 'A5', w: 5.83, h: 8.27 }
}

export interface PrintPage {
  sheet: number
  rows: number[]
  cols: number[]
  /** Print titles repeated on this page (rows/columns not already on it). */
  titleRows: number[]
  titleCols: number[]
  number: number
}

export interface PrintJob {
  sheet: number
  setup: PageSetup
  /** Page size and printable box in CSS pixels (96 per inch), and the content scale. */
  paper: { w: number; h: number }
  scale: number
  pages: PrintPage[]
}

const DPI = 96

/**
 * Paginate `area` of a sheet. `titles` are the print titles (rows/columns to repeat). Hidden rows and columns are
 * skipped. Pages go down then over unless the setup says otherwise.
 */
export function paginate(sh: Sheet, setup: PageSetup, area: Area, titles: { rows?: [number, number]; cols?: [number, number] } = {}): PrintJob {
  const p = PAPER[setup.paper] ?? PAPER[1]
  const [pw, ph] = setup.orientation === 'landscape' ? [p.h, p.w] : [p.w, p.h]
  const m = setup.margins
  const availW = (pw - m.left - m.right) * DPI
  const availH = (ph - m.top - m.bottom) * DPI
  const rowH = (r: number) => (sh.rowInfo.get(r)?.hidden ? 0 : sh.rowHeight(r))
  const colW = (c: number) => (sh.cols.get(c)?.hidden ? 0 : sh.colWidth(c))
  const visible = (a: number, b: number, size: (i: number) => number) => {
    const out: number[] = []
    for (let i = a; i <= b; i++) if (size(i) > 0) out.push(i)
    return out
  }
  const rows = visible(area.r0, area.r1, rowH)
  const cols = visible(area.c0, area.c1, colW)
  const tRows = titles.rows ? visible(titles.rows[0], titles.rows[1], rowH) : []
  const tCols = titles.cols ? visible(titles.cols[0], titles.cols[1], colW) : []
  const sum = (list: number[], size: (i: number) => number) => list.reduce((s, i) => s + size(i), 0)
  // Headings take room too (row numbers and column letters).
  const headW = setup.headings ? 32 : 0
  const headH = setup.headings ? 20 : 0
  let scale = setup.scale / 100
  if (setup.fitToPage) {
    const totalW = sum(cols, colW) + headW
    const totalH = sum(rows, rowH) + headH
    const sw = setup.fitWidth > 0 ? (setup.fitWidth * availW) / totalW : Infinity
    const sh2 = setup.fitHeight > 0 ? (setup.fitHeight * availH) / totalH : Infinity
    scale = Math.min(1, sw, sh2)
  }
  scale = Math.max(0.1, Math.min(4, scale))
  // Split one axis into pages: manual breaks, and wherever the next row/column would not fit.
  const split = (list: number[], size: (i: number) => number, room: number, breaks: number[], title: number[]): number[][] => {
    const out: number[][] = []
    let cur: number[] = []
    let used = 0
    const titleSize = sum(title, size) * scale
    for (const i of list) {
      const s = size(i) * scale
      const extra = out.length && title.length && !title.includes(cur[0] ?? i) ? titleSize : 0
      if (cur.length && (breaks.includes(i) || used + s + extra > room + 0.5)) {
        out.push(cur)
        cur = []
        used = 0
      }
      cur.push(i)
      used += s
    }
    if (cur.length) out.push(cur)
    return out.length ? out : [[]]
  }
  const rowPages = split(rows, rowH, availH - headH * scale, setup.rowBreaks, tRows)
  const colPages = split(cols, colW, availW - headW * scale, setup.colBreaks, tCols)
  const pages: PrintPage[] = []
  const add = (rp: number[], cp: number[]) =>
    pages.push({ sheet: sh.id, rows: rp, cols: cp, titleRows: tRows.filter((r) => !rp.includes(r) && (rp[0] ?? 0) > r), titleCols: tCols.filter((c) => !cp.includes(c) && (cp[0] ?? 0) > c), number: pages.length + 1 })
  if (setup.order === 'overThenDown') for (const rp of rowPages) for (const cp of colPages) add(rp, cp)
  else for (const cp of colPages) for (const rp of rowPages) add(rp, cp)
  return { sheet: sh.id, setup, paper: { w: pw * DPI, h: ph * DPI }, scale, pages }
}

/** A header/footer code string → left, centre and right text for one page. Formatting codes are dropped. */
export function headerFooterText(code: string, ctx: { page: number; pages: number; sheet: string; file: string; date: Date }): { l: string; c: string; r: string } {
  const out = { l: '', c: '', r: '' }
  let part: 'l' | 'c' | 'r' = 'c'
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch !== '&') {
      out[part] += ch
      continue
    }
    const n = code[++i]
    if (n === undefined) break
    if (n === 'L') part = 'l'
    else if (n === 'C') part = 'c'
    else if (n === 'R') part = 'r'
    else if (n === 'P') out[part] += String(ctx.page)
    else if (n === 'N') out[part] += String(ctx.pages)
    else if (n === 'D') out[part] += ctx.date.toLocaleDateString()
    else if (n === 'T') out[part] += ctx.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    else if (n === 'F') out[part] += ctx.file
    else if (n === 'A') out[part] += ctx.sheet
    else if (n === 'Z') out[part] += ''
    else if (n === '&') out[part] += '&'
    else if (n === '"') {
      // &"Font,Style" — skip to the closing quote.
      const end = code.indexOf('"', i + 1)
      i = end < 0 ? code.length : end
    } else if (n === 'K') i += 6 // &Krrggbb colour
    else if (/\d/.test(n)) while (/\d/.test(code[i + 1] ?? '')) i++ // &12 font size
    // &B &I &U &S &E &X &Y &G: formatting or pictures — dropped
  }
  return out
}

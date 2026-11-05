// A1 notation helpers. Rows and columns are 0-based everywhere inside the app.
import { MAX_COLS, MAX_ROWS, type Area } from './engine/values'

export function colName(c: number): string {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** "A" → 0, "XFD" → 16383; -1 if not a valid column. */
export function colIndex(s: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(s)) return -1
  let n = 0
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1 < MAX_COLS ? n - 1 : -1
}

export const cellName = (r: number, c: number) => `${colName(c)}${r + 1}`

/** "B3" → {r:2, c:1}; null if not a cell address. `$` signs are allowed and ignored. */
export function parseCell(s: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(s.trim())
  if (!m) return null
  const c = colIndex(m[1])
  const r = Number(m[2]) - 1
  if (c < 0 || r < 0 || r >= MAX_ROWS) return null
  return { r, c }
}

/** "A1:B3", "A:C", "2:5" or "B3" → area on `sheet`; null if not a range. */
export function parseArea(s: string, sheet = 0): Area | null {
  const t = s.trim().replace(/\$/g, '')
  const parts = t.split(':')
  if (parts.length === 1) {
    const p = parseCell(t)
    return p ? { sheet, r0: p.r, c0: p.c, r1: p.r, c1: p.c } : null
  }
  if (parts.length !== 2) return null
  const [a, b] = parts
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) {
    const c0 = colIndex(a)
    const c1 = colIndex(b)
    if (c0 < 0 || c1 < 0) return null
    return { sheet, r0: 0, r1: MAX_ROWS - 1, c0: Math.min(c0, c1), c1: Math.max(c0, c1) }
  }
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const r0 = Number(a) - 1
    const r1 = Number(b) - 1
    if (r0 < 0 || r1 < 0 || r0 >= MAX_ROWS || r1 >= MAX_ROWS) return null
    return { sheet, r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: 0, c1: MAX_COLS - 1 }
  }
  const p = parseCell(a)
  const q = parseCell(b)
  if (!p || !q) return null
  return { sheet, r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) }
}

export function areaName(a: Pick<Area, 'r0' | 'c0' | 'r1' | 'c1'>): string {
  if (a.r0 === 0 && a.r1 === MAX_ROWS - 1) return `${colName(a.c0)}:${colName(a.c1)}`
  if (a.c0 === 0 && a.c1 === MAX_COLS - 1) return `${a.r0 + 1}:${a.r1 + 1}`
  if (a.r0 === a.r1 && a.c0 === a.c1) return cellName(a.r0, a.c0)
  return `${cellName(a.r0, a.c0)}:${cellName(a.r1, a.c1)}`
}

/** Sheet names that need quotes in formulas ('My Sheet'!A1). */
export function quoteSheet(name: string): string {
  if (/^[A-Za-z_À-￿][\w.À-￿]*$/.test(name) && !parseCell(name) && !/^(R\d*C\d*|R|C)$/i.test(name) && !/^(TRUE|FALSE)$/i.test(name)) return name
  return `'${name.replace(/'/g, "''")}'`
}

export const inArea = (a: Area, sheet: number, r: number, c: number) => a.sheet === sheet && r >= a.r0 && r <= a.r1 && c >= a.c0 && c <= a.c1

export function intersect(a: Area, b: Area): Area | null {
  if (a.sheet !== b.sheet) return null
  const r0 = Math.max(a.r0, b.r0)
  const r1 = Math.min(a.r1, b.r1)
  const c0 = Math.max(a.c0, b.c0)
  const c1 = Math.min(a.c1, b.c1)
  return r0 <= r1 && c0 <= c1 ? { sheet: a.sheet, r0, c0, r1, c1 } : null
}

/** A numeric key for a cell: fits in a double exactly for up to 2^18 sheets. */
/** Sheet multiplier in cell keys (2^34, above MAX_ROWS × MAX_COLS). */
export const KEY_SHEET = 17_179_869_184
export const cellKey = (sheet: number, r: number, c: number) => sheet * KEY_SHEET + r * MAX_COLS + c
export function fromKey(k: number): { sheet: number; r: number; c: number } {
  const sheet = Math.floor(k / KEY_SHEET)
  const rest = k - sheet * KEY_SHEET
  return { sheet, r: Math.floor(rest / MAX_COLS), c: rest % MAX_COLS }
}

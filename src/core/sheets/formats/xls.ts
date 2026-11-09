// Excel 97–2003 workbooks (.xls: BIFF8 records in an OLE2 compound file), read into the same Workbook model as the
// other formats: every sheet's cell values with their number formats (so dates are dates). Formulas keep their cached
// results. Macros live in a separate storage that is never read; encrypted and pre-97 (BIFF5) files are refused.
import { Workbook } from '../model/workbook'
import { CellError } from '../engine/values'
import { Warnings, type ImportResult } from './types'

const MAX_BYTES = 512 * 1024 * 1024

// ---------------------------------------------------------------- compound file (MS-CFB)

/** The named streams of a compound file. */
export function readCfb(buf: Uint8Array): Map<string, Uint8Array> {
  if (buf.length > MAX_BYTES) throw new Error('The workbook is larger than 512 MB.')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  if (buf.length < 512 || sig.some((b, i) => buf[i] !== b)) throw new Error('This isn’t an Excel 97–2003 (.xls) workbook.')
  const u32 = (o: number) => dv.getUint32(o, true)
  const sectorSize = 1 << dv.getUint16(30, true)
  const miniSize = 1 << dv.getUint16(32, true)
  const nFat = u32(44)
  const firstDir = u32(48)
  const miniCutoff = u32(56)
  const firstMiniFat = u32(60)
  let difatSector = u32(68)
  const nSectors = Math.floor((buf.length - sectorSize) / sectorSize) + 1
  const sectorAt = (n: number) => {
    const o = (n + 1) * sectorSize
    if (n < 0 || n >= nSectors || o + sectorSize > buf.length + sectorSize) throw new Error('The workbook file is damaged (bad sector).')
    return o
  }
  // FAT sector numbers: 109 in the header, the rest in DIFAT sectors.
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(u32(76 + i * 4))
  for (let guard = 0; fatSectors.length < nFat && difatSector < 0xfffffffa; guard++) {
    if (guard > nSectors) throw new Error('The workbook file is damaged (DIFAT loop).')
    const o = sectorAt(difatSector)
    for (let i = 0; i < sectorSize / 4 - 1 && fatSectors.length < nFat; i++) fatSectors.push(u32(o + i * 4))
    difatSector = u32(o + sectorSize - 4)
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4))
  fatSectors.forEach((s, i) => {
    const o = sectorAt(s)
    for (let k = 0; k < sectorSize / 4; k++) fat[i * (sectorSize / 4) + k] = u32(o + k * 4)
  })
  const chain = (start: number, table: Uint32Array) => {
    const out: number[] = []
    for (let s = start; s < 0xfffffffa; s = table[s]) {
      if (out.length > table.length || s >= table.length) throw new Error('The workbook file is damaged (sector chain).')
      out.push(s)
    }
    return out
  }
  const readChain = (start: number, size?: number) => {
    const secs = chain(start, fat)
    const out = new Uint8Array(secs.length * sectorSize)
    secs.forEach((s, i) => out.set(buf.subarray(sectorAt(s), sectorAt(s) + sectorSize), i * sectorSize))
    return size === undefined ? out : out.subarray(0, Math.min(size, out.length))
  }
  const dir = readChain(firstDir)
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const entries: { name: string; type: number; start: number; size: number }[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = ddv.getUint16(o + 64, true)
    let name = ''
    for (let i = 0; i + 2 < len && i < 64; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true))
    entries.push({ name, type: dir[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) })
  }
  const root = entries.find((e) => e.type === 5)
  let mini: Uint8Array | null = null
  let miniFat: Uint32Array | null = null
  const streams = new Map<string, Uint8Array>()
  for (const e of entries) {
    if (e.type !== 2) continue
    if (e.size > MAX_BYTES) throw new Error('The workbook is larger than 512 MB.')
    if (e.size < miniCutoff && root) {
      mini ??= readChain(root.start, root.size)
      if (!miniFat) {
        const raw = readChain(firstMiniFat)
        miniFat = new Uint32Array(raw.length / 4)
        for (let i = 0; i < miniFat.length; i++) miniFat[i] = new DataView(raw.buffer, raw.byteOffset).getUint32(i * 4, true)
      }
      const secs = chain(e.start, miniFat)
      const out = new Uint8Array(secs.length * miniSize)
      secs.forEach((s, i) => out.set(mini!.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize))
      streams.set(e.name, out.subarray(0, e.size))
    } else streams.set(e.name, readChain(e.start, e.size))
  }
  return streams
}

// ---------------------------------------------------------------- BIFF8

/** Built-in number formats that Excel doesn't store (the date ones matter: they make a number a date). */
export const BUILTIN: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@'
}

interface Rec {
  type: number
  data: Uint8Array
  /** Where CONTINUE records began inside `data` (strings re-read their encoding flag there). */
  breaks: number[]
}

function records(stream: Uint8Array, from: number): Rec[] {
  const out: Rec[] = []
  let p = from
  while (p + 4 <= stream.length) {
    const type = stream[p] | (stream[p + 1] << 8)
    const len = stream[p + 2] | (stream[p + 3] << 8)
    const data = stream.subarray(p + 4, p + 4 + len)
    p += 4 + len
    if (type === 0x003c && out.length) {
      const prev = out[out.length - 1]
      const joined = new Uint8Array(prev.data.length + data.length)
      joined.set(prev.data)
      joined.set(data, prev.data.length)
      prev.breaks.push(prev.data.length)
      prev.data = joined
      continue
    }
    out.push({ type, data, breaks: [] })
    if (type === 0x000a) break // EOF of this substream
  }
  return out
}

/** Reads an XLUnicodeString (or its rich/extended form) at `o`; strings may continue across CONTINUE breaks. */
function readString(r: Rec, o: number, cch: number): { s: string; end: number } {
  const d = r.data
  let flags = d[o++]
  let runs = 0
  let ext = 0
  if (flags & 0x08) (runs = d[o] | (d[o + 1] << 8)), (o += 2)
  if (flags & 0x04) (ext = d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)), (o += 4)
  let s = ''
  while (s.length < cch) {
    const next = r.breaks.find((b) => b > o) ?? d.length
    const wide = flags & 0x01
    const avail = wide ? Math.floor((next - o) / 2) : next - o
    const take = Math.min(cch - s.length, avail)
    for (let i = 0; i < take; i++) s += String.fromCharCode(wide ? d[o + 2 * i] | (d[o + 2 * i + 1] << 8) : d[o + i])
    o += wide ? 2 * take : take
    if (s.length < cch) {
      if (o >= d.length) throw new Error('The workbook file is damaged (string).')
      flags = d[o++] // a CONTINUE restates whether the rest of the string is 8- or 16-bit
    }
  }
  return { s, end: o + runs * 4 + ext }
}

export const rk = (v: number) => {
  let n: number
  if (v & 0x02) n = v >> 2
  else {
    const b = new DataView(new ArrayBuffer(8))
    b.setUint32(4, v & 0xfffffffc, true)
    n = b.getFloat64(0, true)
  }
  return v & 0x01 ? n / 100 : n
}

export const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' }

export function importXls(bytes: Uint8Array): ImportResult {
  const streams = readCfb(bytes)
  const stream = streams.get('Workbook') ?? streams.get('WORKBOOK')
  if (!stream) {
    if (streams.has('Book')) throw new Error('Excel 95 and older workbooks aren’t supported. Save the file as .xlsx.')
    throw new Error('This file has no Excel workbook inside.')
  }
  return importBiff(stream)
}

/** The BIFF8 "Workbook" stream of an .xls file. */
export function importBiff(stream: Uint8Array): ImportResult {
  const w = new Warnings()
  const globals = records(stream, 0)
  if (globals[0]?.type !== 0x0809) throw new Error('The workbook file is damaged (no BOF).')
  const formats = new Map<number, string>()
  const xfFormat: number[] = []
  const sheets: { name: string; pos: number; kind: number; hidden: boolean }[] = []
  let sst: string[] = []
  let date1904 = false
  for (const r of globals) {
    const d = r.data
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
    switch (r.type) {
      case 0x002f:
        throw new Error('The workbook is password-protected. Open it in Excel, remove the password, and save it again.')
      case 0x0022:
        date1904 = dv.getUint16(0, true) === 1
        break
      case 0x041e:
        formats.set(dv.getUint16(0, true), readString(r, 4, dv.getUint16(2, true)).s)
        break
      case 0x00e0:
        xfFormat.push(dv.getUint16(2, true))
        break
      case 0x0085:
        sheets.push({ pos: dv.getUint32(0, true), hidden: (d[4] & 3) !== 0, kind: d[5], name: readString(r, 7, d[6]).s })
        break
      case 0x00fc: {
        const n = dv.getUint32(4, true)
        let o = 8
        sst = []
        for (let i = 0; i < n && o < d.length; i++) {
          const cch = d[o] | (d[o + 1] << 8)
          const { s, end } = readString(r, o + 2, cch)
          sst.push(s)
          o = end
        }
        break
      }
    }
  }
  const wb = new Workbook()
  const styleOf = new Map<number, number | undefined>()
  const style = (xf: number) => {
    if (!styleOf.has(xf)) {
      const id = xfFormat[xf] ?? 0
      const code = formats.get(id) ?? BUILTIN[id] ?? 'General'
      styleOf.set(xf, code === 'General' ? undefined : wb.styles.intern({ numFmt: code }))
    }
    return styleOf.get(xf)
  }
  // 1904-based serials (old Mac workbooks) as 1900-based, which the model uses.
  const num = (v: number, xf: number) => (date1904 && style(xf) !== undefined ? v + 1462 : v)
  for (const info of sheets.filter((s) => s.kind === 0)) {
    const sh = wb.addSheet(info.name)
    if (info.hidden) sh.hidden = 'hidden'
    const recs = records(stream, info.pos)
    let pendingString: { r: number; c: number; xf: number } | null = null
    for (const r of recs) {
      const d = r.data
      if (d.length < 6 && r.type !== 0x0207) continue
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
      const row = dv.getUint16(0, true)
      const col = dv.getUint16(2, true)
      const xf = d.length >= 6 ? dv.getUint16(4, true) : 0
      const put = (c: number, v: unknown, x: number) => sh.set(row, c, { v, ...(style(x) !== undefined ? { s: style(x) } : {}) } as never)
      switch (r.type) {
        case 0x00fd: // LABELSST
          put(col, sst[dv.getUint32(6, true)] ?? '', xf)
          break
        case 0x0203: // NUMBER
          put(col, num(dv.getFloat64(6, true), xf), xf)
          break
        case 0x027e: // RK
          put(col, num(rk(dv.getUint32(6, true)), xf), xf)
          break
        case 0x00bd: {
          // MULRK: several RK cells in a row
          const last = dv.getUint16(d.length - 2, true)
          for (let c = col, o = 4; c <= last && o + 6 <= d.length - 2; c++, o += 6) put(c, num(rk(dv.getUint32(o + 2, true)), dv.getUint16(o, true)), dv.getUint16(o, true))
          break
        }
        case 0x0204: // LABEL (older writers)
          put(col, readString(r, 8, dv.getUint16(6, true)).s, xf)
          break
        case 0x0205: // BOOLERR
          put(col, d[7] ? CellError.of((ERRORS[d[6]] ?? '#VALUE!') as never) : d[6] !== 0, xf)
          break
        case 0x0006: {
          // FORMULA: the cached result (a string result follows in a STRING record)
          if (dv.getUint16(12, true) === 0xffff) {
            const kind = d[6]
            if (kind === 0) pendingString = { r: row, c: col, xf }
            else if (kind === 1) put(col, d[8] !== 0, xf)
            else if (kind === 2) put(col, CellError.of((ERRORS[d[8]] ?? '#VALUE!') as never), xf)
          } else put(col, num(dv.getFloat64(6, true), xf), xf)
          break
        }
        case 0x0207:
          if (pendingString) {
            const p = pendingString
            pendingString = null
            sh.set(p.r, p.c, { v: readString(r, 2, dv.getUint16(0, true)).s, ...(style(p.xf) !== undefined ? { s: style(p.xf) } : {}) } as never)
          }
          break
      }
    }
  }
  if (!wb.sheets.length) throw new Error('The workbook has no worksheets.')
  if (sheets.some((s) => s.kind !== 0)) w.add('loss', 'Chart sheets and macro sheets were skipped.')
  return { workbook: wb, warnings: w.list }
}

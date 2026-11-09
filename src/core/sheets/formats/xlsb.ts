// Excel binary workbooks (.xlsb: BIFF12 records in a ZIP package, [MS-XLSB]), read into the same Workbook model as
// the other formats: every worksheet's cell values with their number formats (so dates are dates). Formulas keep
// their cached results. The macro part (vbaProject.bin) is never read.
import { Workbook } from '../model/workbook'
import { CellError } from '../engine/values'
import { readZip } from './zip'
import { parseRels, resolveTarget } from './opc'
import { BUILTIN, ERRORS, rk } from './xls'
import { Warnings, type ImportResult } from './types'

/** BIFF12 records: a type and a size, each a little-endian base-128 number (1–2 and 1–4 bytes). */
export function* records(b: Uint8Array): Generator<{ type: number; data: Uint8Array }> {
  let o = 0
  while (o < b.length) {
    let type = 0
    for (let i = 0; i < 2 && o < b.length; i++) {
      const x = b[o++]
      type |= (x & 0x7f) << (7 * i)
      if (!(x & 0x80)) break
    }
    let size = 0
    for (let i = 0; i < 4 && o < b.length; i++) {
      const x = b[o++]
      size |= (x & 0x7f) << (7 * i)
      if (!(x & 0x80)) break
    }
    if (o + size > b.length) return
    yield { type, data: b.subarray(o, o + size) }
    o += size
  }
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength)
const utf16 = new TextDecoder('utf-16le')

/** An XLWideString at `o`: a character count, then UTF-16. Null (0xFFFFFFFF) reads as ''. */
function wide(d: Uint8Array, o: number): { s: string; end: number } {
  if (o + 4 > d.length) return { s: '', end: d.length }
  const n = view(d).getUint32(o, true)
  if (n === 0xffffffff) return { s: '', end: o + 4 }
  const end = Math.min(d.length, o + 4 + 2 * n)
  return { s: utf16.decode(d.subarray(o + 4, end)), end }
}

const R = {
  bundleSheet: 0x9c,
  wbProp: 0x99,
  sstItem: 0x13,
  fmt: 0x2c,
  xf: 0x2f,
  beginCellXfs: 0x269,
  endCellXfs: 0x26a,
  rowHdr: 0x00,
  rk: 0x02,
  error: 0x03,
  bool: 0x04,
  real: 0x05,
  st: 0x06,
  isst: 0x07,
  fmlaString: 0x08,
  fmlaNum: 0x09,
  fmlaBool: 0x0a,
  fmlaError: 0x0b
}

export function importXlsb(bytes: Uint8Array): ImportResult {
  const w = new Warnings()
  const files = readZip(bytes)
  const wbPart = 'xl/workbook.bin'
  if (!files[wbPart]) throw new Error('This is not an Excel binary workbook (.xlsb): it has no workbook part.')
  const rels = parseRels(files, wbPart)
  const relTarget = (type: string) => rels.find((r) => r.type.endsWith(`/${type}`))
  let date1904 = false
  const sheets: { name: string; part: string; hidden: boolean }[] = []
  let skipped = 0
  for (const r of records(files[wbPart])) {
    if (r.type === R.wbProp && r.data.length >= 4) date1904 = (view(r.data).getUint32(0, true) & 1) === 1
    if (r.type === R.bundleSheet && r.data.length >= 8) {
      const hs = view(r.data).getUint32(0, true)
      const id = wide(r.data, 8)
      const name = wide(r.data, id.end).s
      const rel = rels.find((x) => x.id === id.s)
      if (!rel || !rel.type.endsWith('/worksheet')) {
        skipped++
        continue
      }
      sheets.push({ name, part: resolveTarget(wbPart, rel.target), hidden: hs !== 0 })
    }
  }

  // Shared strings: each item is a flags byte, then the text (rich-text runs and phonetics after it are ignored).
  const sst: string[] = []
  const sstRel = relTarget('sharedStrings')
  const sstPart = sstRel && files[resolveTarget(wbPart, sstRel.target)]
  if (sstPart) for (const r of records(sstPart)) if (r.type === R.sstItem) sst.push(wide(r.data, 1).s)

  // Number formats: custom codes, and each cell format's code (only the cell XFs, not the cell-style XFs).
  const formats = new Map<number, string>()
  const xfFormat: number[] = []
  const stylesRel = relTarget('styles')
  const stylesPart = stylesRel && files[resolveTarget(wbPart, stylesRel.target)]
  if (stylesPart) {
    let inCellXfs = false
    for (const r of records(stylesPart)) {
      if (r.type === R.fmt && r.data.length >= 2) formats.set(view(r.data).getUint16(0, true), wide(r.data, 2).s)
      else if (r.type === R.beginCellXfs) inCellXfs = true
      else if (r.type === R.endCellXfs) inCellXfs = false
      else if (r.type === R.xf && inCellXfs && r.data.length >= 4) xfFormat.push(view(r.data).getUint16(2, true))
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

  for (const info of sheets) {
    const part = files[info.part]
    const sh = wb.addSheet(info.name)
    if (info.hidden) sh.hidden = 'hidden'
    if (!part) {
      w.add('loss', `The sheet “${info.name}” is missing from the file.`)
      continue
    }
    let row = 0
    for (const r of records(part)) {
      const d = r.data
      if (r.type === R.rowHdr) {
        if (d.length >= 4) row = view(d).getUint32(0, true)
        continue
      }
      if (r.type < R.rk || r.type > R.fmlaError || d.length < 9) continue
      const dv = view(d)
      const col = dv.getUint32(0, true)
      const xf = dv.getUint32(4, true) & 0xffffff
      const put = (v: unknown) => sh.set(row, col, { v, ...(style(xf) !== undefined ? { s: style(xf) } : {}) } as never)
      switch (r.type) {
        case R.rk:
          put(num(rk(dv.getUint32(8, true)), xf))
          break
        case R.real:
        case R.fmlaNum:
          if (d.length >= 16) put(num(dv.getFloat64(8, true), xf))
          break
        case R.st:
        case R.fmlaString:
          put(wide(d, 8).s)
          break
        case R.isst:
          if (d.length >= 12) put(sst[dv.getUint32(8, true)] ?? '')
          break
        case R.bool:
        case R.fmlaBool:
          put(d[8] !== 0)
          break
        case R.error:
        case R.fmlaError:
          put(CellError.of((ERRORS[d[8]] ?? '#VALUE!') as never))
          break
      }
    }
  }
  if (!wb.sheets.length) throw new Error('The workbook has no worksheets.')
  if (skipped) w.add('loss', 'Chart sheets and macro sheets were skipped.')
  return { workbook: wb, warnings: w.list }
}

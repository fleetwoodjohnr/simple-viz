// Arrow IPC files and streams (.arrow, .feather v2, .arrows) read with Apache Arrow's JS library, into the same column
// shape the spreadsheet readers produce (so they stage through the same appender). Compressed files use LZ4 frames
// (pyarrow's default for Feather) or ZSTD: ZSTD comes from Node's zlib, LZ4 from the small decoder below.
import { zstdDecompressSync } from 'node:zlib'
import { tableFromIPC, compressionRegistry, CompressionType, DataType, type Table } from 'apache-arrow'
import type { ColumnType } from '../core/sheets/rows'

/** Decodes an LZ4 frame (lz4.github.io/lz4/lz4_Frame_format.html): blocks may refer back to earlier blocks. */
export function lz4FrameDecode(src: Uint8Array): Uint8Array {
  const u32 = (i: number) => (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0
  if (u32(0) !== 0x184d2204) throw new Error('Not an LZ4 frame.')
  const flg = src[4]
  if (flg >> 6 !== 1) throw new Error('Unsupported LZ4 frame version.')
  if (flg & 0x01) throw new Error('LZ4 frames with a dictionary are not supported.')
  let p = 6 + (flg & 0x08 ? 8 : 0) + 1 // FLG, BD, [content size], header checksum
  const blockChecksum = !!(flg & 0x10)
  let out = new Uint8Array(Math.max(1024, src.length * 4))
  let n = 0
  const need = (k: number) => {
    if (n + k <= out.length) return
    let size = out.length * 2
    while (size < n + k) size *= 2
    const grown = new Uint8Array(size)
    grown.set(out.subarray(0, n))
    out = grown
  }
  for (;;) {
    const raw = u32(p)
    p += 4
    if (raw === 0) break
    const size = raw & 0x7fffffff
    const end = p + size
    if (end > src.length) throw new Error('Truncated LZ4 frame.')
    if (raw & 0x80000000) {
      need(size)
      out.set(src.subarray(p, end), n)
      n += size
    } else {
      while (p < end) {
        const token = src[p++]
        let lit = token >> 4
        if (lit === 15) for (let b = 255; b === 255 && p < end; ) lit += b = src[p++]
        need(lit)
        out.set(src.subarray(p, p + lit), n)
        n += lit
        p += lit
        if (p >= end) break // the last sequence has literals only
        const offset = src[p] | (src[p + 1] << 8)
        p += 2
        if (!offset || offset > n) throw new Error('Corrupt LZ4 data.')
        let len = (token & 15) + 4
        if ((token & 15) === 15) for (let b = 255; b === 255 && p < end; ) len += b = src[p++]
        need(len)
        // Byte by byte: a match may overlap the bytes it is producing.
        for (let i = 0, from = n - offset; i < len; i++) out[n++] = out[from + i]
      }
    }
    p = end + (blockChecksum ? 4 : 0)
  }
  return out.subarray(0, n)
}

let codecs = false
function registerCodecs() {
  if (codecs) return
  codecs = true
  compressionRegistry.set(CompressionType.LZ4_FRAME, { decode: (b: Uint8Array) => lz4FrameDecode(b) })
  compressionRegistry.set(CompressionType.ZSTD, { decode: (b: Uint8Array) => new Uint8Array(zstdDecompressSync(b)) })
}

const DAY_MS = 86_400_000

/** An Arrow file's columns as typed values (DATE: days since 1970; TIMESTAMP: ms since 1970, UTC). */
export function readArrow(bytes: Uint8Array): { columns: { name: string; type: ColumnType; values: (string | number | boolean | null)[] }[]; rowCount: number } {
  registerCodecs()
  let t: Table
  try {
    t = tableFromIPC(bytes)
  } catch (e) {
    throw new Error(`This isn’t a readable Arrow or Feather file: ${(e as Error).message}`)
  }
  // Arrow's reader returns an empty table for bytes that aren't Arrow at all.
  if (!t.schema.fields.length) throw new Error('This isn’t a readable Arrow or Feather file (it has no columns).')
  const columns = t.schema.fields.map((f, i) => {
    const v = t.getChildAt(i)!
    const ty = f.type
    const type: ColumnType = DataType.isBool(ty) ? 'BOOLEAN' : DataType.isInt(ty) ? 'BIGINT' : DataType.isFloat(ty) || DataType.isDecimal(ty) ? 'DOUBLE' : DataType.isDate(ty) ? 'DATE' : DataType.isTimestamp(ty) ? 'TIMESTAMP' : 'VARCHAR'
    const values: (string | number | boolean | null)[] = new Array(t.numRows)
    for (let r = 0; r < t.numRows; r++) {
      const x = v.get(r) as unknown
      values[r] =
        x === null || x === undefined
          ? null
          : type === 'BOOLEAN'
            ? !!x
            : type === 'BIGINT'
              ? Number(x)
              : type === 'DOUBLE'
                ? Number(DataType.isDecimal(ty) ? Number(String(x)) / 10 ** (ty as { scale: number }).scale : x)
                : type === 'DATE'
                  ? Math.floor(Number(x instanceof Date ? x.getTime() : x) / DAY_MS)
                  : type === 'TIMESTAMP'
                    ? Number(x instanceof Date ? x.getTime() : x)
                    : typeof x === 'object'
                      ? JSON.stringify(x, (_k, y) => (typeof y === 'bigint' ? Number(y) : y))
                      : String(x)
    }
    return { name: f.name, type, values }
  })
  return { columns, rowCount: t.numRows }
}

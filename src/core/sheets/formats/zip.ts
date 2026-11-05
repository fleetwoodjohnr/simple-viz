// Reading and writing ZIP packages (XLSX, ODS) with limits against malicious archives ("zip bombs").
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate'

export const LIMITS = {
  /** Most entries a package may have. */
  entries: 20_000,
  /** Largest total uncompressed size. */
  totalBytes: 1.5 * 1024 ** 3,
  /** Largest single entry. */
  entryBytes: 1024 ** 3,
  /** Highest compression ratio for entries over 1 MB (real spreadsheets stay well below this). */
  ratio: 1000
}

export class PackageError extends Error {}

/** Unzip after checking every entry's declared size and the overall totals. */
export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new PackageError('This file is not a valid package (it is not a ZIP archive).')
  let count = 0
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter(f) {
        count++
        if (count > LIMITS.entries) throw new PackageError('The file has too many parts to open safely.')
        if (f.name.includes('..') || f.name.startsWith('/')) return false
        total += f.originalSize
        if (f.originalSize > LIMITS.entryBytes || total > LIMITS.totalBytes) throw new PackageError('The file expands to more data than Simple Viz opens safely.')
        if (f.originalSize > 1024 ** 2 && f.size > 0 && f.originalSize / f.size > LIMITS.ratio) throw new PackageError('Part of the file is compressed suspiciously well; it was not opened (possible zip bomb).')
        return true
      }
    })
  } catch (e) {
    if (e instanceof PackageError) throw e
    throw new PackageError('The file is damaged and could not be opened.')
  }
  // Declared sizes can lie: check what actually came out.
  let actual = 0
  for (const v of Object.values(files)) actual += v.length
  if (actual > LIMITS.totalBytes) throw new PackageError('The file expands to more data than Simple Viz opens safely.')
  return files
}

export function writeZip(files: Record<string, Uint8Array>): Uint8Array {
  // mimetype must come first and uncompressed (ODF); the rest is deflated.
  const z: Zippable = {}
  if (files.mimetype) z.mimetype = [files.mimetype, { level: 0 }]
  for (const [k, v] of Object.entries(files)) if (k !== 'mimetype') z[k] = v
  return zipSync(z, { level: 6 })
}

export const text = (b: Uint8Array | undefined) => (b ? strFromU8(b) : '')
export const bytes = (s: string) => strToU8(s)

// The catalog of every Excel worksheet function, generated from Microsoft's documentation (scripts/gen-catalog.mjs).
// It drives autocomplete, the coverage report, and reporting formulas that use functions Simple Cell lacks.
import data from './catalog.json'

export interface CatalogEntry {
  n: string
  cat: string
  d: string
  /** Excel version that introduced it (null: Excel 2007 or earlier). */
  v: string | null
}

export const CATALOG = data as CatalogEntry[]
const byName = new Map(CATALOG.map((e) => [e.n, e]))

export const catalogEntry = (name: string) => byName.get(name.toUpperCase())
export const isKnownExcelFunction = (name: string) => byName.has(name.toUpperCase())

// Functions written with a _xlfn._xlws. prefix in OOXML.
const XLWS = new Set(['SORT', 'FILTER'])
// Functions introduced after Excel 2007 are written with _xlfn. in files; older ones are not.
const XLFN_EXTRA = new Set(['SINGLE', 'ANCHORARRAY', 'STOCKHISTORY', 'AGGREGATE'])

/** The name as it must appear in an OOXML formula. */
export function fileFunctionName(name: string): string {
  const e = byName.get(name)
  if (XLWS.has(name)) return `_xlfn._xlws.${name}`
  if ((e && e.v !== null) || XLFN_EXTRA.has(name)) return `_xlfn.${name}`
  return name
}

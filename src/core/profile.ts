// Column profiling: one SQL pass over a relation gives counts, nulls, distincts, ranges, duplicates, and the hints that
// drive suggestions (currency text that should be numbers, dates stored as text, geographic roles).

import type { ColumnInfo } from '../shared/engine-protocol'

export const q = (s: string) => `"${s.replace(/"/g, '""')}"`

export type GeoRole = 'country' | 'state' | 'city' | 'postcode' | 'latitude' | 'longitude' | 'county' | 'region'

const GEO: [RegExp, GeoRole][] = [
  [/^(lat|latitude|lat_dd|y_coord)$/i, 'latitude'],
  [/^(lon|lng|long|longitude|lon_dd|x_coord)$/i, 'longitude'],
  [/(^|_|\s)(country|nation)(_?(name|code))?$/i, 'country'],
  [/(^|_|\s)(state|province|prov|us_state|state_code|state_name)$/i, 'state'],
  [/(^|_|\s)(city|town|municipality)$/i, 'city'],
  [/(^|_|\s)(zip|zipcode|zip_code|postcode|postal_code|postal)$/i, 'postcode'],
  [/(^|_|\s)county$/i, 'county'],
  [/^region$/i, 'region']
]

export function geoRole(name: string): GeoRole | null {
  const n = name.trim()
  for (const [re, role] of GEO) if (re.test(n)) return role
  return null
}

export const isNumericType = (t: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL|REAL)/.test(t)
export const isDateType = (t: string) => /^(DATE|TIMESTAMP)/.test(t)
export const isTextType = (t: string) => /^VARCHAR/.test(t)

/** One query: a row with n, dup, and per column nn_i, nd_i, min_i, max_i, (text) cur_i / num_i / date_i. */
export function profileSql(relation: string, cols: ColumnInfo[]): string {
  const parts = ['count(*) AS n']
  cols.forEach((c, i) => {
    const col = q(c.name)
    parts.push(`count(${col}) AS nn_${i}`, `approx_count_distinct(${col}) AS nd_${i}`)
    if (isNumericType(c.type) || isDateType(c.type)) parts.push(`CAST(min(${col}) AS VARCHAR) AS min_${i}`, `CAST(max(${col}) AS VARCHAR) AS max_${i}`)
    if (isTextType(c.type)) {
      // Text that is really money, numbers or dates: how many non-empty values parse.
      parts.push(`count(*) FILTER (WHERE regexp_full_match(trim(${col}), '[-+(]?[$€£¥]?\\s?[-+]?[0-9][0-9,]*(\\.[0-9]+)?\\)?%?'))  AS num_${i}`)
      parts.push(`count(*) FILTER (WHERE regexp_matches(${col}, '[$€£¥]'))  AS cur_${i}`)
      parts.push(`count(*) FILTER (WHERE TRY_CAST(${col} AS DATE) IS NOT NULL OR TRY_STRPTIME(${col}, '%m/%d/%Y') IS NOT NULL) AS date_${i}`)
    }
  })
  return `SELECT ${parts.join(', ')}, (SELECT count(*) FROM (SELECT ${cols.map((c) => q(c.name)).join(', ')} FROM ${q(relation)} GROUP BY ALL HAVING count(*) > 1)) AS dup FROM ${q(relation)}`
}

export interface ColumnProfile {
  name: string
  type: string
  nulls: number
  distinct: number
  min?: string
  max?: string
  geo: GeoRole | null
  /** A better type for text that holds numbers, money or dates, with the reason. */
  suggest?: { type: string; why: string }
}

export interface Profile {
  rows: number
  /** Rows that appear more than once (counted once per duplicated row value). */
  duplicateRows: number
  columns: ColumnProfile[]
}

export function readProfile(cols: ColumnInfo[], row: Record<string, unknown>): Profile {
  const num = (k: string) => Number(row[k] ?? 0)
  const rows = num('n')
  return {
    rows,
    duplicateRows: num('dup'),
    columns: cols.map((c, i) => {
      const nn = num(`nn_${i}`)
      const p: ColumnProfile = { name: c.name, type: c.type, nulls: rows - nn, distinct: num(`nd_${i}`), geo: geoRole(c.name) }
      if (row[`min_${i}`] != null) p.min = String(row[`min_${i}`])
      if (row[`max_${i}`] != null) p.max = String(row[`max_${i}`])
      if (isTextType(c.type) && nn > 0) {
        if (num(`num_${i}`) === nn) p.suggest = num(`cur_${i}`) > 0 ? { type: 'DOUBLE', why: 'Looks like currency' } : { type: 'DOUBLE', why: 'Every value is a number' }
        else if (num(`date_${i}`) === nn) p.suggest = { type: 'DATE', why: 'Every value is a date' }
      }
      return p
    })
  }
}

/** SQL expression turning currency/number text into a DOUBLE ($1,234.50 → 1234.5; (12) → -12; 15% → 0.15). */
export function numberFromText(col: string): string {
  const c = q(col)
  const digits = `TRY_CAST(regexp_replace(${c}, '[^0-9.\\-]', '', 'g') AS DOUBLE)`
  return `CASE WHEN ${c} LIKE '(%)' THEN -${digits} WHEN ${c} LIKE '%\\%%' ESCAPE '\\' THEN ${digits} / 100 ELSE ${digits} END`
}

// SQL text helpers for statements the engine itself writes (never applied to user SQL).

export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Trailing semicolons and whitespace, which users type out of habit, are not part of the statement. */
export const trimStatement = (sql: string) => sql.replace(/[\s;]+$/, '')

/** Type names a user may pick when correcting an inferred column type. */
const TYPE = /^(VARCHAR|TEXT|BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL\(\d{1,2},\s?\d{1,2}\)|DATE|TIME|TIMESTAMP|TIMESTAMPTZ|INTERVAL|UUID)$/i
export const isSafeType = (t: string) => TYPE.test(t.trim())

/** A stable cache-table name for one table of one source. */
export function extractName(sourceId: string, ref: string | undefined): string {
  let h = 2166136261
  for (const ch of `${sourceId}\u0000${ref ?? ''}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return `e_${sourceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}_${h.toString(36)}`
}

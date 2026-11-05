// Small, dialect-agnostic scanners over SQL text: they skip strings, quoted identifiers and comments.

/** Calls fn for each code (non-string, non-comment) span of the SQL. */
function codeSpans(sql: string, fn: (start: number, end: number) => void) {
  let i = 0
  let start = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    let skipTo = -1
    if (ch === "'" || ch === '"') {
      let j = i + 1
      for (; j < n; j++) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j++
          else break
        }
      }
      skipTo = j + 1
    } else if (ch === '-' && next === '-') {
      const j = sql.indexOf('\n', i)
      skipTo = j < 0 ? n : j
    } else if (ch === '/' && next === '*') {
      const j = sql.indexOf('*/', i + 2)
      skipTo = j < 0 ? n : j + 2
    } else if (ch === '$' && next === '$') {
      const j = sql.indexOf('$$', i + 2)
      skipTo = j < 0 ? n : j + 2
    }
    if (skipTo >= 0) {
      if (i > start) fn(start, i)
      i = start = skipTo
    } else i++
  }
  if (n > start) fn(start, n)
}

/** Named parameters ($region, $min_revenue) in order of first use. */
export function sqlParams(sql: string): string[] {
  const out: string[] = []
  codeSpans(sql, (s, e) => {
    for (const m of sql.slice(s, e).matchAll(/\$([A-Za-z_]\w*)/g)) if (!out.includes(m[1])) out.push(m[1])
  })
  return out
}

/** The statement around offset `pos` in a script of `;`-separated statements (for "run the statement at the cursor"). */
export function statementAt(sql: string, pos: number): { from: number; to: number; text: string } {
  const bounds: number[] = []
  codeSpans(sql, (s, e) => {
    for (let i = s; i < e; i++) if (sql[i] === ';') bounds.push(i)
  })
  let from = 0
  for (const b of bounds) {
    if (b < pos) from = b + 1
    else {
      const text = sql.slice(from, b)
      if (text.trim()) return { from, to: b, text }
      from = b + 1
    }
  }
  return { from, to: sql.length, text: sql.slice(from) }
}

/** A parameter value typed in a text box: numbers become numbers, the rest stay text. */
export function paramValue(raw: string): string | number | boolean | null {
  const t = raw.trim()
  if (t === '') return null
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t)
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true'
  return raw
}

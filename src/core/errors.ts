// Turns driver and engine errors into one or two sentences a user can act on. The raw text stays in the log.

export function explainError(raw: unknown, ctx: { host?: string; port?: number; database?: string; path?: string } = {}): string {
  const m = String((raw as Error)?.message ?? raw ?? '')
  const where = ctx.host ? `${ctx.host}${ctx.port ? `:${ctx.port}` : ''}` : 'the server'
  if (/password authentication failed|authentication failed|Access denied for user|Login failed for user/i.test(m)) return 'The server rejected the user name or password.'
  if (/no password supplied|password is required/i.test(m)) return 'The server needs a password.'
  if (/Connection refused|could not connect|ECONNREFUSED|Can't connect to (MySQL )?server/i.test(m)) return `Can’t reach ${where}. Check that the database is running and the host and port are right.`
  if (/could not translate host name|Name or service not known|ENOTFOUND|nodename nor servname/i.test(m)) return `The host name ${ctx.host ?? ''} couldn’t be found. Check the spelling, or your network.`.replace('  ', ' ')
  if (/timeout expired|timed out|ETIMEDOUT|statement timeout|canceling statement due to statement timeout/i.test(m)) return `The connection to ${where} timed out. The server may be busy or unreachable.`
  if (/database "[^"]+" does not exist|Unknown database/i.test(m)) return `The database ${ctx.database ?? ''} doesn’t exist on ${where}.`.replace('  ', ' ')
  if (/SSL|certificate/i.test(m) && /required|verify|unsupported|failed|reject/i.test(m)) return `The secure (SSL) connection to ${where} failed. Try a different SSL mode, or ask your administrator for the server’s certificate settings.`
  if (/server closed the connection unexpectedly|terminating connection|connection to server .* lost|no connection to the server/i.test(m)) return `The connection to ${where} was lost. It is retried on the next refresh.`
  if (/INTERRUPT|Interrupted/i.test(m)) return 'The query was cancelled.'
  if (/No such file or directory|ENOENT|IO Error: Cannot open file|IO Error:[^\n]*does not exist|^File [^\n]* does not exist/i.test(m)) return ctx.path ? `The file is missing: ${ctx.path}. It may have been moved or renamed — use Relink to find it.` : 'A file this project uses is missing.'
  if (/EACCES|EPERM|Permission denied/i.test(m)) return ctx.path ? `Simple Viz isn’t allowed to read ${ctx.path}.` : 'Permission denied.'
  if (/EBUSY|being used by another process|Could not set lock/i.test(m)) return 'The file is locked by another program. Close it there, or wait a moment, and refresh again.'
  if (/Invalid Input Error: (CSV|Error when sniffing)|Could not convert string|Conversion Error/i.test(m)) return `The data couldn’t be read as a table: ${firstLine(m).replace(/^[A-Za-z ]+Error: /, '')}`
  return firstLine(m).replace(/^(Binder|Parser|Catalog|Invalid Input|IO|Conversion|Constraint|Permission|Out of Memory) Error: /, '') || 'Something went wrong.'
}

const firstLine = (s: string) => s.split('\n')[0].trim()

/** Where a DuckDB error points in the statement (0-based offset), from its `LINE n: …` excerpt and caret. */
export function errorPosition(message: string, sql: string): number | null {
  const m = /LINE (\d+): (.*)\n(\s*)\^/.exec(message)
  if (!m) return null
  const line = Number(m[1]) - 1
  const excerpt = m[2]
  const col = m[3].length - `LINE ${m[1]}: `.length
  const lines = sql.split('\n')
  if (line >= lines.length) return null
  // DuckDB trims long lines to a window around the error ("...text"): find the excerpt in the real line.
  const real = lines[line]
  const trimmed = excerpt.replace(/^\.\.\./, '')
  const shift = excerpt.startsWith('...') ? real.indexOf(trimmed.slice(0, 20)) - 3 : 0
  const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0)
  return offset + Math.max(0, Math.min(real.length, col + Math.max(0, shift)))
}

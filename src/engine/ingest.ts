// How each kind of source becomes a SELECT the refresh can materialize into the cache.
// Flat files use DuckDB's own readers; spreadsheets go through Simple Cell's readers and an appender; databases are
// read through their (read-only) attachment.

import { promises as fs } from 'node:fs'
import { dateValue, timestampValue, type DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { isServer } from '../shared/project'
import { readWorkbook, tableRows, type SheetFormat } from '../core/sheets/rows'
import type { Workbook } from '../core/sheets/model/workbook'
import { ident, lit } from './sql'

export interface Stat {
  size: number
  mtime: number
}

/** Size and modification time of a file-backed source (null for servers). */
export async function sourceStat(s: ResolvedSource): Promise<Stat | null> {
  if (!s.path || isServer(s.kind)) return null
  const st = await fs.stat(s.path)
  if (!st.isFile()) throw new Error(`ENOENT: not a file: ${s.path}`)
  return { size: st.size, mtime: Math.round(st.mtimeMs) }
}

const MAX_SHEET_BYTES = 512 * 1024 * 1024
let stageSeq = 0

/** One refresh of one source: a workbook with several sheets is read once. */
export type Memo = { book?: Promise<Workbook> }

export async function extractSelect(conn: DuckDBConnection, s: ResolvedSource, ref: string | undefined, memo: Memo = {}): Promise<{ select: string; cleanup: () => Promise<void> }> {
  const none = async () => {}
  if (s.kind === 'file') {
    const p = lit(s.path!)
    const header = s.header === false ? 'false' : 'true'
    switch (s.format) {
      case 'csv':
        return { select: `SELECT * FROM read_csv(${p}, header = ${header})`, cleanup: none }
      case 'tsv':
        return { select: `SELECT * FROM read_csv(${p}, header = ${header}, delim = '\t')`, cleanup: none }
      case 'json':
        return { select: `SELECT * FROM read_json_auto(${p})`, cleanup: none }
      case 'jsonl':
        return { select: `SELECT * FROM read_json_auto(${p}, format = 'newline_delimited')`, cleanup: none }
      case 'parquet':
        return { select: `SELECT * FROM read_parquet(${p})`, cleanup: none }
      case 'xlsx':
      case 'ods':
      case 'xml2003':
        return stageSheet(conn, s, ref, memo)
    }
    throw new Error(`Unsupported file format: ${s.format}`)
  }
  const db = ident(`db_${s.id}`)
  const r = ref ?? ''
  const dot = r.indexOf('.')
  if (s.kind === 'postgres' || s.kind === 'mysql') {
    const [schema, table] = dot > 0 ? [r.slice(0, dot), r.slice(dot + 1)] : [s.kind === 'mysql' ? (s.database ?? '') : 'public', r]
    return { select: `SELECT * FROM ${db}.${ident(schema)}.${ident(table)}`, cleanup: none }
  }
  if (s.kind === 'duckdb' && dot > 0) return { select: `SELECT * FROM ${db}.${ident(r.slice(0, dot))}.${ident(r.slice(dot + 1))}`, cleanup: none }
  return { select: `SELECT * FROM ${db}.${ident(r)}`, cleanup: none }
}

/** Loads one sheet table into a staging table with an appender; the caller copies it into the cache. */
async function stageSheet(conn: DuckDBConnection, s: ResolvedSource, ref: string | undefined, memo: Memo) {
  memo.book ??= (async () => {
    const st = await fs.stat(s.path!)
    if (st.size > MAX_SHEET_BYTES) throw new Error('The workbook is larger than 512 MB.')
    return readWorkbook(new Uint8Array(await fs.readFile(s.path!)), s.format as SheetFormat)
  })()
  const table = tableRows(await memo.book, ref, s.header !== false)
  if (!table.columns.length) throw new Error(`“${ref ?? 'The first sheet'}” is empty.`)
  const stage = `__stage_${process.pid}_${++stageSeq}`
  const q = `memory.main.${ident(stage)}`
  await conn.run(`CREATE TABLE ${q} (${table.columns.map((c) => `${ident(c.name)} ${c.type}`).join(', ')})`)
  const app = await conn.createAppender(stage, 'main', 'memory')
  try {
    for (let r = 0; r < table.rowCount; r++) {
      for (const c of table.columns) {
        const v = c.values[r]
        if (v === null) app.appendNull()
        else if (c.type === 'BOOLEAN') app.appendBoolean(v as boolean)
        else if (c.type === 'BIGINT') app.appendBigInt(BigInt(v as number))
        else if (c.type === 'DOUBLE') app.appendDouble(v as number)
        else if (c.type === 'DATE') app.appendDate(dateValue(v as number))
        else if (c.type === 'TIMESTAMP') app.appendTimestamp(timestampValue(BigInt(v as number) * 1000n))
        else app.appendVarchar(v as string)
      }
      app.endRow()
    }
    app.flushSync()
  } finally {
    app.closeSync()
  }
  return { select: `SELECT * FROM ${q}`, cleanup: async () => void (await conn.run(`DROP TABLE IF EXISTS ${q}`).catch(() => {})) }
}

// How each kind of source becomes a SELECT the refresh can materialize into the cache.
// Flat files use DuckDB's own readers; spreadsheets go through Simple Cell's readers and an appender; databases are
// read through their (read-only) attachment.

import { promises as fs } from 'node:fs'
import { dateValue, timestampValue, type DuckDBConnection } from '@duckdb/node-api'
import type { ResolvedSource } from '../shared/engine-protocol'
import { isServer, isRemotePath } from '../shared/project'
import { readArrow } from './arrow'
import { stageSqlServer } from './sqlserver'
import { decryptWorkbook, isEncryptedWorkbook } from './decrypt'
import { stageWarehouse } from './warehouses'
import { stageRedshift } from './redshift'
import { isSpreadsheetXml, xmlRecords, xmlTables } from '../core/xmlrows'
import { listTables } from '../core/sheets/rows'
import { readWorkbook, tableRows, type SheetFormat } from '../core/sheets/rows'
import type { Workbook } from '../core/sheets/model/workbook'
import { ident, lit } from './sql'

export interface Stat {
  size: number
  mtime: number
}

/** Size and modification time of a file-backed source (null for servers). */
export async function sourceStat(s: ResolvedSource): Promise<Stat | null> {
  if (!s.path || isServer(s.kind) || isRemotePath(s.path)) return null
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
      case 'arrow': {
        const bytes = isRemotePath(s.path) ? await readBytes(conn, s.path!) : await readLocal(s.path!)
        return stageColumns(conn, readArrow(bytes))
      }
      case 'xml2003': {
        // Excel's XML spreadsheet format, or any other XML: its repeated elements are the rows.
        const text = new TextDecoder().decode(isRemotePath(s.path) ? await readBytes(conn, s.path!) : await readLocal(s.path!))
        return isSpreadsheetXml(text) ? stageSheet(conn, s, ref, memo) : stageColumns(conn, xmlRecords(text, ref))
      }
      case 'xlsx':
      case 'xls':
      case 'xlsb':
      case 'ods':
        return stageSheet(conn, s, ref, memo)
    }
    throw new Error(`Unsupported file format: ${s.format}`)
  }
  if (s.kind === 'sqlserver') return stageSqlServer(conn, s, ref ?? '')
  if (s.kind === 'redshift') return stageRedshift(conn, s, ref ?? '')
  if (['clickhouse', 'trino', 'bigquery', 'snowflake', 'databricks'].includes(s.kind)) return stageWarehouse(conn, s, ref ?? '')
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
    const bytes = isRemotePath(s.path) ? await readBytes(conn, s.path!) : await readLocal(s.path!)
    return readWorkbook(isEncryptedWorkbook(bytes) ? decryptWorkbook(bytes, s.password) : bytes, s.format as SheetFormat)
  })()
  const table = tableRows(await memo.book, ref, s.header !== false)
  if (!table.columns.length) throw new Error(`“${ref ?? 'The first sheet'}” is empty.`)
  return stageColumns(conn, table)
}

async function readLocal(file: string) {
  const st = await fs.stat(file)
  if (st.size > MAX_SHEET_BYTES) throw new Error('The file is larger than 512 MB.')
  return new Uint8Array(await fs.readFile(file))
}

/** Typed columns (spreadsheet tables, Arrow files) into a staging table with an appender; the caller copies it on. */
async function stageColumns(conn: DuckDBConnection, table: { columns: { name: string; type: string; values: unknown[] }[]; rowCount: number }) {
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

/** A remote file's bytes, through DuckDB (so the same URL allow-list and credentials apply). */
export async function readBytes(conn: DuckDBConnection, url: string): Promise<Uint8Array> {
  const r = await conn.runAndReadAll(`SELECT size, content FROM read_blob(${lit(url)})`)
  const [size, content] = r.getRows()[0] ?? []
  if (Number(size) > MAX_SHEET_BYTES) throw new Error('The workbook is larger than 512 MB.')
  const b = content as { bytes?: Uint8Array } | Uint8Array | undefined
  if (!b) throw new Error(`Nothing was read from ${url}.`)
  return b instanceof Uint8Array ? b : (b.bytes ?? new Uint8Array())
}

/** The tables a file offers (sheet picker, connection dialog): sheets and named tables, or an XML file's records. */
export async function fileTables(bytes: Uint8Array, format: SheetFormat, password?: string) {
  if (isEncryptedWorkbook(bytes)) bytes = decryptWorkbook(bytes, password)
  if (format === 'xml2003') {
    const text = new TextDecoder().decode(bytes)
    if (!isSpreadsheetXml(text)) return xmlTables(text)
  }
  return listTables(readWorkbook(bytes, format))
}

// What file format adapters return: the workbook plus a list of compatibility notes.
import type { Workbook } from '../model/workbook'

export type FormatId = 'xlsx' | 'xlsm' | 'xltx' | 'xltm' | 'ods' | 'csv' | 'tsv' | 'json' | 'html' | 'xml' | 'xls' | 'xlsb'

export const FORMAT_LABELS: Record<FormatId, string> = {
  xlsx: 'Excel Workbook (.xlsx)',
  xlsm: 'Excel Macro-Enabled Workbook (.xlsm)',
  xltx: 'Excel Template (.xltx)',
  xltm: 'Excel Macro-Enabled Template (.xltm)',
  ods: 'OpenDocument Spreadsheet (.ods)',
  csv: 'CSV (comma separated)',
  tsv: 'Text (tab separated)',
  json: 'JSON',
  html: 'Web page (HTML table)',
  xml: 'XML Spreadsheet 2003',
  xls: 'Excel 97-2003 Workbook (.xls)',
  xlsb: 'Excel Binary Workbook (.xlsb)'
}

export interface FormatWarning {
  /** 'loss': something is dropped or simplified on save; 'info': kept but not editable, or a note. */
  level: 'info' | 'loss'
  message: string
  count?: number
}

export class Warnings {
  private map = new Map<string, FormatWarning>()
  add(level: FormatWarning['level'], message: string) {
    const w = this.map.get(message)
    if (w) w.count = (w.count ?? 1) + 1
    else this.map.set(message, { level, message })
  }
  get list(): FormatWarning[] {
    return [...this.map.values()]
  }
}

export interface ImportResult {
  workbook: Workbook
  warnings: FormatWarning[]
}

export interface ExportResult {
  data: Uint8Array
  warnings: FormatWarning[]
}

export function formatFromPath(name: string): FormatId | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'txt') return 'tsv'
  if (ext === 'htm') return 'html'
  return (Object.keys(FORMAT_LABELS) as FormatId[]).includes(ext as FormatId) ? (ext as FormatId) : null
}

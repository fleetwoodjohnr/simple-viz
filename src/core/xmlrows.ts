// Rows from an ordinary XML file (Excel's own XML spreadsheet format is read by the sheet readers instead). The record
// is the element that repeats most under one parent (or the one chosen); its attributes and simple child elements
// are the columns. DOCTYPEs are removed before parsing (no entities, no external references).
import { parseXml, elements, textOf, type El } from './sheets/formats/xml'
import type { ColumnType } from './sheets/rows'

export const isSpreadsheetXml = (text: string) => /urn:schemas-microsoft-com:office:spreadsheet/.test(text.slice(0, 4096))

interface Candidate {
  name: string
  items: El[]
}

/** Repeated elements, most frequent first (several parents with the same record name are pooled). */
export function xmlCandidates(doc: Document): Candidate[] {
  const byName = new Map<string, El[]>()
  const walk = (el: El, depth: number) => {
    if (depth > 64) return
    const kids = elements(el)
    const counts = new Map<string, number>()
    for (const k of kids) counts.set(k.localName, (counts.get(k.localName) ?? 0) + 1)
    for (const k of kids) {
      if ((counts.get(k.localName) ?? 0) > 1 || kids.length === 1) {
        if (!byName.has(k.localName)) byName.set(k.localName, [])
        byName.get(k.localName)!.push(k)
      }
      walk(k, depth + 1)
    }
  }
  if (doc.documentElement) walk(doc.documentElement as El, 0)
  return [...byName].map(([name, items]) => ({ name, items })).filter((c) => c.items.length > 1).sort((a, b) => b.items.length - a.items.length)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** The record elements a file offers, as the sheet picker lists tables (most frequent first, up to five). */
export function xmlTables(text: string): { ref: string; kind: 'table'; rows: number; columns: number }[] {
  return xmlCandidates(parseXml(text)).slice(0, 5).map((c) => ({ ref: c.name, kind: 'table' as const, rows: c.items.length, columns: xmlRecords(text, c.name).columns.length }))
}

/** Typed columns of the records (attributes first, then child elements, in order of first appearance). */
export function xmlRecords(text: string, record?: string): { record: string; columns: { name: string; type: ColumnType; values: (string | number | boolean | null)[] }[]; rowCount: number } {
  if (text.length > 100 * 1024 * 1024) throw new Error('The XML file is larger than 100 MB.')
  const doc = parseXml(text)
  const cands = xmlCandidates(doc)
  const c = record ? cands.find((x) => x.name === record) : cands[0]
  if (!c) throw new Error(record ? `There are no “${record}” elements in this XML file.` : 'No repeated elements were found in this XML file, so it has no rows.')
  const names: string[] = []
  const raw: Map<string, string>[] = c.items.map((el) => {
    const m = new Map<string, string>()
    const put = (k: string, v: string) => {
      let key = k
      for (let i = 2; m.has(key); i++) key = `${k}_${i}`
      if (!names.includes(key)) names.push(key)
      m.set(key, v)
    }
    for (let i = 0; i < el.attributes.length; i++) put(el.attributes[i].localName || el.attributes[i].name, el.attributes[i].value)
    const kids = elements(el)
    if (!kids.length) put('value', textOf(el).trim())
    for (const k of kids) {
      const grand = elements(k)
      // A nested element: its leaves as parent_child columns; deeper structure is kept as text.
      if (grand.length && grand.every((g) => !elements(g).length)) for (const g of grand) put(`${k.localName}_${g.localName}`, textOf(g).trim())
      else put(k.localName, textOf(k).trim())
      for (let i = 0; i < k.attributes.length; i++) put(`${k.localName}_${k.attributes[i].localName || k.attributes[i].name}`, k.attributes[i].value)
    }
    return m
  })
  const columns = names.map((name) => {
    const vals = raw.map((m) => (m.has(name) && m.get(name) !== '' ? m.get(name)! : null))
    const filled = vals.filter((v): v is string => v !== null)
    const all = (re: RegExp) => filled.length > 0 && filled.every((v) => re.test(v))
    const type: ColumnType = !filled.length ? 'VARCHAR' : all(/^(true|false)$/i) ? 'BOOLEAN' : all(/^[+-]?\d{1,15}$/) ? 'BIGINT' : all(NUM) ? 'DOUBLE' : all(DATE) ? 'DATE' : all(STAMP) ? 'TIMESTAMP' : 'VARCHAR'
    const conv = (v: string | null) => {
      if (v === null) return null
      switch (type) {
        case 'BOOLEAN':
          return /^true$/i.test(v)
        case 'BIGINT':
        case 'DOUBLE':
          return Number(v)
        case 'DATE':
          return Math.floor(Date.parse(`${v}T00:00:00Z`) / 86_400_000)
        case 'TIMESTAMP':
          return Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(v) ? v.replace(' ', 'T') : `${v.replace(' ', 'T')}Z`)
        default:
          return v
      }
    }
    return { name, type, values: vals.map(conv) }
  })
  return { record: c.name, columns, rowCount: c.items.length }
}

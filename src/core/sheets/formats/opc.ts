// Open Packaging Conventions: relationships, part names, content types.
import { text } from './zip'

export interface Rel {
  id: string
  type: string
  target: string
  external?: boolean
}

export const REL = {
  office: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  chartsheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet',
  sharedStrings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  table: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  drawing: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
  vml: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing',
  calcChain: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain',
  metadata: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata',
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  app: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  vba: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
  pivotCache: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition',
  externalLink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink'
}

export const CT = {
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  workbookMacro: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  template: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  templateMacro: 'application/vnd.ms-excel.template.macroEnabled.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  table: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
  metadata: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
}

const unescapeXml = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => (e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))))

export function relsPath(part: string): string {
  const i = part.lastIndexOf('/')
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`
}

export function parseRels(files: Record<string, Uint8Array>, part: string): Rel[] {
  const xml = text(files[relsPath(part)])
  const out: Rel[] = []
  for (const [tag] of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const get = (a: string) => new RegExp(`\\b${a}="([^"]*)"`).exec(tag)?.[1]
    const id = get('Id')
    const type = get('Type')
    const target = get('Target')
    if (id && type && target !== undefined) out.push({ id, type, target: unescapeXml(target), external: get('TargetMode') === 'External' })
  }
  return out
}

/** Resolve a relationship target relative to its source part. */
export function resolveTarget(source: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : ''
  const out: string[] = []
  for (const seg of (dir + target).split('/')) {
    if (seg === '..') out.pop()
    else if (seg !== '.' && seg !== '') out.push(seg)
  }
  return decodeURIComponent(out.join('/'))
}

export function relsXml(rels: Rel[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
    .map((r) => `<Relationship Id="${esc(r.id)}" Type="${esc(r.type)}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`
}

export function contentTypes(files: Record<string, Uint8Array>): { defaults: Record<string, string>; overrides: Record<string, string> } {
  const xml = text(files['[Content_Types].xml'])
  const defaults: Record<string, string> = {}
  const overrides: Record<string, string> = {}
  for (const [tag] of xml.matchAll(/<Default\b[^>]*>/g)) {
    const e = /Extension="([^"]*)"/.exec(tag)?.[1]
    const t = /ContentType="([^"]*)"/.exec(tag)?.[1]
    if (e && t) defaults[e.toLowerCase()] = t
  }
  for (const [tag] of xml.matchAll(/<Override\b[^>]*>/g)) {
    const p = /PartName="([^"]*)"/.exec(tag)?.[1]
    const t = /ContentType="([^"]*)"/.exec(tag)?.[1]
    if (p && t) overrides[decodeURIComponent(p.replace(/^\//, ''))] = t
  }
  return { defaults, overrides }
}

export function contentTypesXml(defaults: Record<string, string>, overrides: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${Object.entries(defaults)
    .map(([e, t]) => `<Default Extension="${esc(e)}" ContentType="${esc(t)}"/>`)
    .join('')}${Object.entries(overrides)
    .map(([p, t]) => `<Override PartName="/${esc(p)}" ContentType="${esc(t)}"/>`)
    .join('')}</Types>`
}

/** Parts no relationship leads to any more (OPC: every part is reached from the package relationships). */
export function unreachable(files: Record<string, Uint8Array>): string[] {
  const seen = new Set(['[Content_Types].xml'])
  const visit = (part: string) => {
    if (seen.has(part)) return
    if (part !== '' && !files[part]) return
    seen.add(part)
    const rels = part === '' ? '_rels/.rels' : relsPath(part)
    if (!files[rels]) return
    seen.add(rels)
    for (const r of parseRels(files, part)) if (!r.external) visit(resolveTarget(part, r.target))
  }
  visit('')
  return Object.keys(files).filter((p) => !seen.has(p))
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
}

export { unescapeXml }

/** Escape element text (quotes may stay as they are, as Excel writes them). */
export const escText = (s: string) => esc(s).replace(/&quot;/g, '"')

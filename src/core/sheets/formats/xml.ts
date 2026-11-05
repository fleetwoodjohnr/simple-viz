// XML helpers that run in the worker and in Node: xmldom for structured parts, and a fast scanner for big parts.
import { DOMParser as XDOMParser, XMLSerializer as XSerializer } from '@xmldom/xmldom'
import { unescapeXml } from './opc'

export type El = Element

/** Parse XML. DOCTYPE declarations are removed first (no entity expansion, no external entities). */
export function parseXml(text: string): Document {
  const safe = text.replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, '')
  return new XDOMParser({ onError: () => {} }).parseFromString(safe, 'text/xml') as unknown as Document
}

export function serialize(node: Node): string {
  return new XSerializer().serializeToString(node as never)
}

export function elements(el: Node | null | undefined): El[] {
  const out: El[] = []
  if (!el) return out
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as El)
  return out
}

/** Child elements by local name (namespace prefixes vary between producers). */
export const kids = (el: Node | null | undefined, name: string) => elements(el).filter((c) => c.localName === name)
export const kid = (el: Node | null | undefined, name: string): El | null => elements(el).find((c) => c.localName === name) ?? null
export function deep(el: Node | null | undefined, name: string, out: El[] = []): El[] {
  for (const c of elements(el)) {
    if (c.localName === name) out.push(c)
    deep(c, name, out)
  }
  return out
}

export function attr(el: El | null | undefined, name: string): string | null {
  if (!el) return null
  // Plain attribute first, then any namespaced attribute with that local name.
  if (el.hasAttribute(name)) return el.getAttribute(name)
  const a = el.attributes
  for (let i = 0; i < a.length; i++) {
    const it = a.item(i)!
    if (it.localName === name) return it.value
  }
  return null
}

export function numAttr(el: El | null | undefined, name: string): number | null {
  const v = attr(el, name)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function boolAttr(el: El | null | undefined, name: string, dflt = false): boolean {
  const v = attr(el, name)
  if (v === null) return dflt
  return v === '1' || v === 'true' || v === 'on'
}

export function textOf(el: Node | null | undefined): string {
  if (!el) return ''
  if (el.nodeType === 3 || el.nodeType === 4) return el.nodeValue ?? ''
  let s = ''
  for (let c = el.firstChild; c; c = c.nextSibling) s += textOf(c)
  return s
}

// ---------- fast scanning for large parts ----------

/** Attributes of a start tag string: `<c r="A1" s="2" t="s">` → {r, s, t}. */
export function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) out[m[1]] = unescapeXml(m[3] ?? m[4] ?? '')
  return out
}

/** Text of an element that holds only text (<v>, <t>, <f>), unescaped. */
export const xmlText = (s: string) => unescapeXml(s)

/** Top-level child elements of an element's inner XML, as raw strings with their local names (for preservation). */
export function topLevel(inner: string): { name: string; xml: string }[] {
  const out: { name: string; xml: string }[] = []
  let i = 0
  while (i < inner.length) {
    const lt = inner.indexOf('<', i)
    if (lt < 0) break
    if (inner.startsWith('<?', lt) || inner.startsWith('<!--', lt)) {
      const end = inner.startsWith('<!--', lt) ? inner.indexOf('-->', lt) + 3 : inner.indexOf('?>', lt) + 2
      i = end > 1 ? end : inner.length
      continue
    }
    const m = /^<([\w:.-]+)/.exec(inner.slice(lt, lt + 100))
    if (!m) {
      i = lt + 1
      continue
    }
    const qname = m[1]
    const name = qname.includes(':') ? qname.split(':')[1] : qname
    const gt = inner.indexOf('>', lt)
    if (inner[gt - 1] === '/') {
      out.push({ name, xml: inner.slice(lt, gt + 1) })
      i = gt + 1
      continue
    }
    // Find the matching close tag, counting nested elements of the same name.
    let depth = 1
    let j = gt + 1
    const openRe = new RegExp(`<${qname.replace('.', '\\.')}(?=[\\s>/])|</${qname.replace('.', '\\.')}>`, 'g')
    openRe.lastIndex = j
    let mm: RegExpExecArray | null
    while (depth > 0 && (mm = openRe.exec(inner))) {
      if (mm[0].startsWith('</')) depth--
      else {
        const close = inner.indexOf('>', mm.index)
        if (inner[close - 1] !== '/') depth++
      }
      j = openRe.lastIndex
    }
    out.push({ name, xml: inner.slice(lt, j) })
    i = j
  }
  return out
}

// Notes (legacy comments + their VML shapes) and hyperlinks in SpreadsheetML.
import type { Link, Note } from '../../model/workbook'
import { cellName, parseCell } from '../../refs'
import { esc, escText, type Rel } from '../opc'
import { attr, kid, kids, parseXml, serialize, textOf } from '../xml'

export const key = (r: number, c: number) => r * 16384 + c

export function readComments(xml: string): Map<number, Note> {
  const out = new Map<number, Note>()
  const doc = parseXml(xml)
  const authors = kids(kid(doc.documentElement, 'authors'), 'author').map((a) => textOf(a))
  for (const cm of kids(kid(doc.documentElement, 'commentList'), 'comment')) {
    const p = parseCell(attr(cm, 'ref') ?? '')
    if (!p) continue
    const t = kid(cm, 'text')
    const text = t ? [...(t.getElementsByTagName('*') as unknown as Element[])].filter((e) => e.localName === 't' && e.parentNode && (e.parentNode as Element).localName !== 'rPh').map((e) => e.textContent ?? '').join('') : ''
    out.set(key(p.r, p.c), { author: authors[Number(attr(cm, 'authorId') ?? 0)] ?? '', text, carry: t ? { text: serialize(t).replace(/ xmlns="[^"]*"/, ''), plain: text } : undefined })
  }
  return out
}

export const notesSig = (notes: Map<number, Note>) => JSON.stringify([...notes].sort((a, b) => a[0] - b[0]).map(([k, n]) => [k, n.author, n.text]))

export function commentsXml(notes: Map<number, Note>): string {
  const list = [...notes].sort((a, b) => a[0] - b[0])
  const authors = [...new Set(list.map(([, n]) => n.author))]
  const comments = list.map(([k, n]) => {
    const text = n.carry?.text && n.carry.plain === n.text ? n.carry.text : `<text><r><rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr><t xml:space="preserve">${escText(n.text)}</t></r></text>`
    return `<comment ref="${cellName(Math.floor(k / 16384), k % 16384)}" authorId="${authors.indexOf(n.author)}">${text}</comment>`
  })
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors>${authors.map((a) => `<author>${escText(a)}</author>`).join('')}</authors><commentList>${comments.join('')}</commentList></comments>`
}

/** The VML drawing for notes. Shapes that aren't notes (form controls) are kept from `previous`. */
export function vmlXml(notes: Map<number, Note>, previous?: string): string {
  const others = previous ? [...previous.matchAll(/<v:shape\b[\s\S]*?<\/v:shape>/g)].map((m) => m[0]).filter((s) => !/ObjectType="Note"/.test(s)) : []
  let id = 1025 + others.length
  const shapes = [...notes.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const r = Math.floor(k / 16384)
      const c = k % 16384
      return `<v:shape id="_x0000_s${id++}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${id - 1025};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${c + 1}, 15, ${Math.max(0, r - 1)}, 10, ${c + 3}, 15, ${r + 3}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${r}</x:Row><x:Column>${c}</x:Column></x:ClientData></v:shape>`
    })
  const head = previous ? (/^[\s\S]*?<v:shapetype\b[\s\S]*?<\/v:shapetype>/.exec(previous)?.[0] ?? null) : null
  const start =
    head ??
    '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'
  return start + others.join('') + shapes.join('') + '</xml>'
}

export const vmlHasShapes = (xml: string) => /<v:shape\b/.test(xml)

/** <hyperlinks> → links; external addresses come from the sheet's relationships. */
export function readHyperlinks(xml: string, rels: Rel[]): Map<number, Link> {
  const out = new Map<number, Link>()
  const doc = parseXml(`<w xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${xml}</w>`)
  for (const h of kids(doc.documentElement.firstChild as Element, 'hyperlink')) {
    const ref = attr(h, 'ref') ?? ''
    const [a, b] = ref.split(':')
    const p = parseCell(a)
    const q = b ? parseCell(b) : p
    if (!p || !q) continue
    const link: Link = {}
    const rid = h.getAttribute('r:id') ?? attr(h, 'id')
    const rel = rid ? rels.find((r) => r.id === rid) : undefined
    if (rel) link.url = rel.target
    if (attr(h, 'location')) link.location = attr(h, 'location')!
    if (attr(h, 'tooltip')) link.tooltip = attr(h, 'tooltip')!
    if (!link.url && !link.location) continue
    // ponytail: a link over a range is stored per cell (Excel writes one element for the range).
    for (let r = p.r; r <= q.r && r - p.r < 10_000; r++) for (let c = p.c; c <= q.c; c++) out.set(key(r, c), link)
  }
  return out
}

/** <hyperlinks> for the sheet; `rel(url)` adds an external relationship and returns its id. */
export function hyperlinksXml(links: Map<number, Link>, rel: (url: string) => string): string {
  if (!links.size) return ''
  const items = [...links]
    .sort((a, b) => a[0] - b[0])
    .map(([k, l]) => `<hyperlink ref="${cellName(Math.floor(k / 16384), k % 16384)}"${l.url ? ` r:id="${rel(l.url)}"` : ''}${l.location ? ` location="${esc(l.location)}"` : ''}${l.tooltip ? ` tooltip="${esc(l.tooltip)}"` : ''}/>`)
  return `<hyperlinks>${items.join('')}</hyperlinks>`
}

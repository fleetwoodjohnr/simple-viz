// JavaScript macros in files: XLSX keeps them in a customXml part, ODS in a private package entry.
import { escText, unescapeXml } from './opc'

export const MACRO_NS = 'urn:simple-cell:macros:1'

export function macrosXml(list: { name: string; code: string }[]): string {
  // CDATA can't hold "]]>": split it across sections.
  const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sc:macros xmlns:sc="${MACRO_NS}">${list.map((m) => `<sc:macro name="${escText(m.name).replace(/"/g, '&quot;')}">${cdata(m.code)}</sc:macro>`).join('')}</sc:macros>`
}

export function readMacros(xml: string): { name: string; code: string }[] | null {
  if (!xml.includes(MACRO_NS)) return null
  const out: { name: string; code: string }[] = []
  for (const m of xml.matchAll(/<sc:macro name="([^"]*)">([\s\S]*?)<\/sc:macro>/g)) {
    const code = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    out.push({ name: unescapeXml(m[1]), code })
  }
  return out
}

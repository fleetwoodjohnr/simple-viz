// OpenFormula (ODF) ⇄ Excel formula syntax.
//   of:=SUM([.A1:.B2];[$Other.C3])  ⇄  =SUM(A1:B2,Other!C3)
//   {1;2|3;4}                       ⇄  {1,2;3,4}
//   ~ (union) and ! (intersection)  ⇄  , and space
import { catalogEntry } from '../../engine/catalog'
import { quoteSheet } from '../../refs'

/** ODFF names that differ from Excel's. */
const ODF_TO_XL: Record<string, string> = {
  'LEGACY.CHIDIST': 'CHIDIST',
  'LEGACY.CHIINV': 'CHIINV',
  'LEGACY.CHITEST': 'CHITEST',
  'LEGACY.FDIST': 'FDIST',
  'LEGACY.FINV': 'FINV',
  'LEGACY.FTEST': 'FTEST',
  'LEGACY.NORMSDIST': 'NORMSDIST',
  'LEGACY.NORMSINV': 'NORMSINV',
  'LEGACY.TDIST': 'TDIST',
  'ERRORTYPE': 'ERROR.TYPE',
  'ORG.OPENOFFICE.ERRORTYPE': 'ERROR.TYPE',
  'CEILING.XCL': 'CEILING',
  'FLOOR.XCL': 'FLOOR',
  'MULTIPLE.OPERATIONS': 'TABLE'
}
const XL_TO_ODF: Record<string, string> = Object.fromEntries(Object.entries(ODF_TO_XL).filter(([k]) => !k.startsWith('ORG.')).map(([k, v]) => [v, k]))
delete XL_TO_ODF.TABLE

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (const ch of s) {
    if (ch === "'") q = !q
    if (ch === sep && !q) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** One ODF reference part: "$Sheet1.A1", ".A$1", "'My sheet'.B2", ".A" (column), ".3" (row). */
function refPart(p: string): { sheet: string | null; cell: string } {
  const dot = (() => {
    let q = false
    for (let i = p.length - 1; i >= 0; i--) {
      if (p[i] === "'") q = !q
      if (p[i] === '.' && !q) return i
    }
    return -1
  })()
  if (dot < 0) return { sheet: null, cell: p }
  let sheet: string | null = p.slice(0, dot).replace(/^\$/, '')
  if (sheet === '') sheet = null
  else if (sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'")
  return { sheet, cell: p.slice(dot + 1) }
}

/** The bracketed ODF reference (without brackets) in Excel A1 syntax. */
export function odfRefToA1(ref: string): string {
  if (/#REF!/i.test(ref)) return '#REF!'
  const parts = splitTopLevel(ref, ':').map(refPart)
  const s0 = parts[0].sheet
  const s1 = parts[1]?.sheet
  const prefix = s0 && s1 && s1 !== s0 ? `${quoteSheet(s0) === s0 && quoteSheet(s1) === s1 ? `${s0}:${s1}` : `'${(s0 + ':' + s1).replace(/'/g, "''")}'`}!` : s0 ? `${quoteSheet(s0)}!` : ''
  return prefix + parts.map((p) => p.cell).join(':')
}

/** "of:=SUM([.A1:.A3];1)" → "=SUM(A1:A3,1)". */
export function odfToExcel(formula: string): string {
  let f = formula.replace(/^(of|oooc|msoxl):/, '')
  if (!f.startsWith('=')) f = '=' + f
  let out = ''
  let i = 0
  let braces = 0
  while (i < f.length) {
    const ch = f[i]
    if (ch === '"') {
      const j = (() => {
        let k = i + 1
        while (k < f.length) {
          if (f[k] === '"') {
            if (f[k + 1] === '"') {
              k += 2
              continue
            }
            return k
          }
          k++
        }
        return f.length - 1
      })()
      out += f.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '[') {
      let j = i + 1
      let q = false
      while (j < f.length && (f[j] !== ']' || q)) {
        if (f[j] === "'") q = !q
        j++
      }
      out += odfRefToA1(f.slice(i + 1, j))
      i = j + 1
      continue
    }
    if (ch === '{') braces++
    if (ch === '}') braces--
    if (ch === ';') out += ','
    else if (ch === '|' && braces > 0) out += ';'
    else if (ch === '~') out += ','
    else if (ch === '!' && !/[\w']/.test(f[i - 1] ?? '')) out += ' '
    else out += ch
    i++
  }
  // Function names with prefixes or different names
  out = out.replace(/(^|[^\w.])((?:COM\.MICROSOFT\.|_xlfn\.)?[A-Z][A-Z0-9.]*)(?=\()/g, (_m, pre: string, name: string) => {
    const bare = name.replace(/^(COM\.MICROSOFT\.|_xlfn\.)/, '')
    return pre + (ODF_TO_XL[bare] ?? bare)
  })
  return out
}

/** Excel formula text (as printed by Simple Cell) → OpenFormula "of:=…". Sheet names are resolved by the printer. */
export function excelToOdf(formula: string): string {
  const f = formula.startsWith('=') ? formula.slice(1) : formula
  let out = ''
  let i = 0
  let braces = 0
  let parens = 0
  while (i < f.length) {
    const ch = f[i]
    if (ch === '"') {
      let j = i + 1
      while (j < f.length) {
        if (f[j] === '"') {
          if (f[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += f.slice(i, j + 1)
      i = j + 1
      continue
    }
    // References: [sheet!]A1[:B2], A:B, 1:3, 'My Sheet'!A1
    const m = /^(?:('(?:[^']|'')+'|[A-Za-z_][\w.]*)(?::('(?:[^']|'')+'|[A-Za-z_][\w.]*))?!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\w(])/.exec(f.slice(i))
    if (m && !/[\w.]/.test(f[i - 1] ?? '')) {
      const sheet = m[1] ? m[1].replace(/^'|'$/g, '').replace(/''/g, "'") : null
      const sheet2 = m[2] ? m[2].replace(/^'|'$/g, '').replace(/''/g, "'") : null
      const q = (s: string) => (/^[\w]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`)
      const [a, b] = m[3].split(':')
      const pa = sheet ? `$${q(sheet)}.${a}` : `.${a}`
      const pb = b === undefined ? '' : `:${sheet2 ? `$${q(sheet2)}.` : sheet ? `$${q(sheet)}.` : '.'}${b}`
      out += `[${pa}${pb}]`
      i += m[0].length
      continue
    }
    const fn = /^([A-Za-z_][\w.]*)\(/.exec(f.slice(i))
    if (fn && !/[\w.]/.test(f[i - 1] ?? '')) {
      const name = fn[1].toUpperCase()
      const e = catalogEntry(name)
      const odf = XL_TO_ODF[name] ?? (e && e.v && ['2016', '2019', '2021', '2024', 'Microsoft 365'].includes(e.v) ? `COM.MICROSOFT.${name}` : name)
      out += odf + '('
      parens++
      i += fn[0].length
      continue
    }
    if (ch === '{') braces++
    if (ch === '}') braces--
    if (ch === '(') parens++
    if (ch === ')') parens--
    if (ch === ',') out += braces > 0 ? ';' : ';'
    else if (ch === ';' && braces > 0) out += '|'
    else out += ch
    i++
  }
  return 'of:=' + out
}

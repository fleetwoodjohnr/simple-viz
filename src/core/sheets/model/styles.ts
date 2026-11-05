// Cell formatting. Styles are interned: cells store a small integer id, equal styles share one id.

export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double' | 'hair' | 'mediumDashed' | 'dashDot' | 'mediumDashDot' | 'dashDotDot' | 'mediumDashDotDot' | 'slantDashDot'

export interface BorderSide {
  style: BorderStyle
  color?: string
}

export interface Style {
  font?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: 'single' | 'double' | 'singleAccounting' | 'doubleAccounting'
  strike?: boolean
  vertAlign?: 'superscript' | 'subscript'
  color?: string
  /** Solid fill colour. Pattern fills keep their pattern and both colours. */
  fill?: string
  pattern?: { type: string; fg?: string; bg?: string }
  borderTop?: BorderSide
  borderBottom?: BorderSide
  borderLeft?: BorderSide
  borderRight?: BorderSide
  borderDiagUp?: BorderSide
  borderDiagDown?: BorderSide
  hAlign?: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed'
  vAlign?: 'top' | 'center' | 'bottom' | 'justify' | 'distributed'
  wrap?: boolean
  shrink?: boolean
  indent?: number
  /** Degrees, -90…90, or 255 for vertical stacked text (Excel's encoding). */
  rotation?: number
  /** Number format code, e.g. "0.00%" or "yyyy-mm-dd". Absent means General. */
  numFmt?: string
  locked?: boolean
  hiddenFormula?: boolean
  /** Theme colour references and other file-specific details, kept for round trips. */
  carry?: Record<string, unknown>
}

export class StyleTable {
  readonly list: Style[] = [{}]
  private index = new Map<string, number>([['{}', 0]])

  /** Id for this style, adding it if new. */
  intern(style: Style): number {
    const clean: Record<string, unknown> = {}
    for (const k of Object.keys(style).sort()) {
      const v = (style as Record<string, unknown>)[k]
      if (v !== undefined && v !== null && v !== false && !(k === 'numFmt' && v === 'General')) clean[k] = v
    }
    const key = JSON.stringify(clean)
    let id = this.index.get(key)
    if (id === undefined) {
      id = this.list.length
      this.list.push(clean as Style)
      this.index.set(key, id)
    }
    return id
  }

  get(id: number | undefined): Style {
    return this.list[id ?? 0] ?? this.list[0]
  }

  /** The id of `base` with `patch` applied. `undefined` in the patch removes a property. */
  derive(base: number | undefined, patch: Partial<Style>): number {
    const s: Style = { ...this.get(base) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (s as Record<string, unknown>)[k]
      else (s as Record<string, unknown>)[k] = v
    }
    return this.intern(s)
  }
}

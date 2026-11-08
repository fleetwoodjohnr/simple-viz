// Pieces every chart option shares: theme, axes, legend, grid, tooltips (data values escaped: data is untrusted).
import { type ChartData, type Theme, type Value, fmt, esc } from './data'

export type Option = Record<string, unknown>

export const isDateT = (t: string) => /^(DATE|TIMESTAMP)/.test(t)

export function base(t: Theme, d: ChartData): Option {
  return {
    backgroundColor: t.bg,
    color: t.palette,
    textStyle: { fontFamily: t.font, color: t.text2 },
    animation: t.motion !== false,
    animationDuration: 300,
    title: d.options.title ? { text: d.options.title, subtext: d.options.subtitle, left: 8, top: 4, textStyle: { color: t.text, fontSize: 14, fontWeight: 600 }, subtextStyle: { color: t.text2 } } : undefined,
    aria: { enabled: true, decal: { show: !!t.patterns } }
  }
}

export const axisStyle = (t: Theme) => ({ axisLine: { lineStyle: { color: t.axis } }, axisTick: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text2, hideOverlap: true }, splitLine: { lineStyle: { color: t.grid } }, nameTextStyle: { color: t.text2 } })

export function legend(d: ChartData, t: Theme, n: number): Option | undefined {
  const pos = d.options.legend ?? 'auto'
  if (pos === 'none' || (pos === 'auto' && n < 2)) return undefined
  const where = pos === 'auto' ? 'top' : pos
  return { type: 'scroll', [where === 'right' ? 'right' : 'left']: where === 'right' ? 4 : 'center', [where === 'bottom' ? 'bottom' : 'top']: where === 'right' ? 'middle' : d.options.title ? 34 : 4, orient: where === 'right' ? 'vertical' : 'horizontal', textStyle: { color: t.text2 }, pageTextStyle: { color: t.text2 } }
}

export function grid(d: ChartData, hasLegend: boolean): Option {
  const top = (d.options.title ? 40 : 12) + (hasLegend && (d.options.legend ?? 'auto') !== 'right' && d.options.legend !== 'bottom' ? 28 : 0)
  return { left: 12, right: d.options.legend === 'right' ? 140 : 20, top, bottom: d.options.legend === 'bottom' ? 40 : 12, containLabel: true }
}

/** Tooltip listing every field of the hovered row. */
export function rowTooltip(d: ChartData, t: Theme) {
  return {
    trigger: 'item',
    confine: true,
    backgroundColor: t.dark ? '#2a2a30' : '#ffffff',
    borderColor: t.axis,
    textStyle: { color: t.text, fontSize: 12 },
    formatter: (p: { data?: { row?: Value[] } ; marker?: string; seriesName?: string; name?: string; value?: unknown }) => {
      const row = p.data?.row
      if (!row) return `${p.marker ?? ''}${esc(String(p.seriesName ?? ''))}: ${esc(fmt(p.value as Value))}`
      return d.fields.map((f, i) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="opacity:.7">${esc(f.title)}</span><b>${esc(fmt(row[i], f))}</b></div>`).join('')
    }
  }
}

export const axisTooltip = (d: ChartData, t: Theme, valueField?: (seriesIndex: number) => ChartData['fields'][number] | undefined) => ({
  trigger: 'axis',
  confine: true,
  axisPointer: { type: 'shadow' },
  backgroundColor: t.dark ? '#2a2a30' : '#ffffff',
  borderColor: t.axis,
  textStyle: { color: t.text, fontSize: 12 },
  formatter: (all: { axisValueLabel: string; marker: string; seriesName: string; seriesId?: string; value: Value; seriesIndex: number }[]) => {
    const ps = all.filter((p) => !p.seriesId?.startsWith('fc-band') && !(p.seriesId?.startsWith('fc-line') && p.value === null))
    return `<div style="font-weight:600;margin-bottom:4px">${esc(all[0]?.axisValueLabel ?? '')}</div>` +
    ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.marker}${esc(p.seriesName)}</span><b>${esc(fmt(p.value, valueField?.(p.seriesIndex)))}</b></div>`).join('')
  }
})

/** Category axis labels: dates formatted at their grain, other values as text. */
export const catLabels = (d: ChartData, key: string | undefined, cats: Value[]) => {
  const f = key ? d.fields.find((x) => x.key === key) : undefined
  return cats.map((c) => fmt(c, f))
}


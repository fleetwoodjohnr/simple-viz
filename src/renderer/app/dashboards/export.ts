// Dashboard export. PDF: a copy of the dashboard at its design size, charts as high-resolution images, printed by
// Chromium on a page of exactly that size. PNG: the dashboard as shown. HTML: the same copy as one self-contained page
// (the app's styles inline, charts as images, no scripts).

import { toast } from '../../state/store'
import { setDash, getDash } from './runtime'
import type { Dashboard } from '@/shared/dashboards'
import { esc } from '@/core/charts/data'

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)))

/** Builds the print copy of a dashboard canvas; returns it and a cleanup function. */
export async function preparePrint(d: Dashboard, canvas: HTMLElement, dark: boolean, scale = 2): Promise<{ clone: HTMLElement; cleanup: () => void }> {
  const prevSel = getDash().selected
  setDash({ selected: [] })
  await nextFrame()
  const clone = canvas.cloneNode(true) as HTMLElement
  clone.style.transform = 'none'
  clone.style.boxShadow = 'none'
  clone.style.borderRadius = '0'
  clone.style.backgroundImage = 'none'
  clone.style.backgroundColor = d.background ?? 'var(--bg)'
  clone.removeAttribute('tabindex')
  const live = [...canvas.querySelectorAll<HTMLElement & { __echart?: { getDataURL(o: object): string } }>('[data-testid=echart]')]
  const copies = [...clone.querySelectorAll<HTMLElement>('[data-testid=echart]')]
  live.forEach((el, i) => {
    const chart = el.__echart
    if (!chart || !copies[i]) return
    const img = document.createElement('img')
    img.src = chart.getDataURL({ type: 'png', pixelRatio: scale, backgroundColor: dark ? '#18181b' : '#ffffff' })
    img.alt = el.getAttribute('aria-label') ?? ''
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
    copies[i].replaceWith(img)
  })
  const host = document.createElement('div')
  host.className = 'print-host'
  host.appendChild(clone)
  const style = document.createElement('style')
  style.textContent = `@page { size: ${d.size.w}px ${d.size.h}px; margin: 0 } @media print { .print-host { position: absolute; left: 0; top: 0; } }`
  document.head.appendChild(style)
  document.body.appendChild(host)
  // Let images decode before printing.
  await Promise.all([...host.querySelectorAll('img')].map((i) => i.decode().catch(() => {})))
  const cleanup = () => {
    host.remove()
    style.remove()
    setDash({ selected: prevSel })
  }
  return { clone, cleanup }
}

export async function exportDashboardPdf(d: Dashboard, canvas: HTMLElement | null, dark: boolean) {
  if (!canvas) return
  const path = await window.simpleViz.saveDialog(`${d.name}.pdf`, ['pdf'])
  if (!path) return
  const { cleanup } = await preparePrint(d, canvas, dark)
  try {
    const pdf = await window.simpleViz.exportPdf({ landscape: d.size.w > d.size.h })
    await window.simpleViz.writeFile(path, pdf)
    toast(`Exported ${path.split(/[\\/]/).pop()}`, 'success')
  } catch (e) {
    toast(`PDF export failed: ${(e as Error).message}`, 'error')
  } finally {
    cleanup()
  }
}

export async function exportDashboardPng(d: Dashboard, canvas: HTMLElement | null) {
  if (!canvas) return
  const path = await window.simpleViz.saveDialog(`${d.name}.png`, ['png'])
  if (!path) return
  setDash({ selected: [] })
  await nextFrame()
  const r = canvas.getBoundingClientRect()
  const png = await window.simpleViz.capturePage({ x: r.left, y: r.top, width: r.width, height: r.height }, Math.max(d.size.w, Math.round(r.width)) * 2)
  if (!png) return toast('Nothing could be captured. Make the window visible and try again.', 'error')
  await window.simpleViz.writeFile(path, png)
  toast(`Exported ${path.split(/[\\/]/).pop()}`, 'success')
}

export async function exportDashboardHtml(d: Dashboard, canvas: HTMLElement | null, dark: boolean) {
  if (!canvas) return
  const path = await window.simpleViz.saveDialog(`${d.name}.html`, ['html'])
  if (!path) return
  const { clone, cleanup } = await preparePrint(d, canvas, dark)
  try {
    const css = [...document.styleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join('\n')).join('\n')
    const html = `<!doctype html>\n<html lang="en"${dark ? ' class="dark"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(d.name)}</title><style>${css}\nbody{margin:0;padding:24px;overflow:auto;background:var(--panel-2)}</style></head><body>${clone.outerHTML}</body></html>\n`
    await window.simpleViz.writeFile(path, new TextEncoder().encode(html))
    toast(`Exported ${path.split(/[\\/]/).pop()}`, 'success')
  } catch (e) {
    toast(`HTML export failed: ${(e as Error).message}`, 'error')
  } finally {
    cleanup()
  }
}

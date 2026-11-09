// Background map tiles under a point map (when a tile server is set in Settings): the tiles covering the view, placed
// as images behind the points, redrawn as the map is panned and zoomed. Tiles come through the main process.
import type * as echarts from 'echarts/core'
import { mercator, unmercator, tilesFor } from '@/core/charts/geo'

const urls = new Map<string, string | null>()
const pending = new Set<string>()

export function tileLayer(chart: echarts.ECharts) {
  let on = false
  let shown: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const remove = (ids: string[]) => ids.map((id) => ({ id, $action: 'remove' as const }))
  const draw = () => {
    if (chart.isDisposed()) return
    if (!on) {
      if (shown.length) chart.setOption({ graphic: remove(shown) })
      shown = []
      return
    }
    // Point maps draw on a geo component; filled maps are a map series.
    const finder = (chart.getOption() as { geo?: unknown[] }).geo?.length ? { geoIndex: 0 } : { seriesIndex: 0 }
    const toPx = (lon: number, lat: number) => chart.convertToPixel(finder, [lon, lat]) as unknown as number[] | undefined
    const fromPx = (x: number, y: number) => chart.convertFromPixel(finder, [x, y]) as unknown as number[] | undefined
    const a = fromPx(0, 0)
    const b = fromPx(chart.getWidth(), chart.getHeight())
    const w0 = toPx(-180, 0)
    const w1 = toPx(180, 0)
    if (!a || !b || !w0 || !w1) return
    const [x0, y0] = mercator(a[0], a[1])
    const [x1, y1] = mercator(b[0], b[1])
    const { z, tiles } = tilesFor({ x0, y0, x1, y1 }, Math.abs(w1[0] - w0[0]))
    const els: Record<string, unknown>[] = []
    for (const t of tiles) {
      const key = `${z}/${t.x}/${t.y}`
      if (!urls.has(key)) {
        if (!pending.has(key)) {
          pending.add(key)
          window.simpleViz.mapTile(z, t.x, t.y).then(
            (r) => (urls.set(key, r ? URL.createObjectURL(new Blob([r.data as BlobPart], { type: r.type })) : null), pending.delete(key), schedule()),
            () => (urls.set(key, null), pending.delete(key))
          )
        }
        continue
      }
      const url = urls.get(key)
      if (!url) continue
      const n = 2 ** z
      const [lon0, lat0] = unmercator(t.x / n, t.y / n)
      const [lon1, lat1] = unmercator((t.x + 1) / n, (t.y + 1) / n)
      const p0 = toPx(lon0, lat0)
      const p1 = toPx(lon1, lat1)
      if (!p0 || !p1) continue
      els.push({ id: `tile:${key}`, type: 'image', x: p0[0], y: p0[1], z: -10, silent: true, style: { image: url, width: p1[0] - p0[0], height: p1[1] - p0[1] } })
    }
    const ids = new Set(els.map((e) => e.id as string))
    // The map's own graphics (its credit, the not-found count) are named in every update: ECharts would otherwise give
    // their places to new tiles.
    type G = { id?: string; elements?: G[] }
    const own = ((chart.getOption() as { graphic?: G[] }).graphic ?? [])
      .flatMap((g) => g.elements ?? [g])
      .map((e) => String(e.id ?? ''))
      .filter((id) => id && !id.startsWith('tile:'))
    chart.setOption({ graphic: [...own.map((id) => ({ id })), ...els, ...remove(shown.filter((id) => !ids.has(id)))] })
    shown = [...ids]
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(draw, 30)
  }
  chart.on('georoam', schedule)
  return {
    /** After every full redraw (which clears the graphics): tiles on or off. */
    set(enabled: boolean) {
      on = enabled
      shown = []
      schedule()
    },
    resize: schedule,
    dispose: () => clearTimeout(timer)
  }
}

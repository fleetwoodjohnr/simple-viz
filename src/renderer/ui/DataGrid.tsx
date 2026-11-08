// A virtualized, read-only table for query results and previews. Rows are fetched a page at a time as the user
// scrolls, so a ten-million-row result costs only the rows on screen. Values arrive JSON-safe from the engine.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnInfo } from '@/shared/engine-protocol'
import { cx } from './index'

type Value = string | number | boolean | null
const ROW = 28
const PAGE = 200

export interface GridSource {
  columns: ColumnInfo[]
  rowCount: number
  /** Rows already loaded, starting at row 0. */
  first: Value[][]
  /** Loads rows [offset, offset + limit). Absent when `first` holds every row. */
  fetch?: (offset: number, limit: number) => Promise<Value[][]>
}

const isNum = (t: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL|REAL)/.test(t)

export function typeLabel(t: string): string {
  if (isNum(t)) return /INT/.test(t) ? '123' : '1.2'
  if (/^(DATE|TIMESTAMP|TIME)/.test(t)) return /^DATE/.test(t) ? 'date' : 'time'
  if (t === 'BOOLEAN') return 'T/F'
  return 'Abc'
}

export function formatCell(v: Value, type: string): string {
  if (v === null) return ''
  if (typeof v === 'number') return isNum(type) && !/INT/.test(type) ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return v
}

export function DataGrid({ source, label, className }: { source: GridSource; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  const [, setTick] = useState(0)
  const pages = useRef(new Map<number, Value[][]>())
  const loading = useRef(new Set<number>())

  // Reset the cache when the source changes.
  useMemo(() => {
    pages.current = new Map()
    loading.current = new Set()
    for (let i = 0; i * PAGE < source.first.length; i++) pages.current.set(i, source.first.slice(i * PAGE, (i + 1) * PAGE))
  }, [source])

  const widths = useMemo(
    () =>
      source.columns.map((c, i) => {
        let w = Math.max(c.name.length * 7.5 + 44, 72)
        for (const r of source.first.slice(0, 50)) w = Math.max(w, formatCell(r[i], c.type).length * 7 + 20)
        return Math.min(Math.round(w), 360)
      }),
    [source]
  )
  const total = widths.reduce((a, b) => a + b, 0) + 56

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, height: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const firstRow = Math.max(0, Math.floor(scroll.top / ROW) - 10)
  const lastRow = Math.min(source.rowCount, Math.ceil((scroll.top + scroll.height) / ROW) + 10)

  useEffect(() => {
    if (!source.fetch) return
    for (let p = Math.floor(firstRow / PAGE); p * PAGE < lastRow; p++) {
      if (pages.current.has(p) || loading.current.has(p)) continue
      loading.current.add(p)
      void source.fetch(p * PAGE, PAGE).then(
        (rows) => {
          pages.current.set(p, rows)
          loading.current.delete(p)
          setTick((t) => t + 1)
        },
        () => loading.current.delete(p)
      )
    }
  }, [firstRow, lastRow, source])

  const rows: { i: number; r: Value[] | undefined }[] = []
  for (let i = firstRow; i < lastRow; i++) rows.push({ i, r: pages.current.get(Math.floor(i / PAGE))?.[i % PAGE] })

  return (
    <div
      ref={ref}
      role="grid"
      aria-label={label}
      aria-rowcount={source.rowCount + 1}
      aria-colcount={source.columns.length}
      tabIndex={0}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      className={cx('relative h-full overflow-auto bg-panel text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', className)}
      data-testid="data-grid"
    >
      <div style={{ width: total, height: (source.rowCount + 1) * ROW }} className="relative">
        <div role="row" aria-rowindex={1} className="sticky top-0 z-10 flex border-b border-border-strong bg-panel-2 font-medium" style={{ height: ROW, width: total }}>
          <div className="sticky left-0 z-10 w-14 shrink-0 border-r border-border bg-panel-2" aria-hidden="true" />
          {source.columns.map((c, i) => (
            <div key={c.name + i} role="columnheader" title={`${c.name} · ${c.type}`} className="flex shrink-0 items-center gap-1.5 border-r border-border px-2" style={{ width: widths[i] }}>
              <span className="shrink-0 rounded bg-hover px-1 font-mono text-[9.5px] text-text-2" aria-label={c.type}>
                {typeLabel(c.type)}
              </span>
              <span className="truncate">{c.name}</span>
            </div>
          ))}
        </div>
        {rows.map(({ i, r }) => (
          <div key={i} role="row" aria-rowindex={i + 2} className="absolute left-0 flex border-b border-border/70 hover:bg-hover" style={{ top: (i + 1) * ROW, height: ROW, width: total }}>
            <div className="sticky left-0 flex w-14 shrink-0 items-center justify-end border-r border-border bg-panel-2 pr-2 text-[11px] tabular-nums text-text-3" aria-hidden="true">
              {i + 1}
            </div>
            {source.columns.map((c, k) => {
              const v = r?.[k]
              return (
                <div key={k} role="gridcell" className={cx('select-text shrink-0 truncate border-r border-border/70 px-2 leading-[28px]', isNum(c.type) && 'text-right tabular-nums', v === null && 'italic text-text-3')} style={{ width: widths[k] }}>
                  {r === undefined ? <span className="inline-block h-2.5 w-2/3 rounded bg-hover align-middle" /> : v === null || v === undefined ? "null" : formatCell(v, c.type)}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

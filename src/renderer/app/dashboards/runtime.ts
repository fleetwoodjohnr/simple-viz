// Dashboard state that is not saved in the project: current filter selections, selected marks, drill-down levels,
// edit/view mode and presentation mode.
import { create } from 'zustand'
import type { Selections } from '@/shared/dashboards'
import type { MarkSelection } from '@/core/dashboard'

type Value = string | number | boolean | null

export interface Drill {
  level: number
  /** Values chosen at each level so far. */
  path: Value[]
}

interface Runtime {
  active: string | null
  /** A story being shown instead of a dashboard, and its current point. */
  story: string | null
  storyPoint: number
  mode: 'edit' | 'view'
  presenting: boolean
  selected: string[]
  /** Per dashboard. */
  selections: Record<string, Selections>
  marks: Record<string, MarkSelection[]>
  drill: Record<string, Record<string, Drill>>
}

export const useDash = create<Runtime>(() => ({ active: null, story: null, storyPoint: 0, mode: 'edit', presenting: false, selected: [], selections: {}, marks: {}, drill: {} }))
export const setDash = useDash.setState
export const getDash = useDash.getState

export const NO_SELECTIONS: Selections = {}
export const NO_MARKS: MarkSelection[] = []
export const NO_DRILL: Record<string, Drill> = {}

export function setSelection(dash: string, field: string, sel: Selections[string] | null) {
  setDash((s) => {
    const cur = { ...(s.selections[dash] ?? {}) }
    if (sel) cur[field] = sel
    else delete cur[field]
    return { selections: { ...s.selections, [dash]: cur } }
  })
}

export function resetFilters(dash: string) {
  setDash((s) => ({ selections: { ...s.selections, [dash]: {} }, marks: { ...s.marks, [dash]: [] }, drill: { ...s.drill, [dash]: {} } }))
}

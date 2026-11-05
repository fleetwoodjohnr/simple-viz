// The fields a chart can use: dataset columns and calculated fields, with their default role and aggregation.

import type { Agg, CalcField, DateGrain, FieldRef } from '@/shared/charts'
import type { ColumnInfo } from '@/shared/engine-protocol'
import { compileCalc } from '@/core/calc/compile'
import { isDate, isNumeric } from '@/core/query/compile'

export interface FieldDef {
  name: string
  type: string
  role: 'dim' | 'measure'
  calc?: CalcField
  /** For calcs: row-level, aggregate or table calculation (aggregates are always measures). */
  calcKind?: 'row' | 'aggregate' | 'tablecalc'
  error?: string
}

export function fieldDefs(columns: ColumnInfo[], calcs: CalcField[], calcTypes: Record<string, string>): FieldDef[] {
  const out: FieldDef[] = columns.map((c) => ({ name: c.name, type: c.type, role: isNumeric(c.type) && !/(^|_)(id|code|zip|year)$/i.test(c.name) ? 'measure' : 'dim' }))
  for (const c of calcs) {
    try {
      const k = compileCalc(c.formula, columns.map((x) => x.name), calcs, 'p').kind
      const type = calcTypes[c.name] ?? (k === 'row' ? 'VARCHAR' : 'DOUBLE')
      out.push({ name: c.name, type, role: k !== 'row' || isNumeric(type) ? 'measure' : 'dim', calc: c, calcKind: k })
    } catch (e) {
      out.push({ name: c.name, type: '?', role: 'measure', calc: c, error: (e as Error).message })
    }
  }
  return out
}

/** How a field lands on a shelf: measures get SUM (or nothing for aggregate calcs), dates a month grain. */
export function defaultRef(f: FieldDef, asMeasure?: boolean): FieldRef {
  if (f.calcKind === 'aggregate' || f.calcKind === 'tablecalc') return { field: f.name, agg: 'none' }
  if (asMeasure ?? f.role === 'measure') return { field: f.name, agg: isNumeric(f.type) ? 'sum' : 'countd' }
  if (isDate(f.type)) return { field: f.name, grain: 'month' as DateGrain }
  return { field: f.name }
}

export const AGGS: Agg[] = ['sum', 'avg', 'median', 'min', 'max', 'count', 'countd', 'stdev', 'var', 'p25', 'p75', 'p90']
export const GRAINS: DateGrain[] = ['year', 'quarter', 'month', 'week', 'day', 'exact']

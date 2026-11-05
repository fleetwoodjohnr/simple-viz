import { describe, it, expect } from 'vitest'
import { compileCalc, CalcError } from '@/core/calc/compile'
import { aggregateCalls, windowAgg } from '@/core/query/compile'

const cols = ['Sales', 'Profit', 'Region', 'Order Date', 'tags']
const c = (f: string, calcs: { name: string; formula: string }[] = []) => compileCalc(f, cols, calcs, 't')

describe('calculated field syntax', () => {
  it('resolves [Field] references and leaves DuckDB lists alone', () => {
    expect(c('[Sales] - [profit]').expr).toBe('"Sales" - "Profit"')
    expect(c('list_contains([1, 2, 3], 2)').expr).toBe('list_contains([1, 2, 3], 2)')
    expect(c("[Region] = '[not a field]'").expr).toBe(`"Region" = '[not a field]'`)
    expect(() => c('[Salez] * 2')).toThrow(/no field called \[Salez\]/)
  })

  it("turns Tableau's IF into CASE, keeps DuckDB's if()", () => {
    expect(c("IF [Sales] > 10 THEN 'big' ELSEIF [Sales] > 5 THEN 'mid' ELSE 'small' END").expr).toBe(`CASE WHEN "Sales" > 10 THEN 'big' WHEN "Sales" > 5 THEN 'mid' ELSE 'small' END`)
    expect(c("if([Sales] > 10, 'big', 'small')").expr).toBe(`if("Sales" > 10, 'big', 'small')`)
  })

  it('classifies row, aggregate and table calculations', () => {
    expect(c('[Sales] * 2').kind).toBe('row')
    expect(c('SUM([Profit]) / SUM([Sales])').kind).toBe('aggregate')
    expect(c('COUNTD([Region])').kind).toBe('aggregate')
    const t = c('SUM([Sales]) / TOTAL(SUM([Sales]))')
    expect(t.kind).toBe('tablecalc')
    expect(t.aggs.map((a) => a.expr)).toEqual(['SUM("Sales")'])
    expect(t.totals.map((a) => a.expr)).toEqual(['SUM("Sales")'])
    const w = c('WINDOW_AVG(SUM([Sales]), -2, 0)')
    expect(w.tcs[0]).toMatchObject({ fn: 'window_avg', nums: [-2, 0] })
    expect(c('FIRST()').kind).toBe('tablecalc')
    expect(c('first([Sales])').kind).toBe('aggregate')
  })

  it('parses level-of-detail expressions, not DuckDB structs', () => {
    const f = c('{FIXED [Region], [Order Date] : SUM([Sales])} / 2')
    expect(f.kind).toBe('row')
    expect(f.lods[0]).toMatchObject({ kind: 'fixed', dims: ['Region', 'Order Date'], agg: 'SUM("Sales")' })
    expect(f.expr).toBe('"__t_lod0" / 2')
    expect(c("{'a': 1}").expr).toBe("{'a': 1}")
    expect(c('{INCLUDE [Region]: AVG([Sales])}').lods[0].kind).toBe('include')
    expect(() => c('{FIXED [Region] : [Sales]}')).toThrow(/must aggregate/)
  })

  it('inlines other calculated fields and catches cycles', () => {
    const calcs = [{ name: 'Margin', formula: '[Profit] / [Sales]' }, { name: 'A', formula: '[B] + 1' }, { name: 'B', formula: '[A] + 1' }]
    expect(compileCalc('[Margin] * 100', cols, calcs).expr).toBe('("Profit" / "Sales") * 100')
    expect(() => compileCalc('[A]', cols, calcs)).toThrow(/refers to itself/)
  })

  it('skips comments and reports unbalanced text', () => {
    expect(c('[Sales] // Tableau comment\n+ 1 -- SQL comment').expr.replace(/\s+/g, ' ').trim()).toBe('"Sales" + 1')
    expect(() => c("'unterminated")).toThrow(CalcError)
    expect(() => c('SUM([Sales]')).not.toThrow() // left for DuckDB to report
  })
})

describe('query helpers', () => {
  it('finds outermost aggregate calls', () => {
    expect(aggregateCalls('sum("a") / count(DISTINCT "b") + max(coalesce("c", 0))').map((x) => x.text)).toEqual(['sum("a")', 'count(DISTINCT "b")', 'max(coalesce("c", 0))'])
  })
  it('turns aggregates into per-partition windows', () => {
    expect(windowAgg('SUM("Sales") / COUNTD("Region")', ['"Region"'])).toBe('SUM("Sales") OVER (PARTITION BY "Region") / count(DISTINCT "Region") OVER (PARTITION BY "Region")')
  })
})

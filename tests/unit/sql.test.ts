import { describe, it, expect } from 'vitest'
import { collectRefs, gateProblems, SAFE_TABLE_FUNCTIONS } from '@/core/sql/ast'
import { sqlParams, statementAt, paramValue } from '@/core/sql/text'
import { errorPosition, explainError } from '@/core/errors'

// Trimmed shapes of DuckDB's json_serialize_sql() output.
const base = (name: string, schema = '', catalog = '') => ({ type: 'BASE_TABLE', table_name: name, schema_name: schema, catalog_name: catalog })
const select = (from: unknown, extra: Record<string, unknown> = {}) => [{ node: { type: 'SELECT_NODE', cte_map: { map: [] }, select_list: [], from_table: from, ...extra } }]
const rules = { relations: new Set(['transactions', 'customers']), tableFunctions: SAFE_TABLE_FUNCTIONS }

describe('SQL gate rules', () => {
  it('allows known relations, CTEs and safe table functions', () => {
    expect(gateProblems(select(base('transactions')), rules)).toEqual([])
    expect(gateProblems(select({ type: 'JOIN', left: base('Transactions'), right: base('customers') }), rules)).toEqual([])
    const cte = select(base('t'), { cte_map: { map: [{ key: 't', value: { query: { node: { type: 'SELECT_NODE', from_table: base('transactions') } } } }] } })
    expect(gateProblems(cte, rules)).toEqual([])
    expect(gateProblems(select({ type: 'TABLE_FUNCTION', function: { class: 'FUNCTION', function_name: 'range' } }), rules)).toEqual([])
  })

  it('refuses files, unknown tables, qualified names and other table functions', () => {
    expect(gateProblems(select(base('/etc/passwd')), rules)[0]).toMatch(/file path/)
    expect(gateProblems(select(base('secrets')), rules)[0]).toMatch(/Unknown table “secrets”/)
    expect(gateProblems(select(base('__meta', 'main', 'cache')), rules)[0]).toMatch(/cache\.main\.__meta/)
    expect(gateProblems(select(base('tables', 'information_schema')), rules)).toHaveLength(1)
    expect(gateProblems(select({ type: 'TABLE_FUNCTION', function: { function_name: 'read_csv' } }), rules)[0]).toMatch(/read_csv/)
    // Deep inside an expression (scalar subquery) still counts.
    const nested = select(base('transactions'), { select_list: [{ class: 'SUBQUERY', subquery: { node: { type: 'SELECT_NODE', from_table: { type: 'TABLE_FUNCTION', function: { function_name: 'read_text' } } } } }] })
    expect(gateProblems(nested, rules)[0]).toMatch(/read_text/)
  })

  it('collects references for lineage', () => {
    const r = collectRefs(select({ type: 'JOIN', left: base('a'), right: { type: 'SUBQUERY', subquery: { node: { from_table: base('b') } } } }, { select_list: [{ class: 'FUNCTION', function_name: 'SUM' }] }))
    expect(r.tables.map((t) => t.name)).toEqual(['a', 'b'])
    expect(r.functions).toEqual(['sum'])
  })
})

describe('SQL text', () => {
  it('finds $parameters outside strings and comments', () => {
    expect(sqlParams("SELECT * FROM t WHERE a = $region AND b > $min -- $not\nAND c = '$nope' AND d = $region")).toEqual(['region', 'min'])
  })
  it('picks the statement at the cursor', () => {
    const sql = "SELECT 1;\nSELECT ';' AS x;\n\nSELECT 3"
    expect(statementAt(sql, 3).text).toBe('SELECT 1')
    expect(statementAt(sql, 14).text.trim()).toBe("SELECT ';' AS x")
    expect(statementAt(sql, sql.length).text.trim()).toBe('SELECT 3')
  })
  it('types parameter values', () => {
    expect([paramValue('12'), paramValue('-1.5'), paramValue('true'), paramValue(' '), paramValue('Virginia')]).toEqual([12, -1.5, true, null, 'Virginia'])
  })
})

describe('errors', () => {
  it('points at the error position', () => {
    const sql = 'SELECT a,\n  nope FROM t'
    const msg = 'Binder Error: Referenced column "nope" not found\n\nLINE 2:   nope FROM t\n          ^'
    expect(errorPosition(msg, sql)).toBe(sql.indexOf('nope'))
  })
  it('explains connection problems', () => {
    expect(explainError(new Error('IO Error: connection to server failed: FATAL:  password authentication failed for user "x"'))).toMatch(/rejected the user name or password/)
    expect(explainError(new Error('could not connect: Connection refused'), { host: 'db', port: 5432 })).toMatch(/Can’t reach db:5432/)
    expect(explainError(new Error("ENOENT: no such file or directory, stat '/x/Sales.xlsx'"), { path: '/x/Sales.xlsx' })).toMatch(/missing: \/x\/Sales.xlsx.*Relink/)
    expect(explainError(new Error('Binder Error: Table with name foo does not exist!'))).not.toMatch(/^Binder Error/)
  })
})

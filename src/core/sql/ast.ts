// Walks the JSON syntax tree DuckDB's json_serialize_sql() returns for a SELECT statement. One pass collects what the
// SQL gate, lineage and the calculation compiler need: table references, table functions, function calls, CTE names.
// The node shapes are not a documented contract, so the walk is generic (every object, every array) and the gate that
// uses it fails closed on anything it does not recognise.

export interface TableRef {
  catalog: string
  schema: string
  name: string
}

export interface SqlRefs {
  tables: TableRef[]
  tableFunctions: string[]
  functions: string[]
  ctes: string[]
  /** Node types seen for table references (BASE_TABLE, JOIN, SUBQUERY, TABLE_FUNCTION, …). */
  refTypes: string[]
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** `ast`: the `statements` of json_serialize_sql's result (any JSON). */
export function collectRefs(ast: unknown): SqlRefs {
  const out: SqlRefs = { tables: [], tableFunctions: [], functions: [], ctes: [], refTypes: [] }
  const visit = (n: Json) => {
    if (Array.isArray(n)) return n.forEach(visit)
    if (!n || typeof n !== 'object') return
    const type = typeof n.type === 'string' ? n.type : ''
    if (type === 'BASE_TABLE') {
      out.tables.push({ catalog: str(n.catalog_name), schema: str(n.schema_name), name: str(n.table_name) })
      out.refTypes.push(type)
    } else if (type === 'TABLE_FUNCTION') {
      const fn = n.function as { function_name?: Json } | null
      out.tableFunctions.push(str(fn?.function_name).toLowerCase())
      out.refTypes.push(type)
    } else if (['JOIN', 'SUBQUERY', 'EMPTY', 'EXPRESSION_LIST', 'PIVOT', 'SHOW_REF', 'COLUMN_DATA', 'DELIM_GET'].includes(type)) {
      out.refTypes.push(type)
    }
    if (n.class === 'FUNCTION' && typeof n.function_name === 'string') out.functions.push(n.function_name.toLowerCase())
    // CTE definitions: { cte_map: { map: [{ key: 'name', value: {...} }] } }
    const map = (n.cte_map as { map?: Json } | undefined)?.map
    if (Array.isArray(map)) for (const e of map) if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.key === 'string') out.ctes.push(e.key.toLowerCase())
    for (const k in n) visit(n[k])
  }
  visit(ast as Json)
  return out
}

const str = (v: Json | undefined) => (typeof v === 'string' ? v : '')

export interface GateRules {
  /** Relation names user SQL may read (lower case): source aliases and datasets. */
  relations: Set<string>
  /** Table functions allowed in user SQL (lower case). */
  tableFunctions: Set<string>
}

export const SAFE_TABLE_FUNCTIONS = new Set(['range', 'generate_series', 'unnest'])

/** Problems with a parsed SELECT under the rules; empty when it may run. */
export function gateProblems(ast: unknown, rules: GateRules): string[] {
  const refs = collectRefs(ast)
  const problems: string[] = []
  const ctes = new Set(refs.ctes)
  for (const t of refs.tables) {
    const name = t.name.toLowerCase()
    const qualified = (t.catalog && t.catalog.toLowerCase() !== 'memory') || (t.schema && t.schema.toLowerCase() !== 'main')
    if (qualified || (!rules.relations.has(name) && !ctes.has(name))) {
      const shown = [t.catalog, t.schema, t.name].filter(Boolean).join('.')
      problems.push(/[./\\]/.test(t.name) ? `“${t.name}” is a file path. Add the file as a data source, then query it by its name.` : `Unknown table “${shown}”.`)
    }
  }
  for (const f of refs.tableFunctions) if (!rules.tableFunctions.has(f)) problems.push(`The table function ${f}() isn’t available here. Add files and databases as data sources instead.`)
  return [...new Set(problems)]
}

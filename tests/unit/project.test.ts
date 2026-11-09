import { describe, it, expect } from 'vitest'
import { newProject, packProject, unpackProject, migrate } from '@/core/project/sviz'
import { PROJECT_SCHEMA_VERSION, toAlias, DEFAULT_REFRESH } from '@/shared/project'
import { checkRendererRequest } from '@/shared/engine-protocol'
import { zipSync, strToU8 } from 'fflate'

describe('.sviz project files', () => {
  it('round-trips a project and never stores credentials', () => {
    const p = { ...newProject('Sales'), sources: [{ id: 'a', kind: 'postgres' as const, name: 'db', host: 'h', port: 5432, database: 'd', user: 'u', mode: 'extract' as const, timeoutSec: 30, tables: [{ alias: 'customers', ref: 'public.customers' }], refresh: DEFAULT_REFRESH }], datasets: [{ id: 'd1', name: 'enriched', sql: 'SELECT 1' }] }
    const bytes = packProject(p)
    const { project } = unpackProject(bytes)
    expect(project).toEqual(p)
    expect(new TextDecoder().decode(bytes)).not.toMatch(/password/i)
  })
  it('refuses other files and newer versions with a clear message', () => {
    expect(() => unpackProject(zipSync({ mimetype: strToU8('application/x-other'), 'project.json': strToU8('{}') }))).toThrow(/not a Simple Viz project/)
    expect(() => unpackProject(strToU8('plain text'))).toThrow(/not a valid package/)
    expect(() => migrate({ schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toThrow(/newer version/)
  })
  it('fills defaults for missing fields', () => {
    const p = migrate({ schemaVersion: 1, id: 'x', sources: [{ id: 's', kind: 'file', tables: [] }] })
    expect(p.sources[0].refresh).toEqual(DEFAULT_REFRESH)
    expect(p.datasets).toEqual([])
  })

  it('keeps stories, role-playing tables and sets; drops malformed story points', () => {
    const p = migrate({
      schemaVersion: 1,
      id: 'x',
      stories: [{ id: 's', name: 'Story', points: [{ id: 'a', dashboard: 'd1', caption: 'First' }, { id: 'b', dashboard: 'd1', caption: 'Texas', selections: { region: { values: ['Texas'] } }, marks: [{ item: 'i1', values: { segment: 'Consumer' } }, { bad: 1 }] }, { caption: 'no dashboard' }] }, { name: 'no id' }],
      models: [{ id: 'm', name: 'M', tables: [{ name: 'origin', source: 'regions', x: 0, y: 0 }], relationships: [] }],
      calcs: [{ id: 'c', dataset: 'sales', name: 'region (set)', formula: "'Out'", set: { field: 'region', values: ['Texas'] } }]
    })
    expect(p.stories).toEqual([{ id: 's', name: 'Story', points: [{ id: 'a', dashboard: 'd1', caption: 'First' }, { id: 'b', dashboard: 'd1', caption: 'Texas', selections: { region: { values: ['Texas'] } }, marks: [{ item: 'i1', values: { segment: 'Consumer' } }] }] }])
    expect(unpackProject(packProject(p)).project.models[0].tables[0].source).toBe('regions')
    expect(unpackProject(packProject(p)).project.calcs[0].set).toEqual({ field: 'region', values: ['Texas'] })
  })
})

describe('names', () => {
  it('turns file and sheet names into SQL names', () => {
    expect(toAlias('Sales Transactions 2024')).toBe('sales_transactions_2024')
    expect(toAlias('2024 Q1')).toBe('t_2024_q1')
    expect(toAlias('Café-Umsätze')).toBe('cafe_umsatze')
    expect(toAlias('***')).toBe('data')
  })
})

describe('engine port validation', () => {
  it('accepts well-formed requests only', () => {
    expect(checkRendererRequest({ id: 1, op: 'query', sql: 'SELECT 1', params: { a: 1, b: 'x', c: null } })).toBeTruthy()
    expect(() => checkRendererRequest({ id: 1, op: 'boot' })).toThrow()
    expect(() => checkRendererRequest({ id: -1, op: 'query', sql: 'x' })).toThrow()
    expect(() => checkRendererRequest({ id: 1, op: 'query', sql: 'x', params: { 'bad name': 1 } })).toThrow()
    expect(() => checkRendererRequest({ id: 1, op: 'query', sql: 'x', params: { a: {} } })).toThrow()
    expect(() => checkRendererRequest({ id: 1, op: 'page', resultId: 'r1', offset: -5, limit: 10 })).toThrow()
  })
})

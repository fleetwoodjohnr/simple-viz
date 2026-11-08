// The SQL editor beyond running a query: completion from the schema, formatting, the plan, history, saved queries
// (kept in the project file), and export to CSV and Excel.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, tempDir, setSql, stubDialogs, MOD } from './helpers'
import { readWorkbook, tableRows } from '../../src/core/sheets/rows'

test('completion, format, plan, history, saved queries, export', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const { app, page } = await launch()
  await salesProject(app, page, dir)
  await page.getByTestId('nav-sql').click()
  const editor = page.locator('.cm-content')

  // Completion offers the project's tables and their columns.
  await setSql(page, '')
  await editor.click()
  await page.keyboard.type('select * from sales_enr')
  await page.locator('.cm-tooltip-autocomplete li', { hasText: 'sales_enriched' }).first().click()
  await expect(editor).toContainText('select * from sales_enriched')

  // Format: keywords upper-cased, one clause per line.
  await setSql(page, 'select region, sum(revenue) as revenue from sales_enriched group by region order by 2 desc')
  await page.getByRole('button', { name: 'Format' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__svEditor.state.doc.toString())).toMatch(/^SELECT\n\s+region,[\s\S]*FROM\n\s+sales_enriched[\s\S]*GROUP BY/)

  // Run, then the plan.
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-rowcount')).toContainText('6')
  await page.getByTestId('sql-explain').click()
  await expect(page.getByTestId('sql-plan')).toContainText(/hash_group_by|projection|order_by/i)

  // History lists what ran; picking it puts it back in the editor.
  await page.getByRole('tab', { name: /History/ }).click()
  await expect(page.getByTestId('sql-history')).toContainText('sales_enriched')
  await setSql(page, 'SELECT 1')
  await page.getByTestId('sql-history').getByRole('button').first().click()
  await expect.poll(() => page.evaluate(() => (window as any).__svEditor.state.doc.toString())).toContain('GROUP BY')

  // A saved query is part of the project.
  await page.getByRole('button', { name: 'Save query' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Revenue by region')
  await page.getByRole('dialog').getByLabel('Name').press('Enter')
  await page.getByRole('tab', { name: /Saved/ }).click()
  await expect(page.getByLabel('Schema, saved queries and history').getByText('Revenue by region')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__sv.get().project.queries.map((q: any) => q.name))).toEqual(['Revenue by region'])

  // Export the result: CSV and Excel.
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-rowcount')).toContainText('6')
  for (const [fmt, label] of [['csv', 'CSV'], ['xlsx', 'Excel workbook (.xlsx)']] as const) {
    const out = path.join(dir, `result.${fmt}`)
    await stubDialogs(app, { save: out })
    await page.getByTestId('sql-export').click()
    await page.getByRole('menuitem', { name: label }).click()
    await expect.poll(() => existsSync(out)).toBe(true)
  }
  const csv = readFileSync(path.join(dir, 'result.csv'), 'utf8').trim().split('\n')
  expect(csv[0]).toBe('region,revenue')
  expect(csv).toHaveLength(7)
  const t = tableRows(readWorkbook(new Uint8Array(readFileSync(path.join(dir, 'result.xlsx'))), 'xlsx'), undefined, true)
  expect(t.rowCount).toBe(6)
  expect(t.columns.map((c) => [c.name, c.type])).toEqual([['region', 'VARCHAR'], ['revenue', 'DOUBLE']])
  void MOD
  await quit(app)
})

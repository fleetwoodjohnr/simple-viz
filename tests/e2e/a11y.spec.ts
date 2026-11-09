// Accessibility: axe-core's WCAG 2.2 A/AA rules on every workspace (with real content: a chart, a dashboard, an
// analysis result) and every dialog, in the light and the dark theme.
import { type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, launch, quit, salesProject, tempDir, waitForUiSettled } from './helpers'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function violations(page: Page, label: string) {
  await waitForUiSettled(page)
  const r = await new AxeBuilder({ page }).setLegacyMode(true).withTags(TAGS).analyze()
  return r.violations.map((v) => `${label}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length}×: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')})`)
}

const DIALOGS: [string, Record<string, unknown>][] = [
  ...['appearance', 'data', 'backup', 'privacy', 'keyboard', 'about'].map((section): [string, Record<string, unknown>] => [`Settings ${section}`, { kind: 'settings', section }]),
  ['Keyboard shortcuts', { kind: 'shortcuts' }],
  ['About', { kind: 'about' }],
  ['Command palette', { kind: 'palette' }],
  ['Connect to PostgreSQL', { kind: 'connect-db', kind2: 'postgres' }],
  ['Connect to MySQL', { kind: 'connect-db', kind2: 'mysql' }],
  ['Connect to SQL Server', { kind: 'connect-db', kind2: 'sqlserver' }],
  ['Web or cloud file', { kind: 'connect-remote' }],
  ['Relink', { kind: 'relink', sourceId: '$source' }],
  ['Message', { kind: 'message', title: 'Done', body: 'Something happened.' }],
  ['Prompt', { kind: 'prompt', title: 'Name', label: 'Dataset name', value: 'sales', resolve: '$fn' }],
  ['Unsaved changes', { kind: 'confirm-close', then: 'close' }]
]

async function audit(theme: 'light' | 'dark') {
  const { app, page } = await launch({ settings: { theme } })
  // The theme is applied after the first paint: audit once it is (a slow machine was caught mid-switch).
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  await page.waitForTimeout(300)
  const found: string[] = []
  found.push(...(await violations(page, `${theme} Home (empty)`)))
  await salesProject(app, page, tempDir())

  // A chart and a dashboard with it.
  await page.getByTestId('nav-charts').click()
  await page.getByTestId('new-chart-empty').click()
  await page.getByTestId('chart-dataset').selectOption('sales_enriched')
  for (const [field, shelf] of [['region', 'x'], ['revenue', 'y']]) {
    await page.getByTestId(`field-${field}`).hover()
    await page.getByTestId(`field-menu-${field}`).click()
    await page.getByTestId(`add-to-${shelf}`).click()
  }
  await expect(page.getByTestId('chart-canvas').locator('[data-chart-state=ready]')).toBeVisible()
  found.push(...(await violations(page, `${theme} Charts`)))
  // The chart as a table: one row per region, then back to the chart.
  await page.getByTestId('chart-canvas').hover()
  await page.getByTestId('chart-as-table').click()
  await expect(page.getByTestId('chart-canvas').getByTestId('data-grid').getByRole('row')).toHaveCount(7)
  found.push(...(await violations(page, `${theme} Chart as a table`)))
  await page.getByTestId('chart-as-table').click()
  await expect(page.getByTestId('chart-canvas').locator('[data-testid=echart]')).toBeVisible()
  await page.getByTestId('nav-dashboards').click()
  await page.getByTestId('new-dashboard-empty').click()
  await page.locator('[data-testid^=palette-chart-]').first().click()
  await expect(page.locator('[data-testid=item-chart]')).toHaveCount(1)
  found.push(...(await violations(page, `${theme} Dashboards`)))

  await page.getByTestId('nav-data').click()
  await page.getByTestId('relation-sales_enriched').click()
  found.push(...(await violations(page, `${theme} Data`)))
  await page.getByTestId('nav-sql').click()
  found.push(...(await violations(page, `${theme} SQL`)))
  await page.getByTestId('nav-analytics').click()
  await page.getByTestId('analysis-dataset').selectOption('sales_enriched')
  await page.getByTestId('analysis-columns').getByText('revenue', { exact: true }).click()
  await page.getByTestId('analysis-run').click()
  await expect(page.getByTestId('analysis-result')).toBeVisible()
  found.push(...(await violations(page, `${theme} Analytics`)))

  for (const [name, d] of DIALOGS) {
    await page.evaluate((d) => {
      const sv = (window as any).__sv
      const fill: Record<string, unknown> = { $source: sv.get().project.sources[0].id, $fn: () => {} }
      sv.set({ dialog: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' && v in fill ? fill[v] : v])) })
    }, d)
    await expect(page.getByRole('dialog')).toBeVisible()
    found.push(...(await violations(page, `${theme} dialog ${name}`)))
    await page.evaluate(() => (window as any).__sv.set({ dialog: null }))
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await quit(app)
  return found
}

for (const theme of ['light', 'dark'] as const) {
  test(`no WCAG 2.2 AA violations: every workspace and dialog, ${theme}`, async () => {
    test.setTimeout(240_000)
    expect(await audit(theme)).toEqual([])
  })
}

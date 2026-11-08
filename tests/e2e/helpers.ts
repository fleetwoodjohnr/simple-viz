import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const open = new Set<ElectronApplication>()

/**
 * Specs use this `test`: after every test, an app it left running (it failed before quitting) is killed. Otherwise
 * Playwright's own teardown asks the app to close, the app asks about unsaved changes, and the worker hangs.
 */
export const test = base.extend<{ cleanup: void }>({
  cleanup: [
    async ({}, use) => {
      await use()
      for (const a of open) a.process().kill('SIGKILL')
      open.clear()
    },
    { auto: true }
  ]
})
export { expect } from '@playwright/test'

export interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
}

export const fixture = (name: string) => path.resolve('tests', 'fixtures', name)

export function tempDir(prefix = 'sv-e2e-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

export async function launch(opts: { userData?: string; settings?: Record<string, unknown>; env?: Record<string, string>; args?: string[] } = {}): Promise<Launched> {
  const userData = opts.userData ?? tempDir('sv-profile-')
  mkdirSync(userData, { recursive: true })
  if (opts.settings) writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(opts.settings))
  // SV_PACKAGED=path/to/binary runs the suite against an electron-builder output instead of the dev build.
  const packaged = process.env.SV_PACKAGED
  // Update checks go to a closed local port unless a test serves a feed: tests never contact GitHub.
  const app = await electron.launch({ ...(packaged ? { executablePath: packaged, args: opts.args ?? [] } : { args: ['.', ...(opts.args ?? [])] }), env: { ...process.env, SV_UPDATE_URL: 'http://127.0.0.1:9', ...opts.env, SIMPLE_VIZ_USER_DATA: userData } })
  if (process.env.SV_DEBUG) {
    app.process().stdout?.on('data', (d) => process.stdout.write(`main: ${d}`))
    app.process().stderr?.on('data', (d) => process.stdout.write(`main! ${d}`))
  } else if (process.env.CI) {
    // On CI, engine events (exits, errors) go into the test log: a failure there can't be rerun with SV_DEBUG.
    app.process().stderr?.on('data', (d) => open.has(app) && String(d).split('\n').filter((l) => /\[engine\]|terminate called/.test(l)).forEach((l) => process.stdout.write(`main! ${l}\n`)))
  }
  open.add(app)
  const page = await app.firstWindow()
  // Charts honour reduced motion: without animations, marks are where a click expects them.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) violations.push(m.text())
    if (m.type() === 'error' && process.env.SV_DEBUG) console.log('renderer:', m.text())
  })
  page.on('pageerror', (e) => errors.get(app)?.push(e.message))
  cspViolations.set(app, violations)
  errors.set(app, [])
  // Bounded by the test's timeout: a first launch under Rosetta takes minutes.
  await page.waitForSelector('[data-testid=home], [data-testid=data-view]', { timeout: 0 })
  return { app, page, userData }
}

const cspViolations = new WeakMap<ElectronApplication, string[]>()
const errors = new WeakMap<ElectronApplication, string[]>()

/** Replace native dialogs in the main process with fixed answers. Lists answer successive dialogs. */
export async function stubDialogs(app: ElectronApplication, d: { save?: string | string[]; open?: string[] | string[][]; message?: number }) {
  await app.evaluate(({ dialog }, d) => {
    const saves = d.save === undefined ? undefined : [d.save].flat()
    if (saves) dialog.showSaveDialog = (async () => ({ canceled: false, filePath: saves.length > 1 ? saves.shift() : saves[0] })) as never
    if (d.open !== undefined) {
      const opens = (Array.isArray(d.open[0]) ? d.open : [d.open]) as string[][]
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: opens.length > 1 ? opens.shift() : opens[0] })) as never
    }
    if (d.message !== undefined) dialog.showMessageBox = (async () => ({ response: d.message, checkboxChecked: false })) as never
  }, d)
}

/** Every test fails on a Content-Security-Policy violation or an uncaught renderer error. */
export async function quit(app: ElectronApplication) {
  open.delete(app)
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  const v = cspViolations.get(app)
  if (v?.length) throw new Error(`CSP violations:\n${v.join('\n')}`)
  const e = errors.get(app)
  if (e?.length) throw new Error(`Renderer errors:\n${e.join('\n')}`)
}

const mac = process.platform === 'darwin'
export const MOD = mac ? 'Meta' : 'Control'

/** Runs SQL through the engine port from the page, returning rows as objects. */
export async function sql(page: Page, text: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (text) => {
    const r = await (window as any).__sv.E.query(text, { limit: 10000 })
    return r.rows.map((row: unknown[]) => Object.fromEntries(r.columns.map((c: { name: string }, i: number) => [c.name, row[i]])))
  }, text)
}

/** Types into the SQL editor (replacing its text). */
export async function setSql(page: Page, text: string) {
  await page.evaluate((text) => {
    const v = (window as any).__svEditor
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
  }, text)
}

export async function waitForUiSettled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    const animations = document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})))
  })
}

export const SALES_SQL = `SELECT t.order_id, t.order_date, t.customer_id, c.region, c.segment, t.product_name, t.revenue, t.cost,
  t.revenue - t.cost AS profit,
  CASE WHEN t.revenue >= 10000 THEN 'High Value' WHEN t.revenue >= 5000 THEN 'Medium Value' ELSE 'Low Value' END AS customer_segment
FROM transactions t LEFT JOIN customers c ON t.customer_id = c.customer_id`

/** A project with Sales.xlsx (copied to `dir`), customers.csv and the dataset sales_enriched, set up through the UI. */
export async function salesProject(app: ElectronApplication, page: Page, dir: string) {
  const { copyFileSync } = await import('node:fs')
  const sales = path.join(dir, 'Sales.xlsx')
  const customers = path.join(dir, 'customers.csv')
  copyFileSync(fixture('Sales.xlsx'), sales)
  copyFileSync(fixture('customers.csv'), customers)
  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [sales, customers] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  await page.getByTestId('relation-customers').waitFor()
  await page.evaluate((sql) => (window as any).__sv.P.saveDataset({ name: 'sales_enriched', sql }), SALES_SQL)
  await page.waitForFunction(() => (window as any).__sv.get().relations.some((r: { name: string }) => r.name === 'sales_enriched'))
  return { sales, customers }
}

/** The data ECharts is drawing: series name → values, in category order, plus the category labels. */
export async function chartSeries(page: Page, scope = page.getByTestId('chart-canvas')) {
  await scope.locator('[data-chart-state=ready]').first().waitFor()
  return scope.locator('[data-testid=echart]').first().evaluate((el) => {
    const opt = (el as any).__echart.getOption()
    const cat = [opt.xAxis?.[0], opt.yAxis?.[0]].find((a: any) => a?.type === 'category')
    return { categories: (cat?.data ?? []) as string[], series: Object.fromEntries(opt.series.map((s: any) => [s.name, s.data.map((d: any) => (d && typeof d === 'object' && 'value' in d ? d.value : d))])) as Record<string, number[]> }
  })
}

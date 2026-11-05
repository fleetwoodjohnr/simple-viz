import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
  }
  const page = await app.firstWindow()
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) violations.push(m.text())
    if (m.type() === 'error' && process.env.SV_DEBUG) console.log('renderer:', m.text())
  })
  page.on('pageerror', (e) => errors.get(app)?.push(e.message))
  cspViolations.set(app, violations)
  errors.set(app, [])
  await page.waitForSelector('[data-testid=home], [data-testid=data-view]')
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

// A project's life outside one session: opened on another computer (it asks before reading sources), files moved
// (relink), and unsaved work after a crash (recovery).
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, salesProject, tempDir, stubDialogs, messagesShown, MOD } from './helpers'

async function savedProject(dir: string) {
  const { app, page, userData } = await launch()
  await salesProject(app, page, dir)
  const file = path.join(dir, 'sales.sviz')
  await stubDialogs(app, { save: file })
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await quit(app)
  return { file, userData }
}

test('a project from elsewhere asks before reading its sources; refused sources stay unloaded', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const { file } = await savedProject(dir)
  // Another computer (a fresh profile): refuse.
  let other = await launch()
  await stubDialogs(other.app, { open: [file], message: 1 })
  await other.page.evaluate(() => (window as any).__sv.runCommand('file.open'))
  await expect(other.page.getByText('was not allowed, so its data isn’t loaded').first()).toBeVisible()
  const asked = await messagesShown(other.app)
  expect(asked[0].message).toBe('Allow this project to read these data sources?')
  expect(asked[0].detail).toContain(path.join(dir, 'Sales.xlsx'))
  expect(await other.page.evaluate(() => (window as any).__sv.get().relations.map((r: any) => r.name))).not.toContain('transactions')
  await quit(other.app)
  // Allow: the data loads, and it isn't asked again on the next open.
  other = await launch()
  await stubDialogs(other.app, { open: [file], message: 0 })
  await other.page.evaluate(() => (window as any).__sv.runCommand('file.open'))
  await other.page.getByTestId('relation-transactions').click()
  await expect(other.page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 })
  expect(await messagesShown(other.app)).toHaveLength(1)
  await quit(other.app)
})

test('a moved workbook is found again with the relink dialog', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const { file, userData } = await savedProject(dir)
  mkdirSync(path.join(dir, 'moved'))
  renameSync(path.join(dir, 'Sales.xlsx'), path.join(dir, 'moved', 'Sales.xlsx'))
  const { app, page } = await launch({ userData })
  await page.getByTestId('recent-card').first().click()
  // The last good copy still shows; the refresh status says the file is missing and offers to find it.
  await expect(page.getByTestId('refresh-status')).toHaveAttribute('data-state-summary', 'error')
  await page.getByTestId('refresh-status').click()
  await page.getByTestId('relink-source').click()
  await stubDialogs(app, { open: [path.join(dir, 'moved', 'Sales.xlsx')], message: 0 })
  await page.getByRole('dialog').getByRole('button', { name: 'Find file…' }).click()
  // The source now reads the moved file, and its refresh succeeds (the rows alone would show from the cache).
  await expect.poll(() => page.evaluate(() => (window as any).__sv.get().project.sources.find((s: any) => s.format === 'xlsx').path)).toBe(path.join(dir, 'moved', 'Sales.xlsx'))
  await expect(page.getByTestId('refresh-status')).toHaveAttribute('data-state-summary', 'ok')
  await expect(page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 })
  void file
  await quit(app)
})

test('unsaved work comes back after a crash', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  copyFileSync(path.resolve('tests/fixtures/customers.csv'), path.join(dir, 'customers.csv'))
  const { app, page, userData } = await launch({ settings: { recoveryIntervalSec: 1 } })
  await page.getByTestId('new-project').click()
  await stubDialogs(app, { open: [path.join(dir, 'customers.csv')] })
  await page.getByTestId('add-data').click()
  await page.getByTestId('add-file').click()
  await page.getByTestId('relation-customers').waitFor()
  await expect.poll(() => (existsSync(path.join(userData, 'recovery')) ? readdirSync(path.join(userData, 'recovery')).length : 0), { timeout: 15_000 }).toBe(1)
  // Kill the app with its child processes: Windows doesn't end the children with the main process, and while they
  // live they hold the single-instance lock, so a new instance hands over to them and quits.
  const gone = new Promise((r) => app.process().once('exit', r))
  if (process.platform === 'win32') execSync(`taskkill /pid ${app.process().pid} /T /F`, { stdio: 'ignore' })
  else app.process().kill('SIGKILL')
  await gone
  await new Promise((r) => setTimeout(r, 1500))
  const again = await launch({ userData })
  await expect(again.page.getByTestId('recovery')).toBeVisible({ timeout: 20_000 }) // a cold start of the packaged app on Windows is slow
  await again.page.getByTestId('recovery').getByRole('button', { name: 'Restore' }).click()
  await again.page.getByTestId('relation-customers').click()
  await expect(again.page.getByTestId('relation-rows')).toHaveText('120 rows', { timeout: 20_000 })
  await quit(again.app)
})

test('a portable copy carries its data to a computer without the sources', async () => {
  test.setTimeout(180_000)
  const dir = tempDir()
  const { app, page } = await launch()
  await salesProject(app, page, dir)
  const pkg = path.join(tempDir(), 'sales (with data).sviz')
  await stubDialogs(app, { save: pkg })
  await page.evaluate(() => (window as any).__sv.runCommand('file.savePortable'))
  await expect(page.getByText(/Saved a portable copy with the data of 2 tables/)).toBeVisible()
  await quit(app)
  // Another computer: the workbook and the CSV aren't there.
  rmSync(path.join(dir, 'Sales.xlsx'))
  rmSync(path.join(dir, 'customers.csv'))
  const other = await launch()
  await stubDialogs(other.app, { open: [pkg], message: 0 })
  await other.page.evaluate(() => (window as any).__sv.runCommand('file.open'))
  await other.page.getByTestId('relation-sales_enriched').click()
  await expect(other.page.getByTestId('relation-rows')).toHaveText('1,000 rows', { timeout: 20_000 })
  // The sources can't be read here: the packaged data is shown as the last good data.
  await expect(other.page.getByTestId('refresh-status')).toHaveAttribute('data-state-summary', 'error')
  await quit(other.app)
})

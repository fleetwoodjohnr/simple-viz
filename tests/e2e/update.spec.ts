import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launch, quit, tempDir } from './helpers'

// On Linux an unpacked build counts as an AppImage, and electron-updater's AppImage updater stays off unless
// APPIMAGE names the running image: point it at a stand-in file (the test never installs).
const linuxAppImage = (): Record<string, string> => {
  if (process.platform !== 'linux') return {}
  const file = path.join(tempDir(), 'simple-viz.AppImage')
  writeFileSync(file, '')
  return { APPIMAGE: file }
}

// The updater against a local release feed. Packaged builds only: development builds never check.
test.skip(!process.env.SV_PACKAGED, 'set SV_PACKAGED to the packaged executable')

test('update check: offers the newer version, downloads and verifies it, then offers a restart', async () => {
  // A release 99.0.0 with one file per installer type; each platform's updater picks its own.
  const payload = randomBytes(4096)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const files = ['AppImage', 'deb', 'rpm', 'exe', 'zip'].map((ext) => `  - url: simple-viz-99.0.0.${ext}\n    sha512: ${sha512}\n    size: ${payload.length}`)
  const feed = `version: 99.0.0\nfiles:\n${files.join('\n')}\npath: simple-viz-99.0.0.zip\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`
  const server = createServer((req, res) => {
    const name = (req.url ?? '').split('?')[0].slice(1)
    if (/^latest(-linux|-mac)?\.yml$/.test(name)) return void res.end(feed)
    if (/^simple-viz-99\.0\.0\.\w+$/.test(name)) return void res.end(payload)
    res.statusCode = 404 // e.g. the NSIS blockmap: the updater falls back to a full download
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { app, page } = await launch({ settings: { updateCheck: false }, env: { SV_UPDATE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...linuxAppImage() } })
  try {
    // Answer the native prompts: Install, then Later (so the window stays open); record what was shown.
    await app.evaluate(({ dialog, shell }) => {
      const log: string[] = []
      ;(globalThis as { svLog?: string[] }).svLog = log
      dialog.showMessageBox = (async (...args: { message: string; buttons?: string[] }[]) => {
        const o = args[args.length - 1]
        log.push(o.message)
        return { response: o.buttons?.[0] === 'Restart now' ? 1 : 0, checkboxChecked: false }
      }) as never
      shell.openExternal = (async (url: string) => void log.push(`open ${url}`)) as never
    })
    await page.evaluate(() => window.simpleViz.checkForUpdates())
    const log = await app.evaluate(() => (globalThis as { svLog?: string[] }).svLog)
    expect(log?.[0]).toBe('Simple Viz 99.0.0 is available')
    // macOS: unsigned builds can't self-update, so the release page opens instead.
    expect(log?.[1]).toBe(process.platform === 'darwin' ? 'open https://github.com/fleetwoodjohnr/simple-viz/releases/tag/v99.0.0' : 'Simple Viz 99.0.0 is ready to install')
  } finally {
    await quit(app)
    server.close()
  }
})

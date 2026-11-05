import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as store from './store'

// Updates come from the GitHub releases named in electron-builder.yml (`publish`). Nothing is downloaded until the user
// clicks Install; downloads are checked against the sha512 in the release's latest*.yml.
const RELEASES = 'https://github.com/fleetwoodjohnr/simple-viz/releases'
const DAY = 24 * 60 * 60 * 1000
const isMac = process.platform === 'darwin'

let configured = false
let busy = false
let restartForUpdate = false

function updater() {
  if (!configured) {
    configured = true
    autoUpdater.autoDownload = false
    // Packaged E2E tests point the updater at a local feed (loopback only); a test update is never installed on quit.
    const feed = process.env.SV_UPDATE_URL
    if (feed?.startsWith('http://127.0.0.1:')) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed })
      autoUpdater.autoInstallOnAppQuit = false
    }
  }
  return autoUpdater
}

const OFFLINE = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH']

/**
 * What to tell the user about a failed check or download. electron-updater's messages carry the whole HTTP response
 * (headers, cookies, page), so they are never shown. null: GitHub has no published release, so nothing is newer.
 * electron-updater 6.8 wraps a failed /releases/latest lookup (no published release, or offline at that step) in
 * ERR_UPDATER_INVALID_RELEASE_FEED; only the text of the wrapped error tells which, so that is what is matched.
 */
export function updateErrorMessage(e: unknown): string | null {
  const { code, statusCode, message = '' } = (e ?? {}) as { code?: string; statusCode?: number; message?: string }
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || /production release exists: HttpError: 40[46]\b/.test(message)) return null
  if (OFFLINE.includes(code ?? '') || /net::ERR_|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)\b/.test(message)) {
    return 'Couldn’t reach GitHub. Check your internet connection, then try again.'
  }
  if (statusCode === 403 || statusCode === 429 || /HttpError: 4(03|29)\b/.test(message)) return 'GitHub is limiting update checks right now. Try again in an hour.'
  if (code === 'ERR_CHECKSUM_MISMATCH') return 'The download was incomplete or damaged, so nothing was installed. Try again.'
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'The newest release has no update information for this system. Download it from the releases page instead.'
  return 'Something went wrong while updating. Try again later, or download the newest version from the releases page.'
}

/** Asks GitHub for a newer version. A manual check always reports the outcome; the automatic one speaks only if there is an update. */
export async function checkForUpdates(win: BrowserWindow | null, manual: boolean): Promise<void> {
  const box = (o: MessageBoxOptions) => (win && !win.isDestroyed() ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o))
  if (!app.isPackaged) {
    if (manual) await box({ type: 'info', message: 'Updates are checked in installed builds only', detail: 'This is a development build.' })
    return
  }
  if (busy) return
  busy = true
  let report = manual
  try {
    const result = await updater().checkForUpdates()
    const info = result?.isUpdateAvailable ? result.updateInfo : null
    if (!info) {
      if (manual) await box({ type: 'info', message: 'Simple Viz is up to date', detail: `Version ${app.getVersion()}` })
      return
    }
    // macOS only applies updates to apps with a Developer ID signature, and ours are signed ad hoc: download by hand.
    const { response } = await box({
      type: 'info',
      message: `Simple Viz ${info.version} is available`,
      detail: `You have version ${app.getVersion()}.${isMac ? ' The download page opens in your browser.' : ''}`,
      buttons: [isMac ? 'Download' : 'Install', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return
    report = true
    if (isMac) return void (await shell.openExternal(`${RELEASES}/tag/v${info.version}`))
    await updater().downloadUpdate()
    const ready = await box({
      type: 'info',
      message: `Simple Viz ${info.version} is ready to install`,
      detail: 'Restart now, or it installs the next time you quit Simple Viz.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (ready.response === 0) {
      // Closing the window runs the usual unsaved-documents check; window-all-closed then installs.
      restartForUpdate = true
      win?.close()
    }
  } catch (e) {
    console.error('Update failed:', e)
    if (!report) return
    const detail = updateErrorMessage(e)
    if (detail === null) return void (await box({ type: 'info', message: 'Simple Viz is up to date', detail: `Version ${app.getVersion()}. No newer version has been published.` }))
    const { response } = await box({ type: 'error', message: 'Couldn’t update Simple Viz', detail, buttons: ['Open download page', 'OK'], defaultId: 1, cancelId: 1 })
    if (response === 0) await shell.openExternal(RELEASES)
  } finally {
    busy = false
  }
}

/** Called once the window has closed: installs a downloaded update and relaunches. False if there is nothing to install. */
export function installIfRequested(): boolean {
  if (!restartForUpdate) return false
  updater().quitAndInstall(true, true)
  return true
}

/** The automatic check: shortly after startup, at most once a day, unless turned off in Settings → Updates. */
export function scheduleUpdateCheck(win: () => BrowserWindow | null) {
  if (!app.isPackaged) return
  setTimeout(async () => {
    const s = await store.getSettings()
    if (!s.updateCheck || Date.now() - s.lastUpdateCheck < DAY) return
    await store.setSettings({ lastUpdateCheck: Date.now() })
    await checkForUpdates(win(), false)
  }, 10_000)
}

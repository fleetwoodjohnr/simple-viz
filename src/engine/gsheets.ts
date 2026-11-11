// Google Sheets: the spreadsheet is fetched as an Excel workbook (Google's own export) and read like any workbook.
// Shared by link ("anyone with the link can view"): no sign-in. Private: a service account's key (kept in the
// keychain) that the spreadsheet is shared with, exchanged for a read-only Drive token. No interactive Google sign-in.
import type { ResolvedSource } from '../shared/engine-protocol'
import { googleAuth } from './warehouses'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const sheetId = (url: string) => /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(url)?.[1] ?? null

/** Tests point this at a stand-in on this computer; anything else is ignored. */
const standIn = () => (/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SV_GOOGLE_API ?? '') ? process.env.SV_GOOGLE_API! : null)

export async function fetchGoogleSheet(s: ResolvedSource): Promise<Uint8Array> {
  const id = sheetId(s.path ?? '')
  if (!id) throw new Error('That isn’t a Google Sheets address. Copy it from the browser: https://docs.google.com/spreadsheets/d/…')
  const key = (s.password ?? '').trim()
  const signal = AbortSignal.timeout(Math.max(5, s.timeoutSec) * 6000)
  // ponytail: Drive's export stops at 10 MB of workbook; larger private sheets need the Sheets API, page by page.
  const url = key ? `${standIn() ?? 'https://www.googleapis.com'}/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(XLSX)}` : `${standIn() ?? 'https://docs.google.com'}/spreadsheets/d/${id}/export?format=xlsx`
  const res = await fetch(url, { headers: key ? await googleAuth(key, 'https://www.googleapis.com/auth/drive.readonly', 'Google Sheets', signal) : {}, signal })
  const bytes = new Uint8Array(await res.arrayBuffer())
  // A workbook is a zip ("PK"); a sign-in page or an error is not.
  if (res.ok && bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes
  if (!key) throw new Error('Google Sheets: the spreadsheet isn’t shared by link. In Google Sheets choose Share → “Anyone with the link”, or add a service account’s key here and share the spreadsheet with that account.')
  let account = 'the service account'
  try {
    account = (JSON.parse(key) as { client_email?: string }).client_email ?? account
  } catch {
    // an access token
  }
  if (res.status === 401) throw new Error('Google Sheets: authentication failed (the key or token was refused).')
  if (res.status === 403 || res.status === 404) throw new Error(`Google Sheets: ${account} can’t open this spreadsheet. Share it with that address (Viewer), and check that the Google Drive API is enabled for its project.`)
  throw new Error(`Google Sheets: the spreadsheet couldn’t be downloaded (HTTP ${res.status}).`)
}

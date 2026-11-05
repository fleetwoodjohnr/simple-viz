// Database passwords, encrypted with the OS keychain (macOS Keychain, Windows DPAPI, libsecret/KWallet on Linux) through
// Electron's safeStorage and kept in userData/credentials.json. Never in project files, never in the renderer.
// Without a real keychain (Linux "basic_text"), passwords are kept for this session only.

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './store'

const file = () => path.join(app.getPath('userData'), 'credentials.json')
const session = new Map<string, string>()
const validId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id)

export function backend(): { backend: string; secure: boolean } {
  const b = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'darwin' ? 'keychain' : 'dpapi'
  return { backend: b, secure: safeStorage.isEncryptionAvailable() && b !== 'basic_text' && b !== 'unknown' }
}

async function readAll(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export async function setPassword(id: string, password: string | null): Promise<void> {
  if (!validId(id)) throw new Error('Invalid source id')
  const all = await readAll()
  session.delete(id)
  delete all[id]
  if (password !== null) {
    if (backend().secure) all[id] = safeStorage.encryptString(password).toString('base64')
    else session.set(id, password)
  }
  await atomicWrite(file(), JSON.stringify(all))
}

export async function getPassword(id: string): Promise<string | undefined> {
  if (session.has(id)) return session.get(id)
  const enc = (await readAll())[id]
  if (!enc || !backend().secure) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

// Downloads the DuckDB extensions Simple Viz bundles (they are never downloaded at runtime) into
// resources/duckdb-ext/<os>-<arch>/ (electron-builder's names: linux, mac, win), checked against the SHA-256 pinned in
// duckdb-extensions.lock.json. electron-builder.yml copies the folder for the platform it packages.
//
//   node scripts/fetch-duckdb-extensions.ts                 this machine's platform
//   node scripts/fetch-duckdb-extensions.ts mac x64         another platform (CI packages macOS Intel on Apple silicon)
//   node scripts/fetch-duckdb-extensions.ts --update-lock   pin new hashes after a DuckDB upgrade (review the diff)

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'

export const EXTENSIONS = ['postgres_scanner', 'sqlite_scanner', 'mysql_scanner', 'httpfs', 'azure', 'odbc_scanner']
const PLATFORMS: Record<string, string> = {
  'linux-x64': 'linux_amd64',
  'linux-arm64': 'linux_arm64',
  'mac-x64': 'osx_amd64',
  'mac-arm64': 'osx_arm64',
  'win-x64': 'windows_amd64',
  'win-arm64': 'windows_arm64'
}
export const OS_NAMES: Record<string, string> = { linux: 'linux', darwin: 'mac', win32: 'win' }

const root = path.resolve(import.meta.dirname, '..')
const lockFile = path.join(root, 'scripts', 'duckdb-extensions.lock.json')

function duckdbVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', '@duckdb', 'node-bindings', 'package.json'), 'utf8')) as { version: string }
  return `v${pkg.version.replace(/-.*$/, '')}`
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const update = process.argv.includes('--update-lock')
  const key = `${args[0] ?? OS_NAMES[process.platform]}-${args[1] ?? process.arch}`
  const platform = PLATFORMS[key]
  if (!platform) throw new Error(`No DuckDB extensions for ${key}`)
  const version = duckdbVersion()
  const lock = (existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {}) as Record<string, string>
  const dir = path.join(root, 'resources', 'duckdb-ext', key)
  mkdirSync(dir, { recursive: true })
  for (const ext of EXTENSIONS) {
    const id = `${version}/${platform}/${ext}`
    const target = path.join(dir, `${ext}.duckdb_extension`)
    if (existsSync(target) && lock[id] === sha256(readFileSync(target))) {
      console.log(`ok   ${id}`)
      continue
    }
    const url = `https://extensions.duckdb.org/${version}/${platform}/${ext}.duckdb_extension.gz`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    const bytes = gunzipSync(new Uint8Array(await res.arrayBuffer()))
    const hash = sha256(bytes)
    if (lock[id] && lock[id] !== hash) throw new Error(`${id}: SHA-256 ${hash} does not match the pinned ${lock[id]}`)
    if (!lock[id]) {
      if (!update) throw new Error(`${id} is not pinned in ${path.relative(root, lockFile)}. Run with --update-lock and commit the change.`)
      lock[id] = hash
    }
    writeFileSync(target, bytes)
    console.log(`got  ${id} (${(bytes.length / 1e6).toFixed(1)} MB)`)
  }
  if (update) writeFileSync(lockFile, JSON.stringify(Object.fromEntries(Object.entries(lock).sort()), null, 2) + '\n')
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

await main()

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dump, load } from 'js-yaml'
import { draftRelease, validateArtifacts, validateTag } from '../../scripts/release'

const version = '0.1.0'
const platforms = {
  'latest.yml': ['Simple-Viz-Setup-0.1.0.exe'],
  'latest-linux.yml': ['Simple-Viz-0.1.0.AppImage', 'simple-viz_0.1.0_amd64.deb', 'simple-viz-0.1.0.x86_64.rpm'],
  'latest-mac.yml': ['Simple-Viz-0.1.0.dmg', 'Simple-Viz-0.1.0-arm64.dmg', 'Simple-Viz-0.1.0-mac.zip', 'Simple-Viz-0.1.0-arm64-mac.zip']
}
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc-release-test-'))
  dirs.push(dir)
  for (const [manifest, names] of Object.entries(platforms)) {
    const files = names.map((url) => {
      const bytes = Buffer.from(`installer: ${url}`)
      writeFileSync(path.join(dir, url), bytes)
      if (/\.(exe|dmg|zip)$/.test(url)) writeFileSync(path.join(dir, `${url}.blockmap`), 'blockmap')
      return { url, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
    })
    writeFileSync(path.join(dir, manifest), dump({ version, files, path: files[0].url, sha512: files[0].sha512 }))
  }
  return dir
}

function editManifest(dir: string, edit: (info: any) => void) {
  const file = path.join(dir, 'latest.yml')
  const info = load(readFileSync(file, 'utf8'))
  edit(info)
  writeFileSync(file, dump(info))
}

describe('release validation', () => {
  it('requires a matching version tag', () => {
    expect(() => validateTag('v0.1.0', version)).not.toThrow()
    for (const tag of ['v0.2.0', 'main', '', 'v0.1.0\nextra']) expect(() => validateTag(tag, version)).toThrow(/match/)
  })

  it('accepts all eight installers with their update feeds and blockmaps', async () => {
    const files = await validateArtifacts(fixture(), version)
    expect(files).toHaveLength(16)
    for (const names of Object.values(platforms)) expect(files).toEqual(expect.arrayContaining(names))
  })

  it('can verify a Windows build before the other platforms finish', async () => {
    const dir = fixture()
    for (const [manifest, names] of Object.entries(platforms)) {
      if (manifest === 'latest.yml') continue
      for (const file of [manifest, ...names, ...names.filter((name) => /\.(dmg|zip)$/.test(name)).map((name) => `${name}.blockmap`)]) rmSync(path.join(dir, file))
    }
    expect(await validateArtifacts(dir, version, 'Windows')).toEqual(['Simple-Viz-Setup-0.1.0.exe', 'Simple-Viz-Setup-0.1.0.exe.blockmap', 'latest.yml'])
    await expect(validateArtifacts(dir, version)).rejects.toThrow(/Missing release asset/)
  })

  it('normalizes spaces in installer and blockmap names to match the update feed', async () => {
    const dir = fixture()
    const { renameSync } = await import('node:fs')
    for (const suffix of ['', '.blockmap']) renameSync(path.join(dir, `Simple-Viz-Setup-0.1.0.exe${suffix}`), path.join(dir, `Simple Viz Setup 0.1.0.exe${suffix}`))
    expect(await validateArtifacts(dir, version)).toContain('Simple-Viz-Setup-0.1.0.exe.blockmap')
  })

  it.each(['Simple-Viz-Setup-0.1.0.exe', 'Simple-Viz-0.1.0-arm64.dmg', 'simple-viz_0.1.0_amd64.deb', 'latest-linux.yml', 'Simple-Viz-0.1.0-mac.zip.blockmap'])('rejects a missing %s', async (name) => {
    const dir = fixture()
    rmSync(path.join(dir, name))
    await expect(validateArtifacts(dir, version)).rejects.toThrow(name)
  })

  it.each([
    ['version', (info: any) => { info.version = '0.2.0' }],
    ['size', (info: any) => { info.files[0].size++ }],
    ['sha512', (info: any) => { info.files[0].sha512 = 'incorrect' }],
    ['path', (info: any) => { info.path = 'missing.exe' }],
    ['sha512', (info: any) => { info.sha512 = 'incorrect' }],
    ['url', (info: any) => { info.files[0].url = '../outside.exe' }]
  ])('rejects an incorrect manifest %s', async (field, edit) => {
    const dir = fixture()
    editManifest(dir, edit)
    await expect(validateArtifacts(dir, version)).rejects.toThrow(field)
  })

  it('rejects an update feed missing its AppImage', async () => {
    const dir = fixture()
    const file = path.join(dir, 'latest-linux.yml')
    const info = load(readFileSync(file, 'utf8')) as any
    info.files.shift()
    writeFileSync(file, dump(info))
    await expect(validateArtifacts(dir, version)).rejects.toThrow('Simple-Viz-0.1.0.AppImage')
  })

  it('rejects a filename collision instead of overwriting an installer', async () => {
    const dir = fixture()
    writeFileSync(path.join(dir, 'Simple Viz Setup 0.1.0.exe'), 'different installer')
    await expect(validateArtifacts(dir, version)).rejects.toThrow(/collision/)
  })
})

describe('draft releases', () => {
  const repo = 'fleetwoodjohnr/simple-viz'
  const url = `https://github.com/${repo}/releases/tag/v0.1.0`
  const options = { tag: 'v0.1.0', sha: 'built-commit', repo, dir: '/installers', files: ['installer.exe'], notesFile: '/notes.md' }

  const remote = (args: string[], releases = '[[]]') => {
    if (args.some((arg) => arg.includes('/commits/'))) return options.sha
    if (args.some((arg) => arg.endsWith('/releases/1'))) return 'true'
    return releases
  }

  it('creates an unpublished release using an existing tag', () => {
    const gh = vi.fn((args: string[]) => args[0] === 'api' ? remote(args) : url)
    expect(draftRelease(options, gh)).toBe(url)
    const create = gh.mock.calls.find(([args]) => args[1] === 'create')![0]
    expect(create).toEqual(expect.arrayContaining(['--draft', '--verify-tag', path.resolve(options.dir, 'installer.exe')]))
    expect(create).not.toContain('--clobber')
  })

  it('replaces assets and notes when retrying an existing draft', () => {
    const gh = vi.fn((args: string[]) => args[0] === 'api' ? remote(args, JSON.stringify([[{ id: 1, tag_name: 'v0.1.0', draft: true, html_url: url }]])) : '')
    expect(draftRelease(options, gh)).toBe(url)
    expect(gh.mock.calls.some(([args]) => args[1] === 'create')).toBe(false)
    expect(gh.mock.calls.find(([args]) => args[1] === 'upload')![0]).toContain('--clobber')
    expect(gh.mock.calls.find(([args]) => args[1] === 'edit')![0]).not.toContain('--draft=true')
  })

  it('refuses to change a published release', () => {
    const gh = vi.fn((args: string[]) => remote(args, JSON.stringify([[{ tag_name: 'v0.1.0', draft: false, html_url: url }]])))
    expect(() => draftRelease(options, gh)).toThrow(/published/)
    expect(gh.mock.calls.every(([args]) => args[0] === 'api')).toBe(true)
  })

  it('rejects a tag that moved after the build', () => {
    const gh = vi.fn(() => 'different-commit')
    expect(() => draftRelease(options, gh)).toThrow('no longer points to the built commit')
    expect(gh).toHaveBeenCalledTimes(1)
  })

  it('stops a retry if the draft has since been published', () => {
    const gh = vi.fn((args: string[]) => args.some((arg) => arg.endsWith('/releases/1')) ? 'false' : remote(args, JSON.stringify([[{ id: 1, tag_name: 'v0.1.0', draft: true, html_url: url }]])))
    expect(() => draftRelease(options, gh)).toThrow(/published/)
    expect(gh.mock.calls.every(([args]) => args[0] === 'api')).toBe(true)
  })

  it('does not mistake a GitHub API failure for a missing release', () => {
    const gh = vi.fn(() => { throw new Error('GitHub unavailable') })
    expect(() => draftRelease(options, gh)).toThrow('GitHub unavailable')
    expect(gh).toHaveBeenCalledTimes(1)
  })
})

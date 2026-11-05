// Node 24 runs this TypeScript directly. The prepare command deliberately needs no installed packages.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateTag(tag: string, version: string) {
  if (tag !== `v${version}`) throw new Error(`Release tag ${JSON.stringify(tag)} must match package.json version v${version}`)
}

function platformFiles(version: string) {
  return {
    'latest.yml': [`Simple-Viz-Setup-${version}.exe`],
    'latest-linux.yml': [`Simple-Viz-${version}.AppImage`, `simple-viz_${version}_amd64.deb`, `simple-viz-${version}.x86_64.rpm`],
    'latest-mac.yml': [`Simple-Viz-${version}.dmg`, `Simple-Viz-${version}-arm64.dmg`, `Simple-Viz-${version}-mac.zip`, `Simple-Viz-${version}-arm64-mac.zip`]
  }
}

interface Manifest {
  version: string
  files: { url: string; size: number; sha512: string }[]
  path: string
  sha512: string
}

/** Normalize builder filenames to their GitHub names, then check the complete download and update set. */
export async function validateArtifacts(dir: string, version: string, platform?: string): Promise<string[]> {
  const entries = await readdir(dir)
  const normalized = entries.map((name) => name.replaceAll(' ', '-'))
  if (new Set(normalized).size !== entries.length) throw new Error('Release filename collision after replacing spaces with dashes')
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] !== normalized[i]) await rename(path.join(dir, entries[i]), path.join(dir, normalized[i]))
  }
  const allPlatforms = platformFiles(version)
  const manifestForPlatform: Record<string, string> = { Windows: 'latest.yml', Linux: 'latest-linux.yml', macOS: 'latest-mac.yml' }
  if (platform && !manifestForPlatform[platform]) throw new Error(`Unknown release platform: ${platform}`)
  const platforms = Object.fromEntries(Object.entries(allPlatforms).filter(([name]) => !platform || name === manifestForPlatform[platform]))
  const installers = Object.values(platforms).flat()
  const blockmaps = installers.filter((name) => /\.(exe|dmg|zip)$/.test(name)).map((name) => `${name}.blockmap`)
  const required = [...installers, ...blockmaps, ...Object.keys(platforms)].sort()
  for (const name of required) {
    if (!normalized.includes(name)) throw new Error(`Missing release asset: ${name}`)
    const info = await stat(path.join(dir, name))
    if (!info.isFile() || info.size === 0) throw new Error(`Empty or invalid release asset: ${name}`)
  }
  // Read large installers once, without holding them in memory.
  const hashes = new Map<string, { size: number; sha512: string }>()
  for (const name of installers) {
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of createReadStream(path.join(dir, name))) {
      hash.update(chunk)
      size += chunk.length
    }
    hashes.set(name, { size, sha512: hash.digest('base64') })
  }
  const { load } = await import('js-yaml')
  for (const [name, expected] of Object.entries(platforms)) {
    const manifest = load(await readFile(path.join(dir, name), 'utf8')) as Manifest
    if (manifest?.version !== version) throw new Error(`${name}: version does not match ${version}`)
    if (!Array.isArray(manifest.files)) throw new Error(`${name}: missing files`)
    for (const file of manifest.files) {
      if (!file || !expected.includes(file.url)) throw new Error(`${name}: invalid file url ${JSON.stringify(file?.url)}`)
      const actual = hashes.get(file.url)!
      if (file.size !== actual.size) throw new Error(`${name}: incorrect size for ${file.url}`)
      if (file.sha512 !== actual.sha512) throw new Error(`${name}: incorrect sha512 for ${file.url}`)
    }
    for (const file of expected) {
      if (!manifest.files.some((entry) => entry.url === file)) throw new Error(`${name}: missing update file ${file}`)
    }
    if (!manifest.files.some((file) => file.url === manifest.path)) throw new Error(`${name}: invalid legacy path`)
    if (manifest.sha512 !== hashes.get(manifest.path)?.sha512) throw new Error(`${name}: incorrect legacy sha512`)
  }
  return required
}

interface DraftOptions {
  tag: string
  sha: string
  repo: string
  dir: string
  files: string[]
  notesFile: string
}

type GitHub = (args: string[]) => string
const github: GitHub = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()

/** Leave the release as a draft, including on a retry after a partial upload. */
export function draftRelease({ tag, sha, repo, dir, files, notesFile }: DraftOptions, gh: GitHub = github): string {
  const currentSha = gh(['api', `repos/${repo}/commits/${encodeURIComponent(tag)}`, '--jq', '.sha']).trim()
  if (currentSha !== sha) throw new Error(`${tag} no longer points to the built commit ${sha}`)
  // Paginate so retrying an old draft still finds it. API errors must stop the release, not imply "missing".
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])) as { id: number; tag_name: string; draft: boolean; html_url: string }[][]
  const existing = pages.flat().find((release) => release.tag_name === tag)
  if (existing && !existing.draft) throw new Error(`${tag} is already published; release a new version instead`)
  const metadata = ['--repo', repo, '--title', `Simple Viz ${tag.slice(1)}`, '--notes-file', notesFile]
  const assets = files.map((file) => path.resolve(dir, file))
  if (existing) {
    // Publishing is a manual step after this workflow finishes. Also stop if it happened since the list request.
    const ensureDraft = () => {
      if (gh(['api', `repos/${repo}/releases/${existing.id}`, '--jq', '.draft']).trim() !== 'true') throw new Error(`${tag} has been published; release a new version instead`)
    }
    ensureDraft()
    gh(['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'])
    ensureDraft()
    gh(['release', 'edit', tag, ...metadata])
    return existing.html_url
  }
  return gh(['release', 'create', tag, ...assets, '--draft', '--verify-tag', ...metadata]).trim()
}

async function main() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
  const tag = process.env.RELEASE_TAG ?? ''
  if (process.argv[2] === 'prepare') {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (tag) {
      validateTag(tag, version)
      const taggedSha = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim()
      if (taggedSha !== sha) throw new Error(`Checked-out commit does not match ${tag}`)
    }
    const outputs = `sha=${sha}\ntag=${tag}\n`
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, outputs)
    else process.stdout.write(outputs)
    return
  }
  const dir = path.resolve(process.argv[3] ?? 'dist')
  if (process.argv[2] === 'verify') {
    const files = await validateArtifacts(dir, version, process.env.RUNNER_OS)
    console.log(`Verified ${files.length} release assets`)
    return
  }
  if (process.argv[2] !== 'draft') throw new Error('Usage: node scripts/release.ts prepare|verify|draft [artifact-directory]')
  validateTag(tag, version)
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const files = await validateArtifacts(dir, version)
  const changelog = await readFile('CHANGELOG.md', 'utf8')
  const section = changelog.split(/^## /m)[1]
  if (!section?.trim()) throw new Error('CHANGELOG.md has no release notes')
  const notesFile = path.join(await mkdtemp(path.join(tmpdir(), 'sc-release-notes-')), 'notes.md')
  await writeFile(notesFile, `## ${section}`)
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const url = draftRelease({ tag, sha, repo, dir, files, notesFile })
  console.log(`Draft release: ${url}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release draft ready\n\n[Review and publish ${tag}](${url})\n\nDownloads become public after you publish the draft.\n\n${files.map((file) => `- \`${file}\``).join('\n')}\n`)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

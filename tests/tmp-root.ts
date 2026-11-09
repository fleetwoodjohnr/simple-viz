// Global setup for the integration and end-to-end suites: every temporary folder of a run (profiles, caches of up
// to hundreds of MB) lives under one root, removed when the run ends. Workers inherit the environment.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export default function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'sv-run-'))
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = root
  return () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // still in use (Windows): the OS clears its temp folder
    }
  }
}

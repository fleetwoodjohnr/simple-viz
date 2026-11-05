// Watches the data files of the open project. Spreadsheet apps save by writing a temporary file and renaming it over
// the original, which ends a watch on the file itself, so the folder is watched and events are filtered by name.

import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, NodeJS.Timeout>()

export function watchFiles(paths: string[], onChange: (file: string) => void) {
  for (const w of watchers.values()) w.close()
  watchers.clear()
  const byDir = new Map<string, Set<string>>()
  for (const p of paths) {
    const dir = path.dirname(p)
    if (!byDir.has(dir)) byDir.set(dir, new Set())
    byDir.get(dir)!.add(path.basename(p))
  }
  for (const [dir, names] of byDir) {
    try {
      const w = watch(dir, { persistent: false }, (_ev, name) => {
        const n = name?.toString()
        // Some platforms omit the name: treat as a change to every watched file in the folder.
        for (const target of n ? (names.has(n) ? [n] : []) : [...names]) {
          const full = path.join(dir, target)
          clearTimeout(timers.get(full))
          // Saves arrive as several events; wait until the file has settled.
          timers.set(full, setTimeout(() => (timers.delete(full), onChange(full)), 700))
        }
      })
      w.on('error', () => w.close())
      watchers.set(dir, w)
    } catch {
      /* folder missing or not watchable: refresh on open/focus still applies */
    }
  }
}

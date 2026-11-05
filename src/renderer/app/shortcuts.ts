// Default keyboard shortcuts. Key format: Mod = Ctrl (Windows/Linux) or ⌘ (macOS); chords joined with "-".
// Editor keys (run query: Mod-Enter, format: Mod-Shift-f) live in the SQL editor's keymap and are listed in
// EDITOR_SHORTCUTS for the shortcut reference.

export interface ShortcutDef {
  command: string
  win: string[]
  mac?: string[]
}

export const SHORTCUTS: ShortcutDef[] = [
  { command: 'file.new', win: ['Mod-n'] },
  { command: 'file.open', win: ['Mod-o'] },
  { command: 'file.save', win: ['Mod-s'] },
  { command: 'file.saveAs', win: ['Mod-Shift-s'] },
  { command: 'file.close', win: ['Mod-w'] },
  { command: 'edit.undo', win: ['Mod-z'] },
  { command: 'edit.redo', win: ['Mod-y', 'Mod-Shift-z'], mac: ['Mod-Shift-z', 'Mod-y'] },
  { command: 'nav.home', win: ['Alt-1'], mac: ['Mod-1'] },
  { command: 'nav.data', win: ['Alt-2'], mac: ['Mod-2'] },
  { command: 'nav.sql', win: ['Alt-3'], mac: ['Mod-3'] },
  { command: 'nav.charts', win: ['Alt-4'], mac: ['Mod-4'] },
  { command: 'nav.dashboards', win: ['Alt-5'], mac: ['Mod-5'] },
  { command: 'nav.analytics', win: ['Alt-6'], mac: ['Mod-6'] },
  { command: 'data.add', win: ['Mod-Shift-d'] },
  { command: 'data.refresh', win: ['F5'], mac: ['Mod-r'] },
  { command: 'tools.palette', win: ['Mod-k', 'Mod-Shift-p'] },
  { command: 'tools.settings', win: ['Mod-,'] },
  { command: 'tools.shortcuts', win: ['Mod-/'] },
  { command: 'view.theme', win: ['Mod-Shift-l'] }
]

export const EDITOR_SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Mod-Enter', action: 'Run the query (or the selected text)' },
  { keys: 'Mod-Shift-f', action: 'Format SQL' },
  { keys: 'Mod-t', action: 'New query tab' },
  { keys: 'Ctrl-Space', action: 'Show completions' },
  { keys: 'Escape', action: 'Cancel the running query' }
]

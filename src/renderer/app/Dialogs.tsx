import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun, Search, ShieldCheck, ShieldAlert } from 'lucide-react'
import { flushSync } from 'react-dom'
import { useApp, set, get, updateSettings, toast, type Dialog } from '../state/store'
import * as P from '../state/project'
import { allCommands, eventToShortcut, formatShortcut, getCommand, runCommand, shortcutFor, shortcutsFor } from './commands'
import { EDITOR_SHORTCUTS } from './shortcuts'
import { Btn, Kbd, Modal, Segmented, Switch, cx, inputCls } from '../ui'
import { SheetPicker, ConnectDialog, RelinkDialog, RemoteDialog } from './Connect'

export const close = () => flushSync(() => set({ dialog: null }))

export function Dialogs() {
  const d = useApp((s) => s.dialog)
  if (!d) return null
  switch (d.kind) {
    case 'settings':
      return <SettingsDialog initial={d.section} />
    case 'confirm-close':
      return <ConfirmClose d={d} />
    case 'shortcuts':
      return <ShortcutsDialog />
    case 'palette':
      return <CommandPalette />
    case 'about':
      return <AboutDialog />
    case 'sheet-picker':
      return <SheetPicker path={d.path} />
    case 'connect-remote':
      return <RemoteDialog />
    case 'connect-db':
      return <ConnectDialog kind={d.kind2} key={d.kind2} />
    case 'relink':
      return <RelinkDialog sourceId={d.sourceId} />
    case 'prompt':
      return <PromptDialog d={d} />
    case 'message':
      return (
        <Modal open onOpenChange={(o) => !o && close()} title={d.title} width={460} footer={<Btn variant="primary" autoFocus onClick={close}>OK</Btn>}>
          <p className="select-text whitespace-pre-line text-[13px] leading-relaxed text-text-2">{d.body}</p>
        </Modal>
      )
    default:
      return null
  }
}

/** Asks for a line of text (Electron has no window.prompt). Resolves null when cancelled. */
export function askText(title: string, label: string, value = '', secret = false): Promise<string | null> {
  return new Promise((resolve) => set({ dialog: { kind: 'prompt', title, label, value, secret, resolve } }))
}

function PromptDialog({ d }: { d: Extract<Dialog, { kind: 'prompt' }> }) {
  const [v, setV] = useState(d.value)
  const done = (out: string | null) => {
    close()
    d.resolve(out)
  }
  return (
    <Modal open onOpenChange={(o) => !o && done(null)} title={d.title} width={420} footer={<><Btn onClick={() => done(null)}>Cancel</Btn><Btn variant="primary" onClick={() => done(v)} data-testid="prompt-ok">OK</Btn></>}>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-text-2">{d.label}</span>
        <input autoFocus type={d.secret ? 'password' : 'text'} autoComplete="off" className={inputCls} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && done(v)} aria-label={d.label} data-testid="prompt-input" />
      </label>
    </Modal>
  )
}

function ConfirmClose({ d }: { d: Extract<Dialog, { kind: 'confirm-close' }> }) {
  const title = useApp((s) => s.project?.title)
  const finish = () => {
    close()
    void P.continueAfterClose(d.then)
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && close()}
      title={`Save changes to “${title}”?`}
      description="Your changes will be lost if you don’t save them."
      width={440}
      footer={
        <>
          <Btn variant="ghost" onClick={finish} data-testid="dont-save">
            Don’t save
          </Btn>
          <Btn onClick={close}>Cancel</Btn>
          <Btn
            variant="primary"
            autoFocus
            onClick={async () => {
              if (await P.save()) finish()
            }}
          >
            Save
          </Btn>
        </>
      }
    />
  )
}

/** Arrow keys (and Home/End on the list itself) move through n items; Enter chooses. */
export function listKeys(e: React.KeyboardEvent, n: number, i: number, move: (k: number) => void, enter: () => void, homeEnd: boolean) {
  const k = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : homeEnd && e.key === 'Home' ? 0 : homeEnd && e.key === 'End' ? n - 1 : null
  if (k !== null && n) {
    e.preventDefault()
    move(Math.max(0, Math.min(n - 1, k)))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    enter()
  }
}

function useScrollIntoView(id: string | undefined) {
  useEffect(() => {
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' })
  }, [id])
}

// ---------- command palette: commands, plus every table, dataset and column in the project ----------

function CommandPalette() {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const relations = useApp((s) => s.relations)
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w))
    const project = !!get().project
    const out: { id: string; label: string; hint: string; run: () => void }[] = allCommands()
      .filter((c) => (!c.needsProject || project) && match(`${c.label} ${c.id} ${c.keywords ?? ''}`))
      .slice(0, 40)
      .map((c) => ({ id: c.id, label: c.label, hint: formatShortcut(shortcutFor(c.id)), run: () => void runCommand(c.id) }))
    if (words.length)
      for (const r of relations) {
        if (match(r.name)) out.push({ id: `rel:${r.name}`, label: `Open ${r.name}`, hint: r.kind === 'dataset' ? 'Dataset' : 'Table', run: () => set({ workspace: 'data', focusRelation: r.name }) })
        for (const c of r.columns) if (out.length < 60 && match(`${r.name} ${c.name}`) && match(c.name)) out.push({ id: `col:${r.name}.${c.name}`, label: `${r.name}.${c.name}`, hint: c.type, run: () => set({ workspace: 'data', focusRelation: r.name }) })
      }
    return out
  }, [q, relations])
  const active = results.length ? `palette-opt-${i}` : undefined
  useScrollIntoView(active)
  const choose = (k: number) => {
    const r = results[k]
    if (!r) return
    close()
    setTimeout(r.run, 0)
  }
  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Search commands and data" width={560}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
        <input
          autoFocus
          aria-label="Search commands and data"
          className={cx(inputCls, 'h-10 pl-9 text-[14px]')}
          placeholder="Type a command, table or column name"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setI(0)
          }}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="palette-list"
          aria-activedescendant={active}
          onKeyDown={(e) => listKeys(e, results.length, i, setI, () => choose(i), false)}
        />
      </div>
      {results.length ? (
        <ul id="palette-list" tabIndex={0} aria-activedescendant={active} onKeyDown={(e) => listKeys(e, results.length, i, setI, () => choose(i), true)} className="mt-2 max-h-[50vh] overflow-y-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent" role="listbox" aria-label="Results" data-testid="palette-results">
          {results.map((r, k) => (
            <li key={r.id} id={`palette-opt-${k}`} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => choose(k)} className={cx('flex h-9 cursor-default items-center justify-between gap-4 rounded-lg px-3 text-[13px]', k === i && 'bg-accent-soft text-accent-ink')}>
              <span className="truncate">{r.label}</span>
              <span className={cx('shrink-0 text-[11.5px]', k === i ? 'text-accent-ink' : 'text-text-3')}>{r.hint}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 px-3 py-6 text-center text-[13px] text-text-3" data-testid="palette-results">
          Nothing matches
        </p>
      )}
    </Modal>
  )
}

// ---------- shortcuts ----------

function ShortcutsDialog() {
  const [q, setQ] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const settings = useApp((s) => s.settings)
  const cmds = allCommands().filter((c) => !q || `${c.label} ${c.id}`.toLowerCase().includes(q.toLowerCase()) || shortcutsFor(c.id).some((k) => formatShortcut(k).toLowerCase().includes(q.toLowerCase())))
  const owners = new Map<string, string[]>()
  for (const c of allCommands()) for (const k of shortcutsFor(c.id)) owners.set(k, [...(owners.get(k) ?? []), c.id])
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(null)
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      void updateSettings({ shortcuts: { ...get().settings.shortcuts, [recording]: eventToShortcut(e) } })
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])
  const exportJson = async () => {
    const path = await window.simpleViz.saveDialog('Simple Viz shortcuts.json', ['json'])
    if (path) await window.simpleViz.writeFile(path, new TextEncoder().encode(JSON.stringify({ shortcuts: settings.shortcuts }, null, 2)))
  }
  const importJson = async () => {
    const [f] = await window.simpleViz.openDialog({ name: 'Shortcuts', extensions: ['json'] })
    if (!f) return
    try {
      const data = JSON.parse(new TextDecoder().decode(f.data)) as { shortcuts?: Record<string, string> }
      await updateSettings({ shortcuts: Object.fromEntries(Object.entries(data.shortcuts ?? {}).filter(([k, v]) => getCommand(k) && typeof v === 'string')) })
      toast('Shortcuts imported', 'success')
    } catch {
      toast('That file isn’t a Simple Viz shortcut file.', 'error')
    }
  }
  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Keyboard shortcuts" description="Click a shortcut to change it." width={680} footer={<><Btn onClick={importJson}>Import…</Btn><Btn onClick={exportJson}>Export…</Btn><Btn onClick={() => updateSettings({ shortcuts: {} })}>Reset all</Btn><Btn variant="primary" onClick={close}>Done</Btn></>}>
      <input autoFocus aria-label="Search shortcuts" placeholder="Search by action or key" className={cx(inputCls, 'mb-3')} value={q} onChange={(e) => setQ(e.target.value)} />
      <table className="w-full text-[12.5px]" data-testid="shortcut-table">
        <tbody>
          {cmds.map((c) => {
            const keys = shortcutsFor(c.id)
            const conflict = keys.some((k) => (owners.get(k)?.length ?? 0) > 1)
            return (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1.5">{c.label}</td>
                <td className="py-1.5 text-right">
                  <button className={cx('inline-flex min-w-[96px] justify-end gap-1 rounded px-2 py-0.5 hover:bg-hover', conflict && 'text-danger')} onClick={() => setRecording(c.id)}>
                    <span className="sr-only">Change shortcut for {c.label}: </span>
                    {recording === c.id ? <span className="text-accent-ink">Press keys…</span> : keys.length ? keys.map((k) => <Kbd key={k}>{formatShortcut(k)}</Kbd>) : <span className="text-text-3">—</span>}
                  </button>
                  {conflict && <span className="ml-1 text-[11px] text-danger">conflict</span>}
                </td>
              </tr>
            )
          })}
          <tr>
            <td colSpan={2} className="pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-text-3">
              SQL editor
            </td>
          </tr>
          {EDITOR_SHORTCUTS.map((b) => (
            <tr key={b.keys} className="border-t border-border">
              <td className="py-1.5">{b.action}</td>
              <td className="py-1.5 text-right">
                <Kbd>{formatShortcut(b.keys)}</Kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

// ---------- settings ----------

const ACCENTS = ['#c2410c', '#1b7f53', '#5b5bd6', '#2563eb', '#0e7490', '#be185d', '#7c3aed', '#3f3f46']

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-text-3">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function SettingsDialog({ initial }: { initial?: string }) {
  const s = useApp((x) => x.settings)
  const [section, setSection] = useState(initial ?? 'appearance')
  const [version, setVersion] = useState('')
  const [keychain, setKeychain] = useState<{ backend: string; secure: boolean } | null>(null)
  useEffect(() => {
    void window.simpleViz.appVersion().then(setVersion)
    void window.simpleViz.credentialStatus().then(setKeychain)
  }, [])
  const sections = [
    ['appearance', 'Appearance'],
    ['data', 'Data and refresh'],
    ['backup', 'Backup and recovery'],
    ['privacy', 'Security and privacy'],
    ['keyboard', 'Keyboard'],
    ['about', 'About and updates']
  ]
  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Settings" width={700} footer={<Btn variant="primary" onClick={close}>Done</Btn>}>
      <div className="flex gap-5">
        <nav className="w-44 shrink-0 space-y-0.5" aria-label="Settings sections">
          {sections.map(([id, label]) => (
            <button key={id} onClick={() => setSection(id)} aria-current={section === id ? 'true' : undefined} className={cx('h-8 w-full rounded-lg px-3 text-left text-[13px]', section === id ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2 hover:bg-hover')}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-h-[320px] flex-1 divide-y divide-border">
          {section === 'appearance' && (
            <>
              <Row label="Theme" hint="Charts, tables and dashboards follow it">
                <Segmented value={s.theme} onChange={(v) => updateSettings({ theme: v })} label="Theme" options={[{ value: 'system', label: <Monitor className="size-3.5" />, title: 'System' }, { value: 'light', label: <Sun className="size-3.5" />, title: 'Light' }, { value: 'dark', label: <Moon className="size-3.5" />, title: 'Dark' }]} />
              </Row>
              <Row label="Accent color">
                <div className="flex gap-1.5">
                  {ACCENTS.map((a) => (
                    <button key={a} aria-label={`Accent ${a}`} onClick={() => updateSettings({ accent: a })} className={cx('size-6 rounded-full', s.accent === a && 'ring-2 ring-text ring-offset-2 ring-offset-elev')} style={{ background: a }} />
                  ))}
                </div>
              </Row>
              <Row label="Interface size">
                <Segmented value={String(s.uiScale)} onChange={(v) => updateSettings({ uiScale: Number(v) })} label="Interface size" options={['0.9', '1', '1.1', '1.25'].map((v) => ({ value: v, label: `${Math.round(Number(v) * 100)}%` }))} />
              </Row>
              <Row label="Reduce motion">
                <Switch checked={s.reduceMotion} onChange={(v) => updateSettings({ reduceMotion: v })} label="Reduce motion" />
              </Row>
            </>
          )}
          {section === 'data' && (
            <>
              <Row label="Rows in previews" hint="How many rows previews and query results load at first (scrolling loads more)">
                <Segmented value={String(s.previewRows)} onChange={(v) => updateSettings({ previewRows: Number(v) })} label="Rows in previews" options={['200', '1000', '5000'].map((v) => ({ value: v, label: v }))} />
              </Row>
              <Row label="Refresh time limit" hint="Seconds before reading one source gives up; the last good data stays">
                <input aria-label="Refresh time limit (seconds)" type="number" min={5} max={3600} className={cx(inputCls, 'w-24')} value={s.refreshTimeoutSec} onChange={(e) => updateSettings({ refreshTimeoutSec: Math.max(5, Number(e.target.value) || 60) })} />
              </Row>
              <p className="py-2.5 text-[12px] leading-relaxed text-text-3">When to refresh (on open, when a file changes, when you return to the app, every few minutes) is set per source, in Data → the source’s menu.</p>
            </>
          )}
          {section === 'backup' && (
            <>
              <Row label="AutoSave" hint="Saves projects that already have a file, shortly after each change">
                <Switch checked={s.autosave} onChange={(v) => updateSettings({ autosave: v })} label="AutoSave" />
              </Row>
              <Row label="Recovery snapshots" hint={`Unsaved changes are kept every ${s.recoveryIntervalSec} s in case the app closes unexpectedly`}>
                <input aria-label="Recovery interval" type="number" min={2} max={300} className={cx(inputCls, 'w-24')} value={s.recoveryIntervalSec} onChange={(e) => updateSettings({ recoveryIntervalSec: Math.max(2, Number(e.target.value) || 5) })} />
              </Row>
            </>
          )}
          {section === 'privacy' && (
            <>
              <Row label="Passwords" hint={keychain?.secure ? `Stored encrypted by your system keychain (${keychain.backend}).` : 'No system keychain was found, so passwords are kept only until you quit.'}>
                {keychain?.secure ? <ShieldCheck className="size-5 text-success" /> : <ShieldAlert className="size-5 text-warn" />}
              </Row>
              <div className="space-y-2 py-3 text-[12.5px] leading-relaxed text-text-2">
                <p>Your data stays on this computer. Simple Viz has no account and sends no telemetry. It connects only to the databases you add, and to GitHub for the update check (which you can turn off under About and updates).</p>
                <p>Queries only read data: SQL that would change a database or a file is refused. Macros in spreadsheets never run. Project files never contain passwords.</p>
              </div>
            </>
          )}
          {section === 'keyboard' && (
            <Row label="Customize shortcuts">
              <Btn onClick={() => set({ dialog: { kind: 'shortcuts' } })}>Open shortcut list</Btn>
            </Row>
          )}
          {section === 'about' && (
            <>
              <Row label={`Simple Viz ${version}`} hint="Open source (MIT). Part of the Simple family of apps.">
                <Btn onClick={() => window.simpleViz.checkForUpdates()} data-testid="check-updates">
                  Check for updates
                </Btn>
              </Row>
              <Row label="Check for updates automatically" hint="Once a day Simple Viz asks GitHub whether a newer version exists. Nothing downloads until you click Install.">
                <Switch checked={s.updateCheck} onChange={(v) => updateSettings({ updateCheck: v })} label="Check for updates automatically" />
              </Row>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

function AboutDialog() {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.simpleViz.appVersion().then(setVersion)
  }, [])
  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Simple Viz" description={`Version ${version}`} width={440} footer={<><Btn onClick={() => window.simpleViz.checkForUpdates()}>Check for updates</Btn><Btn variant="primary" onClick={close}>OK</Btn></>}>
      <p className="text-[13px] leading-relaxed text-text-2">An open-source, local-first business intelligence app. MIT licence. No account, no telemetry. Built on DuckDB, Apache ECharts and Electron.</p>
    </Modal>
  )
}

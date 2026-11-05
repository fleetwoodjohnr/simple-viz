import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Cloud, Command, Loader2, Minus, Moon, Redo2, Save, Search, Settings, Square, Sun, Undo2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, set } from '../state/store'
import { canRedo, canUndo } from '../state/project'
import { runCommand, shortcutFor } from './commands'
import { IconBtn, Tip, cx } from '../ui'
import { RefreshStatus } from './RefreshStatus'

/** The app icon (resources/icon.svg) redrawn small, without its shadow and sheen. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="sv-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="color-mix(in oklab, var(--accent) 70%, #ffd2b0)" />
          <stop offset="1" stopColor="color-mix(in oklab, var(--accent) 70%, #3a1205)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="url(#sv-logo)" />
      <rect x="7" y="7.25" width="18" height="17.5" rx="1.6" fill="#fff" />
      <path d="M9.6 17.8h2.6v4.4H9.6ZM14.4 14.8h2.6v7.4h-2.6ZM19.2 11.6h2.6v10.6h-2.6Z" fill="var(--accent)" />
      <path d="M11 15.3 15.7 12.5 20.5 9.4" fill="none" stroke="color-mix(in oklab, var(--accent) 55%, #2e0f04)" strokeWidth="0.9" strokeLinecap="round" />
      <circle cx="20.5" cy="9.4" r="1.2" fill="#fff" stroke="color-mix(in oklab, var(--accent) 55%, #2e0f04)" strokeWidth="0.7" />
    </svg>
  )
}

function useOverlayInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void } }).windowControlsOverlay
    if (!wco) return
    const update = () => setInset(wco.visible ? Math.max(0, window.innerWidth - wco.getTitlebarAreaRect().right) : 0)
    update()
    wco.addEventListener('geometrychange', update)
    return () => wco.removeEventListener('geometrychange', update)
  }, [])
  return inset
}

function SaveStatus() {
  const { status, path, saveError } = useApp(useShallow((s) => ({ status: s.status, path: s.path, saveError: s.saveError })))
  const label = status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : status === 'unsaved' ? (path ? 'Edited' : 'Not saved') : path ? 'Saved' : 'New'
  const icon = status === 'saving' ? <Loader2 className="size-3.5 animate-spin" /> : status === 'error' ? <AlertTriangle className="size-3.5" /> : status === 'saved' && path ? <Check className="size-3.5" /> : <Cloud className="size-3.5" />
  return (
    <Tip label={saveError ?? path ?? 'This project has not been saved yet'}>
      <span data-testid="save-status" className={cx('no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-text-3', status === 'error' && 'text-danger')}>
        {icon}
        {label}
      </span>
    </Tip>
  )
}

export function TitleBar() {
  const { project, dark, dirty } = useApp(useShallow((s) => ({ project: s.project, dark: s.dark, dirty: s.dirty })))
  useApp((s) => s.project) // re-render on edits so undo/redo state is current
  const isMac = window.simpleViz.platform === 'darwin'
  const inset = useOverlayInset()
  const customControls = !isMac && inset === 0

  return (
    <header className="drag flex h-11 shrink-0 items-center gap-1 border-b border-border bg-bg pr-2" style={{ paddingLeft: isMac ? 80 : 10, paddingRight: inset ? inset + 8 : undefined }}>
      <Tip label="Home">
        <button onClick={() => set({ workspace: 'home' })} className="no-drag mr-1 flex items-center gap-2 rounded-lg p-1 transition-opacity hover:opacity-85" aria-label="Home">
          <Logo />
        </button>
      </Tip>
      {project ? (
        <div className="flex min-w-0 items-center gap-1">
          <h1 className="truncate text-[13px] font-semibold" data-testid="project-title" title={project.title}>
            {project.title}
            {dirty && <span className="sr-only"> (unsaved changes)</span>}
          </h1>
          <SaveStatus />
          <RefreshStatus />
        </div>
      ) : (
        <span className="text-[13px] font-semibold">Simple Viz</span>
      )}
      <div className="h-full flex-1" />
      {project && (
        <div className="no-drag flex items-center gap-0.5">
          <IconBtn label="Save" shortcut={shortcutFor('file.save')} onClick={() => runCommand('file.save')}>
            <Save className="size-4" />
          </IconBtn>
          <IconBtn label="Undo" shortcut={shortcutFor('edit.undo')} disabled={!canUndo()} onClick={() => runCommand('edit.undo')}>
            <Undo2 className="size-4" />
          </IconBtn>
          <IconBtn label="Redo" shortcut={shortcutFor('edit.redo')} disabled={!canRedo()} onClick={() => runCommand('edit.redo')}>
            <Redo2 className="size-4" />
          </IconBtn>
          <div className="mx-1 h-4 w-px bg-border" />
        </div>
      )}
      <div className="no-drag ml-1 flex items-center gap-0.5">
        <button onClick={() => runCommand('tools.palette')} className="mr-1 flex h-7 w-52 items-center gap-2 rounded-lg border border-border bg-panel px-2.5 text-[12px] text-text-3 hover:border-border-strong" data-testid="search-commands">
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search commands</span>
          <Command className="size-3" />
        </button>
        <IconBtn label={dark ? 'Light mode' : 'Dark mode'} shortcut={shortcutFor('view.theme')} onClick={() => runCommand('view.theme')} data-testid="theme-toggle">
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </IconBtn>
        <IconBtn label="Settings" shortcut={shortcutFor('tools.settings')} onClick={() => runCommand('tools.settings')}>
          <Settings className="size-4" />
        </IconBtn>
      </div>
      {customControls && (
        <div className="no-drag -mr-2 ml-2 flex h-full items-stretch">
          <button aria-label="Minimize" onClick={() => window.simpleViz.windowMinimize()} className="flex w-11 items-center justify-center text-text-2 hover:bg-hover">
            <Minus className="size-4" />
          </button>
          <button aria-label="Maximize" onClick={() => window.simpleViz.windowToggleMaximize()} className="flex w-11 items-center justify-center text-text-2 hover:bg-hover">
            <Square className="size-3.5" />
          </button>
          <button aria-label="Close window" onClick={() => window.simpleViz.windowClose()} className="flex w-11 items-center justify-center text-text-2 hover:bg-[#e81123] hover:text-white">
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}

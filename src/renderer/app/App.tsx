import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CheckCircle2, AlertCircle, Info, FileUp } from 'lucide-react'
import { useApp, set, get, toast } from '../state/store'
import * as P from '../state/project'
import * as E from '../state/engine'
import { handleKeydown, runCommand } from './commands'
import { TitleBar } from './TitleBar'
import { Nav } from './Nav'
import { Home } from './Home'
import { DataView } from './Data'
import { SqlEditor } from './SqlEditor'
import { Placeholder } from './Placeholder'
import { Dialogs } from './Dialogs'
import { TooltipProvider } from '../ui'

async function boot() {
  const api = window.simpleViz
  const [settings, recents, recovery] = await Promise.all([api.settingsGet(), api.recentList(), api.recoveryList()])
  set({ settings, recents, recovery, ready: true })
}

function useTheme() {
  const { theme, accent, reduceMotion } = useApp(useShallow((s) => ({ theme: s.settings.theme, accent: s.settings.accent, reduceMotion: s.settings.reduceMotion })))
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.setProperty('--accent', accent)
      set({ dark })
      window.simpleViz.setTitleBarColors({ color: dark ? '#121214' : '#f7f7f8', symbolColor: dark ? '#d4d4d8' : '#3f3f46' })
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, accent])
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion)
  }, [reduceMotion])
}

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-[120] flex flex-col items-center gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} data-testid={`toast-${t.kind}`} className="slide-up pointer-events-auto flex max-w-[620px] items-center gap-2.5 rounded-xl bg-[#1c1c22] px-4 py-2.5 text-[13px] text-white shadow-[0_12px_32px_-8px_rgb(0_0_0/0.45)] dark:bg-[#2a2a30]">
          {t.kind === 'success' ? <CheckCircle2 className="size-4 shrink-0 text-emerald-400" /> : t.kind === 'error' ? <AlertCircle className="size-4 shrink-0 text-red-400" /> : <Info className="size-4 shrink-0 text-sky-300" />}
          {t.message}
        </div>
      ))}
    </div>
  )
}

function DropOverlay() {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setOver(false)
    }
    const overH = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      depth = 0
      setOver(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.simpleViz.grantDroppedFile(f))
        .filter((p): p is string => !!p)
      if (!paths.length) return
      // Grants are asynchronous in main; give them a moment before the engine is asked to read the files.
      setTimeout(async () => {
        const projects = paths.filter((p) => p.toLowerCase().endsWith('.sviz'))
        if (projects[0]) await P.openPath(projects[0])
        const data = paths.filter((p) => !projects.includes(p))
        if (data.length) await P.addFiles(data)
      }, 50)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overH)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overH)
      window.removeEventListener('drop', drop)
    }
  }, [])
  if (!over) return null
  return (
    <div className="fade-in pointer-events-none fixed inset-3 z-[110] flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft backdrop-blur-sm">
      <div className="flex flex-col items-center gap-2 text-accent-ink">
        <FileUp className="size-8" />
        <div className="text-[15px] font-semibold">Drop to add data</div>
        <div className="text-[12.5px]">Excel, CSV, Parquet, JSON, SQLite, DuckDB — or a .sviz project</div>
      </div>
    </div>
  )
}

function Workspace() {
  const { workspace, project } = useApp(useShallow((s) => ({ workspace: s.workspace, project: s.project })))
  if (workspace === 'home' || !project) return <Home />
  switch (workspace) {
    case 'data':
      return <DataView />
    case 'sql':
      return <SqlEditor />
    default:
      return <Placeholder workspace={workspace} />
  }
}

export function App() {
  const ready = useApp((s) => s.ready)
  useTheme()
  useEffect(() => {
    void boot()
    const api = window.simpleViz
    window.addEventListener('keydown', handleKeydown, true)
    const offs = [
      api.onOpenFiles((f) => void P.openFiles(f)),
      api.onCloseRequest(() => P.requestQuit()),
      api.onMenuCommand((id) => void runCommand(id)),
      api.onEngineStatus((s) => P.onEngineStatus(s)),
      api.onEngineRestart(() => toast('The data engine restarted.', 'info')),
      api.onFocus(() => P.onWindowFocus()),
      api.onFileChanged((f) => P.onFileChanged(f))
    ]
    // Test/automation hook (renderer-only; exposes nothing the page could not already reach).
    ;(window as unknown as Record<string, unknown>).__sv = { get, set, P, E, runCommand, toast }
    return () => {
      window.removeEventListener('keydown', handleKeydown, true)
      offs.forEach((o) => o())
    }
  }, [])

  if (!ready) return <div className="h-full bg-bg" />
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Nav />
          <main className="relative min-w-0 flex-1 bg-workspace" aria-label="Workspace">
            <Workspace />
          </main>
        </div>
        <Dialogs />
        <Toasts />
        <DropOverlay />
      </div>
    </TooltipProvider>
  )
}

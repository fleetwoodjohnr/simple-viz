import { useMemo, useState } from 'react'
import { Clock, Database, FilePlus2, FileSpreadsheet, FolderOpen, LifeBuoy, MoreHorizontal, Pin, PinOff, Search, Server, Star, Trash2, BarChart3 } from 'lucide-react'
import { useApp, set } from '../state/store'
import * as P from '../state/project'
import type { RecentFile } from '@/shared/ipc-types'
import { formatShortcut, pickDataFiles, runCommand, shortcutFor } from './commands'
import { Logo } from './TitleBar'
import { Btn, Kbd, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, cx } from '../ui'
import { timeAgo } from './RefreshStatus'

function RecentCard({ r }: { r: RecentFile }) {
  return (
    <div className="group relative">
      <button onClick={() => P.openPath(r.path)} className="flex w-full flex-col text-left" title={r.path} data-testid="recent-card">
        <div className="aspect-[1.4/1] w-full overflow-hidden rounded-xl border border-border bg-panel-2 transition-all duration-200 group-hover:border-border-strong group-hover:shadow-[0_8px_20px_-10px_rgb(0_0_0/0.25)]">
          {r.thumbnail ? (
            <img src={r.thumbnail} alt="" className="h-full w-full object-cover object-top" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <BarChart3 className="size-8 text-text-3 opacity-50" />
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5 px-0.5">
          {r.pinned && <Pin className="size-3 shrink-0 text-accent-ink" />}
          {r.favorite && <Star className="size-3 shrink-0 fill-current text-accent-ink" />}
          <span className="truncate text-[12.5px] font-medium text-text">{r.name.replace(/\.sviz$/i, '')}</span>
        </div>
        <div className="px-0.5 text-[11.5px] text-text-3">Opened {timeAgo(r.openedAt)}</div>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button aria-label={`More actions for ${r.name}`} className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg bg-elev/90 text-text-2 opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-text focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
            <MoreHorizontal className="size-4" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<FolderOpen />} onSelect={() => P.openPath(r.path)}>
            Open
          </MenuItem>
          <MenuItem icon={r.pinned ? <PinOff /> : <Pin />} onSelect={async () => set({ recents: await window.simpleViz.recentUpdate(r.path, { pinned: !r.pinned }) })}>
            {r.pinned ? 'Unpin' : 'Pin to top'}
          </MenuItem>
          <MenuItem icon={<Star />} onSelect={async () => set({ recents: await window.simpleViz.recentUpdate(r.path, { favorite: !r.favorite }) })}>
            {r.favorite ? 'Remove from favorites' : 'Add to favorites'}
          </MenuItem>
          <MenuItem icon={<FolderOpen />} onSelect={() => window.simpleViz.showInFolder(r.path)}>
            Show in folder
          </MenuItem>
          <MenuSep />
          <MenuItem icon={<Trash2 />} onSelect={async () => set({ recents: await window.simpleViz.recentRemove(r.path) })}>
            Remove from list
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

function StartCard({ icon, title, body, onClick, testid }: { icon: React.ReactNode; title: string; body: string; onClick: () => void; testid?: string }) {
  return (
    <button onClick={onClick} data-testid={testid} className="group flex items-start gap-3 rounded-xl border border-border bg-panel p-4 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-all duration-150 hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_10px_24px_-12px_rgb(120_40_10/0.35)]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink [&>svg]:size-[18px]">{icon}</span>
      <span>
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-text-3">{body}</span>
      </span>
    </button>
  )
}

export function Home() {
  const recents = useApp((s) => s.recents)
  const recovery = useApp((s) => s.recovery)
  const project = useApp((s) => s.project)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'pinned' | 'favorites'>('all')
  const list = useMemo(
    () =>
      recents
        .filter((r) => (filter === 'pinned' ? r.pinned : filter === 'favorites' ? r.favorite : true))
        .filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()) || r.path.toLowerCase().includes(q.toLowerCase())),
    [recents, q, filter]
  )
  const hour = new Date().getHours()
  return (
    <div className="h-full overflow-y-auto bg-bg" data-testid="home">
      <div className="mx-auto max-w-[1080px] px-10 pb-16 pt-10">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[26px] font-semibold tracking-[-0.025em]">{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}</h2>
            <p className="mt-1 text-[13.5px] text-text-2">Connect data, explore it with SQL or charts, and share dashboards that stay up to date.</p>
          </div>
          <div className="flex gap-2">
            <Btn onClick={() => runCommand('file.open')}>
              <FolderOpen className="size-4" />
              Open
              <span className="ml-1 text-[11px] text-text-3">{formatShortcut(shortcutFor('file.open'))}</span>
            </Btn>
            <Btn variant="primary" onClick={() => runCommand('file.new')} data-testid="new-project">
              <FilePlus2 className="size-4" />
              New project
            </Btn>
          </div>
        </div>

        {recovery.length > 0 && (
          <div className="slide-up mt-7 rounded-2xl border border-warn/40 bg-warn/[0.06] p-4" data-testid="recovery">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold">
              <LifeBuoy className="size-4 text-warn" />
              Recovered projects
            </div>
            <p className="mt-1 text-[12.5px] text-text-2">Simple Viz closed unexpectedly. These unsaved changes were recovered.</p>
            <div className="mt-3 space-y-1.5">
              {recovery.map((r) => {
                let title = 'Untitled project'
                try {
                  title = (JSON.parse(r.payload) as { title: string }).title
                } catch {
                  /* damaged */
                }
                return (
                  <div key={r.id} className="flex items-center gap-3 rounded-lg bg-panel px-3 py-2 shadow-[0_0_0_1px_var(--border)]">
                    <BarChart3 className="size-4 text-text-3" />
                    <span className="flex-1 text-[13px] font-medium">{title}</span>
                    <span className="text-[12px] text-text-3">{timeAgo(r.savedAt)}</span>
                    <Btn size="sm" variant="ghost" onClick={() => P.discardRecovery(r.id)}>
                      Discard
                    </Btn>
                    <Btn size="sm" variant="primary" onClick={() => P.restoreRecovery(r)}>
                      Restore
                    </Btn>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <section className="mt-9">
          <h3 className="mb-3 text-[13px] font-semibold text-text-2">{project ? `Add data to ${project.title}` : 'Start with your data'}</h3>
          <div className="grid grid-cols-3 gap-3">
            <StartCard testid="start-file" icon={<FileSpreadsheet />} title="Excel, CSV or other file" body="xlsx, xlsm, ods, csv, tsv, json, parquet, SQLite and DuckDB files" onClick={() => void pickDataFiles()} />
            <StartCard testid="start-postgres" icon={<Server />} title="PostgreSQL" body="Query a database live, or keep a fast local extract" onClick={() => runCommand('data.connect')} />
            <StartCard testid="start-blank" icon={<Database />} title={project ? 'Go to Data' : 'Blank project'} body={project ? 'Sources, previews and datasets' : 'Start empty and add sources later'} onClick={() => (project ? set({ workspace: 'data' }) : runCommand('file.new'))} />
          </div>
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center gap-3">
            <h3 className="text-[13px] font-semibold text-text-2">Recent projects</h3>
            <div className="flex gap-1" role="radiogroup" aria-label="Filter recent projects">
              {(['all', 'pinned', 'favorites'] as const).map((f) => (
                <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)} className={cx('h-7 rounded-full px-3 text-[12px] font-medium capitalize transition-colors', filter === f ? 'bg-text text-bg' : 'text-text-2 hover:bg-hover')}>
                  {f}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recent projects" aria-label="Search recent projects" className="h-8 w-full rounded-lg border border-border bg-panel pl-8 pr-3 text-[12.5px] outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]" />
            </div>
          </div>
          {list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5">
              {list.map((r) => (
                <RecentCard key={r.path} r={r} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center rounded-2xl border border-dashed border-border-strong py-14 text-center">
              <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-hover">
                <Clock className="size-5 text-text-3" />
              </div>
              <div className="text-[13.5px] font-medium">{recents.length ? 'No matching projects' : 'No recent projects'}</div>
              <p className="mt-1 max-w-sm text-[12.5px] text-text-3">{recents.length ? 'Try a different search or filter.' : 'Projects you save appear here. Drop a data file anywhere in this window to start.'}</p>
            </div>
          )}
        </section>
        <div className="mt-12 flex items-center justify-center gap-2 text-[12px] text-text-3">
          <Logo size={16} />
          Simple Viz · your data stays on this computer · <Kbd>{formatShortcut(shortcutFor('tools.shortcuts'))}</Kbd> for shortcuts
        </div>
      </div>
    </div>
  )
}

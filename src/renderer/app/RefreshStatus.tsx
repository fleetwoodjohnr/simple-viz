import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, set } from '../state/store'
import { refreshSources, enterPassword } from '../state/project'
import { Pop, PopContent, PopTrigger, Btn, cx } from '../ui'
import type { SourceStatus } from '@/shared/engine-protocol'
import { isRemotePath } from '@/shared/project'

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const s = (Date.now() - ts) / 1000
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  const d = new Date(ts)
  return s < 86400 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function SourceBadge({ s }: { s: SourceStatus | undefined }) {
  if (!s) return <span className="text-[11.5px] text-text-3">Not loaded</span>
  if (s.state === 'checking') return <span className="flex items-center gap-1 text-[11.5px] text-text-3"><Loader2 className="size-3 animate-spin" /> Checking…</span>
  if (s.state === 'error') return <span className="flex items-center gap-1 text-[11.5px] font-medium text-danger" title={s.error}><AlertTriangle className="size-3" /> {s.refreshedAt ? `Stale · last good ${timeAgo(s.refreshedAt)}` : 'Not available'}</span>
  if (s.state === 'stale') return <span className="flex items-center gap-1 text-[11.5px] text-warn"><AlertTriangle className="size-3" /> Cached · {timeAgo(s.refreshedAt)}</span>
  return <span className="flex items-center gap-1 text-[11.5px] text-text-3"><CheckCircle2 className="size-3 text-success" /> Refreshed {timeAgo(s.refreshedAt)}</span>
}

/** Title bar summary of every source's freshness, with a list and a Refresh button. */
export function RefreshStatus() {
  const { sources, project } = useApp(useShallow((s) => ({ sources: s.sources, project: s.project })))
  if (!project?.sources.length) return null
  const list = project.sources.map((src) => ({ src, st: sources[src.id] }))
  const checking = list.some((x) => x.st?.state === 'checking')
  const errors = list.filter((x) => x.st?.state === 'error').length
  const stale = list.filter((x) => !x.st || x.st.state === 'stale').length
  const oldest = Math.min(...list.map((x) => x.st?.refreshedAt ?? 0))
  const label = checking ? 'Checking for new data…' : errors ? `${errors} source${errors > 1 ? 's' : ''} not refreshed` : stale ? 'Showing cached data' : `Data refreshed ${timeAgo(oldest)}`
  return (
    <Pop>
      <PopTrigger asChild>
        <button data-testid="refresh-status" data-state-summary={checking ? 'checking' : errors ? 'error' : stale ? 'stale' : 'ok'} className={cx('no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium hover:bg-hover', errors ? 'text-danger' : stale && !checking ? 'text-warn' : 'text-text-3')}>
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : errors || stale ? <AlertTriangle className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          {label}
        </button>
      </PopTrigger>
      <PopContent align="start" className="w-[380px]">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[13px] font-semibold">Data sources</div>
          <Btn size="sm" onClick={() => void refreshSources(undefined, true)} disabled={checking} data-testid="refresh-all">
            <RefreshCw className={cx('size-3.5', checking && 'animate-spin')} /> Refresh all
          </Btn>
        </div>
        <ul className="space-y-1.5">
          {list.map(({ src, st }) => (
            <li key={src.id} className="rounded-lg bg-panel-2 px-2.5 py-2 shadow-[0_0_0_1px_var(--border)]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-medium">{src.name}</span>
                <SourceBadge s={st} />
              </div>
              {st?.error && <p className="mt-1 text-[11.5px] leading-snug text-danger">{st.error}</p>}
              {st?.auth && (
                <Btn size="sm" className="mt-1.5" onClick={() => void enterPassword(src.id)} data-testid="enter-password">
                  Enter password…
                </Btn>
              )}
              {st?.state === 'error' && src.path && !isRemotePath(src.path) && /missing|moved|renamed/i.test(st.error ?? '') && (
                <Btn size="sm" className="mt-1.5" onClick={() => set({ dialog: { kind: 'relink', sourceId: src.id } })} data-testid="relink-source">
                  Find the file…
                </Btn>
              )}
            </li>
          ))}
        </ul>
      </PopContent>
    </Pop>
  )
}

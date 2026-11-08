import { BarChart3, Database, FlaskConical, Home, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Settings, SquareTerminal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, set, updateSettings, type Workspace } from '../state/store'
import { formatShortcut, runCommand, shortcutFor } from './commands'
import { Tip, cx } from '../ui'

const ITEMS: { id: Workspace; label: string; icon: typeof Home; hint: string }[] = [
  { id: 'home', label: 'Home', icon: Home, hint: 'Recent projects and templates' },
  { id: 'data', label: 'Data', icon: Database, hint: 'Sources, previews and datasets' },
  { id: 'sql', label: 'SQL', icon: SquareTerminal, hint: 'Query any source with SQL' },
  { id: 'charts', label: 'Charts', icon: BarChart3, hint: 'Build visualizations' },
  { id: 'dashboards', label: 'Dashboards', icon: LayoutDashboard, hint: 'Interactive dashboards' },
  { id: 'analytics', label: 'Analytics', icon: FlaskConical, hint: 'Statistics and forecasting' }
]

export function Nav() {
  const { workspace, project, collapsed } = useApp(useShallow((s) => ({ workspace: s.workspace, project: s.project, collapsed: s.settings.navCollapsed })))
  return (
    <nav aria-label="Workspaces" className={cx('flex shrink-0 flex-col border-r border-border bg-bg py-2 transition-[width] duration-150', collapsed ? 'w-[52px] px-1.5' : 'w-[184px] px-2')}>
      <ul className="flex flex-col gap-0.5">
        {ITEMS.map((it) => {
          const disabled = it.id !== 'home' && !project
          const active = workspace === it.id || (it.id === 'home' && !project)
          const sc = shortcutFor(`nav.${it.id}`)
          const btn = (
            <button
              onClick={() => set({ workspace: it.id })}
              disabled={disabled}
              aria-current={active ? 'page' : undefined}
              aria-label={collapsed ? it.label : undefined}
              data-testid={`nav-${it.id}`}
              className={cx(
                'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
                active ? 'bg-accent-soft text-accent-ink' : 'text-text-2 hover:bg-hover hover:text-text'
              )}
            >
              <it.icon className="size-[18px] shrink-0" />
              {!collapsed && <span className="flex-1 truncate text-left">{it.label}</span>}
              {!collapsed && sc && <span className="text-[10.5px] font-normal text-text-2">{formatShortcut(sc)}</span>}
            </button>
          )
          return <li key={it.id}>{collapsed ? <Tip label={`${it.label} — ${it.hint}`} side="right">{btn}</Tip> : btn}</li>
        })}
      </ul>
      <div className="flex-1" />
      <div className={cx('flex gap-0.5', collapsed ? 'flex-col' : 'items-center')}>
        <Tip label="Settings" side="right">
          <button onClick={() => runCommand('tools.settings')} aria-label="Settings" className="flex h-9 w-9 items-center justify-center rounded-lg text-text-2 hover:bg-hover hover:text-text">
            <Settings className="size-[18px]" />
          </button>
        </Tip>
        <Tip label={collapsed ? 'Expand navigation' : 'Collapse navigation'} side="right">
          <button onClick={() => updateSettings({ navCollapsed: !collapsed })} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} className="flex h-9 w-9 items-center justify-center rounded-lg text-text-2 hover:bg-hover hover:text-text">
            {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
          </button>
        </Tip>
      </div>
    </nav>
  )
}

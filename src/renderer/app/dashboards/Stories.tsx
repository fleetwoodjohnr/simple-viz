// Stories (Tableau's story points): dashboards in order, each with a caption, shown one point at a time — in the
// workspace, or full screen with ← → like a presentation. The dashboards stay interactive.

import { useEffect, useRef } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, Filter, Maximize, Plus, Trash2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../state/store'
import * as P from '../../state/project'
import { Btn, IconBtn, cx, inputCls } from '../../ui'
import { newId } from '@/core/project/sviz'
import type { Story } from '@/shared/project'
import { useDash, setDash, getDash, NO_SELECTIONS } from './runtime'
import { Canvas } from './DashboardsView'

const NO_STORIES: Story[] = []
const editStory = (id: string, fn: (s: Story) => Story) => P.edit((p) => ({ ...p, stories: (p.stories ?? []).map((s) => (s.id === id ? fn(s) : s)) }))

/** The sidebar's list of stories. */
export function StoryList() {
  const stories = useApp((s) => s.project?.stories ?? NO_STORIES)
  const dashboards = useApp((s) => s.project!.dashboards)
  const current = useDash((s) => s.story)
  const create = () => {
    const story: Story = { id: newId(), name: `Story ${stories.length + 1}`, points: dashboards.map((d) => ({ id: newId(), dashboard: d.id, caption: d.name })) }
    P.edit((p) => ({ ...p, stories: [...(p.stories ?? []), story] }))
    setDash({ story: story.id, storyPoint: 0, selected: [] })
  }
  return (
    <div className="px-2 pt-3">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Stories</span>
        <IconBtn size="sm" label="New story" onClick={create} disabled={!dashboards.length} data-testid="new-story">
          <Plus className="size-3.5" />
        </IconBtn>
      </div>
      <ul className="space-y-0.5" aria-label="Stories">
        {stories.map((s) => (
          <li key={s.id}>
            <button aria-current={current === s.id ? 'page' : undefined} onClick={() => setDash({ story: s.id, storyPoint: 0, selected: [] })} className={cx('flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px]', current === s.id ? 'bg-accent-soft font-medium text-accent-ink' : 'hover:bg-hover')} data-testid={`story-${s.name}`}>
              <BookOpen className="size-3.5 shrink-0" />
              <span className="truncate">{s.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A story in the workspace: its points as captions on top, the current point's dashboard below. */
export function StoryView({ story, presenting }: { story: Story; presenting?: boolean }) {
  const dashboards = useApp((s) => s.project!.dashboards)
  const { point } = useDash(useShallow((s) => ({ point: s.storyPoint })))
  const ref = useRef<HTMLDivElement>(null)
  const i = Math.min(point, Math.max(0, story.points.length - 1))
  const cur = story.points[i]
  const d = cur && dashboards.find((x) => x.id === cur.dashboard)
  const go = (j: number) => j >= 0 && j < story.points.length && setDash({ storyPoint: j })
  // A point with captured filters and clicked marks shows them (Tableau's story points keep their dashboard's state).
  const kept = cur?.selections
  const keptMarks = cur?.marks
  useEffect(() => {
    if (cur && kept) setDash((s) => ({ selections: { ...s.selections, [cur.dashboard]: structuredClone(kept) }, marks: { ...s.marks, [cur.dashboard]: structuredClone(keptMarks ?? []) } }))
  }, [cur?.id, kept, keptMarks]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useDash((s) => (cur ? JSON.stringify([s.selections[cur.dashboard] ?? NO_SELECTIONS, s.marks[cur.dashboard] ?? []]) : ''))
  const capture = () => cur && setPoints((pts) => pts.map((p) => (p.id === cur.id ? { ...p, selections: structuredClone(getDash().selections[cur.dashboard] ?? {}), marks: structuredClone(getDash().marks[cur.dashboard] ?? []) } : p)))
  useEffect(() => {
    if (!presenting) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(i + 1)
      if (e.key === 'ArrowLeft') go(i - 1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  const setPoints = (fn: (pts: Story['points']) => Story['points']) => editStory(story.id, (s) => ({ ...s, points: fn(s.points) }))
  const move = (by: number) => {
    setPoints((pts) => {
      const next = [...pts]
      const [x] = next.splice(i, 1)
      next.splice(i + by, 0, x)
      return next
    })
    go(i + by)
  }
  return (
    <div className={cx('flex min-w-0 flex-1 flex-col', presenting && 'fixed inset-0 z-[70] bg-workspace')} data-testid={presenting ? 'presentation' : 'story-view'}>
      <div className="flex items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5">
        {presenting ? (
          <span className="mr-2 truncate text-[14px] font-semibold">{story.name}</span>
        ) : (
          <div className="w-56 shrink-0">
            <input aria-label="Story name" className={cx(inputCls, 'h-7 text-[13px] font-semibold')} defaultValue={story.name} key={story.id} onBlur={(e) => e.target.value.trim() && editStory(story.id, (s) => ({ ...s, name: e.target.value.trim() }))} />
          </div>
        )}
        <div className="flex-1" />
        {presenting ? (
          <>
            <span className="text-[11.5px] text-text-3">Esc to leave · ← → to move</span>
            <IconBtn label="Leave presentation" onClick={() => setDash({ presenting: false })} data-testid="leave-presentation">
              <X className="size-4" />
            </IconBtn>
          </>
        ) : (
          <>
            <div className="w-44 shrink-0">
            <select aria-label="Add a story point" className={cx(inputCls, 'h-7 text-[12px]')} value="" onChange={(e) => {
              const dash = dashboards.find((x) => x.id === e.target.value)
              if (!dash) return
              setPoints((pts) => [...pts, { id: newId(), dashboard: dash.id, caption: dash.name }])
              setDash({ storyPoint: story.points.length })
            }} data-testid="story-add-point">
              <option value="">Add a point…</option>
              {dashboards.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            </div>
            <IconBtn label="Present the story (Esc to leave)" onClick={() => setDash({ presenting: true, selected: [] })} data-testid="present-story">
              <Maximize className="size-4" />
            </IconBtn>
            <IconBtn label="Delete the story" onClick={() => (P.edit((p) => ({ ...p, stories: (p.stories ?? []).filter((s) => s.id !== story.id) })), setDash({ story: null }))}>
              <Trash2 className="size-4" />
            </IconBtn>
          </>
        )}
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-border bg-panel px-3 py-1.5" role="tablist" aria-label="Story points">
        {story.points.map((p, j) => (
          <button key={p.id} role="tab" aria-selected={j === i} onClick={() => go(j)} className={cx('h-8 max-w-[240px] shrink-0 truncate rounded-lg px-3 text-[12.5px]', j === i ? 'bg-accent-soft font-medium text-accent-ink' : 'text-text-2 hover:bg-hover')} data-testid={`story-point-${j}`}>
            {j + 1}. {p.caption || 'Untitled'}
          </button>
        ))}
      </div>
      {cur && !presenting && (
        <div className="flex items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5">
          <input aria-label="Caption" className={cx(inputCls, 'h-7 flex-1 text-[12.5px]')} defaultValue={cur.caption} key={cur.id} onBlur={(e) => e.target.value !== cur.caption && setPoints((pts) => pts.map((p) => (p.id === cur.id ? { ...p, caption: e.target.value } : p)))} data-testid="story-caption" />
          <IconBtn size="sm" label="Move earlier" disabled={i === 0} onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
          </IconBtn>
          <IconBtn size="sm" label="Move later" disabled={i === story.points.length - 1} onClick={() => move(1)}>
            <ChevronRight className="size-4" />
          </IconBtn>
          <Btn size="sm" variant="ghost" onClick={capture} title="This point will show the dashboard with the filter choices and clicked marks it has now" data-testid="story-capture">
            <Filter className="size-3.5" /> {kept ? (JSON.stringify([kept, keptMarks ?? []]) === live ? 'Filters kept' : 'Keep the new filters') : 'Keep these filters'}
          </Btn>
          {kept && (
            <Btn size="sm" variant="ghost" onClick={() => setPoints((pts) => pts.map((p) => (p.id === cur.id ? { id: p.id, dashboard: p.dashboard, caption: p.caption } : p)))} data-testid="story-forget">
              Forget filters
            </Btn>
          )}
          <Btn size="sm" variant="ghost" onClick={() => (setPoints((pts) => pts.filter((p) => p.id !== cur.id)), go(Math.max(0, i - 1)))}>
            Remove point
          </Btn>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {d ? <Canvas d={{ ...d, size: { ...d.size, mode: 'fit' } }} edit={false} canvasRef={ref} /> : <div className="flex h-full items-center justify-center text-[12.5px] text-text-3">{cur ? 'This point’s dashboard was deleted.' : 'Add a point: choose a dashboard above.'}</div>}
      </div>
    </div>
  )
}

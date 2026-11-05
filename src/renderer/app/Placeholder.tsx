// Shown for a workspace whose milestone has not landed yet (see IMPLEMENTATION_STATUS.md). Removed as each lands.
import type { Workspace } from '../state/store'

const PLANNED: Partial<Record<Workspace, string>> = {
  analytics: 'The statistics workspace is milestone M5.'
}

export function Placeholder({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex h-full items-center justify-center p-10 text-center" data-testid={`placeholder-${workspace}`}>
      <div>
        <div className="text-[15px] font-semibold capitalize">{workspace}</div>
        <p className="mt-1 text-[13px] text-text-3">Not built yet. {PLANNED[workspace]}</p>
      </div>
    </div>
  )
}

// The renderer's side of the engine port: requests with ids, answers matched back, cancel by id.
// The port arrives from the preload as a window message; requests made before it arrives wait for it.

import type { QueryResult, RelationInfo, RendererRequest, ResultPage, SourceStatus } from '@/shared/engine-protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let port: MessagePort | null = null
let seq = 0
const pending = new Map<number, Pending>()
let waiting: (() => void)[] = []
const listeners = new Set<() => void>()

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data !== 'simple-viz:engine-port' || !e.ports?.[0]) return
  port?.close()
  for (const p of pending.values()) p.reject(new Error('The engine restarted. Run the query again.'))
  pending.clear()
  port = e.ports[0]
  port.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const m = ev.data
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.result)
    else p.reject(new Error(m.error ?? 'Query failed'))
  }
  const w = waiting
  waiting = []
  w.forEach((f) => f())
  listeners.forEach((f) => f())
})

/** Called each time a new engine port arrives (first start, restarts). */
export function onEngineConnected(f: () => void) {
  listeners.add(f)
  return () => listeners.delete(f)
}

export const engineReady = () => !!port

// While the project's sources or datasets are being applied, new requests wait, so they see the new configuration.
let barrier: Promise<unknown> = Promise.resolve()
export function holdRequestsUntil(p: Promise<unknown>) {
  barrier = p.catch(() => {})
}

function send<T>(req: RendererRequest, bypass = false): { id: number; done: Promise<T> } {
  const id = ++seq
  const wait = bypass || req.op === 'cancel' ? Promise.resolve() : barrier
  const done = wait.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const go = () => {
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
          port!.postMessage({ ...req, id })
        }
        if (port) go()
        else waiting.push(go)
      })
  )
  return { id, done }
}

export function runQuery(sql: string, opts: { params?: Record<string, string | number | boolean | null>; keep?: boolean; limit?: number } = {}) {
  return send<QueryResult>({ op: 'query', sql, ...opts })
}

export const query = (sql: string, opts?: Parameters<typeof runQuery>[1]) => runQuery(sql, opts).done
export const page = (resultId: string, offset: number, limit: number) => send<ResultPage>({ op: 'page', resultId, offset, limit }).done
export const release = (resultId: string) => send<void>({ op: 'release', resultId }).done.catch(() => {})
export const cancel = (target: number) => send<void>({ op: 'cancel', target }).done.catch(() => {})
export const explain = (sql: string) => send<string>({ op: 'explain', sql }).done
export const validate = (sql: string) => send<true>({ op: 'validate', sql }).done

export interface Description {
  relations: RelationInfo[]
  datasetErrors: Record<string, string>
  deps: Record<string, string[]>
  statuses: SourceStatus[]
}
/** The relations and statuses as they are now (does not wait for a pending reconfiguration: it is part of applying one). */
export const describe = () => send<Description>({ op: 'describe' }, true).done

// Entry of the engine utility process. Two channels:
//  - process.parentPort, from main: boot (with resolved sources and credentials), refresh, export, probes;
//  - a MessagePort per window, from the renderer: queries, paging, cancel, describe. Validated, never trusted.

import { promises as fs } from 'node:fs'
import { Engine } from './engine'
import { checkRendererRequest, type ControlMessage, type EngineResponse } from '../shared/engine-protocol'
import { readWorkbook, listTables, type SheetFormat } from '../core/sheets/rows'

interface PortLike {
  on(ev: 'message', cb: (e: { data: unknown; ports: PortLike[] }) => void): void
  postMessage(m: unknown): void
  start(): void
  close(): void
}

const parent = (process as unknown as { parentPort: PortLike }).parentPort
const engine = new Engine()
let extensionsDir: string | null = null
let port: PortLike | null = null

engine.onStatus = (sources) => parent.postMessage({ event: 'status', sources })
engine.onLog = (level, message) => parent.postMessage({ event: 'log', level, message })

async function control(m: ControlMessage): Promise<unknown> {
  switch (m.op) {
    case 'boot':
      extensionsDir = m.config.extensionsDir
      await engine.boot(m.config)
      // Draw from the cache now; bring sources up to date in the background.
      {
        const ids = engine.bootRefreshIds()
        if (ids.length) void engine.refresh(ids).catch((e) => engine.onLog('error', (e as Error).message))
        else engine.onStatus(engine.statuses())
      }
      return engine.statuses()
    case 'refresh':
      return engine.refresh(m.sourceIds, m.force)
    case 'export':
      return engine.work(() => engine.exportTo(m.sql, m.format, m.file))
    case 'tables':
      return (await Engine.probe(m.source, extensionsDir)).tables
    case 'sheets': {
      const wb = readWorkbook(new Uint8Array(await fs.readFile(m.path)), m.format as SheetFormat)
      return listTables(wb)
    }
  }
}

parent.on('message', (e) => {
  const m = e.data as ControlMessage & { type?: string }
  if (m?.type === 'port') {
    port?.close()
    port = e.ports[0]
    const p = port
    p.on('message', (ev) => void onRenderer(p, ev.data))
    p.start()
    return
  }
  control(m).then(
    (result) => parent.postMessage({ id: m.id, ok: true, result }),
    (err: Error) => parent.postMessage({ id: m.id, ok: false, error: err.message })
  )
})

async function onRenderer(p: PortLike, data: unknown) {
  let id = -1
  let res: EngineResponse
  try {
    const req = checkRendererRequest(data)
    id = req.id
    if (req.op !== 'cancel') await engine.whenReady()
    let result: unknown
    switch (req.op) {
      case 'query':
        result = await engine.work(() => engine.query(req.id, req.sql, { params: req.params, keep: req.keep, limit: req.limit }))
        break
      case 'page':
        result = await engine.work(() => engine.page(req.resultId, req.offset, req.limit))
        break
      case 'release':
        result = await engine.work(() => engine.release(req.resultId))
        break
      case 'cancel':
        result = engine.cancel(req.target)
        break
      case 'describe':
        result = { ...engine.describe(), statuses: engine.statuses() }
        break
      case 'explain':
        result = await engine.work(() => engine.explain(req.sql))
        break
      case 'validate':
        await engine.work(() => engine.gate(req.sql))
        result = true
        break
    }
    res = { id, ok: true, result }
  } catch (e) {
    res = { id, ok: false, error: (e as Error).message }
  }
  p.postMessage(res)
}

process.on('uncaughtException', (e) => parent.postMessage({ event: 'log', level: 'error', message: `Uncaught: ${e.stack ?? e.message}` }))

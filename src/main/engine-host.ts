// Runs the engine (src/engine) in an Electron utility process, restarts it if it crashes, and hands the renderer a
// MessagePort to it. Only main sends control messages (boot with resolved paths and credentials, refresh, export).

import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import path from 'node:path'
import type { ControlRequest, EngineConfig, EngineEvent, SourceStatus } from '../shared/engine-protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class EngineHost {
  private child: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private config: EngineConfig | null = null
  private stopping = false
  private crashes: number[] = []
  private ready: Promise<void> | null = null
  constructor(
    private web: () => WebContents | null,
    private onStatus: (s: SourceStatus[]) => void,
    private log: (level: string, message: string) => void = (l, m) => console[l === 'error' ? 'error' : 'log'](`[engine] ${m}`)
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], { serviceName: 'Simple Viz engine', stdio: 'inherit' })
      this.child = child
      child.once('spawn', () => resolve())
      child.on('message', (m: { id?: number; ok?: boolean; result?: unknown; error?: string } & Partial<EngineEvent>) => {
        if (m.event === 'status') return this.onStatus(m.sources ?? [])
        if (m.event === 'log') return this.log(m.level ?? 'info', m.message ?? '')
        const p = m.id !== undefined ? this.pending.get(m.id) : undefined
        if (!p) return
        this.pending.delete(m.id!)
        if (m.ok) p.resolve(m.result)
        else p.reject(new Error(m.error ?? 'Engine error'))
      })
      child.on('exit', (code) => {
        this.child = null
        this.ready = null
        for (const p of this.pending.values()) p.reject(new Error('The engine stopped. It restarts automatically; run the query again.'))
        this.pending.clear()
        if (this.stopping) return
        this.log('error', `Engine exited with code ${code}`)
        this.crashes.push(Date.now())
        this.crashes = this.crashes.filter((t) => Date.now() - t < 60_000)
        if (this.crashes.length > 3) return this.log('error', 'Engine keeps crashing; not restarting.')
        // Come back with the same project, and give the window a new port.
        setTimeout(() => void this.restart(), 300)
      })
      child.once('error', (e) => reject(new Error(`The engine failed to start: ${String((e as { type?: string }).type ?? e)}`)))
    })
    return this.ready
  }

  private async restart() {
    await this.start()
    if (this.config) await this.request({ op: 'boot', config: this.config }).catch((e) => this.log('error', (e as Error).message))
    this.web()?.send('engine:restart')
    this.connectRenderer()
  }

  /** A fresh port for the window; the old one (if any) stops working. */
  connectRenderer() {
    const wc = this.web()
    if (!wc || !this.child) return
    const { port1, port2 } = new MessageChannelMain()
    this.child.postMessage({ type: 'port' }, [port1])
    wc.postMessage('engine:port', null, [port2])
  }

  async request<T = unknown>(req: ControlRequest): Promise<T> {
    await this.start()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child!.postMessage({ ...req, id })
    })
  }

  async boot(config: EngineConfig) {
    this.config = config
    await this.request({ op: 'boot', config })
  }

  stop() {
    this.stopping = true
    this.child?.kill()
  }
}

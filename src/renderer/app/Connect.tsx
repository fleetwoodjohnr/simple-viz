// Adding data: the sheet picker for spreadsheets, the PostgreSQL connection dialog, and relinking moved files.

import { useEffect, useState } from 'react'
import { FileSpreadsheet, Loader2, Server, Table2, Tag } from 'lucide-react'
import { useApp, get, toast } from '../state/store'
import * as P from '../state/project'
import { close } from './Dialogs'
import { Btn, Field, Modal, Segmented, cx, inputCls } from '../ui'
import { newId } from '@/core/project/sviz'
import { DEFAULT_REFRESH, FILE_FORMATS, type DbSource } from '@/shared/project'

type SheetRef = { ref: string; kind: 'sheet' | 'table' | 'name'; rows: number; columns: number }

export function SheetPicker({ path }: { path: string }) {
  const [tables, setTables] = useState<SheetRef[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [range, setRange] = useState('')
  const [error, setError] = useState('')
  const name = path.split(/[\\/]/).pop()!
  useEffect(() => {
    window.simpleViz.sheetTables(path).then(
      (t) => {
        setTables(t)
        // Excel tables are the cleanest data when present; otherwise every sheet.
        const tbls = t.filter((x) => x.kind === 'table')
        setPicked(new Set((tbls.length ? tbls : t.filter((x) => x.kind === 'sheet')).map((x) => x.ref)))
      },
      (e: Error) => setError(e.message)
    )
  }, [path])
  const toggle = (ref: string) => setPicked((s) => (s.has(ref) ? new Set([...s].filter((x) => x !== ref)) : new Set([...s, ref])))
  const refs = [...picked, ...(range.trim() ? [range.trim()] : [])]
  const add = () => {
    const ext = name.split('.').pop()!.toLowerCase()
    P.addSource(P.fileSource(path, FILE_FORMATS[ext], refs))
    close()
  }
  const icon = { sheet: <FileSpreadsheet className="size-4 text-text-3" />, table: <Table2 className="size-4 text-text-3" />, name: <Tag className="size-4 text-text-3" /> }
  return (
    <Modal open onOpenChange={(o) => !o && close()} title={`Add data from ${name}`} description="Choose the sheets, Excel tables or named ranges to use. Each becomes a table you can query with SQL." width={520} footer={<><Btn onClick={close}>Cancel</Btn><Btn variant="primary" disabled={!refs.length} onClick={add} data-testid="sheet-add">Add {refs.length || ''}</Btn></>}>
      {error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : !tables ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-text-3"><Loader2 className="size-4 animate-spin" /> Reading the workbook…</div>
      ) : (
        <>
          <ul className="max-h-[300px] space-y-1 overflow-y-auto" data-testid="sheet-list">
            {tables.map((t) => (
              <li key={`${t.kind}:${t.ref}`}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
                  <input type="checkbox" checked={picked.has(t.ref)} onChange={() => toggle(t.ref)} className="size-4 accent-[var(--accent)]" />
                  {icon[t.kind]}
                  <span className="flex-1 text-[13px] font-medium">{t.ref}</span>
                  <span className="text-[11.5px] text-text-3">
                    {t.kind === 'sheet' ? 'Sheet' : t.kind === 'table' ? 'Table' : 'Named range'} · {t.rows.toLocaleString()} rows × {t.columns} cols
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Field label="Or a cell range" hint="For example Sales!A3:F500. The first row holds the column names.">
              <input className={inputCls} value={range} onChange={(e) => setRange(e.target.value)} placeholder="Sheet!A1:D100" aria-label="Cell range" />
            </Field>
          </div>
        </>
      )}
    </Modal>
  )
}

export function ConnectDialog() {
  const settings = useApp((s) => s.settings)
  const [f, setF] = useState({ name: '', host: 'localhost', port: 5432, database: 'postgres', user: '', password: '', sslmode: 'prefer' as DbSource['sslmode'], mode: 'extract' as DbSource['mode'], timeoutSec: settings.refreshTimeoutSec })
  const [tables, setTables] = useState<string[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keychain, setKeychain] = useState<{ secure: boolean } | null>(null)
  const [id] = useState(newId)
  useEffect(() => void window.simpleViz.credentialStatus().then(setKeychain), [])
  const upd = (patch: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...patch }))
    setTables(null)
    setError('')
  }
  const source = (): DbSource => ({ id, kind: 'postgres', name: f.name || `${f.database} on ${f.host}`, host: f.host.trim(), port: Number(f.port) || 5432, database: f.database.trim(), user: f.user.trim(), sslmode: f.sslmode, mode: f.mode, timeoutSec: f.timeoutSec, tables: [], refresh: { ...DEFAULT_REFRESH, watch: false } })
  const test = async () => {
    setBusy(true)
    setError('')
    try {
      const t = await window.simpleViz.connectionTables({ source: source(), password: f.password })
      setTables(t)
      setPicked(new Set(t.length <= 8 ? t : []))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    if (f.password) await window.simpleViz.credentialSet(id, f.password)
    const taken = P.usedNames()
    const tablesOut = [...picked].map((ref) => {
      const alias = P.uniqueAlias(ref.split('.').pop()!, taken)
      taken.add(alias)
      return { alias, ref }
    })
    P.addSource({ ...source(), tables: tablesOut })
    close()
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && close()}
      title={
        <span className="flex items-center gap-2">
          <Server className="size-4 text-accent-ink" /> Connect to PostgreSQL
        </span>
      }
      description="Simple Viz only reads from the database. The password is kept in your system keychain, never in the project file."
      width={560}
      footer={
        <>
          <Btn onClick={close}>Cancel</Btn>
          {tables ? (
            <Btn variant="primary" disabled={!picked.size} onClick={add} data-testid="pg-add">
              Add {picked.size} table{picked.size === 1 ? '' : 's'}
            </Btn>
          ) : (
            <Btn variant="primary" disabled={busy || !f.host || !f.database} onClick={test} data-testid="pg-test">
              {busy && <Loader2 className="size-4 animate-spin" />} Connect
            </Btn>
          )}
        </>
      }
    >
      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field label="Host">
          <input className={inputCls} value={f.host} onChange={(e) => upd({ host: e.target.value })} aria-label="Host" data-testid="pg-host" />
        </Field>
        <Field label="Port">
          <input className={inputCls} type="number" value={f.port} onChange={(e) => upd({ port: Number(e.target.value) })} aria-label="Port" data-testid="pg-port" />
        </Field>
        <Field label="Database">
          <input className={inputCls} value={f.database} onChange={(e) => upd({ database: e.target.value })} aria-label="Database" data-testid="pg-database" />
        </Field>
        <Field label="SSL">
          <select className={inputCls} value={f.sslmode} onChange={(e) => upd({ sslmode: e.target.value as DbSource['sslmode'] })} aria-label="SSL mode">
            <option value="disable">Off</option>
            <option value="prefer">Prefer</option>
            <option value="require">Require</option>
            <option value="verify-full">Verify</option>
          </select>
        </Field>
        <Field label="User">
          <input className={inputCls} value={f.user} onChange={(e) => upd({ user: e.target.value })} aria-label="User" autoComplete="off" data-testid="pg-user" />
        </Field>
        <div />
        <Field label="Password" hint={keychain && !keychain.secure ? 'No system keychain was found: the password is kept until you quit.' : undefined}>
          <input className={inputCls} type="password" value={f.password} onChange={(e) => upd({ password: e.target.value })} aria-label="Password" autoComplete="off" data-testid="pg-password" />
        </Field>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 rounded-lg bg-panel-2 px-3 py-2.5 shadow-[0_0_0_1px_var(--border)]">
        <div>
          <div className="text-[13px] font-medium">How to use the data</div>
          <div className="text-[12px] text-text-3">{f.mode === 'extract' ? 'Copy into a fast local cache; refreshed on open and on demand. Works offline.' : 'Query the server every time (filters run on the server). Needs the connection.'}</div>
        </div>
        <Segmented value={f.mode} onChange={(v) => upd({ mode: v })} label="Connection mode" options={[{ value: 'extract', label: 'Extract' }, { value: 'live', label: 'Live' }]} />
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert" data-testid="pg-error">
          {error}
        </p>
      )}
      {tables && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-[12px] font-medium text-text-2">
            <span>Tables ({tables.length})</span>
            <button className="text-accent-ink hover:underline" onClick={() => setPicked(new Set(picked.size === tables.length ? [] : tables))}>
              {picked.size === tables.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          <ul className="max-h-[220px] overflow-y-auto rounded-lg border border-border" data-testid="pg-tables">
            {tables.map((t) => (
              <li key={t}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-hover">
                  <input type="checkbox" checked={picked.has(t)} onChange={() => setPicked((s) => (s.has(t) ? new Set([...s].filter((x) => x !== t)) : new Set([...s, t])))} className="size-4 accent-[var(--accent)]" />
                  <span className="text-[13px]">{t}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

export function RelinkDialog({ sourceId }: { sourceId: string }) {
  const src = useApp((s) => s.project?.sources.find((x) => x.id === sourceId))
  const [suggestion, setSuggestion] = useState<string | null>(null)
  useEffect(() => {
    const projectPath = get().path
    if (!src?.path || !projectPath) return
    const sep = projectPath.includes('\\') ? '\\' : '/'
    const candidate = projectPath.slice(0, projectPath.lastIndexOf(sep) + 1) + src.path.split(/[\\/]/).pop()
    if (candidate !== src.path) void window.simpleViz.fileExists(candidate).then((ok) => ok && setSuggestion(candidate))
  }, [src])
  if (!src) return null
  const relink = (path: string) => {
    P.updateSource(src.id, { path })
    close()
    toast(`${src.name} now reads ${path}`, 'success')
  }
  const find = async () => {
    const ext = src.path?.split('.').pop() ?? '*'
    const [p] = await window.simpleViz.pickFiles({ name: src.name, extensions: [ext] })
    if (p) relink(p)
  }
  return (
    <Modal open onOpenChange={(o) => !o && close()} title={`Find ${src.name}`} description="The file this source reads was moved or renamed. Point Simple Viz at its new location; charts and SQL keep working." width={520} footer={<><Btn onClick={close}>Cancel</Btn><Btn variant="primary" onClick={find}>Find file…</Btn></>}>
      <p className="select-text break-all rounded-lg bg-panel-2 px-3 py-2 font-mono text-[12px] text-text-2">{src.path}</p>
      {suggestion && (
        <div className={cx('mt-3 flex items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2')}>
          <span className="min-w-0 break-all text-[12.5px]">Found next to the project: {suggestion}</span>
          <Btn size="sm" variant="primary" onClick={() => relink(suggestion)}>
            Use it
          </Btn>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12.5px] text-text-2">Remove this source instead</span>
        <Btn size="sm" variant="danger" onClick={() => (P.removeSource(src.id), close())}>
          Remove
        </Btn>
      </div>
    </Modal>
  )
}

// One connected glasses client (phone WebView). Owns the command queue and
// the last view committed to that specific display, so several clients (the
// glasses plus the simulator, say) can be driven from a single shell.
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import type { ClientFrame, CmdArgs, CmdOp, DeviceInfo, HelloFrame, NormalizedEvent, ServerFrame, UserInfo } from '../shared/protocol.ts'
import type { View } from '../shared/view.ts'
import { compile, diff, type Compiled } from './renderer.ts'
import { log } from './log.ts'

const RESULT_TIMEOUT_MS = 12000
let nextConnId = 1

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; op: CmdOp }

export interface ConnectionSummary {
  id: number; remote: string; connectedAt: number
  client: HelloFrame['client'] | null; device: DeviceInfo | null; user: UserInfo | null
  launchSource: string | null; pageCreated: boolean; audioOn: boolean; imuOn: boolean
}

export class Connection extends EventEmitter {
  readonly id = nextConnId++
  readonly connectedAt = Date.now()
  device: DeviceInfo | null = null
  user: UserInfo | null = null
  launchSource: string | null = null
  client: HelloFrame['client'] | null = null
  tz: string | null = null
  locale: string | null = null
  alive = true
  /** last compiled view known to be on the glasses */
  committed: Compiled | null = null
  pageCreated = false
  audioOn = false
  imuOn = false
  private pending = new Map<number, Pending>()
  private nextCmdId = 1
  private queue: Promise<unknown> = Promise.resolve()
  /** latest requested view while a render is in flight */
  private wantView: View | null = null
  private rendering = false
  /** when the in-flight render started (0 = idle); used for input debouncing */
  busySince = 0
  /** consecutive failed page builds; after a few we stop trying until the client comes back */
  private pageFailures = 0
  /** heartbeat: set false on ping, true on pong; two misses = dead */
  alivePing = true
  /** the last gesture accepted from this client (input debouncing is per client) */
  lastInput: (NormalizedEvent & { ts: number; conn: number }) | null = null

  readonly ws: WebSocket
  readonly remote: string
  constructor(ws: WebSocket, remote: string) { super(); this.ws = ws; this.remote = remote }

  /** Called when the client's page state is unknown; forces a full rebuild. */
  resetPage(): void { this.committed = null; this.pageFailures = 0 }

  send(frame: ServerFrame): boolean {
    if (this.ws.readyState !== 1) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  /** Send a command and await the client's result. */
  cmd<O extends CmdOp>(op: O, args: CmdArgs[O]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextCmdId++
      if (!this.send({ t: 'cmd', id, op, args } as ServerFrame)) { reject(new Error('socket closed')); return }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${op} timed out`))
      }, RESULT_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer, op })
    })
  }

  handleResult(frame: Extract<ClientFrame, { t: 'result' }>): void {
    const p = this.pending.get(frame.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(frame.id)
    if (frame.ok) p.resolve(frame.value)
    else p.reject(new Error(frame.error || `${p.op} failed`))
  }

  /**
   * Render a view. Coalesces: if called while a render is in flight only the
   * newest view is applied afterwards.
   */
  render(view: View): Promise<unknown> {
    this.wantView = view
    if (this.rendering) return this.queue
    this.rendering = true
    this.busySince = Date.now()
    this.queue = this.queue.then(() => this.drain()).catch((err: Error) => {
      log('error', `conn ${this.id} render: ${err.message}`)
    }).finally(() => { this.rendering = false; this.busySince = 0 })
    return this.queue
  }

  private async drain(): Promise<void> {
    while (this.wantView !== null && this.alive) {
      const view = this.wantView
      this.wantView = null
      const next = compile(view)
      const ops = diff(this.committed, next)
      if (!ops.length) continue
      let ok = true
      for (const { op, args } of ops) {
        try {
          await this.cmd(op, args as never)
          if (op === 'page') { this.pageCreated = true; this.pageFailures = 0 }
        } catch (err) {
          ok = false
          log('warn', `conn ${this.id} ${op} failed: ${(err as Error).message}`)
          // The display no longer matches what we believe; rebuild next pass
          // (a failed page build too — otherwise nothing is drawn until the
          // next gesture or refresh).
          this.committed = null
          this.wantView = this.wantView ?? view
          if (op === 'page') {
            // The glasses page is gone (the Even app ejected it, the link is
            // wedged): back off, and stop after a few tries — the client will
            // say hello again when it recovers, and that resets us.
            if (++this.pageFailures >= 5) { log('warn', `conn ${this.id}: page build failed ${this.pageFailures}×, waiting for the client to come back`); this.wantView = null; return }
            await new Promise((r) => setTimeout(r, Math.min(8000, 1500 * this.pageFailures)))
          }
          break
        }
      }
      if (ok) this.committed = next
      this.emit('rendered', { view: next, ops: ops.map((o) => o.op) })
    }
  }

  close(): void {
    this.alive = false
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')) }
    this.pending.clear()
    try { this.ws.close() } catch {}
  }

  summary(): ConnectionSummary {
    return {
      id: this.id, remote: this.remote, connectedAt: this.connectedAt,
      client: this.client, device: this.device, user: this.user,
      launchSource: this.launchSource, pageCreated: this.pageCreated,
      audioOn: this.audioOn, imuOn: this.imuOn,
    }
  }
}

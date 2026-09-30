// Reconnecting WebSocket with exponential backoff. Binary frames carry raw
// PCM when the mic is on; everything else is JSON text.

import type { ServerFrame } from './protocol'

export type WsHandlers = {
  onOpen: () => void
  onClose: (reason: string) => void
  onJson: (frame: ServerFrame) => void
}

export class OmniSocket {
  private ws: WebSocket | null = null
  private url = ''
  private attempts = 0
  private closedByUser = false
  private timer: number | null = null

  constructor(private handlers: WsHandlers) {}

  connect(url: string) {
    this.url = url
    this.closedByUser = false
    this.attempts = 0
    this.open()
  }

  disconnect() {
    this.closedByUser = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.ws?.close()
    this.ws = null
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN }

  send(frame: unknown) {
    if (!this.connected) return false
    this.ws!.send(JSON.stringify(frame))
    return true
  }

  sendBinary(buf: ArrayBuffer | Uint8Array) {
    if (!this.connected) return false
    this.ws!.send(buf)
    return true
  }

  private open() {
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => { this.attempts = 0; this.handlers.onOpen() }
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return
        try { this.handlers.onJson(JSON.parse(e.data)) } catch (err) { console.warn('bad frame', err) }
      }
      ws.onerror = () => { /* onclose follows */ }
      ws.onclose = (e) => {
        if (this.ws !== ws) return
        this.ws = null
        this.handlers.onClose(`${e.code} ${e.reason || ''}`.trim())
        this.scheduleReconnect()
      }
    } catch (err) {
      this.handlers.onClose(String(err))
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.closedByUser) return
    // Fast at first, and never more than a few seconds apart: a dropped socket
    // during a live app (a recording, say) must not sit idle for half a minute.
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts++, 5))
    this.timer = window.setTimeout(() => this.open(), delay)
  }
}

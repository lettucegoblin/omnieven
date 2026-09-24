// HTTP API. Everything the glasses show can be driven from here, which is
// what lets an agent (or a cron job, or a shell script) push to the display.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventEmitter } from 'node:events'
import type { HttpResponse } from '../shared/app.ts'
import { compile } from './renderer.ts'
import { recentLogs, onLog } from './log.ts'
import { VERSION } from './config.ts'
import type { Shell } from './shell.ts'

const started = Date.now()

export function readJson(req: IncomingMessage): Promise<any> {
  return readText(req).then((body) => {
    try { return body ? JSON.parse(body) : {} } catch { throw new Error('invalid JSON') }
  })
}
export function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 5e6) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}
export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}
/**
 * An app's http hook may return: null → 204; a string → text/plain;
 * {status?, headers?, body?, json?} → explicit; anything else → JSON 200.
 */
export function sendResult(res: ServerResponse, result: Exclude<HttpResponse, undefined>): void {
  if (result === null) { res.writeHead(204); res.end(); return }
  if (typeof result === 'string') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(result); return }
  if (typeof result === 'object' && ('status' in result || 'headers' in result || 'body' in result || 'json' in result)) {
    const r = result as { status?: number; headers?: Record<string, string>; body?: string | Uint8Array; json?: unknown }
    const status = r.status ?? 200
    if (r.json !== undefined) { sendJson(res, status, r.json); return }
    const body = r.body instanceof Uint8Array ? Buffer.from(r.body) : String(r.body ?? '')
    // The app's own headers replace the defaults even when their case differs —
    // two Content-Type headers would otherwise reach the phone (the first wins,
    // so an audio/image body would arrive as text/plain).
    const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }
    for (const [k, v] of Object.entries(r.headers || {})) {
      for (const had of Object.keys(headers)) if (had.toLowerCase() === k.toLowerCase()) delete headers[had]
      headers[k] = String(v)
    }
    res.writeHead(status, headers)
    res.end(body); return
  }
  sendJson(res, 200, result)
}

/** @returns true when the request was an API route */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, shell: Shell): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false
  const path = url.pathname.slice(4)
  const m = req.method || 'GET'
  try {
    if (m === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' })
      res.end(); return true
    }

    if (m === 'GET' && path === '/status') {
      sendJson(res, 200, {
        version: VERSION, uptimeSec: Math.round((Date.now() - started) / 1000),
        connections: [...shell.connections].map((c) => c.summary()),
        active: shell.activeId, scratch: !!shell.scratch, blank: shell.blank, overlay: shell.overlay ? { text: shell.overlay.text } : null,
        apps: shell.appSummaries(), lastEvent: shell.lastEvent,
      }); return true
    }
    if (path === '/cache') {
      if (m === 'POST') {
        const b = await readJson(req)
        const id = String(b.app || '')
        if (b.clear) { await shell.clearCache(id || undefined); sendJson(res, 200, { cleared: id || 'all' }); return true }
        sendJson(res, 200, id ? { pushed: await shell.pushCache(id) } : { pushed: await shell.pushAllCaches() })
        return true
      }
      if (m === 'DELETE') { await shell.clearCache(); sendJson(res, 200, { cleared: 'all' }); return true }
      sendJson(res, 200, { cached: [...shell.cached].map(([key, pages]) => ({ key, pages })) }); return true
    }
    if (m === 'GET' && path === '/apps') { sendJson(res, 200, { apps: shell.appSummaries() }); return true }
    if (m === 'GET' && path === '/screen') {
      const c = compile(shell.currentView())
      sendJson(res, 200, { active: shell.activeId, text: c.textDump, page: c.page, images: c.images.map((i) => ({ containerID: i.containerID, containerName: i.containerName, bytes: Math.round(i.png.length * 0.75) })) })
      return true
    }
    if (m === 'GET' && path === '/config') { sendJson(res, 200, shell.config); return true }
    if ((m === 'PUT' || m === 'PATCH') && path === '/config') { const b = await readJson(req); sendJson(res, 200, shell.updateConfig(b)); return true }
    if (m === 'POST' && path === '/action') {
      const b = await readJson(req)
      if (!b.action) { sendJson(res, 400, { error: 'action required' }); return true }
      sendJson(res, 200, { ok: shell.runAction(String(b.action)) }); return true
    }
    if (m === 'POST' && path === '/settings') { shell.openSettings(); sendJson(res, 200, { ok: true }); return true }
    if (m === 'GET' && path === '/logs') { sendJson(res, 200, { logs: recentLogs(Number(url.searchParams.get('n')) || 100) }); return true }

    if (m === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' })
      res.write(':ok\n\n')
      const write = (type: string, data: unknown) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }
      const offs = [
        onLog((e) => write('log', e)),
        sub(shell, 'event', (e) => write('event', e)),
        sub(shell, 'render', (t) => write('render', { text: t })),
        sub(shell, 'nav', (e) => write('nav', e)),
        sub(shell, 'connection', (e) => write('connection', e)),
        sub(shell, 'apps', (e) => write('apps', e)),
        sub(shell, 'location', (e) => write('location', e)),
        sub(shell, 'config', (e) => write('config', e)),
      ]
      const hb = setInterval(() => { try { res.write(':hb\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(hb); offs.forEach((f) => f()) })
      return true
    }

    if (m === 'POST' && path === '/notify') {
      const b = await readJson(req)
      if (!b.text) { sendJson(res, 400, { error: 'text required' }); return true }
      shell.notify(String(b.text), b); sendJson(res, 200, { ok: true }); return true
    }
    if (m === 'POST' && path === '/dismiss') { shell.dismiss(); sendJson(res, 200, { ok: true }); return true }
    if (m === 'POST' && path === '/show') {
      const b = await readJson(req)
      const view = b.view ?? b
      compile(view) // validate before committing
      shell.show(view); sendJson(res, 200, { ok: true }); return true
    }
    if (m === 'POST' && path === '/home') { shell.home(); sendJson(res, 200, { ok: true }); return true }
    if (m === 'POST' && path === '/exit') { await shell.exit(); sendJson(res, 200, { ok: true }); return true }
    if (m === 'POST' && path === '/render') { shell.requestRender(); sendJson(res, 200, { ok: true }); return true }
    if (m === 'POST' && path === '/reload') {
      await shell.registry.loadAll(); shell.requestRender()
      sendJson(res, 200, { ok: true, apps: shell.appSummaries() }); return true
    }
    if (m === 'POST' && path === '/client/reload') { await shell.broadcast('reload', {}); sendJson(res, 200, { ok: true }); return true }
    if (m === 'POST' && path === '/audio') { const b = await readJson(req); const r = await shell.registry.host.audio(!!b.on, b.source); sendJson(res, 200, { results: r }); return true }
    if (m === 'POST' && path === '/imu') { const b = await readJson(req); const r = await shell.registry.host.imu(!!b.on, b.pace); sendJson(res, 200, { results: r }); return true }
    if (m === 'POST' && path === '/location') { const b = await readJson(req); const r = await shell.registry.host.location(b); sendJson(res, 200, { location: r }); return true }
    if (m === 'POST' && path === '/cmd') {
      // Raw escape hatch: run any client op on every connection.
      const b = await readJson(req)
      if (!b.op) { sendJson(res, 400, { error: 'op required' }); return true }
      const results = await shell.broadcast(b.op, b.args ?? {})
      sendJson(res, 200, { results }); return true
    }

    // /api/apps/:id[/action | /custom/path]
    const am = path.match(/^\/apps\/([\w.-]+)(\/.*)?$/)
    if (am) {
      const id = am[1]
      const rest = am[2] || ''
      const app = shell.registry.get(id)
      if (!app) { sendJson(res, 404, { error: `no such app: ${id}` }); return true }
      if (m === 'GET' && !rest) { sendJson(res, 200, { id, title: app.title, error: app.loadError || app.error, active: shell.isActive(id), state: app.state, file: app.file }); return true }
      if (m === 'POST' && rest === '/open') { shell.open(id); sendJson(res, 200, { ok: true }); return true }
      if (m === 'POST' && rest === '/settings') { shell.open(id); shell.appSettings = { screen: 'list', index: 0 }; shell.requestRender(); sendJson(res, 200, { ok: true }); return true }
      if (m === 'POST' && rest === '/message') {
        const b = await readJson(req)
        const result = await shell.message(id, b)
        sendJson(res, 200, { ok: true, result: result ?? null }); return true
      }
      if (m === 'GET' && rest === '/state') { sendJson(res, 200, { state: app.state }); return true }
      if ((m === 'PUT' || m === 'PATCH') && rest === '/state') {
        const b = await readJson(req)
        Object.assign(app.state, b); app.ctx?.save()
        if (shell.isActive(id)) shell.requestRender()
        sendJson(res, 200, { ok: true, state: app.state }); return true
      }
      if (m === 'POST' && rest === '/reload') { await shell.registry.load(id, app.file); sendJson(res, 200, { ok: true }); return true }
      if (m === 'GET' && rest === '/phone') {
        if (typeof app.mod?.phone !== 'function') { sendJson(res, 404, { error: `app ${id} has no phone page` }); return true }
        const fragment = await (app.mod.phone.call(app.mod, app.ctx!, { method: m, path: '/phone', query: Object.fromEntries(url.searchParams), body: null, headers: req.headers }) as string | Promise<string>)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' })
        res.end(phonePage(id, app.title, String(fragment ?? ''), tokenOf(req, url)))
        return true
      }

      // Anything else under /api/apps/:id/ goes to the app's own `http` hook,
      // so an app can expose webhooks and its own JSON API.
      let body: unknown = null
      const ct = String(req.headers['content-type'] || '')
      if (m !== 'GET' && m !== 'HEAD') body = ct.includes('application/json') ? await readJson(req) : await readText(req)
      const result = await shell.http(id, {
        method: m, path: rest || '/', query: Object.fromEntries(url.searchParams), body, headers: req.headers,
      })
      if (result === undefined) { sendJson(res, 404, { error: `app ${id} has no http handler for ${m} ${rest || '/'}` }); return true }
      sendResult(res, result)
      return true
    }

    sendJson(res, 404, { error: 'not found' })
    return true
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message })
    return true
  }
}

function sub(emitter: EventEmitter, name: string, fn: (...a: any[]) => void): () => void { emitter.on(name, fn); return () => { emitter.off(name, fn) } }

function tokenOf(req: IncomingMessage, url: URL): string {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token') || ''
}

/** Wrap an app's phone fragment in a self-contained page with the omni helper. */
function phonePage(id: string, title: string, fragment: string, token: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>${esc(title)}</title>
<style>
html,body{margin:0;background:#232323;color:#e5e5e5;font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-text-size-adjust:100%}
body{padding:14px}h1,h2,h3{margin:0 0 8px;font-size:17px}h3{font-size:15px;color:#9ff0c0}p{margin:6px 0}
a{color:#9fd0ff}button,.btn{font:inherit;padding:9px 12px;border-radius:8px;border:0;background:#3fbf7f;color:#0b1f14;font-weight:600;display:inline-block;text-decoration:none}
button.secondary,.btn.secondary{background:#3a3a3a;color:#ddd}button:disabled{opacity:.5}
input,select{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #444;background:#161616;color:#eee;width:100%;box-sizing:border-box}
ul{padding-left:18px}li{margin:4px 0}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.muted{color:#999;font-size:13px}
.card{background:#2b2b2b;border-radius:10px;padding:12px;margin:10px 0}audio{width:100%}
</style></head><body>
<script>
window.omni={id:${JSON.stringify(id)},token:${JSON.stringify(token)},
 url:(p)=>'/api/apps/'+${JSON.stringify(id)}+(p.startsWith('/')?p:'/'+p)+(p.includes('?')?'&':'?')+'token='+encodeURIComponent(${JSON.stringify(token)}),
 api:async(p,o={})=>{const r=await fetch(window.omni.url(p),{...o,headers:{'content-type':'application/json',...(o.headers||{})},body:o.body&&typeof o.body!=='string'?JSON.stringify(o.body):o.body});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t}if(!r.ok)throw new Error((j&&j.error)||r.statusText);return j},
 reload:()=>location.reload()};
</script>
${fragment}
</body></html>`
}

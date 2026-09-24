// Omni server entry: static glasses client, HTTP API, WebSocket bridge.
import { createServer } from 'node:http'
import { register } from 'node:module'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import qrcodeTerminal from 'qrcode-terminal'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ClientFrame } from '../shared/protocol.ts'
import { APPS_DIR, CLIENT_DIST, DATA_DIR, HOST, PORT, PUBLIC_URL, ROOT, TOKEN, VERSION, wsUrl } from './config.ts'
import { Connection } from './connection.ts'
import { Shell } from './shell.ts'
import { handleApi, sendJson } from './api.ts'
import { manifest, setupPage } from './setup.ts'
import { log } from './log.ts'

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json' }

// Cache-bust imports inside apps/ so nested helper files hot-reload too.
register('./loader-hooks.ts', { parentURL: import.meta.url, data: { appsDir: APPS_DIR } })

const shell = new Shell({ appsDir: APPS_DIR })

function tokenOf(req: IncomingMessage, url: URL): string {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) return h.slice(7).trim()
  return url.searchParams.get('token') || ''
}

function serveStatic(res: ServerResponse, file: string): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
  createReadStream(file).pipe(res)
  return true
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  const p = url.pathname
  try {
    // The glasses client: public, secret-free. Its token comes from the user.
    if (p === '/app.json' || p === '/app/app.json') { sendJson(res, 200, manifest()); return }
    if (p === '/app' ) { res.writeHead(302, { Location: '/app/' + url.search }); res.end(); return }
    if (p.startsWith('/app/')) {
      if (!existsSync(CLIENT_DIST)) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('client not built: run `npm run build:client`'); return }
      const rel = normalize(p.slice(5)).replace(/^(\.\.[/\\])+/, '')
      const file = join(CLIENT_DIST, rel || 'index.html')
      if (serveStatic(res, file)) return
      if (serveStatic(res, join(CLIENT_DIST, 'index.html'))) return
    }
    if (p === '/healthz') { res.writeHead(200); res.end('ok'); return }

    // Everything else needs the token.
    if (tokenOf(req, url) !== TOKEN) {
      if (p === '/' || p === '/setup') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Omni: add ?token=<token> (printed at server start)'); return }
      sendJson(res, 401, { error: 'unauthorized' }); return
    }
    if (p === '/' || p === '/setup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(await setupPage()); return
    }
    if (p === '/omni.ehpk') {
      const f = join(ROOT, 'omni.ehpk')
      if (!existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not packed yet: run `npm run pack`'); return }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="omni.ehpk"', 'Content-Length': statSync(f).size })
      createReadStream(f).pipe(res); return
    }
    // Token-gated downloads of anything dropped into data/files/ (screenshots, exports…)
    if (p.startsWith('/files/')) {
      if (tokenOf(req, url) !== TOKEN) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return }
      const rel = decodeURIComponent(p.slice('/files/'.length))
      const dir = join(DATA_DIR, 'files')
      const file = resolve(dir, rel)
      if (!file.startsWith(dir + sep) || !serveStatic(res, file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found') }
      return
    }
    if (await handleApi(req, res, url, shell)) return
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found')
  } catch (err) {
    log('error', `http ${p}: ${(err as Error).stack || (err as Error).message}`)
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message })
  }
})

// ── WebSocket ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x')
  if (url.pathname !== '/ws') { socket.destroy(); return }
  if (tokenOf(req, url) !== TOKEN) {
    log('warn', `ws unauthorized from ${req.socket.remoteAddress}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

/** Serve a socket-tunnelled API call by looping back through the HTTP server. */
async function tunnelApi(conn: Connection, f: { id: number; method: string; path: string; body?: string }) {
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST
  try {
    const r = await fetch(`http://${host}:${PORT}/api${f.path.startsWith('/') ? f.path : `/${f.path}`}`, {
      method: f.method || 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: f.body,
    })
    conn.send({ t: 'api', id: f.id, status: r.status, body: await r.text() })
  } catch (err) {
    conn.send({ t: 'api', id: f.id, status: 502, body: JSON.stringify({ error: String(err) }) })
  }
}

wss.on('connection', (ws, req) => {
  const remote = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
  const conn = new Connection(ws, remote)
  log('ws', `client ${conn.id} connected from ${remote}`)
  conn.send({ t: 'welcome', serverVersion: VERSION })
  let registered = false
  const hb = setInterval(() => {
    if (!conn.alivePing) { log('ws', `client ${conn.id} missed heartbeat — closing`); try { ws.terminate() } catch {} return }
    conn.alivePing = false
    conn.send({ t: 'ping' })
  }, 20000)

  ws.on('message', (data, isBinary) => {
    if (isBinary) { shell.handleAudio(conn, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)); return }
    let frame: ClientFrame
    try { frame = JSON.parse(data.toString()) } catch { return }
    switch (frame.t) {
      case 'hello':
        conn.client = frame.client; conn.device = frame.device; conn.user = frame.user
        conn.tz = frame.tz || null; conn.locale = frame.locale || null
        conn.launchSource = frame.launchSource; conn.pageCreated = !!frame.pageCreated
        conn.resetPage()
        log('ws', `client ${conn.id} hello: ${frame.client?.version} device=${frame.device?.model ?? '?'} tz=${frame.tz ?? '?'} pageCreated=${frame.pageCreated}`)
        if (!registered) { registered = true; shell.addConnection(conn) } else shell.requestRender()
        break
      case 'result': conn.handleResult(frame); break
      case 'event': shell.handleEvent(conn, frame.ev); break
      case 'device': conn.device = { ...(conn.device || {}), status: frame.status }; shell.emit('device', frame.status); break
      case 'location': shell.handleLocation(frame.loc); break
      case 'launch': conn.launchSource = frame.source; break
      case 'log': log(`client:${conn.id}`, `${frame.level}: ${frame.msg}`); break
      case 'pong': conn.alivePing = true; break
      case 'api': void tunnelApi(conn, frame); break
      case 'cache': shell.handleCachedProgress(frame.key, Number(frame.index) || 0); break
      default: log('warn', `client ${conn.id} unknown frame ${(frame as { t: string }).t}`)
    }
  })
  ws.on('close', () => {
    clearInterval(hb)
    conn.close()
    if (registered) shell.removeConnection(conn)
    log('ws', `client ${conn.id} disconnected`)
  })
  ws.on('error', (err: Error) => log('warn', `ws ${conn.id}: ${err.message}`))
})

// ── boot ─────────────────────────────────────────────────────────────
await shell.start()
server.listen(PORT, HOST, () => {
  const setup = `${PUBLIC_URL}/setup?token=${TOKEN}`
  console.log(`\nOmni v${VERSION} listening on http://${HOST}:${PORT}`)
  console.log(`  public URL : ${PUBLIC_URL}`)
  console.log(`  websocket  : ${wsUrl()}`)
  console.log(`  setup page : ${setup}`)
  console.log(`  token      : ${TOKEN}`)
  console.log(`  apps dir   : ${APPS_DIR}  (${shell.registry.list().map((a) => a.id).join(', ') || 'empty'})`)
  if (!existsSync(CLIENT_DIST)) console.log('  WARNING    : client not built — run `npm run build:client`')
  console.log('\nScan with the Even app (Even Hub → Developer → Scan QR):')
  qrcodeTerminal.generate(`${PUBLIC_URL}/app/?token=${encodeURIComponent(TOKEN)}`, { small: true })
})

function shutdown(): void { shell.registry.saveAll(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err: Error) => log('error', `uncaught: ${err.stack || err.message}`))
process.on('unhandledRejection', (err) => log('error', `unhandled: ${(err as Error)?.stack || err}`))

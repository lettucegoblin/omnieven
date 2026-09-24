// Omni glasses client. Deliberately dumb: it owns no UI logic. It relays
// every glasses/phone event to the Omni server over a WebSocket and executes
// the render commands the server sends back through the Even Hub SDK.
//
// The phone-side page (index.html) is a small settings form: server URL and
// token, persisted through the Even App's storage bridge.

import {
  waitForEvenAppBridge,
  AudioInputSource,
  ImageRawDataUpdate,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { OmniSocket } from './ws'
import { Companion, type ApiTransport } from './companion'
import { initSetup } from './setup'
import { OfflineShell, clearPacks, listPacks, storePack } from './offline'
import { CLIENT_VERSION, type ClientFrame, type Cmd, type PagePayload, type ServerFrame } from './protocol'

// Stored through the Even App storage bridge as two plain strings (older
// builds kept one JSON blob under PROFILE_LEGACY_KEY, still read as fallback).
const KEY_URL = 'omni.url'
const KEY_TOKEN = 'omni.token'
const PROFILE_LEGACY_KEY = 'omni.profile.v1'
const CALL_TIMEOUT_MS = 8000
// Baked in at build time by `npm run pack` (VITE_OMNI_WS_URL) so an installed
// .ehpk knows its server without the user typing it.
const BUILT_IN_URL: string = (import.meta.env.VITE_OMNI_WS_URL as string | undefined) || ''

type Profile = { url: string; token: string }

// ── phone UI ─────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const elUrl = $<HTMLInputElement>('url')
const elToken = $<HTMLInputElement>('token')
const elStatus = $<HTMLDivElement>('status')
const elDot = $<HTMLSpanElement>('dot')
const companion = new Companion()
const elLog = $<HTMLPreElement>('log')
const elSave = $<HTMLButtonElement>('save')
const elDisconnect = $<HTMLButtonElement>('disconnect')

const logLines: string[] = []
function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  const line = `${new Date().toLocaleTimeString()} ${msg}`
  logLines.push(line)
  if (logLines.length > 80) logLines.shift()
  elLog.textContent = logLines.join('\n')
  elLog.scrollTop = elLog.scrollHeight
  ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(msg)
  sendFrame({ t: 'log', level, msg })
}
function setStatus(text: string, cls: 'ok' | 'bad' | 'wait') {
  elStatus.textContent = text
  elStatus.className = `status ${cls}`
  elDot.className = `dot ${cls}`
}

// Default server = wherever this page was served from (the Omni server hosts
// the client), so a sideloaded install needs only the token.
function defaultUrl(): string {
  const loc = window.location
  if (/^https?:$/.test(loc.protocol)) return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
  return BUILT_IN_URL
}
function tokenFromQuery(): string {
  const p = new URLSearchParams(window.location.search)
  return p.get('token') || ''
}

// ── bridge + socket ──────────────────────────────────────────────────
let bridge: EvenAppBridge | null = null
let pageCreated = false
/** true once the server has drawn a page; the local splash stops updating then */
let serverPageShown = false
let launchSource: string | null = null
let audioOn = false
let cmdChain: Promise<unknown> = Promise.resolve()

// Every frame that leaves the client is checked against the shared contract.
const sendFrame = (f: ClientFrame) => sock.send(f)

// API calls tunnelled over the socket (see ClientFrame 'api'): the installed
// bundle runs from a non-http origin where cross-origin fetch() fails.
let apiSeq = 0
const apiPending = new Map<number, (r: { status: number; body: string }) => void>()
const apiOverSocket: ApiTransport = (method, path, body) => new Promise((resolve, reject) => {
  const id = ++apiSeq
  const timer = setTimeout(() => { apiPending.delete(id); reject(new Error('timed out')) }, CALL_TIMEOUT_MS)
  apiPending.set(id, (r) => { clearTimeout(timer); resolve(r) })
  if (!sendFrame({ t: 'api', id, method, path, body })) { clearTimeout(timer); apiPending.delete(id); reject(new Error('not connected')) }
})

const sock = new OmniSocket({
  onOpen: () => {
    setStatus('Connected', 'ok')
    splash('Connected to your server — loading the dashboard…')
    log('socket open')
    // Hand the display back and tell the server how far we read on our own.
    for (const p of offline.leave()) sendFrame({ t: 'cache', key: p.key, index: p.index })
    void sendHello()
    companion.start()
  },
  onClose: (reason) => {
    setStatus(`Disconnected (${reason || 'closed'}) – retrying`, 'wait')
    if (offline.hasPacks) goOffline(`server unreachable (${reason || 'closed'})`)
    else splash(`Omni started.\n\nCan't reach the server (${reason || 'closed'}) — retrying.\nCheck the URL and token in Omni on your phone.`)
  },
  onJson: (frame: ServerFrame) => {
    if (frame.t === 'ping') { sendFrame({ t: 'pong' }); return }
    if (frame.t === 'welcome') { log(`server ${frame.serverVersion}`); return }
    if (frame.t === 'error') { log(`server error: ${frame.msg}`, 'error'); return }
    if (frame.t === 'api') { const p = apiPending.get(frame.id); if (p) { apiPending.delete(frame.id); p(frame) } return }
    if (frame.t === 'cmd') {
      // Bridge calls must never overlap: the SDK shares one BLE link.
      cmdChain = cmdChain.then(() => runCmd(frame)).catch(() => {}).then(() => inflight)
    }
  },
})

// A bridge call that times out is abandoned by the caller but is still running
// against the shared BLE link, so the queue must not start the next call until
// it actually settles (bounded, in case it never does).
const SETTLE_MAX_MS = 30000
let inflight: Promise<unknown> = Promise.resolve()
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  const settled = Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, SETTLE_MAX_MS))])
  inflight = inflight.then(() => settled)
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), CALL_TIMEOUT_MS)),
  ])
}
/** Run a bridge call in the same queue as server commands (never overlap on the BLE link). */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = cmdChain.then(fn)
  cmdChain = p.catch(() => {}).then(() => inflight)
  return p
}

async function sendHello() {
  const profile = currentProfile()
  let device: unknown = null
  let user: unknown = null
  try { device = await exclusive(() => withTimeout(bridge!.getDeviceInfo(), 'getDeviceInfo')) } catch (e) { log(`getDeviceInfo: ${e}`, 'warn') }
  try { user = await exclusive(() => withTimeout(bridge!.getUserInfo(), 'getUserInfo')) } catch (e) { log(`getUserInfo: ${e}`, 'warn') }
  sendFrame({
    t: 'hello',
    token: profile.token,
    client: { version: CLIENT_VERSION, sdk: '0.0.15' },
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language,
    device: device as any, user: user as any, launchSource, pageCreated,
  })
}

/** Route a glasses event to the offline shell; true when it was handled there. */
function handleOffline(ev: EvenHubEvent): boolean {
  const sys = ev.sysEvent, text = ev.textEvent, list = ev.listEvent
  let kind: 'tap' | 'double' | 'up' | 'down' | 'select' | null = null
  let index = 0
  if (list && (list.eventType ?? OsEventTypeList.CLICK_EVENT) === OsEventTypeList.CLICK_EVENT) { kind = 'select'; index = Number(list.currentSelectItemIndex ?? 0) }
  else if (text) { const t = text.eventType ?? OsEventTypeList.CLICK_EVENT; kind = t === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : t === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 'down' : 'tap' }
  else if (sys) {
    const t = sys.eventType ?? OsEventTypeList.CLICK_EVENT
    if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) { pageCreated = false; serverPageShown = false; offline.leave(); return false }
    kind = t === OsEventTypeList.DOUBLE_CLICK_EVENT ? 'double' : t === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : t === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 'down' : t === OsEventTypeList.CLICK_EVENT ? 'tap' : null
  }
  if (!kind) return false
  void offline.event(kind, index).then((r) => {
    if (r === 'exit') void exclusive(() => withTimeout(bridge!.shutDownPageContainer(1), 'shutDownPageContainer')).catch(() => {})
  })
  return true
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── local splash ─────────────────────────────────────────────────────
// The glasses must show something the moment the app starts, before (and
// without) a server: "Omni started" plus a status line. It is created as
// the startup page; the server's first render then rebuilds over it.
const SPLASH_BODY = 2
function splashPage(status: string): PagePayload {
  const box = { borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 4 }
  return {
    containerTotalNum: 2,
    textObject: [
      { ...box, xPosition: 0, yPosition: 0, width: 576, height: 36, containerID: 1, containerName: 'splash-h', zOrderIndex: 1, isEventCapture: 0, textColor: 2, content: 'Omni  ·  your server-side dashboard' },
      { ...box, xPosition: 0, yPosition: 36, width: 576, height: 252, containerID: SPLASH_BODY, containerName: 'splash-b', zOrderIndex: 2, isEventCapture: 1, content: status },
    ],
    listObject: [], imageObject: [],
  }
}
let splashText = ''
/** Show (or update) the splash; a no-op once the server has drawn. */
function splash(status: string) {
  if (!bridge || serverPageShown) return
  cmdChain = cmdChain.then(async () => {
    if (serverPageShown || !bridge) return
    try {
      if (!pageCreated) {
        const r = await withTimeout(bridge.createStartUpPageContainer(splashPage(status) as any), 'createStartUpPageContainer')
        pageCreated = r === 0
        splashText = status
        if (r !== 0) log(`splash create result ${r}`, 'warn')
      } else if (status !== splashText) {
        await withTimeout(bridge.textContainerUpgrade({ containerID: SPLASH_BODY, containerName: 'splash-b', content: status } as any), 'textContainerUpgrade')
        splashText = status
      }
    } catch (err) { log(`splash: ${err}`, 'warn') }
  }).catch(() => {})
}
/**
 * Put a page on the glasses (create it the first time, rebuild after that).
 * Used by the server's `page` command and by the offline shell.
 */
async function drawPage(page: PagePayload): Promise<void> {
  if (!bridge) return
  if (!pageCreated) {
    const r = await withTimeout(bridge.createStartUpPageContainer(page as any), 'createStartUpPageContainer')
    pageCreated = r === 0
    if (r !== 0) throw new Error(`create result ${r}`)
  } else {
    const ok = await withTimeout(bridge.rebuildPageContainer(page as any), 'rebuildPageContainer')
    if (!ok) throw new Error('rebuild returned false')
  }
}
/** Pages kept for when the server can't be reached; it knows nothing about the apps. */
const offline = new OfflineShell((page) => exclusive(() => drawPage(page)), (msg) => log(msg))
/** Run the offline shell (if anything is stored) and report where we got to later. */
function goOffline(reason: string) {
  if (offline.active || serverPageShown && sock.connected) return
  void offline.enter(reason).then((shown) => { if (shown) setStatus(`Offline — showing ${listPacks().length} saved pack(s)`, 'wait') })
}

const SPLASH_NO_SERVER = 'Omni started.\n\nNo server set up yet — open Omni on your phone\nfor the setup guide (manual, or hand it to an AI assistant).'

async function runCmd(cmd: Cmd) {
  const { id, op } = cmd
  const reply = (ok: boolean, value?: unknown, error?: string) => sendFrame({ t: 'result', id, ok, value, error })
  if (!bridge) { reply(false, undefined, 'bridge not ready'); return }
  try {
    switch (cmd.op) {
      case 'page': {
        serverPageShown = true
        if (offline.active) offline.leave()   // the server is drawing again
        try { await drawPage(cmd.args as PagePayload); reply(true, true) }
        catch (err) { reply(false, undefined, (err as Error).message) }
        return
      }
      case 'text': {
        const ok = await withTimeout(bridge.textContainerUpgrade(cmd.args as any), 'textContainerUpgrade')
        reply(!!ok, ok, ok ? undefined : 'upgrade returned false')
        return
      }
      case 'image': {
        const args = cmd.args
        const r = await withTimeout(bridge.updateImageRawData(new ImageRawDataUpdate({
          containerID: args.containerID,
          containerName: args.containerName,
          imageData: b64ToBytes(args.png),
        })), 'updateImageRawData')
        reply(r === 'success', r, r === 'success' ? undefined : `image result ${r}`)
        return
      }
      case 'audio': {
        const args = cmd.args
        const src = args.source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses
        const ok = await withTimeout(bridge.audioControl(!!args.on, src), 'audioControl')
        audioOn = !!args.on && !!ok
        reply(!!ok, ok)
        return
      }
      case 'imu': {
        const args = cmd.args
        const ok = await withTimeout(bridge.imuControl(!!args.on, args.pace as any), 'imuControl')
        reply(!!ok, ok)
        return
      }
      case 'location': {
        const args = cmd.args as any
        if (args.once) {
          const loc = await withTimeout(bridge.getAppLocation(args), 'getAppLocation')
          reply(true, loc)
        } else if (args.on) {
          const ok = await withTimeout(bridge.startAppLocationUpdates(args), 'startAppLocationUpdates')
          reply(!!ok, ok)
        } else {
          const ok = await withTimeout(bridge.stopAppLocationUpdates(), 'stopAppLocationUpdates')
          reply(!!ok, ok)
        }
        return
      }
      case 'storage.get': {
        const v = await withTimeout(bridge.getLocalStorage(String(cmd.args.key)), 'getLocalStorage')
        reply(true, v)
        return
      }
      case 'storage.set': {
        const ok = await withTimeout(bridge.setLocalStorage(String(cmd.args.key), String(cmd.args.value)), 'setLocalStorage')
        reply(!!ok, ok)
        return
      }
      case 'shutdown': {
        const ok = await withTimeout(bridge.shutDownPageContainer(cmd.args?.mode ?? 1), 'shutDownPageContainer')
        if (cmd.args?.mode === 0) pageCreated = false
        reply(!!ok, ok)
        return
      }
      case 'cache.put': {
        const r = storePack(cmd.args)
        log(`cache: ${cmd.args.key} ${cmd.args.pages?.length ?? 0} page(s)${r.ok ? '' : ` not stored (${r.reason})`}`)
        reply(r.ok, r.ok || r.reason)
        return
      }
      case 'cache.clear': {
        const n = clearPacks(cmd.args?.key)
        log(`cache: cleared ${n} pack(s)`)
        reply(true, n)
        return
      }
      case 'reload': {
        reply(true)
        setTimeout(() => window.location.reload(), 200)
        return
      }
      default: {
        // Compile-time exhaustiveness: adding a CmdOp to shared/protocol.ts
        // without handling it here is a type error.
        const never: never = cmd
        reply(false, undefined, `unknown op ${(never as Cmd).op}`)
      }
    }
  } catch (err) {
    log(`${op} failed: ${(err as Error).message}`, 'error')
    reply(false, undefined, (err as Error).message)
  }
}

// ── event relay ──────────────────────────────────────────────────────
function relayEvent(ev: EvenHubEvent) {
  if (offline.active && handleOffline(ev)) return
  if (ev.audioEvent) {
    // PCM 16 kHz s16le mono. Binary frame; the server knows the format.
    const pcm = (ev.audioEvent as any).audioPcm as Uint8Array | undefined
    if (pcm && audioOn) sock.sendBinary(pcm)
    return
  }
  const sys = ev.sysEvent
  if (sys) {
    const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
    if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      // The glasses page is gone; the next 'page' must be a create again.
      pageCreated = false
      serverPageShown = false
      splashText = ''
      audioOn = false
    }
    if (type === OsEventTypeList.IMU_DATA_REPORT) {
      sendFrame({ t: 'event', ev: { sysEvent: { eventType: type, imuData: sys.imuData } } })
      return
    }
    // Store standard: a double-tap on the root page must open the system exit
    // dialog. The server does this (configurable) once it is drawing; before
    // that — no server set up, not connected, still on the splash — the client
    // handles it itself so the app can always be left.
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT && (!serverPageShown || !sock.connected)) {
      log('double-tap on the splash → exit dialog')
      void exclusive(() => withTimeout(bridge!.shutDownPageContainer(1), 'shutDownPageContainer')).catch((e) => log(`exit dialog: ${e}`, 'warn'))
      return
    }
  }
  sendFrame({ t: 'event', ev: ev as any })
}

// ── profile ──────────────────────────────────────────────────────────
function currentProfile(): Profile {
  return { url: elUrl.value.trim(), token: elToken.value.trim() }
}

// The host may hand back null, '', a string, or (for the legacy JSON key) an
// already-decoded object; normalise all of them to a trimmed string.
async function storageGet(key: string): Promise<string> {
  try {
    const raw: unknown = await exclusive(() => withTimeout(bridge!.getLocalStorage(key), `getLocalStorage(${key})`))
    if (raw == null) return ''
    if (typeof raw === 'string') return raw.trim()
    return JSON.stringify(raw)
  } catch (e) {
    log(`storage get ${key}: ${e}`, 'warn')
    return ''
  }
}

async function loadProfile(): Promise<Profile> {
  let url = await storageGet(KEY_URL)
  let token = await storageGet(KEY_TOKEN)
  if (!url && !token) {
    const legacy = await storageGet(PROFILE_LEGACY_KEY)
    if (legacy) {
      try { const p = JSON.parse(legacy); url = String(p.url || ''); token = String(p.token || '') } catch {}
    }
  }
  log(`stored profile: url=${url ? 'yes' : 'no'} token=${token ? 'yes' : 'no'}`)
  // A token in the launch URL (QR sideload) is used only when nothing is stored
  // yet, so a token rotated later in Connect isn't silently overwritten on
  // every relaunch of the same URL.
  return { url: url || defaultUrl(), token: token || tokenFromQuery() }
}

async function saveProfile(p: Profile) {
  try {
    const okUrl = await exclusive(() => withTimeout(bridge!.setLocalStorage(KEY_URL, p.url), 'setLocalStorage(url)'))
    const okTok = await exclusive(() => withTimeout(bridge!.setLocalStorage(KEY_TOKEN, p.token), 'setLocalStorage(token)'))
    const back = await storageGet(KEY_TOKEN)
    if (okUrl && okTok && back === p.token) log('profile saved')
    else log(`profile save unverified (url=${okUrl} token=${okTok} readback=${back === p.token})`, 'warn')
  } catch (e) { log(`profile save: ${e}`, 'warn') }
}

function connectWith(p: Profile) {
  if (!p.url) { setStatus('Enter the server URL', 'bad'); return }
  if (!p.token) { setStatus('Enter the token', 'bad'); return }
  setStatus(`Connecting to ${p.url}`, 'wait')
  let host = p.url; try { host = new URL(p.url).host } catch {}
  splash(`Omni started.\n\nConnecting to ${host}…`)
  companion.configure(p.url, p.token, apiOverSocket)
  const u = new URL(p.url)
  u.searchParams.set('token', p.token)
  sock.disconnect()
  sock.connect(u.toString())
}

// ── boot ─────────────────────────────────────────────────────────────
async function boot() {
  initSetup()
  setStatus('Waiting for Even App bridge…', 'wait')
  try {
    bridge = await waitForEvenAppBridge()
  } catch (err) {
    // Plain browser (no Even App bridge): the Apps tab still works as a
    // companion page when the token is in the URL.
    setStatus('Not inside the Even App — companion mode only', 'wait')
    log(String(err), 'warn')
    const token = tokenFromQuery()
    const url = defaultUrl()
    elUrl.value = url; elToken.value = token
    if (token && url) { companion.configure(url, token); companion.start() } else companion.showTab('setup')
    return
  }
  bridge.onLaunchSource((src) => { launchSource = src; sendFrame({ t: 'launch', source: src }) })
  bridge.onDeviceStatusChanged((status) => sendFrame({ t: 'device', status: status as any }))
  bridge.onAppLocationChanged((loc) => sendFrame({ t: 'location', loc: loc as any }))
  bridge.onEvenHubEvent(relayEvent)
  // Draw immediately, before anything that could take time.
  splash('Omni started.\n\nStarting up…')

  const profile = await loadProfile()
  elUrl.value = profile.url
  elToken.value = profile.token
  // A QR/URL-supplied token is persisted immediately so the next launch
  // (with or without the query string) reconnects on its own.
  if (tokenFromQuery() && profile.url && profile.token === tokenFromQuery()) await saveProfile(profile)

  elSave.onclick = async () => {
    const p = currentProfile()
    await saveProfile(p)
    connectWith(p)
  }
  elDisconnect.onclick = () => { sock.disconnect(); companion.stop(); setStatus('Disconnected', 'bad') }

  if (profile.url && profile.token) {
    connectWith(profile)
    // If the server is unreachable the socket's onClose brings the packs up.
    setTimeout(() => { if (!sock.connected && !serverPageShown) goOffline('no connection at start-up') }, 6000)
  } else { setStatus('No server set up yet', 'wait'); splash(SPLASH_NO_SERVER); companion.showTab('setup') }
}

void boot()

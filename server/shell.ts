// The dashboard itself: a home list of apps, one active app, a contextual
// menu for jumping between them, transient notifications, and the routing
// of glasses events to whichever of those is on screen.
import { EventEmitter } from 'node:events'
import type { AppEvent, AppLocation, CmdArgs, CmdOp, EvenHubEvent, NormalizedEvent } from '../shared/protocol.ts'
import type { AppSetting } from '../shared/app.ts'
import type { ExplicitView, MenuItem, View } from '../shared/view.ts'
import type { HttpRequest, HttpResponse } from '../shared/app.ts'
import { DEFAULT_CONFIG, type Action, type OmniConfig } from '../shared/config.ts'
import { normalizeEvent } from './protocol.ts'
import { compile, SCREEN } from './renderer.ts'
import { AppRegistry, type GroupNode, type LoadedApp } from './apps.ts'
import type { Connection } from './connection.ts'
import { loadConfig, mergeConfig, saveConfig } from './config-store.ts'
import { GestureTracker, matchBinding } from './gestures.ts'
import { makeSettingsApp } from './settings-app.ts'
import { log } from './log.ts'

export const SETTINGS_ID = 'settings'

const MENU = { HOME: 1, EXIT: 2, SETTINGS: 3, APP_SETTINGS: 4, APP_BASE: 10, CUSTOM_BASE: 100, MAX_ITEMS: 10, MAX_CUSTOM: 8 }
const RENDER_DEBOUNCE_MS = 30
const CACHE_DEBOUNCE_MS = 3000, CACHE_MAX_SCREENS = 120
const DEFAULT_NOTIFY_MS = 5000

interface Overlay { text: string; title?: string; timer: NodeJS.Timeout }
export interface AppSummary { id: string; title: string; order: number; refresh: number; error: string | null; active: boolean; menu: MenuItem[]; file: string; group: string; phone: boolean; settings: boolean }

export class Shell extends EventEmitter {
  readonly connections = new Set<Connection>()
  /** null = home */
  activeId: string | null = null
  overlay: Overlay | null = null
  /** ad-hoc view pushed through the API */
  scratch: View | null = null
  lastEvent: (NormalizedEvent & { ts: number; conn: number }) | null = null
  /** app id → screens currently cached on the phone */
  readonly cached = new Map<string, number>()
  private cacheTimers = new Map<string, NodeJS.Timeout>()
  lastView: View | null = null
  /** display off: blank screen until the next gesture */
  blank = false
  /** folder currently shown on the home screen, e.g. ['Tools', 'Time'] */
  homePath: string[] = []
  /** the folder the current app was opened from, so leaving it goes back there */
  private returnPath: string[] = []
  /** the shell-rendered settings screens of the active app (from its `settings` schema) */
  appSettings: { screen: 'list' | 'option'; index: number } | null = null
  config: OmniConfig = loadConfig()
  readonly registry: AppRegistry
  private gestures = new GestureTracker()
  /** where to go back to after Settings / blank */
  private returnTo: { activeId: string | null; scratch: View | null } | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private renderTimer: NodeJS.Timeout | null = null

  constructor({ appsDir }: { appsDir: string }) {
    super()
    this.registry = new AppRegistry(appsDir, {
      requestRender: (id) => { if (this.isActive(id)) this.requestRender() },
      requestCache: (id) => this.scheduleCache(id),
      isActive: (id) => this.isActive(id),
      notify: (text, opts) => this.notify(text, opts),
      open: (id) => this.open(id),
      home: () => this.home(),
      exit: () => this.exit(),
      message: (id, msg) => this.message(id, msg),
      audio: (on, source) => this.broadcast('audio', { on: !!on, source }, (c, ok) => { if (ok) c.audioOn = !!on }),
      imu: (on, pace) => this.broadcast('imu', { on: !!on, pace }, (c, ok) => { if (ok) c.imuOn = !!on }),
      location: (opts = {}) => this.first('location', (opts.once === false ? opts : { once: true, ...opts }) as never) as Promise<AppLocation | boolean | null>,
      storageGet: (key) => this.first('storage.get', { key }) as Promise<string>,
      storageSet: (key, value) => this.first('storage.set', { key, value }) as Promise<boolean>,
      device: () => [...this.connections].map((c) => c.device).find(Boolean) || null,
      user: () => [...this.connections].map((c) => c.user).find(Boolean) || null,
      tz: () => [...this.connections].map((c) => c.tz).find(Boolean) || Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: () => [...this.connections].map((c) => c.locale).find(Boolean) || Intl.DateTimeFormat().resolvedOptions().locale,
      connected: () => this.connections.size > 0,
    })
    this.registry.on('changed', (id) => {
      if (this.activeId && !this.registry.get(this.activeId)) this.activeId = null
      if (this.isActive(id) || this.activeId === null) this.requestRender()
      this.emit('apps', this.appSummaries())
    })
  }

  async start(): Promise<void> {
    await this.registry.registerBuiltin(SETTINGS_ID, makeSettingsApp({
      config: () => this.config,
      setBinding: (scope, gesture, action) => this.setBinding(scope, gesture, action),
      setMenu: (patch) => { this.updateConfig({ menu: { ...this.config.menu, ...patch } }) },
      resetGestures: () => { this.resetGestures(); this.notify('Gestures reset to the standard', { ms: 1500 }) },
      pinned: () => this.config.pinned,
      setPinned: (ids) => { this.updateConfig({ pinned: ids }) },
      apps: () => this.registry.list().map((a) => ({ id: a.id, title: a.title, group: a.group })),
      close: () => this.restore(),
    }))
    this.registry.bootstrap()
    await this.registry.loadAll()
    this.registry.watch()
  }

  // ── configuration ──────────────────────────────────────────────────
  setBinding(scope: keyof OmniConfig['gestures'], gesture: string, action: Action | null): void {
    if (action == null) delete this.config.gestures[scope][gesture]
    else this.config.gestures[scope][gesture] = action
    saveConfig(this.config)
    log('shell', `gesture ${scope}.${gesture} → ${action ?? '(unbound)'}`)
    this.emit('config', this.config)
  }
  /** The store-standard bindings (docs/CONFIG.md): root double-tap = system exit dialog. */
  resetGestures(): void {
    this.config.gestures = { root: { ...DEFAULT_CONFIG.gestures.root }, global: { ...DEFAULT_CONFIG.gestures.global }, app: { ...DEFAULT_CONFIG.gestures.app } }
    saveConfig(this.config)
    log('shell', 'gestures reset to defaults')
    this.emit('config', this.config)
  }
  updateConfig(patch: Partial<OmniConfig>): OmniConfig {
    this.config = mergeConfig(this.config, patch)
    saveConfig(this.config)
    this.emit('config', this.config)
    return this.config
  }

  /** Run a configured action. Returns false for unknown actions. */
  runAction(action: Action): boolean {
    if (action === 'home') { this.blank = false; this.home(this.activeId ? this.returnPath : []); return true }
    if (action === 'exit') { void this.exit(); return true }
    if (action === 'quit') { void this.broadcast('shutdown', { mode: 0 }); return true }
    if (action === 'blank') { this.setBlank(!this.blank); return true }
    if (action === 'config') { this.openSettings(); return true }
    if (action === 'none') return true
    if (action.startsWith('open:')) { const id = action.slice(5); if (this.registry.get(id)) this.open(id); else log('warn', `action open:${id}: no such app`); return true }
    if (action.startsWith('notify:')) { this.notify(action.slice(7)); return true }
    if (action === 'next-app' || action === 'prev-app') {
      const list = this.registry.list()
      if (!list.length) return true
      const i = list.findIndex((a) => a.id === this.activeId)
      // from the home screen (nothing active) go to the first / the last app
      const n = i < 0 ? (action === 'next-app' ? 0 : list.length - 1) : action === 'next-app' ? (i + 1) % list.length : (i - 1 + list.length) % list.length
      this.open(list[n].id)
      return true
    }
    log('warn', `unknown gesture action "${action}"`)
    return false
  }

  setBlank(on: boolean): void {
    this.blank = on
    log('shell', on ? 'display off' : 'display on')
    this.syncRefresh()
    this.requestRender()
  }

  openSettings(): void {
    if (this.activeId === SETTINGS_ID) return
    this.returnTo = { activeId: this.activeId, scratch: this.scratch }
    this.blank = false
    this.open(SETTINGS_ID)
  }

  /** Leave Settings, going back to whatever was showing before. */
  restore(): void {
    const r = this.returnTo
    this.returnTo = null
    if (r?.activeId && this.registry.get(r.activeId)) this.open(r.activeId)
    else { this.home(); if (r?.scratch) this.show(r.scratch) }
  }

  // ── connections ────────────────────────────────────────────────────
  addConnection(conn: Connection): void {
    this.connections.add(conn)
    this.emit('connection', { type: 'open', conn: conn.summary() })
    this.syncRefresh()
    this.requestRender()
    // top the phone's offline packs up once the dashboard is on screen
    setTimeout(() => { void this.pushAllCaches() }, 4000)
  }
  removeConnection(conn: Connection): void {
    this.connections.delete(conn)
    this.emit('connection', { type: 'close', conn: conn.summary() })
    this.syncRefresh()
  }

  async broadcast<O extends CmdOp>(op: O, args: CmdArgs[O], after?: (c: Connection, ok: boolean, v?: unknown) => void): Promise<unknown[]> {
    return Promise.all([...this.connections].map(async (c) => {
      try { const v = await c.cmd(op, args); after?.(c, true, v); return v } catch (err) { after?.(c, false); log('warn', `${op}: ${(err as Error).message}`); return null }
    }))
  }
  async first<O extends CmdOp>(op: O, args: CmdArgs[O]): Promise<unknown> {
    const c = [...this.connections][0]
    if (!c) throw new Error('no glasses connected')
    return c.cmd(op, args)
  }

  // ── state ──────────────────────────────────────────────────────────
  isActive(id: string): boolean { return this.activeId === id && !this.scratch }
  get activeApp(): LoadedApp | null { return this.activeId ? this.registry.get(this.activeId) ?? null : null }

  appSummaries(): AppSummary[] {
    return this.registry.list().map((a) => ({
      id: a.id, title: a.title, order: a.order, refresh: a.refresh, error: a.loadError || a.error,
      active: this.isActive(a.id), menu: a.menu, file: a.file, group: a.group,
      phone: typeof a.mod?.phone === 'function', settings: !!a.mod?.settings?.length,
    }))
  }

  open(id: string): void {
    const app = this.registry.get(id)
    if (!app || (app.hidden && id !== SETTINGS_ID)) throw new Error(`no such app: ${id}`)
    // Remember where we came from, so leaving the app returns to that folder
    // rather than the top of the tree (a gesture can open an app from anywhere).
    if (!this.activeId && id !== SETTINGS_ID) this.returnPath = [...this.homePath]
    this.blank = false
    const prev = this.activeApp
    if (prev && prev.id !== id) this.safe(prev, 'onClose')
    this.scratch = null
    this.appSettings = null
    this.activeId = id
    if (prev?.id !== id) this.safe(app, 'onOpen')
    log('shell', `open ${id}`)
    this.syncRefresh()
    this.requestRender()
    this.emit('nav', { active: id })
  }

  home(path: string[] = []): void {
    const prev = this.activeApp
    if (prev) this.safe(prev, 'onClose')
    this.scratch = null
    this.appSettings = null
    this.activeId = null
    this.blank = false
    this.homePath = path
    this.syncRefresh()
    this.requestRender()
    this.emit('nav', { active: null })
  }

  /** Show an arbitrary view (from the API) until the user navigates away. */
  show(view: View): void {
    this.scratch = view
    this.syncRefresh()
    this.requestRender()
  }

  async exit(): Promise<unknown> { return this.broadcast('shutdown', { mode: 1 }) }

  notify(text: string, opts: { title?: string; ms?: number; duration?: number } = {}): void {
    const ms = Number(opts.ms ?? opts.duration ?? DEFAULT_NOTIFY_MS)
    if (this.overlay) clearTimeout(this.overlay.timer)
    this.overlay = {
      text: String(text ?? ''), title: opts.title,
      timer: setTimeout(() => this.dismiss(), Math.max(500, ms)),
    }
    log('shell', `notify: ${String(text).slice(0, 80)}`)
    this.requestRender()
  }
  dismiss(): void {
    if (!this.overlay) return
    clearTimeout(this.overlay.timer)
    this.overlay = null
    this.requestRender()
  }

  /** Call an app hook with `this` = the module; errors are logged, never thrown. */
  safe(app: LoadedApp | null, hook: string, ...args: unknown[]): unknown {
    const fn = app?.mod?.[hook]
    if (!app || typeof fn !== 'function') return undefined
    try { return fn.call(app.mod, app.ctx, ...args) } catch (err) {
      log('error', `app ${app.id} ${hook}: ${(err as Error).stack || (err as Error).message}`)
      app.error = `${hook}: ${(err as Error).message}`
      return undefined
    }
  }

  syncRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    const app = this.activeApp
    if (!app || this.scratch || this.blank || !app.refresh || !this.connections.size) return
    this.refreshTimer = setInterval(() => this.requestRender(), app.refresh)
  }

  // ── rendering ──────────────────────────────────────────────────────
  requestRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = setTimeout(() => this.renderNow(), RENDER_DEBOUNCE_MS)
  }

  renderNow(): void {
    const view = this.currentView()
    this.lastView = view
    for (const c of this.connections) c.render(view)
    try { this.emit('render', compile(view).textDump) } catch {}
  }

  currentView(): View {
    if (this.overlay) return this.overlayView()
    if (this.blank) return { containers: [{ type: 'text', name: 'blank', x: 0, y: 0, w: SCREEN.width, h: SCREEN.height, text: ' ', capture: true }] }
    if (this.scratch) return this.scratch
    const app = this.activeApp
    if (!app) return this.homeView()
    if (this.appSettings && app.mod?.settings) return this.appSettingsView(app, app.mod.settings)
    if (app.loadError) return { text: `${app.title}\n\nfailed to load ${app.file.split('/').pop()}:\n${app.loadError}`, menu: this.menuFor(app) }
    if (!app.mod) return { text: `${app.title}\n\nERROR: ${app.error}`, menu: this.menuFor(app) }
    let view: View
    try { view = app.mod.render.call(app.mod, app.ctx!) } catch (err) {
      log('error', `app ${app.id} render: ${(err as Error).stack || (err as Error).message}`)
      return { text: `${app.title}\n\nrender error:\n${(err as Error).message}`, menu: this.menuFor(app) }
    }
    return this.withMenu(view, app)
  }

  /** The group node for the current homePath (falls back towards the root if a folder vanished). */
  private homeNode(): GroupNode {
    let node = this.registry.tree()
    const ok: string[] = []
    for (const part of this.homePath) {
      const next = node.groups.get(part.toLowerCase())
      if (!next) break
      node = next; ok.push(next.name)
    }
    this.homePath = ok
    return node
  }

  /** Rows of the home list: [back], folders…, apps… */
  private homeRows(): ({ kind: 'back' } | { kind: 'group'; node: GroupNode } | { kind: 'app'; app: LoadedApp })[] {
    const node = this.homeNode()
    const rows: ({ kind: 'back' } | { kind: 'group'; node: GroupNode } | { kind: 'app'; app: LoadedApp })[] = []
    if (this.homePath.length) rows.push({ kind: 'back' })
    // Pinned apps come first, in the order the user pinned them (top level only).
    else for (const id of this.config.pinned) { const a = this.registry.get(id); if (a && !a.hidden) rows.push({ kind: 'app', app: a }) }
    for (const g of [...node.groups.values()].sort((a, b) => a.name.localeCompare(b.name))) rows.push({ kind: 'group', node: g })
    for (const app of node.apps) rows.push({ kind: 'app', app })
    return rows
  }

  homeView(): ExplicitView {
    const rows = this.homeRows()
    const total = this.registry.list().length
    const items = rows.map((r) =>
      r.kind === 'back' ? '‹ back' :
      r.kind === 'group' ? `${r.node.name} /` :
      (r.app.loadError || r.app.error ? `! ${r.app.title}` : r.app.title))
    if (!items.length) items.push('(no apps yet)')
    const where = this.homePath.length ? this.homePath.join(' / ') : 'Omni'
    return {
      containers: [
        { type: 'text', name: 'header', x: 0, y: 0, w: SCREEN.width, h: 36, padding: 4, textColor: 2,
          text: `${where}  ·  ${total} app${total === 1 ? '' : 's'}  ·  tap to open` },
        { type: 'list', name: 'apps', x: 0, y: 36, w: SCREEN.width, h: SCREEN.height - 36, items, capture: true },
      ],
      menu: [
        ...(this.homePath.length ? [{ id: MENU.HOME, label: 'Top level' }] : []),
        { id: MENU.SETTINGS, label: 'Settings' }, { id: MENU.EXIT, label: 'Exit Omni' },
      ],
    }
  }

  overlayView(): ExplicitView {
    const o = this.overlay!
    const text = o.title ? `${o.title}\n${o.text}` : o.text
    return {
      containers: [
        { type: 'text', name: 'toast', x: 24, y: 24, w: SCREEN.width - 48, h: SCREEN.height - 48,
          text, padding: 12, border: { width: 2, color: 10, radius: 8 }, capture: true },
      ],
    }
  }

  /** Attach the composed contextual menu to an app's view. */
  withMenu(view: View, app: LoadedApp): View {
    const v: Exclude<View, string | number | null | undefined | unknown[]> =
      view == null ? { text: '' } : typeof view === 'string' || typeof view === 'number' ? { text: String(view) } : Array.isArray(view) ? { containers: view } : { ...view }
    const custom = Array.isArray(v.menu) && v.menu.length ? v.menu : app.menu
    v.menu = this.menuFor(app, custom)
    return v
  }

  /**
   * The contextual menu for an app: its own items (≤8), "<title> settings" when it
   * declares a schema, Home, then — per config.menu — pinned apps, apps of the same
   * folder, or all apps, while there is room (10 total).
   */
  menuFor(app: LoadedApp, custom: MenuItem[] = app.menu || []): MenuItem[] {
    const items: MenuItem[] = []
    const map = new Map<number, string>()
    app.menuMap = map
    custom.slice(0, MENU.MAX_CUSTOM).forEach((m, i) => {
      const id = MENU.CUSTOM_BASE + i
      const key = String(typeof m === 'string' ? m : m.id ?? m.label)
      map.set(id, key)
      items.push({ id, label: typeof m === 'string' ? m : m.label ?? key })
    })
    if (app.mod?.settings?.length) items.push({ id: MENU.APP_SETTINGS, label: `${app.title} settings`.slice(0, 32) })
    items.push({ id: MENU.HOME, label: 'Home' })
    if (this.config.menu.settings) items.push({ id: MENU.SETTINGS, label: 'Settings' })
    const all = this.registry.list()
    const others: LoadedApp[] = []
    for (const id of this.config.menu.pinned) { const a = all.find((x) => x.id === id); if (a && a.id !== app.id) others.push(a) }
    if (this.config.menu.apps === 'folder') for (const a of all) if (a.group.toLowerCase() === app.group.toLowerCase() && a.id !== app.id && !others.includes(a)) others.push(a)
    if (this.config.menu.apps === 'all') for (const a of all) if (a.id !== app.id && !others.includes(a)) others.push(a)
    // Other apps get ids by menu position (APP_BASE..CUSTOM_BASE-1), never by
    // their index in the full app list, so they cannot collide with custom ids.
    app.menuApps = new Map()
    for (const a of others) {
      if (items.length >= MENU.MAX_ITEMS) break
      const id = MENU.APP_BASE + app.menuApps.size
      app.menuApps.set(id, a.id)
      items.push({ id, label: a.title })
    }
    return items
  }

  // ── app settings screens (from an app's `settings` schema) ─────────
  appSettingsView(app: LoadedApp, schema: AppSetting[]): View {
    const st = this.appSettings!
    const state = app.state
    const header = (t: string) => ({ type: 'text' as const, name: 'header', x: 0, y: 0, w: SCREEN.width, h: 36, padding: 4, textColor: 2, text: t })
    const list = (items: string[]) => ({ type: 'list' as const, name: 'list', x: 0, y: 36, w: SCREEN.width, h: SCREEN.height - 36, items, capture: true })
    if (st.screen === 'option') {
      const sdef = schema[st.index]
      if (sdef && 'options' in sdef) {
        return { containers: [header(`${sdef.label}  ·  tap to choose  ·  double-tap: back`),
          list(sdef.options.map((o) => `${o.value === state[sdef.key] ? '● ' : '○ '}${o.label}`))] }
      }
      st.screen = 'list'
    }
    const status = (this.safe(app, 'settingsStatus') as string | undefined) || ''
    const rows = schema.map((sdef) => {
      if ('action' in sdef) return `${sdef.label} ›`
      const cur = sdef.options.find((o) => o.value === state[sdef.key])
      return `${sdef.label}:  ${cur ? cur.label : String(state[sdef.key] ?? '—')}`
    })
    return { containers: [header(`${app.title} settings${status ? '  ·  ' + status : ''}  ·  double-tap: back`), list(rows)] }
  }

  /** Handle input while the app-settings screens are showing. */
  private handleAppSettingsEvent(app: LoadedApp, ev: NormalizedEvent): void {
    const st = this.appSettings!
    const schema = app.mod?.settings || []
    if (ev.type === 'double') {
      if (st.screen === 'option') st.screen = 'list'
      else this.appSettings = null
      this.requestRender(); return
    }
    if (ev.type !== 'select') return
    if (st.screen === 'list') {
      const sdef = schema[ev.index]
      if (!sdef) return
      if ('action' in sdef) { this.safe(app, 'onSettingsAction', sdef.key); this.requestRender(); return }
      st.screen = 'option'; st.index = ev.index
    } else {
      const sdef = schema[st.index]
      if (sdef && 'options' in sdef) {
        const o = sdef.options[ev.index]
        if (o) {
          app.state[sdef.key] = o.value
          app.ctx?.save()
          this.safe(app, 'onSettingsChange', sdef.key, o.value)
          log('shell', `${app.id}.${sdef.key} = ${JSON.stringify(o.value)}`)
        }
      }
      st.screen = 'list'
    }
    this.requestRender()
  }

  // ── events ─────────────────────────────────────────────────────────
  handleEvent(conn: Connection, raw: EvenHubEvent): void {
    const ev = normalizeEvent(raw)
    if (this.isRepeat(conn, ev)) { this.emit('event', { ...ev, ts: Date.now(), conn: conn.id, dropped: true }); return }
    this.lastEvent = { ...ev, ts: Date.now(), conn: conn.id }
    conn.lastInput = this.lastEvent
    this.emit('event', this.lastEvent)
    const app = this.activeApp

    switch (ev.type) {
      case 'enter':
        conn.resetPage()
        this.requestRender()
        if (app) this.safe(app, 'onEvent', withRaw(ev, raw))
        return
      case 'exit':
        if (app) this.safe(app, 'onEvent', ev)
        return
      case 'system-exit':
      case 'abnormal-exit':
        conn.resetPage()
        conn.pageCreated = false
        conn.audioOn = false
        conn.imuOn = false
        if (app) this.safe(app, 'onEvent', ev)
        return
      case 'imu':
        if (app) this.safe(app, 'onImu', ev.imu)
        return
    }

    if (this.overlay) {
      if (ev.type === 'tap' || ev.type === 'double' || ev.type === 'select') this.dismiss()
      return
    }

    // Gesture bindings. Global ones win everywhere (except inside Settings);
    // a blank screen wakes on anything.
    const keys = this.gestures.feed(ev)
    const inSettings = this.activeId === SETTINGS_ID
    if (keys.length && !inSettings) {
      const g = matchBinding(this.config.gestures.global, keys)
      if (g) { this.gestures.reset(); log('shell', `gesture global.${g.key} → ${g.action}`); this.runAction(g.action); return }
    }
    if (this.blank) { if (keys.length) this.setBlank(false); return }

    if (ev.type === 'menu') {
      if (ev.itemId === MENU.HOME) return this.home()  // top level
      if (ev.itemId === MENU.EXIT) return void this.exit()
      if (ev.itemId === MENU.SETTINGS) return this.openSettings()
      if (ev.itemId === MENU.APP_SETTINGS) { if (app?.mod?.settings) { this.appSettings = { screen: 'list', index: 0 }; this.requestRender() } return }
      if (ev.itemId >= MENU.APP_BASE && ev.itemId < MENU.CUSTOM_BASE) {
        const id = app?.menuApps?.get(ev.itemId)
        if (id) this.open(id)
        return
      }
      const key = app?.menuMap?.get(ev.itemId)
      if (app && key != null) {
        const handled = this.safe(app, 'onMenu', key)
        if (handled === undefined) this.safe(app, 'onEvent', { type: 'menu', itemId: ev.itemId, id: key, source: ev.source } satisfies AppEvent)
        this.requestRender()
      }
      return
    }

    if (app && this.appSettings) { this.handleAppSettingsEvent(app, ev); return }

    if (app) {
      // Inside an app: the app first; then the in-app defaults for gestures it did not consume.
      const handled = this.safe(app, 'onEvent', withRaw(ev, raw))
      if (handled === true) { this.gestures.reset(); this.requestRender(); return }
      if (keys.length && !inSettings) {
        const b = matchBinding(this.config.gestures.app, keys)
        if (b) { this.gestures.reset(); log('shell', `gesture app.${b.key} → ${b.action}`); this.runAction(b.action); return }
      }
      this.requestRender()
      return
    }

    // Root screens: home list or an API-pushed view.
    if (keys.length) {
      const b = matchBinding(this.config.gestures.root, keys)
      if (b) {
        this.gestures.reset()
        // "back until the main menu": an exit bound to double-tap first climbs out of
        // folders (and off an API-pushed view); only the top-level home screen exits.
        if (b.action === 'exit' && b.key === 'double' && (this.homePath.length || this.scratch)) { log('shell', 'gesture root.double → up'); this.home(this.homePath.slice(0, -1)); return }
        log('shell', `gesture root.${b.key} → ${b.action}`); this.runAction(b.action); return
      }
    }
    if (ev.type === 'select' && !this.scratch) {
      const row = this.homeRows()[ev.index]
      if (!row) return
      if (row.kind === 'back') this.home(this.homePath.slice(0, -1))
      else if (row.kind === 'group') this.home([...this.homePath, row.node.name])
      else this.open(row.app.id)
    }
  }

  /**
   * Input debouncing (config.input): a gesture that repeats the previous one
   * is dropped when it comes within `repeatMs`, or while the screen update the
   * previous one caused is still being drawn (bounded by `maxWaitMs`).
   * Lifecycle, IMU and release events are never dropped.
   */
  private isRepeat(conn: Connection, ev: NormalizedEvent): boolean {
    if (!['tap', 'double', 'up', 'down', 'longpress', 'select', 'menu'].includes(ev.type)) return false
    const { repeatMs, waitForRender, maxWaitMs } = this.config.input
    const now = Date.now()
    const prev = conn.lastInput
    const same = prev && prev.type === ev.type
      && (ev.type !== 'select' || (prev as { index?: number }).index === (ev as { index?: number }).index)
      && (ev.type !== 'menu' || (prev as { itemId?: number }).itemId === (ev as { itemId?: number }).itemId)
    if (!same) return false
    if (repeatMs > 0 && now - prev.ts < repeatMs) { log('shell', `input: ${ev.type} repeated after ${now - prev.ts} ms — dropped`); return true }
    if (waitForRender && conn.busySince && conn.busySince >= prev.ts - RENDER_DEBOUNCE_MS && now - conn.busySince < maxWaitMs) {
      log('shell', `input: ${ev.type} while the previous one is still being drawn (${now - conn.busySince} ms) — dropped`); return true
    }
    return false
  }

  handleAudio(_conn: Connection, pcm: Uint8Array): void {
    const app = this.activeApp
    if (app) this.safe(app, 'onAudio', pcm)
  }
  handleLocation(loc: AppLocation): void {
    const app = this.activeApp
    if (app) this.safe(app, 'onLocation', loc)
    this.emit('location', loc)
  }

  // ── offline packs ───────────────────────────────────────────────
  /** Build an app's pack soon (several state changes collapse into one push). */
  scheduleCache(id: string): void {
    if (this.cacheTimers.has(id)) return
    this.cacheTimers.set(id, setTimeout(() => { this.cacheTimers.delete(id); void this.pushCache(id) }, CACHE_DEBOUNCE_MS))
  }
  /** Ask an app for its offline pack, pre-render it and store it on the phone. */
  async pushCache(id: string): Promise<{ key: string; pages: number } | null> {
    const app = this.registry.get(id)
    if (!app?.mod?.offline || !app.ctx) return null
    let pack
    try { pack = await app.mod.offline.call(app.mod, app.ctx) } catch (err) { log('warn', `app ${id} offline: ${(err as Error).message}`); return null }
    if (!pack || !Array.isArray(pack.screens) || !pack.screens.length) return null
    const pages = pack.screens.slice(0, CACHE_MAX_SCREENS).map((v) => compile(v).page)
    const args = { key: id, title: pack.title || app.title, pages, index: Math.max(0, Math.min(pack.index ?? 0, pages.length - 1)) }
    this.cached.set(id, pages.length)
    await Promise.all([...this.connections].map((c) => c.cmd('cache.put', args).catch((err: Error) => log('warn', `conn ${c.id} cache.put ${id}: ${err.message}`))))
    log('shell', `cached ${pages.length} screen${pages.length === 1 ? '' : 's'} of ${id} on the phone`)
    return { key: id, pages: pages.length }
  }
  /** Push every app that has something to cache (on connect, or on demand). */
  async pushAllCaches(): Promise<void> {
    for (const app of this.registry.list()) if (app.mod?.offline) await this.pushCache(app.id)
  }
  /** The phone reports where the wearer got to while it was on its own. */
  handleCachedProgress(key: string, index: number): void {
    log('shell', `phone read ${key} offline up to screen ${index}`)
    const app = this.registry.get(key)
    if (app?.mod?.onCached) this.safe(app, 'onCached', index)
  }

  /** Deliver a message to an app (active or not); returns the hook's result. */
  message(id: string, msg: unknown): unknown {
    const app = this.registry.get(id)
    if (!app) throw new Error(`no such app: ${id}`)
    const result = this.safe(app, 'onMessage', msg)
    if (this.isActive(id)) this.requestRender()
    return result
  }

  /**
   * Route an HTTP request to an app's `http` hook. `req` = {method, path,
   * query, body, headers}. Returns whatever the hook returns (see api.js).
   */
  async http(id: string, req: HttpRequest): Promise<HttpResponse> {
    const app = this.registry.get(id)
    if (!app) throw new Error(`no such app: ${id}`)
    if (typeof app.mod?.http !== 'function') return undefined
    const result = await (this.safe(app, 'http', req) as HttpResponse | Promise<HttpResponse>)
    if (this.isActive(id)) this.requestRender()
    return result
  }
}

function withRaw(ev: NormalizedEvent, raw: EvenHubEvent): AppEvent { return { ...ev, raw } }

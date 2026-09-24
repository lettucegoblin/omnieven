// The app module contract. An app is `apps/<id>.js|.ts` or `apps/<id>/index.js|.ts`
// whose default export satisfies `OmniApp`. Hooks are called with `this` bound
// to the module, so helper methods on the object work.
//
//   /** @type {import('../shared/app.ts').OmniApp} */          (JS, JSDoc)
//   export default { title: 'Hello', render: () => 'Hello' }
//
//   import type { OmniApp } from '../shared/app.ts'            (TS)
//   export default { title: 'Hello', render: () => 'Hello' } satisfies OmniApp

import type { AppEvent, AppLocation, DeviceInfo, UserInfo } from './protocol.ts'
import type { View, MenuItem } from './view.ts'
import type * as Ui from '../server/ui.ts'
import type { Canvas } from '../server/png.ts'

export type { View, MenuItem, AppEvent }

/** What an app hands the phone to work from offline. */
export interface OfflinePack {
  /** shown in the phone's offline picker (defaults to the app title) */
  title?: string
  /** one view per screen, in order */
  screens: View[]
  /** which screen to open first */
  index?: number
}

export interface HttpRequest {
  method: string
  /** path below /api/apps/<id>, e.g. '/hook' — always starts with '/' */
  path: string
  query: Record<string, string>
  /** parsed JSON for application/json bodies, otherwise the raw text; null for GET */
  body: unknown
  headers: Record<string, string | string[] | undefined>
}
/** undefined → 404 (no handler); null → 204; string → text; {status,json|body,headers} → explicit; object → JSON */
export type HttpResponse = undefined | null | string | { status?: number; headers?: Record<string, string>; body?: string | Uint8Array; json?: unknown } | Record<string, unknown>

export interface AppContext<S = Record<string, any>, M = Record<string, any>> {
  readonly id: string
  readonly title: string
  /** persisted JSON (data/state/<id>.json); saved on render()/save() */
  state: S
  /** volatile; survives hot reloads, not restarts */
  mem: M
  /** per-app scratch directory (data/apps/<id>/), created on first access */
  readonly dataDir: string
  /** process.env, with .env from the project root merged in */
  readonly env: NodeJS.ProcessEnv
  readonly screen: { width: number; height: number; lineHeight: number }
  readonly ui: typeof Ui
  readonly Canvas: typeof Canvas
  log(...args: unknown[]): void
  /** is this app the one on screen */
  readonly active: boolean
  /** re-render (if active) and schedule a state save */
  render(): void
  save(): void
  /**
   * Ask for this app's offline pack to be rebuilt and stored on the phone
   * (debounced), or drop it with `{ clear: true }`. Nothing is cached unless an
   * app asks — the decision is the app's (and its settings'), not the shell's.
   */
  cache(opts?: { clear?: boolean }): void
  /** full-screen toast over whatever is showing; tap dismisses */
  notify(text: string, opts?: { title?: string; ms?: number }): void
  /** make an app active (defaults to this one) */
  open(id?: string): void
  home(): void
  /** system exit dialog on the glasses */
  exit(): Promise<unknown>
  /** deliver a message to another app's onMessage */
  message(id: string, msg: unknown): unknown
  /** timers cleared automatically on reload/unload */
  setInterval(fn: () => void, ms: number): NodeJS.Timeout
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout
  clear(t: NodeJS.Timeout): void
  /** glasses/phone mic → onAudio(pcm) with 16 kHz s16le mono frames */
  audio(on: boolean, source?: 'glasses' | 'phone'): Promise<unknown>
  /** IMU → onImu({x,y,z}); pace 100..1000 */
  imu(on: boolean, pace?: number): Promise<unknown>
  /** one-shot fix (default) or {once:false, intervalMs} stream → onLocation */
  location(opts?: { once?: boolean; intervalMs?: number; distanceFilter?: number; accuracy?: number; timeoutMs?: number }): Promise<AppLocation | boolean | null>
  /** phone-side key/value store (Even App localStorage) */
  storage: { get(key: string): Promise<string>; set(key: string, value: string): Promise<boolean> }
  readonly device: DeviceInfo | null
  readonly user: UserInfo | null
  /**
   * The phone's IANA time zone / locale (server's own when nothing is
   * connected). Use them for anything time-of-day:
   * `new Date().toLocaleTimeString(ctx.locale, { timeZone: ctx.tz, … })`.
   */
  readonly tz: string
  readonly locale: string
  readonly connected: boolean
  fetch: typeof fetch
}

/**
 * Declarative app settings. Declaring `settings` on an app adds a
 * "<title> settings" item to its contextual menu; the shell renders the list
 * screens, writes chosen values into `ctx.state[key]`, persists, and calls
 * `onSettingsChange`. Action rows call `onSettingsAction` instead.
 */
export type AppSetting =
  | { key: string; label: string; options: { value: any; label: string }[] }
  | { key: string; label: string; action: true }

export interface OmniApp<S = Record<string, any>, M = Record<string, any>> {
  /** shown on the home list and in menus (≤32 chars) */
  title?: string
  /** sort key on the home list, lower first (default 100) */
  order?: number
  /**
   * Folder on the home screen, e.g. 'Tools' or 'Tools/Time' (nested). Defaults
   * to the app's sub-folder under apps/ ('' = top level). Apps in the same
   * group are listed together; the home list drills into groups.
   */
  group?: string
  /** re-render every N ms while on screen */
  refresh?: number
  /** hide from the home list (still reachable via ctx.open / API) */
  hidden?: boolean
  /** the app's own contextual-menu entries (≤8); a view's `menu` overrides per render */
  menu?: MenuItem[]
  /** options edited on the glasses via the contextual menu; values live in ctx.state[key] */
  settings?: AppSetting[]
  /** a settings value was changed on the glasses (already stored in ctx.state) */
  onSettingsChange?(ctx: AppContext<S, M>, key: string, value: any): void
  /** an action row in settings was chosen */
  onSettingsAction?(ctx: AppContext<S, M>, key: string): void
  /** extra text for the settings header (e.g. live sensor values) */
  settingsStatus?(ctx: AppContext<S, M>): string

  init?(ctx: AppContext<S, M>): void | Promise<void>
  render(ctx: AppContext<S, M>): View
  /** gestures + lifecycle; return true from a 'double' handler to stay in the app (async handlers cannot) */
  onEvent?(ctx: AppContext<S, M>, ev: AppEvent): boolean | void | Promise<void>
  /** contextual-menu item chosen (id from `menu`); falls back to onEvent({type:'menu', id}) */
  onMenu?(ctx: AppContext<S, M>, id: string): void
  /** POST /api/apps/<id>/message or ctx.message() from another app */
  onMessage?(ctx: AppContext<S, M>, msg: any): unknown
  /** any other request under /api/apps/<id>/… (webhooks, the app's own API) */
  /**
   * Pages to keep on the phone for when the server can't be reached (a chapter
   * and the next few, say). `ctx.cache()` asks for a refresh; the phone shows
   * them as-is and reports back through `onCached`.
   */
  offline?(ctx: AppContext<S, M>): OfflinePack | null | Promise<OfflinePack | null>
  /** the wearer reached screen `index` of the cached pack while offline */
  onCached?(ctx: AppContext<S, M>, index: number): void
  http?(ctx: AppContext<S, M>, req: HttpRequest): HttpResponse | Promise<HttpResponse>
  /**
   * Phone-side page for this app (shown in the Omni companion's Apps tab and at
   * /api/apps/<id>/phone). Return an HTML fragment; it is wrapped in a page that
   * provides `omni.api(path, opts)` (fetch under /api/apps/<id>/ with the token),
   * `omni.url(path)` (tokenised URL for links/downloads) and `omni.reload()`.
   */
  phone?(ctx: AppContext<S, M>, req: HttpRequest): string | Promise<string>
  onOpen?(ctx: AppContext<S, M>): void
  onClose?(ctx: AppContext<S, M>): void
  onAudio?(ctx: AppContext<S, M>, pcm: Uint8Array): void
  onImu?(ctx: AppContext<S, M>, imu: { x: number; y: number; z: number }): void
  onLocation?(ctx: AppContext<S, M>, loc: AppLocation): void
  /** before a hot reload replaces the module */
  unload?(ctx: AppContext<S, M>): void

  /** apps may add their own helper methods */
  [extra: string]: unknown
}

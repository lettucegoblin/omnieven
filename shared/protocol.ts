// Wire contract between the Omni server and the glasses client, plus the
// Even Hub payload shapes both sides pass through. Imported by server/,
// client/ and apps — this file is the single source of truth.

// ── Even Hub page payloads (what the SDK's create/rebuild calls take) ──
export interface TextObject {
  xPosition: number; yPosition: number; width: number; height: number
  borderWidth: number; borderColor: number; borderRadius: number; paddingLength: number
  containerID: number; containerName: string; zOrderIndex: number
  isEventCapture: 0 | 1
  content: string
  textColor?: number          // 0..4, omitted = device default
}
export interface ListObject {
  xPosition: number; yPosition: number; width: number; height: number
  borderWidth: number; borderColor: number; borderRadius: number; paddingLength: number
  containerID: number; containerName: string; zOrderIndex: number
  isEventCapture: 0 | 1
  itemContainer: { itemCount: number; itemWidth: number; isItemSelectBorderEn: 0 | 1; itemName: string[] }
}
export interface ImageObject {
  xPosition: number; yPosition: number; width: number; height: number
  containerID: number; containerName: string; zOrderIndex: number
}
export interface MenuObject { menuItems: { itemID: number; itemName: string }[] }
export interface PagePayload {
  containerTotalNum: number
  textObject: TextObject[]
  listObject: ListObject[]
  imageObject: ImageObject[]
  menuObject?: MenuObject
}

// ── Commands (server → client) ─────────────────────────────────────
export interface CmdArgs {
  /** createStartUpPageContainer on first use, rebuildPageContainer afterwards */
  page: PagePayload
  /** textContainerUpgrade */
  text: { containerID: number; containerName: string; content: string; textColor?: number }
  /** updateImageRawData; png = base64 PNG bytes */
  image: { containerID: number; containerName: string; png: string }
  audio: { on: boolean; source?: 'glasses' | 'phone' }
  imu: { on: boolean; pace?: number }
  location: { once: true; accuracy?: number; timeoutMs?: number } | { on: boolean; intervalMs?: number; distanceFilter?: number; accuracy?: number }
  'storage.get': { key: string }
  'storage.set': { key: string; value: string }
  /** shutDownPageContainer; 1 = system exit dialog, 0 = immediate */
  shutdown: { mode: 0 | 1 }
  /**
   * Store a pack of pre-rendered pages on the phone so the app still works
   * when the server is unreachable. The client treats it as opaque: it only
   * shows the pages and remembers where the wearer got to.
   */
  'cache.put': { key: string; title: string; pages: PagePayload[]; index?: number }
  /** drop one pack (or all of them) */
  'cache.clear': { key?: string }
  /** reload the WebView page */
  reload: Record<string, never>
}
export type CmdOp = keyof CmdArgs
export type Cmd<O extends CmdOp = CmdOp> = { [K in O]: { t: 'cmd'; id: number; op: K; args: CmdArgs[K] } }[O]

export type ServerFrame =
  | Cmd
  | { t: 'ping' }
  | { t: 'welcome'; serverVersion: string }
  | { t: 'error'; msg: string }
  /** reply to a client `api` frame (the HTTP API tunnelled over the socket) */
  | { t: 'api'; id: number; status: number; body: string }

// ── Client → server ────────────────────────────────────────────────
export interface HelloFrame {
  t: 'hello'
  token: string
  client: { version: string; sdk: string }
  /** phone's IANA time zone (e.g. 'America/New_York') and BCP 47 locale */
  tz?: string
  locale?: string
  device: DeviceInfo | null
  user: UserInfo | null
  launchSource: string | null
  /** true when this WebView already called createStartUpPageContainer */
  pageCreated: boolean
}
export type ClientFrame =
  | HelloFrame
  | { t: 'event'; ev: EvenHubEvent }
  | { t: 'device'; status: DeviceStatus }
  | { t: 'location'; loc: AppLocation }
  | { t: 'launch'; source: string }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { t: 'pong' }
  /**
   * HTTP API call tunnelled over the socket. The Even App's WebView serves the
   * installed bundle from a non-http origin where cross-origin fetch() fails,
   * so the phone companion uses this instead. `path` is relative to `/api`.
   */
  | { t: 'api'; id: number; method: string; path: string; body?: string }
  /** how far the wearer got in a cached pack while the server was unreachable */
  | { t: 'cache'; key: string; index: number }

// ── Even Hub event envelope (as relayed from onEvenHubEvent) ───────
// Protobuf omits zero-valued fields, so eventType 0 (CLICK) and index 0
// arrive as undefined.
export interface EvenHubEvent {
  listEvent?: { containerID?: number; containerName?: string; currentSelectItemName?: string; currentSelectItemIndex?: number; eventType?: number }
  textEvent?: { containerID?: number; containerName?: string; eventType?: number }
  sysEvent?: { eventType?: number; eventSource?: number; imuData?: { x?: number; y?: number; z?: number }; systemExitReasonCode?: number }
  menuItemClickEvent?: { itemID?: number }
  audioEvent?: unknown
  jsonData?: Record<string, unknown>
}

export interface DeviceStatus { sn?: string; connectType?: number; isWearing?: boolean; batteryLevel?: number; isCharging?: boolean; isInCase?: boolean }
export interface DeviceInfo { model?: string; sn?: string; status?: DeviceStatus }
export interface UserInfo { uid?: number; name?: string; avatar?: string; country?: string }
export interface AppLocation { latitude: number; longitude: number; accuracy?: number; altitude?: number; speed?: number; heading?: number; timestamp?: number }

// ── Normalised events (what apps see in onEvent) ───────────────────
export type GestureType = 'tap' | 'double' | 'up' | 'down' | 'longpress' | 'release'
export type LifecycleType = 'enter' | 'exit' | 'abnormal-exit' | 'system-exit'
export type EventSource = 'glasses-right' | 'glasses-left' | 'ring' | 'glasses'
export type NormalizedEvent =
  | { type: GestureType; source?: EventSource; container?: string }
  | { type: 'select'; index: number; name: string; container?: string }
  | { type: 'menu'; itemId: number; id?: string; source?: EventSource }
  | { type: LifecycleType; source?: EventSource; reason?: number }
  | { type: 'imu'; imu: { x: number; y: number; z: number } }
  | { type: 'unknown' }
export type AppEvent = NormalizedEvent & { raw?: EvenHubEvent }

export const PROTOCOL_VERSION = 1

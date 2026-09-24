# Writing apps

An app is one module in `apps/`: `apps/<id>.js`, `apps/<id>.ts`, or a folder
`apps/<id>/index.{js,ts}` with any helper files next to it. The server watches the folder:
save a file and the glasses update within a second; delete it and the app disappears. Load,
init and render errors are shown on the glasses instead of crashing anything. The types live
in [`shared/app.ts`](../shared/app.ts) and are the authoritative reference.

**Folders on the home screen.** Apps are grouped in nested folders that the home list drills
into (`Time /` → `‹ back`, Clock, Stopwatch…). A group comes from either:

- the sub-folder the app sits in — `apps/time/clock.js` → folder *time*,
  `apps/tools/net/ping.js` → *tools / net*; a folder containing `index.js` is an app, not a group;
- or an explicit `group: 'Time'` / `group: 'Tools/Net'` in the module, which wins.

Folder names are matched case-insensitively. App ids are the file/folder name and must be
unique across all folders. Leaving an app with *home* returns to its folder; the contextual
menu's *Top level* goes to the root.

```js
// apps/weather.js
/** @type {import('../shared/app.ts').OmniApp<{ units: 'C'|'F', city?: string }, { wx?: any }>} */
export default {
  title: 'Weather',        // home-list / menu label (≤32 chars)
  order: 10,               // sort key on the home list (lower first)
  refresh: 60_000,         // optional: re-render every N ms while on screen
  menu: [{ id: 'units', label: 'Toggle °C/°F' }],   // the app's own contextual-menu items (≤8)

  async init(ctx) {        // once per (re)load; ctx.state / ctx.mem survive reloads
    ctx.state.units ??= 'C'
    ctx.setInterval(() => fetchWx(ctx), 10 * 60_000)   // cleared automatically on reload
    await fetchWx(ctx)
  },
  render(ctx) {            // → a view (see below)
    if (!ctx.mem.wx) return 'Loading…'
    return `${ctx.mem.wx.temp}°${ctx.state.units}\n${ctx.mem.wx.summary}`
  },
  onEvent(ctx, ev) {       // gestures + lifecycle
    if (ev.type === 'tap') fetchWx(ctx)
    // return true to consume a gesture (stops the in-app default binding, e.g. double → home)
  },
  onMenu(ctx, id) {        // contextual-menu item (id from `menu` above or from view.menu)
    if (id === 'units') { ctx.state.units = ctx.state.units === 'C' ? 'F' : 'C'; ctx.render() }
  },
  onMessage(ctx, msg) {    // POST /api/apps/weather/message {…} or ctx.message('weather', …) from another app
    if (msg.city) { ctx.state.city = msg.city; fetchWx(ctx) }
    return { city: ctx.state.city }          // returned as JSON
  },
  http(ctx, req) {         // any other route under /api/apps/weather/… — webhooks, your own API
    if (req.method === 'GET' && req.path === '/current') return ctx.mem.wx      // JSON
    if (req.method === 'POST' && req.path === '/hook') { /* req.body, req.query, req.headers */ return null } // 204
    return undefined                                                           // 404
  },
  onOpen(ctx) {}, onClose(ctx) {},     // became / stopped being the app on screen
  onAudio(ctx, pcm) {},                // 16 kHz s16le mono frames after ctx.audio(true)
  onImu(ctx, { x, y, z }) {},          // after ctx.imu(true, 500)
  onLocation(ctx, loc) {},             // after ctx.location({ once: false, intervalMs: 1000 })
  unload(ctx) {},                      // before a hot reload replaces this module
}

async function fetchWx(ctx) {
  const key = ctx.env.WEATHER_API_KEY            // from .env in the project root
  const r = await ctx.fetch(`https://api.example.com/wx?city=${ctx.state.city ?? 'Berlin'}&key=${key}`)
  ctx.mem.wx = await r.json()
  ctx.render()
}
```

Hooks are called with `this` bound to the module, but module-level helper functions (as
above) type-check more cleanly. In TypeScript: `export default { … } satisfies OmniApp<State, Mem>`.

## Views

`render(ctx)` may return any of:

| Return | Meaning |
|---|---|
| `'text'` | one full-screen text container |
| `{ text, textColor?, border?, padding?, menu? }` | same, with options |
| `{ list: ['a', 'b'], menu? }` | one full-screen native list (tap → `select` event with `index`) |
| `{ containers: [...], menu? }` | explicit layout |
| `[ ...containers ]` | explicit layout |

Containers (`x, y, w, h` in px on the 576×288 canvas, origin top-left):

```js
{ type: 'text',  name: 'body', x: 0, y: 0, w: 576, h: 288, text: '…',
  capture: true,           // exactly one container per view receives input (auto-picked if omitted)
  textColor: 0..4,         // brightness (4 = default/brightest)
  padding: 0..32, border: { width: 0..5, color: 0..15, radius: 0..10 } }

{ type: 'list',  name: 'items', x, y, w, h, items: ['one', 'two'], capture: true }   // ≤20 items, ≤64 chars each

{ type: 'image', name: 'graph', x, y, w: 20..288, h: 20..144, png: <Buffer | base64 | ctx.Canvas> }
```

A one-line text container needs `27 + 2 × padding` px of height (35 with the default padding
of 4) — one pixel short and the firmware shows a scrollbar.

Firmware limits (the renderer clamps and truncates): 12 containers, of which ≤8 text/list and
≤4 image; text ≤999 bytes per container on a page build and ≤1999 in place — give a container
more and the renderer builds the page with the first 999 bytes then tops it up with an upgrade,
so you can simply hand it ~1.9 KB; one font, no size control, left-aligned, 27 px per line,
~450 chars fill the screen; `\n` breaks lines.

**Native scrolling:** when the input-capturing text container holds more than fits, the glasses
scroll it themselves (smoothly, like the built-in News app) and the app only hears about the
edges: `up` = the reader hit the top, `down` = the bottom (they are *boundary* events, not
swipes). Swap in the next block on `down`, overlapping by a screen so nothing is skipped
(a ~1.9 KB block is 3–4 screens; keep the reader's paragraph to save position). Ignore boundary events for
~0.5 s after a swap; the re-layout can emit spurious ones. If the text fits, every swipe
arrives as `up`/`down` instead and you page manually.

**What costs what:** if only text *content* changes between renders, the server sends an
in-place update (fast, no flicker). Any change to geometry, list items, images or the menu
rebuilds the page (brief flicker, ~0.3 s). Images take 0.5–2 s over BLE — use them for things
that change slowly. The renderer diffs for you; just return the whole view every time.

Images: `png` accepts encoded PNG/JPEG bytes (the phone converts to 4-bit grey and
cover-fits them to the container) or a `new ctx.Canvas(w, h)` — a greyscale surface with
`rect, frame, line, circle, text (tiny 3×5 font), digits (scalable 5×7 digits — the only way
to draw *bigger* text, since the glasses have one font size; size with `ctx.ui.digitsSize`),
sparkline, toPng()`.

Helpers on `ctx.ui`:

- `rows([t1, t2, t3], { capture: 0 })` — equal-height stacked text containers
- `headerBody(header, body)` — dim one-line header + scrolling body
- `wrap(text, widthPx)`, `paginate(text)`, `fit(text, widthPx)`, `measure(text, widthPx)` — firmware-accurate metrics
- `bar(fraction, cells)` — `━━━───` progress bar; `spread(left, right)` — two-column line;
  `align(text, widthPx, 'center'|'right')` — pad with spaces (the firmware only left-aligns); `width(text)` — px
- `clock(date)`, `LINE` (27), `linesFor(heightPx)`

## App settings (declarative)

Declare a `settings` schema and the shell does the rest: a **"<Title> settings"** item
appears in the app's tap-and-hold menu, the option screens are rendered as native lists
(double-tap steps back), chosen values are written to `ctx.state[key]` and persisted, and
`onSettingsChange(ctx, key, value)` is called. Action rows call `onSettingsAction(ctx, key)`.
`settingsStatus(ctx)` can add live text to the header. `POST /api/apps/<id>/settings` opens
the screens from outside; `PUT /api/apps/<id>/state` sets values without them.

```js
settings: [
  { key: 'units', label: 'Units', options: [{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }] },
  { key: 'refreshMin', label: 'Refresh every', options: [5, 15, 60].map((v) => ({ value: v, label: `${v} min` })) },
  { key: 'reset', label: 'Reset history', action: true },
],
onSettingsChange(ctx, key, value) { if (key === 'refreshMin') restartTimer(ctx) },
onSettingsAction(ctx, key) { if (key === 'reset') { ctx.mem.history = []; ctx.render() } },
```

`demo/time/clock/index.js` uses this for a dozen options including IMU-driven fade/wake
with a calibration action.

## The tap-and-hold menu

The glasses' contextual menu (tap-and-hold on the touchpad, ≤10 items) is composed per app:
the app's `menu` items (or the `menu` of the view it just returned), then *"<Title>
settings"* when it has a schema, then **Home**. Which *other* apps are listed is the user's
choice (`config.menu.apps`: none / same folder / all, plus `pinned` ids) — see `docs/CONFIG.md`.
On the home screen the menu is *Settings* and *Exit* (plus *Top level* inside a folder).

## Context (`ctx`)

| Member | Purpose |
|---|---|
| `state` | JSON persisted to `data/state/<id>.json` (saved on `render()`/`save()`, restart-safe) |
| `mem` | volatile object; survives hot reloads, not restarts |
| `dataDir` | per-app scratch directory `data/apps/<id>/` |
| `env` | `process.env` merged with `.env` from the project root — API keys go there |
| `render()` | re-render if this app is on screen |
| `notify(text, { title?, ms? })` | full-screen toast over anything; tap dismisses |
| `open(id?)`, `home()`, `exit()` | navigation; `exit` shows the system exit dialog |
| `message(id, msg)` | call another app's `onMessage` |
| `setInterval / setTimeout / clear` | timers cleared automatically on reload |
| `audio(on, 'glasses'|'phone')`, `imu(on, pace)`, `location(opts)` | device features → `onAudio` / `onImu` / `onLocation` |
| `storage.get/set(key, value)` | phone-side key/value store (Even App localStorage) |
| `device`, `user`, `connected` | device info (incl. `status.batteryLevel`), Even user, is a client connected |
| `tz`, `locale` | the **phone's** IANA time zone and locale (the server's own when nothing is connected). Always pass them when formatting times: `new Date().toLocaleTimeString(ctx.locale, { timeZone: ctx.tz })` — the server may run in another zone |
| `fetch`, `log(...)`, `ui`, `Canvas`, `screen` | utilities |

## Events (`onEvent`)

`ev.type`: `tap`, `double`, `up`, `down`, `longpress`, `release`, `select` (`ev.index`, `ev.name`),
`menu` (`ev.id`, only when there is no `onMenu`), `enter`/`exit` (foreground), `system-exit`/`abnormal-exit`.
`ev.source` is `glasses-right`, `glasses-left` or `ring` when the firmware says. `ev.raw` is the
original Even Hub envelope.

Return `true` to consume a gesture. Otherwise the user's **in-app default bindings** apply
(default: double-tap → home). Global bindings (default: tap-then-long-press → Settings) run
*before* the app sees the gesture. See `docs/CONFIG.md`.

The contextual menu (tap-and-hold on the touchpad) shows your `menu` items first, then
your settings entry and **Home** (other apps only if the user configured that).

## Working offline

`offline(ctx)` returns pages to keep on the phone — `{ title?, screens: View[], index? }`.
The server pre-renders them and stores them in the Even App; when the server can't be
reached the phone shows them on its own (tap/swipe down = next screen, swipe up = previous,
double-tap = the list of cached apps, then the exit dialog). Call `ctx.cache()` whenever the
useful window moves (a new reading position, a new note) and the pack is rebuilt, debounced.
When the connection comes back the phone reports how far the wearer got and the app hears it
in `onCached(ctx, index)` — map that index back to your own state (a chapter and paragraph,
say). Up to 120 screens per app; the phone keeps ~3 MB in total and drops the oldest packs.
`POST /api/cache {"app":"<id>"}` forces a refresh, `GET /api/cache` lists what is stored.

## Phone page

Apps can have a screen on the **phone** too — the Omni companion (the page the Even app
shows, also usable in any browser at `<PUBLIC_URL>/app/?token=…`) lists every app with
*Open* / *Settings* buttons and a *Phone page* button for apps that implement `phone`:

```js
phone(ctx) {
  return `<h1>My app</h1><button id="go">Do it</button>
    <script>document.getElementById('go').onclick = () => omni.api('/do', { method: 'POST' }).then(omni.reload)</script>`
},
http(ctx, req) { if (req.path === '/do' && req.method === 'POST') { …; return { ok: true } } },
```

The fragment is wrapped in a styled page that provides `omni.api(path, opts)` (fetch under
`/api/apps/<id>/` with the token), `omni.url(path)` (tokenised URL — use it for `<a download>`
links and `<audio src>`) and `omni.reload()`. Binary responses come from `http` as
`{ status, headers: { 'content-type': … }, body: Buffer }` — see `demo/tools/voice.ts`, whose
phone page plays, downloads and deletes the WAV memos recorded on the glasses.

## HTTP surface of an app

| Route | Handler |
|---|---|
| `GET /api/apps/<id>` | info + state |
| `POST /api/apps/<id>/open`, `/reload` | shell actions |
| `POST /api/apps/<id>/message` (JSON) | `onMessage(ctx, body)` → `{ok, result}` |
| `GET/PUT /api/apps/<id>/state` | read / merge `ctx.state` |
| `GET /api/apps/<id>/phone` | the app's phone page (`phone` hook) |
| anything else under `/api/apps/<id>/…` | `http(ctx, { method, path, query, body, headers })` |

All require the bearer token (`Authorization: Bearer …` or `?token=…`, which is how webhooks
from third-party services authenticate).

## Testing without hardware

```bash
npm run fake-client -- ws://localhost:7788/ws $TOKEN   # prints what would be drawn; type t/d/u/w/l/s<N>/m<N> + Enter
curl -H "Authorization: Bearer $TOKEN" localhost:7788/api/screen    # text dump of the current page
curl -N -H "Authorization: Bearer $TOKEN" localhost:7788/api/events # live SSE of gestures, renders, logs
npm run typecheck                                                   # server, shared, demo and client against the same types
```

Or point the official simulator at the client: `npx @evenrealities/evenhub-simulator http://localhost:7788/app/`
and paste the token into its phone-side form.

# Omni — your own server drives your Even Realities G2 glasses

Omni turns the G2 into a display for a server **you** run. The Even Hub app on the phone is
a thin renderer; every screen, gesture handler and data source is a small JavaScript or
TypeScript module in an `apps/` folder on the server. Save a file → the glasses update within
a second. A plain HTTP API lets any script, cron job, webhook or AI agent push to the display.
Gestures on the dashboard are rebindable from the glasses themselves.

```
 ┌────────────────────────┐   wss   ┌──────────────────────┐  BLE  ┌──────────┐
 │ Omni server (yours)    │◀───────▶│ Even App WebView     │◀─────▶│ G2 + R1  │
 │  apps/*.js  hot-reload │         │  omni client (/app/) │       │ 576×288  │
 │  HTTP API + SSE        │         └──────────────────────┘       └──────────┘
 └────────────────────────┘
```

Works well with an AI coding agent: the repo ships a `CLAUDE.md`, the API tells the agent
what is on the glasses (`/api/screen`) and what you did (`/api/events`), and the fake client
lets it test apps without touching hardware.

## Requirements

- **Node.js ≥ 22.18** (the server is TypeScript run natively by Node; no build step) — or Docker.
- Even Realities G2 (+ optional R1 ring) paired with the Even app, **Developer Mode** enabled
  (Even app → Even Hub tab → Me → Developer).
- A URL the phone can reach: a public HTTPS host (recommended), a Tailscale address, or your
  LAN IP for testing. The Even app loads the client from that URL and the client connects back
  to it over WebSocket.

## Quick start (local / LAN)

```bash
git clone https://github.com/lettucegoblin/omnieven.git && cd omnieven
npm install                  # also installs the client's deps
npm run build:client         # builds the glasses client into client/dist
PUBLIC_URL=http://<your-lan-ip>:7788 npm start
```

The server prints a **setup URL** with its token and a QR code, and seeds `apps/` from
`demo/` on first run. On the phone: Even app → Even Hub → **Scan QR**. The QR is just the
client URL with the token, so the phone-side form is pre-filled; tap *Save & connect* and the
home list appears on the glasses. Open `<PUBLIC_URL>/setup?token=…` in a browser for the same
QR plus live status.

## Deploying on a VPS / droplet (recommended)

The phone needs HTTPS for anything beyond a LAN. The simplest path is Docker Compose with the
bundled Caddy profile, which gets a Let's Encrypt certificate automatically:

```bash
# on a fresh Ubuntu droplet with a DNS A record (omni.example.com → the droplet)
curl -fsSL https://get.docker.com | sh
git clone https://github.com/lettucegoblin/omnieven.git && cd omnieven
cp .env.example .env      # set PUBLIC_URL=https://omni.example.com and DOMAIN=omni.example.com
docker compose --profile tls up -d --build
docker compose logs omni | head -40      # token, setup URL, QR
```

- `apps/` is bind-mounted, so editing apps on the host hot-reloads inside the container.
- `data/` (token, per-app state, gesture config) is a named volume.
- Already have nginx/Traefik/Caddy? Skip the `tls` profile, proxy your hostname to
  `127.0.0.1:7788` (WebSockets must be passed through), and set `PUBLIC_URL` accordingly.
- No Docker: `npm install && npm run build:client`, run `PUBLIC_URL=… node server/index.ts`
  under systemd/pm2, and put a TLS proxy in front.
- Tailscale: `tailscale serve --https=443 --bg http://localhost:7788` on the box, phone on
  the tailnet, `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`.

Set `OMNI_TOKEN` to pin the token (otherwise one is generated into `data/token`). Secrets for
apps (API keys) go in `.env`; apps read them from `ctx.env`.

## Your apps are a separate repo

Omni ignores `apps/` in git — it is *your* dashboard, not the framework. Keep it in its own
(private) repository:

```bash
cd apps && git init && git add -A && git commit -m "my glasses apps"
gh repo create my-omni-apps --private --source=. --push      # or add any remote
```

On another machine: clone Omni, then clone your apps repo *as* `apps/` (or point
`OMNI_APPS_DIR` at it). `demo/` stays in the Omni repo as the starter set (copied into
`apps/` only when it is empty). See [`docs/APPS.md`](docs/APPS.md) for the app API; a complete
app can be:

```js
export default { title: 'Hello', render: () => 'Hello, glasses!' }
```

Apps can be grouped into nested folders on the home screen — by sub-folder (`apps/time/…`)
or by declaring `group: 'Time'`. Apps that declare a `settings` schema get their option
screens rendered by the shell, reachable from the tap-and-hold menu. Demo apps (in folders `time/`, `feeds/`, `tools/`, `system/`, `examples/`): Hello,
Clock (full screen / corner / big digits, brightness, fade-away, wake when looking up or down
via IMU — all from its settings), Stopwatch, System monitor (image sparkline), Hacker News
(article text + comments), Notes (inbox with webhook + JSON API), Voice memo (TypeScript,
glasses mic → WAV, play/download from the phone), Todoist (open tasks, complete/postpone,
add from anywhere), Transcribe (live captions via Deepgram, saved sessions with an AI
title/summary/action items, prep notes, and mid-conversation cues from your notes and past
sessions — suggested to-dos go to Todoist with a swipe; put who you are in `data/profile.md`;
imports Conversate TXT exports; `brain-map.mjs` folds sessions into a linked knowledge vault
with Claude Code headless, browsable on the glasses and quoted by cues — run it nightly with a
cron/systemd timer).

**The phone app is a companion too.** Its *Apps* tab lists your apps (open on the glasses,
open their settings) and shows each app's own phone page (`phone` hook) — e.g. the voice
memo downloads. It also works in a normal browser at `<PUBLIC_URL>/app/?token=…`.

## Using it on the glasses

- **Home**: native list of apps — swipe to move, tap to open.
- **In an app**: gestures go to the app; double-tap returns home by default; tap-and-hold
  opens the contextual menu with the app's actions, its settings and *Home* (other apps
  only if you enable that in Settings — it stays short no matter how many apps you have).
- **Double-tap on the home screen opens the system exit dialog** — the Even Hub standard,
  and the default. **Gestures are yours to bind** — on the glasses via *Settings* (home
  menu, or tap then long-press anywhere) or with `PUT /api/config`: e.g. double-tap on the
  home screen → display off, or → jump to the mini clock; *Reset gestures to the standard*
  in Settings puts the defaults back. See [`docs/CONFIG.md`](docs/CONFIG.md).
- **Notifications**: `POST /api/notify {"text": "…"}` shows a toast over anything.

## HTTP API

All routes take `Authorization: Bearer <token>` (or `?token=`).

| Route | What |
|---|---|
| `GET /api/status` | connections, active app, apps, last event |
| `GET /api/screen` | text dump + container layout of what is on the glasses right now |
| `GET /api/events` | SSE stream: gestures, renders, navigation, config, logs, location |
| `GET /files/<name>?token=…` | download anything in `data/files/` (screenshots, exports) |
| `GET /api/logs` | recent server log (includes the phone client's console) |
| `POST /api/notify {text, title?, ms?}` | toast |
| `POST /api/show {view}` | show an ad-hoc view (any `render()` return value) until the user navigates |
| `POST /api/home` · `/api/exit` · `/api/settings` · `/api/action {action}` | navigation / run a gesture action |
| `GET/PUT /api/config` | gesture bindings |
| `GET /api/apps` · `POST /api/apps/:id/open` · `/reload` | apps |
| `POST /api/apps/:id/message {…}` | the app's `onMessage`, result returned |
| `GET/PUT /api/apps/:id/state` | read / merge an app's persisted state |
| `ANY /api/apps/:id/<anything>` | the app's own `http` handler (webhooks, custom JSON API) |
| `POST /api/audio {on}` · `/api/imu {on,pace}` · `/api/location {once}` | device features |
| `POST /api/cmd {op,args}` | raw client command (escape hatch) |
| `POST /api/reload` · `/api/client/reload` | reload all apps / reload the WebView |

## Permanent install (private build)

The QR sideload is the Even app's "prototype mode" and is enough for personal use. For an
app that stays installed on the phone:

```bash
PUBLIC_URL=https://omni.example.com npm run pack     # → omni.ehpk
```

`pack` bumps the patch version (the Even app only reinstalls a *higher* version; `--no-bump`
to skip), writes `client/app.json` with the network whitelist set to your `PUBLIC_URL`,
rebuilds the client with that server's WebSocket URL as its default, and packs `client/dist`.
Download it from the setup page (*⬇ Download omni.ehpk*) and upload it at
hub.evenrealities.com → *Private builds*; install on the phone from *Me → Apps → Private
builds*. First launch: paste the token, *Save & connect* — it is stored in the Even app.

Publishing to the store: the listing needs a privacy policy — [`docs/PRIVACY.md`](docs/PRIVACY.md)
covers every permission the client requests (link to your fork's copy); the reviewers check
that the glasses render something at launch with no server, and that a double-tap on the
root screen opens the exit dialog — both handled by the client even before a server is set up.

## Layout

```
server/    TypeScript, run natively by Node (no build)
  index.ts (http+ws)  shell.ts (home/apps/menu/toasts/gestures)  apps.ts (loader, hot reload)
  renderer.ts (view → containers, diffing)  connection.ts (per-client command queue)
  gestures.ts + config-store.ts + settings-app.ts (rebindable gestures)  ui.ts  png.ts  api.ts  setup.ts
shared/    protocol.ts (wire contract), view.ts (what render() returns), app.ts (app API), config.ts
client/    Vite + TS Even Hub app: thin renderer + phone settings form, served at /app/
demo/      starter apps (copied into apps/ on first run)     apps/   your apps (git-ignored, own repo)
scripts/   fake-client.mjs (headless glasses)  dev-server.sh    docs/   APPS.md  CONFIG.md  PROTOCOL.md
```

`npm run typecheck` checks server, shared, demo apps and client against the same types.

## Keeping it up

A server-side app can block Node's event loop (a runaway loop, a pathological
layout): the process keeps its port but answers nothing, and the glasses sit
there. `scripts/omni-watchdog.sh` probes `/api/status` and restarts the service
after two failures in a row — run it from a systemd timer every minute:

```ini
# ~/.config/systemd/user/omni-watchdog.service     Type=oneshot, ExecStart=…/scripts/omni-watchdog.sh
# ~/.config/systemd/user/omni-watchdog.timer       OnUnitActiveSec=1min
systemctl --user enable --now omni-watchdog.timer
```

The server also logs `event loop was blocked for N s` once it recovers, which is
the breadcrumb for finding what did it.

## Platform notes

- Canvas 576×288, 4-bit green. ≤12 containers (≤8 text/list, ≤4 image), exactly one
  input-capturing container, one font, 27 px lines, ~450 chars per full screen.
- Text-only changes are applied in place (no flicker); layout changes rebuild the page.
- Android may suspend the WebView in the background; the client reconnects and the server
  re-sends the current page, so nothing is lost (state lives on the server).
- The client bundle uses relative, flattened asset paths and no `crossorigin` attribute:
  absolute paths work in a browser but never execute from an installed package.
- QR sideload and the installed app are separate app identities with separate storage; each
  needs the token entered once.

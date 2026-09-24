// Built-in Settings screen: rebind shell gestures from the glasses.
// List-driven: tap selects, double-tap goes back one level, double-tap at
// the top level closes Settings. Registered by the shell as a hidden app.
import type { OmniApp } from '../shared/app.ts'
import { ACTION_CHOICES, GESTURE_CHOICES, type Action, type OmniConfig } from '../shared/config.ts'

type Scope = keyof OmniConfig['gestures']
const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'root', label: 'Home screen gestures', hint: 'on the home list / blank screen' },
  { id: 'global', label: 'Global gestures', hint: 'everywhere, before apps' },
  { id: 'app', label: 'In-app defaults', hint: 'when an app ignores the gesture' },
]

/** What the shell hands the settings app. */
export interface SettingsHost {
  config(): OmniConfig
  setBinding(scope: Scope, gesture: string, action: Action | null): void
  setMenu(patch: Partial<OmniConfig['menu']>): void
  /** put every gesture scope back to the defaults (the Even Hub store standard) */
  resetGestures(): void
  /** apps shown first on the home screen, in order */
  pinned(): string[]
  setPinned(ids: string[]): void
  apps(): { id: string; title: string; group: string }[]
  close(): void
}

interface Mem { level: 'scopes' | 'bindings' | 'gesture' | 'action' | 'app' | 'menu-apps' | 'pins' | 'pin' | 'pin-add'; scope: Scope; gesture: string; pin: number }

const MENU_APPS: { value: OmniConfig['menu']['apps']; label: string }[] = [
  { value: 'none', label: 'none (just the app\'s own items + Home)' },
  { value: 'folder', label: 'apps in the same folder' },
  { value: 'all', label: 'all apps (up to the 10-item limit)' },
]

export function makeSettingsApp(host: SettingsHost): OmniApp<{}, Mem> {
  const back = (m: Mem): boolean => {
    if (m.level === 'scopes') { host.close(); return true }
    m.level = m.level === 'app' ? 'action'
      : m.level === 'action' || m.level === 'gesture' ? 'bindings'
      : m.level === 'pin' || m.level === 'pin-add' ? 'pins'
      : 'scopes'
    return true
  }
  return {
    title: 'Settings',
    hidden: true,
    init(ctx) { ctx.mem.level = 'scopes'; ctx.mem.scope = 'root'; ctx.mem.gesture = ''; ctx.mem.pin = 0 },
    onOpen(ctx) { ctx.mem.level = 'scopes' },

    render(ctx) {
      const m = ctx.mem
      const cfg = host.config()
      const header = (t: string) => ({ type: 'text' as const, name: 'header', x: 0, y: 0, w: 576, h: 36, padding: 4, textColor: 2, text: t })
      const list = (items: string[]) => ({ type: 'list' as const, name: 'list', x: 0, y: 36, w: 576, h: 252, items, capture: true })
      switch (m.level) {
        case 'scopes':
          return { containers: [header('Settings  ·  tap: open  ·  double-tap: close'), list([
            '← Close settings',
            ...SCOPES.map((s) => `${s.label}  (${s.hint})`),
            `Menu shows other apps:  ${MENU_APPS.find((o) => o.value === cfg.menu.apps)?.label.split(' (')[0]}`,
            `Menu shows Settings item:  ${cfg.menu.settings ? 'yes' : 'no'}`,
            `Pinned apps on the home screen:  ${host.pinned().length || 'none'}`,
            'Reset gestures to the standard (double-tap = exit dialog)',
          ])] }
        case 'menu-apps':
          return { containers: [header('Which other apps appear in an app\'s tap-and-hold menu?'), list(MENU_APPS.map((o) => `${o.value === cfg.menu.apps ? '● ' : '○ '}${o.label}`))] }
        case 'bindings': {
          const b = cfg.gestures[m.scope]
          const rows = Object.entries(b).map(([g, a]) => `${g}  →  ${a}`)
          return { containers: [header(`${SCOPES.find((s) => s.id === m.scope)?.label}  ·  double-tap: back`), list([...rows, '+ add a gesture'])] }
        }
        case 'gesture':
          return { containers: [header('Which gesture?  (sequences within 1.5 s)'), list(GESTURE_CHOICES)] }
        case 'action':
          return { containers: [header(`${m.scope}: "${m.gesture}" does…`), list(ACTION_CHOICES.map((a) => a.label))] }
        case 'app':
          return { containers: [header(`"${m.gesture}" opens which app?`), list(host.apps().map((a) => (a.group ? `${a.group} / ` : '') + a.title))] }
        case 'pins': {
          const titles = host.apps()
          const rows = host.pinned().map((id, i) => `${i + 1}. ${titles.find((a) => a.id === id)?.title ?? id}`)
          return { containers: [header('Pinned apps  ·  they open the home list  ·  double-tap: back'), list([...rows, '+ pin an app…'])] }
        }
        case 'pin': {
          const id = host.pinned()[m.pin]
          const title = host.apps().find((a) => a.id === id)?.title ?? id
          return { containers: [header(`${title}  ·  double-tap: back`), list(['Move up', 'Move down', 'Unpin'])] }
        }
        case 'pin-add':
          return { containers: [header('Pin which app?  ·  double-tap: back'), list(host.apps().filter((a) => !host.pinned().includes(a.id)).map((a) => (a.group ? `${a.group} / ` : '') + a.title))] }
      }
    },

    onEvent(ctx, ev) {
      const m = ctx.mem
      if (ev.type === 'double') return back(m)
      if (ev.type !== 'select') return
      const cfg = host.config()
      switch (m.level) {
        case 'scopes': {
          const i = ev.index - 1   // row 0 = close
          if (i < 0) return back(m)
          if (i < SCOPES.length) { m.scope = SCOPES[i].id; m.level = 'bindings' }
          else if (i === SCOPES.length) m.level = 'menu-apps'
          else if (i === SCOPES.length + 1) host.setMenu({ settings: !cfg.menu.settings })
          else if (i === SCOPES.length + 2) m.level = 'pins'
          else host.resetGestures()
          break
        }
        case 'pins': {
          const pins = host.pinned()
          if (ev.index < pins.length) { m.pin = ev.index; m.level = 'pin' }
          else m.level = 'pin-add'
          break
        }
        case 'pin': {
          const pins = [...host.pinned()]
          const i = m.pin
          if (i >= pins.length) { m.level = 'pins'; break }
          if (ev.index === 0 && i > 0) { [pins[i - 1], pins[i]] = [pins[i], pins[i - 1]]; m.pin = i - 1 }
          else if (ev.index === 1 && i < pins.length - 1) { [pins[i + 1], pins[i]] = [pins[i], pins[i + 1]]; m.pin = i + 1 }
          else if (ev.index === 2) { pins.splice(i, 1); m.level = 'pins' }
          host.setPinned(pins)
          break
        }
        case 'pin-add': {
          const choices = host.apps().filter((a) => !host.pinned().includes(a.id))
          const a = choices[ev.index]
          if (a) host.setPinned([...host.pinned(), a.id])
          m.level = 'pins'
          break
        }
        case 'menu-apps': {
          const o = MENU_APPS[ev.index]
          if (o) host.setMenu({ apps: o.value })
          m.level = 'scopes'
          break
        }
        case 'bindings': {
          const keys = Object.keys(cfg.gestures[m.scope])
          if (ev.index < keys.length) { m.gesture = keys[ev.index]; m.level = 'action' }
          else m.level = 'gesture'
          break
        }
        case 'gesture':
          m.gesture = GESTURE_CHOICES[ev.index] ?? 'double'; m.level = 'action'; break
        case 'action': {
          const a = ACTION_CHOICES[ev.index]
          if (!a) break
          if (a.id === 'open:') { m.level = 'app'; break }
          host.setBinding(m.scope, m.gesture, a.id === 'none' ? null : a.id)
          m.level = 'bindings'
          break
        }
        case 'app': {
          const app = host.apps()[ev.index]
          if (app) host.setBinding(m.scope, m.gesture, `open:${app.id}`)
          m.level = 'bindings'
          break
        }
      }
      ctx.render()
    },
  }
}

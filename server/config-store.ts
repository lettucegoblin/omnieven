// Persisted shell configuration (data/config.json) with defaults merged in.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Action, type GestureBindings, type InputConfig, type MenuConfig, type OmniConfig } from '../shared/config.ts'
import { DATA_DIR } from './config.ts'
import { log } from './log.ts'

const FILE = join(DATA_DIR, 'config.json')

function cleanBindings(b: unknown): GestureBindings {
  const out: GestureBindings = {}
  if (!b || typeof b !== 'object') return out
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (typeof v === 'string' && /^[a-z]+(>[a-z]+)*$/.test(k)) out[k] = v
  }
  return out
}

function cleanMenu(m: unknown, base: MenuConfig): MenuConfig {
  const o = (m && typeof m === 'object' ? m : {}) as Partial<MenuConfig>
  return {
    apps: o.apps === 'folder' || o.apps === 'all' || o.apps === 'none' ? o.apps : base.apps,
    pinned: Array.isArray(o.pinned) ? o.pinned.filter((x): x is string => typeof x === 'string') : base.pinned,
    settings: typeof o.settings === 'boolean' ? o.settings : base.settings,
  }
}

/** @returns the given list of app ids, deduped, or the current one when absent */
function cleanIds(v: unknown, base: string[]): string[] {
  if (!Array.isArray(v)) return base
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x))]
}
function cleanInput(i: unknown, base: InputConfig): InputConfig {
  const o = (i && typeof i === 'object' ? i : {}) as Partial<InputConfig>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    repeatMs: num(o.repeatMs, base.repeatMs),
    waitForRender: typeof o.waitForRender === 'boolean' ? o.waitForRender : base.waitForRender,
    maxWaitMs: num(o.maxWaitMs, base.maxWaitMs),
  }
}

export function loadConfig(): OmniConfig {
  let saved: Partial<OmniConfig> = {}
  if (existsSync(FILE)) {
    try { saved = JSON.parse(readFileSync(FILE, 'utf8')) } catch (err) { log('warn', `config.json unreadable: ${(err as Error).message}`) }
  }
  const g = saved.gestures || ({} as Partial<OmniConfig['gestures']>)
  return {
    menu: cleanMenu(saved.menu, DEFAULT_CONFIG.menu),
    pinned: cleanIds(saved.pinned, DEFAULT_CONFIG.pinned),
    input: cleanInput(saved.input, DEFAULT_CONFIG.input),
    gestures: {
      root: { ...DEFAULT_CONFIG.gestures.root, ...cleanBindings(g.root) },
      global: { ...DEFAULT_CONFIG.gestures.global, ...cleanBindings(g.global) },
      app: { ...DEFAULT_CONFIG.gestures.app, ...cleanBindings(g.app) },
    },
  }
}

export function saveConfig(cfg: OmniConfig): void {
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n')
}

/** Merge a partial update (from the API or Settings) into the current config. */
export function mergeConfig(cfg: OmniConfig, patch: Partial<OmniConfig>): OmniConfig {
  const g: Partial<OmniConfig['gestures']> = patch.gestures || {}
  return {
    menu: cleanMenu(patch.menu, cfg.menu),
    pinned: cleanIds(patch.pinned, cfg.pinned),
    input: cleanInput(patch.input, cfg.input),
    gestures: {
      root: { ...cfg.gestures.root, ...cleanBindings(g.root) },
      global: { ...cfg.gestures.global, ...cleanBindings(g.global) },
      app: { ...cfg.gestures.app, ...cleanBindings(g.app) },
    },
  }
}

export function isKnownAction(a: Action): boolean {
  return /^(home|exit|quit|blank|config|next-app|prev-app|none|open:[\w.-]+|notify:.*)$/.test(a)
}

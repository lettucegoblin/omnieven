// Offline packs: pages the server pre-rendered and asked the phone to keep, so
// the glasses still show something useful when the server can't be reached
// (a train, a dead cell, a laptop that went to sleep).
//
// The client treats a pack as opaque — it knows nothing about what any app puts
// in it. It stores the pages, shows them, moves between them on taps and
// swipes, and tells the server where the wearer got to once it reconnects.

import type { CmdArgs, PagePayload } from './protocol'

export interface Pack {
  key: string
  title: string
  pages: PagePayload[]
  /** where the wearer is in this pack */
  index: number
  /** when it was stored (oldest packs are evicted first) */
  at: number
}

const PREFIX = 'omni.pack.'
const MAX_PACK_BYTES = 700_000
const MAX_TOTAL_BYTES = 3_000_000

const keyOf = (key: string) => PREFIX + key

function readPack(storageKey: string): Pack | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const p = JSON.parse(raw) as Pack
    return p && Array.isArray(p.pages) && p.pages.length ? p : null
  } catch { return null }
}

/** Every stored pack, newest first. */
export function listPacks(): Pack[] {
  const out: Pack[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k?.startsWith(PREFIX)) continue
    const p = readPack(k)
    if (p) out.push(p)
  }
  return out.sort((a, b) => b.at - a.at)
}

function totalBytes(): number {
  let n = 0
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(PREFIX)) n += (localStorage.getItem(k) || '').length
  }
  return n
}

/** Store (or replace) a pack, evicting the oldest ones if we are over budget. */
export function storePack(args: CmdArgs['cache.put']): { ok: boolean; reason?: string } {
  const pack: Pack = { key: args.key, title: args.title || args.key, pages: args.pages || [], index: args.index ?? 0, at: Date.now() }
  if (!pack.pages.length) return { ok: false, reason: 'empty' }
  const body = JSON.stringify(pack)
  if (body.length > MAX_PACK_BYTES) return { ok: false, reason: `too big (${Math.round(body.length / 1024)} kB)` }
  try { localStorage.setItem(keyOf(pack.key), body) } catch { return { ok: false, reason: 'storage full' } }
  // Budget: drop the oldest packs (never the one just stored).
  let guard = 0
  while (totalBytes() > MAX_TOTAL_BYTES && guard++ < 20) {
    const oldest = listPacks().filter((p) => p.key !== pack.key).pop()
    if (!oldest) break
    localStorage.removeItem(keyOf(oldest.key))
  }
  return { ok: true }
}

export function clearPacks(key?: string): number {
  if (key) { localStorage.removeItem(keyOf(key)); return 1 }
  const all = listPacks()
  for (const p of all) localStorage.removeItem(keyOf(p.key))
  return all.length
}

function savePosition(pack: Pack) {
  try { localStorage.setItem(keyOf(pack.key), JSON.stringify(pack)) } catch {}
}

// ── the offline shell ────────────────────────────────────────────────
type Draw = (page: PagePayload) => Promise<void>

const TEXT_BOX = { borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 4 }

/** A page the client builds itself: the list of packs to choose from. */
function pickerPage(packs: Pack[]): PagePayload {
  const items = packs.slice(0, 20).map((p) => {
    const at = `${p.index + 1}/${p.pages.length}`
    let label = `${p.title}  ·  ${at}`
    while (new TextEncoder().encode(label).length > 63) label = label.slice(0, -2)
    return label
  })
  return {
    containerTotalNum: 2,
    textObject: [{
      ...TEXT_BOX, xPosition: 0, yPosition: 0, width: 576, height: 36, containerID: 1, containerName: 'off-h',
      zOrderIndex: 1, isEventCapture: 0, textColor: 2, content: 'Offline  ·  saved for you  ·  tap to open',
    }],
    listObject: [{
      ...TEXT_BOX, xPosition: 0, yPosition: 36, width: 576, height: 252, containerID: 2, containerName: 'off-l',
      zOrderIndex: 2, isEventCapture: 1,
      itemContainer: { itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items },
    }],
    imageObject: [],
  }
}

/** A one-page notice, used when there is nothing stored yet. */
function noticePage(text: string): PagePayload {
  return {
    containerTotalNum: 1,
    textObject: [{
      ...TEXT_BOX, xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1, containerName: 'off-n',
      zOrderIndex: 1, isEventCapture: 1, content: text,
    }],
    listObject: [], imageObject: [],
  }
}

/** Drop the server's menu: those actions need the server, so they would lie. */
function withoutMenu(page: PagePayload): PagePayload {
  const { menuObject: _menu, ...rest } = page
  return rest as PagePayload
}

export class OfflineShell {
  private draw: Draw
  private log: (msg: string) => void
  active = false
  private packs: Pack[] = []
  private open: Pack | null = null
  /** packs whose position moved while offline, to report on reconnect */
  private moved = new Set<string>()

  constructor(draw: Draw, log: (msg: string) => void) { this.draw = draw; this.log = log }

  get hasPacks() { return listPacks().length > 0 }

  /** Take over the display. Returns false when there is nothing to show. */
  async enter(reason: string): Promise<boolean> {
    this.packs = listPacks()
    if (!this.packs.length) return false
    this.active = true
    this.log(`offline: ${reason} — ${this.packs.length} pack(s) stored`)
    if (this.packs.length === 1) { this.open = this.packs[0]; await this.show() }
    else { this.open = null; await this.draw(pickerPage(this.packs)) }
    return true
  }

  /** Hand the display back to the server. */
  leave(): { key: string; index: number }[] {
    this.active = false
    const out = [...this.moved].map((key) => {
      const p = listPacks().find((x) => x.key === key)
      return p ? { key, index: p.index } : null
    }).filter(Boolean) as { key: string; index: number }[]
    this.moved.clear()
    this.open = null
    return out
  }

  private async show() {
    if (!this.open) return
    const page = this.open.pages[Math.max(0, Math.min(this.open.index, this.open.pages.length - 1))]
    if (page) await this.draw(withoutMenu(page))
  }

  private async move(by: number) {
    if (!this.open) return
    const next = Math.max(0, Math.min(this.open.index + by, this.open.pages.length - 1))
    if (next === this.open.index) return
    this.open.index = next
    this.moved.add(this.open.key)
    savePosition(this.open)
    await this.show()
  }

  /**
   * Handle a glasses event while offline.
   * @returns 'exit' when the wearer asked to leave the app, true when handled.
   */
  async event(kind: 'tap' | 'double' | 'up' | 'down' | 'select', index = 0): Promise<true | 'exit'> {
    if (!this.open) {   // the picker
      if (kind === 'select') {
        const p = this.packs[index]
        if (p) { this.open = p; await this.show() }
        return true
      }
      if (kind === 'double') return 'exit'
      return true
    }
    if (kind === 'tap' || kind === 'down') { await this.move(1); return true }
    if (kind === 'up') { await this.move(-1); return true }
    if (kind === 'double') {
      if (this.packs.length > 1) { this.open = null; await this.draw(pickerPage(this.packs)); return true }
      return 'exit'
    }
    return true
  }

  /** Something to show when a connection has never been made. */
  async showNotice(text: string) { this.active = true; await this.draw(noticePage(text)) }
}

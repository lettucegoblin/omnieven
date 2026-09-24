// Transcribe — live captions on the glasses (Deepgram), saved sessions with an
// AI title/summary/action items, prep notes, and mid-conversation cues drawn
// from your prep notes and past sessions (definitions, recall, to-do suggestions
// that go straight to Todoist).
//
//   idle    tap: start · menu: Sessions, Clear prep notes
//   live    three lines of captions; the newest insight sits in a badge top left
//           tap: open it (tap again to close) · double-tap: stop? (asks, No first)
//           swipe up: accept the suggested to-do · swipe down: dismiss the badge
//   insights the session's insights, newest first; the first row goes back
//   confirm  a small "stop recording?" box — No is selected, so a stray tap keeps going
//   The audio is kept alongside the transcript (mp3 when an encoder is installed,
//   otherwise WAV) so a doubtful line can be listened back to on the phone page.
//   review  tap: next page · menu: Add all to-dos to Todoist, Add to-do N…, Back
//   phone   prep notes editor, session history with summaries and transcripts, Conversate import,
//           brain map (knowledge vault built by brain-map.mjs) browser + "update now"
//   knowledge  menu → Knowledge: browse the vault on the glasses (folders → notes → pages)
// Needs DEEPGRAM_API_KEY in .env. Summaries/cues use ANTHROPIC_API_KEY if set,
// else the local `claude` CLI. Who-you-are context: data/profile.md.

import { spawn } from 'node:child_process'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStream, transcribeFile } from './deepgram.js'
import { ask, parseJson } from './llm.js'
import { Store } from './store.js'

/** @typedef {{ prep: string, cues: boolean, todos: boolean, lines: number, audio: boolean, engine: 'flux'|'nova-3', repass: boolean }} State */
/** @typedef {{ type: 'definition'|'recall'|'prep'|'answer'|'person'|'todo'|'reminder', header: string, text: string, source?: string, todo?: { text: string, due?: string }, shownAt: number }} Cue */
/** @typedef {{ screen: 'idle'|'live'|'insight'|'insights'|'confirm'|'review'|'sessions'|'notes'|'note', store: Store | null, notesIndexedAt: number, noteFolder: string, noteList: { path: string, title: string }[], noteWindow: number, note: { title: string, pages: string[] } | null, brainMapRunning: boolean, stream: ReturnType<typeof openStream> | null, sessionId: number,
 *   finals: { t: number, speaker: number | null, text: string }[], interim: string, startedAt: number, error: string, status: string,
 *   cue: Cue | null, cueBusy: boolean, lastCueAt: number, lastCueWords: number, tick: any, keepTick: any,
 *   audioOut: import('node:fs').WriteStream | null, audioPath: string, audioBytes: number, hintT: any,
 *   insights: Cue[], insightAt: number, level: number, repassing: boolean,
 *   review: import('./store.js').Session | null, page: number, sessions: import('./store.js').Session[], summarizing: boolean, cueHistory?: string[] }} Mem */

const W = 576, H = 288, HEADER = 36, PAD = 4, LINE = 27
const CUE_EVERY_MS = 12_000, CUE_MIN_WORDS = 12, CUE_TTL_MS = 45_000
// Conversate-style layout: the insight badge sits top left, the clock and the
// recording meter top right, the live captions on the last few lines.
// a bordered box needs room for the border too, or the firmware shows a scrollbar
const BADGE_W = 366, CLOCK_W = 200, BOX_LINE = LINE + 2 * PAD + 4, EXPANDED_H = 4 * LINE + 2 * PAD + 4, LIST_H = 7 * LINE
const BOX = { width: 1, color: 15, radius: 8 }
// The firmware font has no emoji (💡 and friends render as nothing), so the
// "idea" mark is the closest glyph it does have — a glowing ring.
const BULB = '◎'
const CAPTION_KEEP = 600   // chars of finished text kept on screen (Deepgram gives us the rest)

/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function store(ctx) { return (ctx.mem.store ??= new Store(ctx.dataDir)) }
/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function profile(ctx) {
  const f = join(ctx.dataDir, '..', '..', 'profile.md')   // data/profile.md
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
/** Keep the vault index fresh (cheap; at most every 2 min). @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function indexNotes(ctx, force = false) {
  const m = ctx.mem
  if (!force && Date.now() - (m.notesIndexedAt || 0) < 120_000) return
  m.notesIndexedAt = Date.now()
  try { const n = store(ctx).indexNotes(); if (force) ctx.log(`indexed ${n} vault notes`) } catch (err) { ctx.log(`note index: ${err instanceof Error ? err.message : err}`) }
}
const MARKER = 'brain-map.json'
/** Last brain-map run info. @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function brainMapStatus(ctx) {
  const f = join(ctx.dataDir, '.' + MARKER)
  /** @type {{ done: string[], runs: { at: string, files: number, secs: number }[] }} */
  const mk = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { done: [], runs: [] }
  return { lastRun: mk.runs[mk.runs.length - 1] || null, sessionsFolded: mk.done.length, notes: store(ctx).listNotes().length, running: !!ctx.mem.brainMapRunning }
}
/** Run brain-map.mjs (Claude Code headless) in the background. @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function runBrainMap(ctx, all = false) {
  const m = ctx.mem
  if (m.brainMapRunning) return false
  m.brainMapRunning = true
  const script = join(dirname(fileURLToPath(import.meta.url)), 'brain-map.mjs')
  const log = openSync(join(ctx.dataDir, 'brain-map.log'), 'a')
  const child = spawn(process.execPath, [script, ...(all ? ['--all'] : [])], {
    cwd: join(ctx.dataDir, '..', '..', '..'), stdio: ['ignore', log, log],
    env: { ...process.env, OMNI_DATA_DIR: join(ctx.dataDir, '..', '..'), CLAUDE_CLI: ctx.env.CLAUDE_CLI || 'claude', BRAIN_MAP_MODEL: ctx.env.BRAIN_MAP_MODEL || 'sonnet' },
  })
  child.on('close', (code) => {
    m.brainMapRunning = false
    indexNotes(ctx, true)
    ctx.notify(code === 0 ? `Brain map updated (${store(ctx).listNotes().length} notes)` : `Brain map run failed (exit ${code}) — see brain-map.log`, { ms: 3000 })
    if (ctx.active) ctx.render()
  })
  child.on('error', (err) => { m.brainMapRunning = false; ctx.log(`brain-map: ${err.message}`) })
  return true
}

/** @param {Mem} m */
const transcript = (m) => m.finals.map((f) => f.text).join(' ')
const words = (/** @type {string} */ s) => (s.match(/\S+/g) || []).length
const stamp = (/** @type {number} */ ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

// ── vocabulary ───────────────────────────────────────────────────────
/**
 * Names, acronyms and jargon to prime the model with (keyterm prompting):
 * everything the brain map knows, with whatever the prep notes mention first.
 * @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx
 */
function keytermsFor(ctx) {
  /** @type {string[]} */ const out = []
  const prep = (ctx.state.prep || '').toLowerCase()
  // words the user has corrected by hand come first: they are the ones the
  // model keeps getting wrong (see the Knowledge app's corrections list)
  for (const c of knownCorrections(ctx)) if (!out.some((x) => x.toLowerCase() === c.to.toLowerCase())) out.push(c.to)
  try {
    indexNotes(ctx)
    const notes = store(ctx).listNotes().filter((n) => /^(people|tools|terms)\//.test(n.path))
    const titles = notes.map((n) => n.title.replace(/\s*\(.*\)$/, '').trim()).filter((t) => t && t.length <= 40)
    const mentioned = titles.filter((t) => prep.includes(t.toLowerCase()))
    for (const t of [...mentioned, ...titles]) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  } catch { /* no vault yet */ }
  // ALL-CAPS acronyms and Capitalised Names straight from the prep notes
  for (const w of (ctx.state.prep || '').match(/\b([A-Z]{2,6}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/g) || []) {
    if (!out.some((x) => x.toLowerCase() === w.toLowerCase())) out.unshift(w)
  }
  return out.slice(0, 45)
}

/** Hand-made corrections ("heard Bicon, it is Ficon"). @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function knownCorrections(ctx) {
  try { return /** @type {{ from: string, to: string }[]} */ (JSON.parse(readFileSync(join(ctx.dataDir, 'corrections.json'), 'utf8'))) } catch { return [] }
}

// ── the recording ────────────────────────────────────────────────────
const RATE = 16000, BYTES_PER_SAMPLE = 2
/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
const audioDir = (ctx) => { const d = join(ctx.dataDir, 'audio'); mkdirSync(d, { recursive: true }); return d }
/** Start writing the mic stream to disk (raw PCM; encoded when the session ends). @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function startRecording(ctx) {
  const m = ctx.mem
  m.audioOut = null; m.audioPath = ''; m.audioBytes = 0
  if (ctx.state.audio === false) return
  try {
    m.audioPath = join(audioDir(ctx), `session-${m.sessionId}.pcm`)
    m.audioOut = createWriteStream(m.audioPath)
    m.audioOut.on('error', (err) => { ctx.log(`recording: ${err.message}`); m.audioOut = null })
  } catch (err) { ctx.log(`recording: ${err instanceof Error ? err.message : err}`) }
}
/** @param {string} pcm @param {string} wav @param {number} bytes */
function pcmToWav(pcm, wav, bytes) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * BYTES_PER_SAMPLE, 28); h.writeUInt16LE(BYTES_PER_SAMPLE, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(bytes, 40)
  return new Promise((res, rej) => {
    const out = createWriteStream(wav)
    out.write(h)
    createReadStream(pcm).pipe(out, { end: true }).on('finish', () => res(wav)).on('error', rej)
  })
}
/** @param {string} bin @param {string[]} args */
const run = (bin, args) => new Promise((res) => { const p = spawn(bin, args, { stdio: 'ignore' }); p.on('error', () => res(false)); p.on('close', (code) => res(code === 0)) })
/**
 * Close the recording and turn it into something playable: mp3 via lame or
 * ffmpeg when either is installed, otherwise the WAV itself.
 * @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {boolean} keep
 * @returns {Promise<{ file: string, secs: number }>}
 */
async function finishRecording(ctx, keep) {
  const m = ctx.mem
  const out = m.audioOut, pcm = m.audioPath
  m.audioOut = null; m.audioPath = ''
  if (!out || !pcm) return { file: '', secs: 0 }
  await new Promise((res) => out.end(res))
  const bytes = existsSync(pcm) ? statSync(pcm).size : 0
  const secs = bytes / (RATE * BYTES_PER_SAMPLE)
  if (!keep || bytes < RATE) { try { unlinkSync(pcm) } catch {} ; return { file: '', secs: 0 } }
  const wav = pcm.replace(/\.pcm$/, '.wav')
  try { await pcmToWav(pcm, wav, bytes) } catch (err) { ctx.log(`recording: ${err instanceof Error ? err.message : err}`); return { file: '', secs } }
  try { unlinkSync(pcm) } catch {}
  const mp3 = wav.replace(/\.wav$/, '.mp3')
  const ok = await run('lame', ['--quiet', '-m', 'm', '-b', '48', wav, mp3]) || await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '48k', mp3])
  if (ok && existsSync(mp3)) { try { unlinkSync(wav) } catch {} ; return { file: basename(mp3), secs } }
  return { file: basename(wav), secs }
}
/** Content type from the extension. @param {string} f */
const audioType = (f) => f.endsWith('.mp3') ? 'audio/mpeg' : f.endsWith('.m4a') ? 'audio/mp4' : f.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav'
/** @param {number} secs */
const clock = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`

// ── live session ─────────────────────────────────────────────────────
/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
async function start(ctx) {
  const m = ctx.mem
  if (!ctx.env.DEEPGRAM_API_KEY) { m.error = 'DEEPGRAM_API_KEY not set in .env'; ctx.render(); return }
  m.finals = []; m.interim = ''; m.error = ''; m.cue = null; m.lastCueAt = Date.now(); m.lastCueWords = 0
  m.insights = []; m.insightAt = 0; m.level = 0
  m.startedAt = Date.now()
  m.sessionId = store(ctx).create({ started: m.startedAt, prep: ctx.state.prep || '' })
  m.status = 'connecting…'
  m.screen = 'live'; ctx.render()
  m.stream = openStream({
    key: ctx.env.DEEPGRAM_API_KEY,
    engine: ctx.state.engine || 'flux',
    keyterms: keytermsFor(ctx),
    log: (t) => ctx.log(t),
    onSegment: (seg) => {
      // Flux revises the turn in progress, so the interim is the whole turn.
      if (seg.final) { m.finals.push({ t: Date.now() - m.startedAt, speaker: seg.speaker, text: seg.text }); m.interim = '' }
      else m.interim = seg.text
      m.status = ''
      ctx.render()
    },
    onError: (msg) => { m.error = msg; ctx.log(msg); ctx.render() },
  })
  startRecording(ctx)
  let ok
  try { ok = await ctx.audio(true, 'glasses') } catch (err) { ok = false; m.error = err instanceof Error ? err.message : String(err) }
  if (!(Array.isArray(ok) ? ok.some(Boolean) : ok)) { m.error ||= 'Mic did not start'; await stop(ctx, false); return }
  m.status = 'listening'
  m.tick = ctx.setInterval(() => tick(ctx), 1000)   // clock + level meter tick; cue timing is by elapsed time
  ctx.render()
}

/** @param {import("../../../shared/app.ts").AppContext<State, Mem>} ctx @param {boolean} [keep] */
async function stop(ctx, keep = true) {
  const m = ctx.mem
  if (!['live', 'confirm', 'insight', 'insights'].includes(m.screen)) return   // already stopping
  m.screen = 'review'
  if (m.tick) { ctx.clear(m.tick); m.tick = null }
  try { await ctx.audio(false) } catch {}
  m.stream?.close(); m.stream = null
  const text = transcript(m)
  const s = store(ctx)
  const rec = await finishRecording(ctx, keep)
  s.update(m.sessionId, { ended: Date.now(), transcript: text, audio: rec.file, audioSecs: Math.round(rec.secs) })
  if (!keep) { s.remove(m.sessionId); m.screen = 'idle'; ctx.render(); return }
  if (words(text) < 5) {
    s.update(m.sessionId, { title: 'Empty session' }); s.finish(m.sessionId)
    m.screen = 'idle'; ctx.render(); return
  }
  m.summarizing = true; m.screen = 'review'; m.review = s.get(m.sessionId); m.page = 0; ctx.render()
  await summarize(ctx, m.sessionId, text, ctx.state.prep || '')
  s.finish(m.sessionId)
  m.review = s.get(m.sessionId); m.summarizing = false; m.page = 0
  ctx.render()
  if (ctx.state.repass !== false && rec.file) void rePass(ctx, m.sessionId)
}

/**
 * Title / summary / action items / terms / people for a finished transcript (smart tier).
 * @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {number} id @param {string} text @param {string} prep
 */
async function summarize(ctx, id, text, prep) {
  const s = store(ctx)
  try {
    const raw = await ask(ctx, {
      model: 'smart', maxTokens: 1200,
      system: `You write concise notes after a conversation. ${profile(ctx) ? `About the user:\n${profile(ctx)}` : ''}\nReply with JSON only.`,
      prompt: `Transcript (speakers numbered when known; the user is usually speaker 0):\n\n${text.slice(0, 24000)}\n\n${prep ? `The user's prep notes for this conversation:\n${prep}\n\n` : ''}Return JSON: {"title": "≤8 words", "summary": "≤120 words, plain prose, what was discussed and decided", "action_items": [{"text": "concrete action, ≤12 words", "due": "optional natural-language date"}], "terms": [{"term": "…", "definition": "≤20 words"}], "people": [{"name": "…", "role": "…"}]}. Only include real action items for the user.`,
    })
    /** @type {any} */ const j = parseJson(raw) || {}
    s.update(id, {
      title: String(j.title || 'Untitled session').slice(0, 80), summary: String(j.summary || ''),
      actions: Array.isArray(j.action_items) ? j.action_items.filter((/** @type {any} */ a) => a && a.text).map((/** @type {any} */ a) => ({ text: String(a.text), due: a.due ? String(a.due) : undefined })) : [],
      terms: Array.isArray(j.terms) ? j.terms.filter((/** @type {any} */ t) => t && t.term).map((/** @type {any} */ t) => ({ term: String(t.term), definition: String(t.definition || '') })) : [],
      people: Array.isArray(j.people) ? j.people.filter((/** @type {any} */ p) => p && p.name).map((/** @type {any} */ p) => ({ name: String(p.name), role: p.role ? String(p.role) : undefined })) : [],
    })
  } catch (err) {
    ctx.log(`summary failed: ${err instanceof Error ? err.message : err}`)
    const started = s.get(id)?.started ?? Date.now()
    s.update(id, { title: `Session ${new Date(started).toLocaleString(ctx.locale, { timeZone: ctx.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, summary: '(summary pending or failed — use Re-summarize)' })
  }
}

/**
 * Import a Conversate export (Even app → conversation → Share → TXT):
 *   line 1 "<title> - Transcriptions", line 2 "07:25 PM 09/01/2026", line 3 location,
 *   then "[HH:MM:SS]" + text blocks. No speaker labels.
 * @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {string} text @param {string} [filename]
 */
async function importConversate(ctx, text, filename = '') {
  const lines = text.replace(/\r/g, '').split('\n')
  const titleLine = (lines[0] || '').trim()
  const title = titleLine.replace(/\s*-\s*Transcriptions?\s*$/i, '').trim() || filename.replace(/\.txt$/i, '').replace(/_/g, ' ') || 'Imported conversation'
  const dm = (lines[1] || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s+(\d{2})\/(\d{2})\/(\d{4})/i)
  const location = /^[A-Za-z].*,/.test(lines[2] || '') ? lines[2].trim() : ''
  /** @type {{ t: number, text: string }[]} */ const segs = []
  let cur = -1, days = 0
  for (const raw of lines.slice(dm ? 3 : 0)) {
    const l = raw.trim()
    const ts = l.match(/^\[(\d{2}):(\d{2}):(\d{2})\]$/)
    if (ts) {
      const t = (+ts[1] * 3600 + +ts[2] * 60 + +ts[3]) * 1000
      if (cur >= 0 && t + days * 86_400_000 < cur - 3_600_000) days++   // clock wrapped past midnight
      cur = t + days * 86_400_000; continue
    }
    if (!l || /^Generated by A/i.test(l) || cur < 0) continue
    segs.push({ t: cur, text: l })
  }
  if (!segs.length) throw new Error('no "[HH:MM:SS]" transcript lines found')
  // absolute start: the header date in the phone's time zone; the first timestamp gives the seconds
  let started = Date.now()
  if (dm) {
    const y = +dm[6], mo = +dm[4], d = +dm[5]
    const first = segs[0].t
    // build the local wall-clock instant for that zone
    const guess = Date.UTC(y, mo - 1, d, Math.floor(first / 3600000), Math.floor((first % 3600000) / 60000), Math.floor((first % 60000) / 1000))
    const offset = tzOffsetMs(ctx.tz, guess)
    started = guess - offset
  }
  const base = segs[0].t
  const transcript = segs.map((x) => x.text).join(' ')
  const s = store(ctx)
  const dup = s.findDuplicate(started, transcript)
  if (dup) { ctx.log(`import skipped, already have "${dup.title}" (session ${dup.id})`); return { session: dup, duplicate: true } }
  const id = s.create({ started, prep: '', source: 'conversate', location })
  s.update(id, { ended: started + (segs[segs.length - 1].t - base), transcript, title })
  s.finish(id)   // searchable right away; the summary lands when it's ready
  ctx.log(`imported conversate "${title}" (${segs.length} lines)`)
  void summarize(ctx, id, transcript, '').then(() => {
    const after = s.get(id)
    if (after && (!after.title || after.title === 'Untitled session')) s.update(id, { title })
    s.finish(id)
    if (ctx.active) ctx.render()
  })
  return { session: s.get(id), duplicate: false }
}
/** Offset of an IANA zone at an instant, in ms (positive east of UTC). @param {string} tz @param {number} atUtcMs */
function tzOffsetMs(tz, atUtcMs) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(atUtcMs))
  const g = (/** @type {string} */ t) => Number(p.find((x) => x.type === t)?.value)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - atUtcMs
}

// ── cues ─────────────────────────────────────────────────────────────
/** Words worth searching past sessions for: names and longer terms from recent speech. @param {string} text */
function keyTerms(text) {
  const stop = new Set(['about', 'there', 'their', 'would', 'could', 'should', 'because', 'really', 'думаю', 'something', 'anything', 'everything', 'people', 'things', 'think', 'going', 'right', 'actually', 'basically', 'probably', 'through', 'before', 'after', 'where', 'which', 'while', 'those', 'these', 'other', 'still', 'thing', 'maybe', 'wanted', 'trying', 'talking', 'looking', 'yeah'])
  const seen = new Set()
  /** @type {string[]} */ const out = []
  for (const w of text.match(/[A-Za-z][A-Za-z0-9'-]{3,}/g) || []) {
    const lw = w.toLowerCase().replace(/'s$/, '')
    if (stop.has(lw) || seen.has(lw)) continue
    if (/^[A-Z]/.test(w) || lw.length >= 6) { seen.add(lw); out.push(lw) }
  }
  return out.slice(-10)
}

/** Briefly show a hint in the live header. @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {string} text */
function hint(ctx, text) {
  const m = ctx.mem
  m.status = text
  if (m.hintT) ctx.clear(m.hintT)
  m.hintT = ctx.setTimeout(() => { if (m.status === text) m.status = 'listening'; ctx.render() }, 3000)
  ctx.render()
}
/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
function tick(ctx) {
  const m = ctx.mem
  if (m.screen !== 'live') return
  const now = Date.now()
  if (m.cue && now - m.cue.shownAt > CUE_TTL_MS) { m.cue = null; ctx.render() }
  if (!ctx.state.cues || m.cueBusy || now - m.lastCueAt < CUE_EVERY_MS) return
  const total = words(transcript(m))
  if (total - m.lastCueWords < CUE_MIN_WORDS) return
  m.cueBusy = true; m.lastCueAt = now; m.lastCueWords = total
  void makeCue(ctx).catch((err) => ctx.log(`cue failed: ${err instanceof Error ? err.message : err}`)).finally(() => { m.cueBusy = false })
}

/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx */
async function makeCue(ctx) {
  const m = ctx.mem
  const recent = m.finals.filter((f) => Date.now() - m.startedAt - f.t < 75_000).map((f) => `${f.speaker != null ? `[${f.speaker}] ` : ''}${f.text}`).join('\n')
  if (!recent) return
  const s = store(ctx)
  indexNotes(ctx)
  const terms = keyTerms(recent)
  const hits = s.search(terms, m.sessionId)
  const notes = s.searchNotes(terms)
  const openTodos = s.openActions(8)
  const past = hits.map((h) => `- ${new Date(h.started).toISOString().slice(0, 10)} "${h.title}": ${h.snippet}`).join('\n')
  const vault = notes.map((n) => `- ${n.title} (${n.path}): ${n.snippet}`).join('\n')
  const system = `You whisper one short cue into someone's smart glasses during a live conversation. ${profile(ctx) ? `About them:\n${profile(ctx)}\n` : ''}
Rules: reply with JSON only. Offer a cue ONLY if it genuinely helps right now; otherwise {"type":"none"}.
Types: "definition" (a term/acronym just came up that they may need explained), "recall" (something relevant from a past conversation — cite its date), "prep" (a point from their prep notes that fits now), "answer" (a factual question was asked that the material answers), "person" (who a mentioned person is, from past sessions), "todo" (a concrete task for the user emerged — phrase it as an action), "reminder" (an open action item of theirs is relevant).
"header" ≤ 22 characters: the subject alone (a term, a name, "Q4 budget"), no verbs, this is the badge the wearer glances at. "text" ≤ 110 characters, plain, no preamble. For "todo" also give {"todo":{"text":"…","due":"optional"}}. Don't repeat a cue already given. Prefer "none" over noise.
Never invent facts, numbers, names or sources: "answer", "recall" and "person" may only state what is literally in the prep notes, knowledge-base notes or past-conversation excerpts below (quote the date for recall). If the material doesn't contain it, use "definition" for general knowledge you are sure of, or "none".`
  const prompt = `${ctx.state.prep ? `Prep notes:\n${ctx.state.prep}\n\n` : ''}${vault ? `From the user's knowledge base (curated from past conversations):\n${vault}\n\n` : ''}${past ? `From past conversations:\n${past}\n\n` : ''}${openTodos.length ? `Their open action items:\n${openTodos.map((t) => `- ${t.text}${t.due ? ` (${t.due})` : ''}`).join('\n')}\n\n` : ''}Recent cues already shown: ${m.cueHistory?.slice(-4).join(' | ') || 'none'}\n\nLast ~minute of the conversation (speaker numbers in brackets, 0 is usually the user):\n${recent}\n\nJSON:`
  const raw = await ask(ctx, { model: 'fast', maxTokens: 200, timeoutMs: 15_000, system, prompt })
  const j = parseJson(raw)
  if (!j || !j.type || j.type === 'none' || !j.text || m.screen !== 'live') return
  if (j.type === 'todo' && !ctx.state.todos) return
  m.cue = { type: j.type, header: String(j.header || j.text).replace(/\s+/g, ' ').slice(0, 26), text: String(j.text).slice(0, 140), source: j.source ? String(j.source) : undefined, todo: j.todo && j.todo.text ? { text: String(j.todo.text), due: j.todo.due ? String(j.todo.due) : undefined } : (j.type === 'todo' ? { text: String(j.text) } : undefined), shownAt: Date.now() }
  ;(m.cueHistory ??= []).push(m.cue.text)
  m.insights.push(m.cue)
  ctx.render()
}

/** @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {{ text: string, due?: string }} todo */
async function addTodo(ctx, todo) {
  try {
    await ctx.message('todoist', { add: todo.text, due: todo.due })
  } catch (err) { ctx.notify(`Todoist: ${err instanceof Error ? err.message : err}`, { ms: 2500 }) }
}

// ── the accurate second pass ─────────────────────────────────────────
/**
 * Re-transcribe the saved recording with the pre-recorded model (it sees the
 * whole conversation, so it is more accurate than the live stream), fix
 * mis-heard jargon against the brain map, then re-write the summary.
 * @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {number} id
 */
async function rePass(ctx, id) {
  const m = ctx.mem
  const s = store(ctx)
  const sess = s.get(id)
  if (!sess || !sess.audio || !ctx.env.DEEPGRAM_API_KEY) return
  const f = join(ctx.dataDir, 'audio', sess.audio)
  if (!existsSync(f)) return
  m.repassing = true
  if (ctx.active) ctx.render()
  try {
    const started = Date.now()
    const r = await transcribeFile({ key: ctx.env.DEEPGRAM_API_KEY, file: readFileSync(f), contentType: audioType(f), keyterms: keytermsFor(ctx) })
    if (!r.text.trim()) { ctx.log('re-transcribe: nothing came back, keeping the live transcript'); return }
    let text = r.text, source = 'batch'
    const fixed = await glossaryFix(ctx, text)
    if (fixed.changes) { text = fixed.text; source = 'batch+glossary' }
    s.update(id, { liveTranscript: sess.liveTranscript || sess.transcript, transcript: text, transcriptSource: source })
    ctx.log(`re-transcribed session ${id} in ${Math.round((Date.now() - started) / 1000)} s (confidence ${r.confidence.toFixed(2)}, ${fixed.changes} glossary fixes)`)
    await summarize(ctx, id, text, sess.prep)
    s.finish(id)
    if (m.review?.id === id) m.review = s.get(id)
  } catch (err) {
    ctx.log(`re-transcribe: ${err instanceof Error ? err.message : err}`)
  } finally {
    m.repassing = false
    if (ctx.active) ctx.render()
  }
}
/** Edit distance, for the "does this even sound like it?" check below. @param {string} a @param {string} b */
function distance(a, b) {
  const m = a.length, n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}
/** A replacement is only plausible when the two actually sound close. @param {string} a @param {string} b */
function couldBeMisheard(a, b) {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, ''), y = b.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!x || !y || x === y) return false
  return distance(x, y) <= Math.max(2, Math.ceil(Math.max(x.length, y.length) * 0.34))
}
/**
 * Ask the fast model which mis-hearings to correct against the vault's
 * vocabulary; the replacements are applied here, so it can't rewrite content.
 * @param {import('../../../shared/app.ts').AppContext<State, Mem>} ctx @param {string} text
 */
async function glossaryFix(ctx, text) {
  const glossary = keytermsFor(ctx)
  if (!glossary.length || !text.trim()) return { text, changes: 0 }
  // the user's own corrections are applied outright, no model involved
  let fixed = text, applied = 0
  for (const c of knownCorrections(ctx)) {
    const re = new RegExp(`\\b${c.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    const before = fixed
    fixed = fixed.replace(re, c.to)
    if (fixed !== before) applied++
  }
  text = fixed
  try {
    const raw = await ask(ctx, {
      model: 'fast', maxTokens: 800, timeoutMs: 30_000,
      system: 'You spot words a speech-to-text model mis-heard. Reply with JSON only.',
      prompt: `Known vocabulary (names, tools, acronyms) from the user's own notes:\n${glossary.join(', ')}\n\nTranscript:\n${text.slice(0, 18000)}\n\nList only clear mis-hearings of the vocabulary above — a word or phrase in the transcript that is obviously the same spoken sound as a known term. Do not fix grammar, do not change meaning, do not invent terms that are not in the list.\nJSON: {"replacements": [{"from": "exact text in the transcript", "to": "correct term"}]}`,
    })
    /** @type {any} */ const j = parseJson(raw) || {}
    let out = text, changes = 0
    for (const r of Array.isArray(j.replacements) ? j.replacements : []) {
      const from = String(r?.from || '').trim(), to = String(r?.to || '').trim()
      if (!from || !to || from.toLowerCase() === to.toLowerCase() || from.length < 2 || from.length > 60) continue
      if (!glossary.some((g) => g.toLowerCase() === to.toLowerCase())) continue   // only the known vocabulary
      if (glossary.some((g) => g.toLowerCase() === from.toLowerCase())) continue   // already a known term: leave it alone
      if (!couldBeMisheard(from, to)) { ctx.log(`glossary: ignored "${from}" → "${to}" (doesn't sound alike)`); continue }
      const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
      const before = out
      out = out.replace(re, to)
      if (out !== before) changes++
    }
    return { text: out, changes: changes + applied }
  } catch (err) { ctx.log(`glossary: ${err instanceof Error ? err.message : err}`); return { text, changes: applied } }
}

// ── app ──────────────────────────────────────────────────────────────
/** @type {import('../../../shared/app.ts').OmniApp<State, Mem>} */
export default {
  title: 'Transcribe',
  settings: [
    { key: 'cues', label: 'Cues during conversation', options: [{ value: true, label: 'on' }, { value: false, label: 'off' }] },
    { key: 'todos', label: 'Suggest to-dos', options: [{ value: true, label: 'on (swipe up to add)' }, { value: false, label: 'off' }] },
    { key: 'lines', label: 'Caption lines', options: [2, 3, 4, 5].map((v) => ({ value: v, label: `${v}` })) },
    { key: 'engine', label: 'Live model', options: [{ value: 'flux', label: 'Flux (turn-based, revises words)' }, { value: 'nova-3', label: 'Nova-3 (speaker labels)' }] },
    { key: 'repass', label: 'Re-transcribe afterwards', options: [{ value: true, label: 'on (more accurate)' }, { value: false, label: 'off' }] },
    { key: 'audio', label: 'Keep the recording', options: [{ value: true, label: 'on (listen back later)' }, { value: false, label: 'off' }] },
  ],
  init(ctx) {
    ctx.state.prep ??= ''; ctx.state.cues ??= true; ctx.state.todos ??= true; ctx.state.lines ??= 3; ctx.state.audio ??= true
    ctx.state.engine ??= 'flux'; ctx.state.repass ??= true
    const m = ctx.mem
    m.screen = 'idle'; m.finals ??= []; m.interim = ''; m.error = ''; m.status = ''; m.cue = null; m.cueBusy = false
    m.lastCueAt = 0; m.lastCueWords = 0; m.review = null; m.page = 0; m.sessions = []; m.summarizing = false
    m.notesIndexedAt = 0; m.noteFolder = ''; m.noteList = []; m.noteWindow = 0; m.note = null; m.brainMapRunning ??= false
    m.audioOut = null; m.audioPath = ''; m.audioBytes = 0; m.hintT = null
    m.insights ??= []; m.insightAt = 0; m.level = 0; m.repassing = false
    setTimeout(() => indexNotes(ctx, true), 500)
  },
  onClose(ctx) { if (['live', 'confirm', 'insight', 'insights'].includes(ctx.mem.screen)) void stop(ctx) },
  // mem survives a hot reload; drop the Store so the reloaded class is used
  unload(ctx) {
    const m = ctx.mem
    if (['live', 'confirm', 'insight', 'insights'].includes(m.screen)) {   // a reload mid-recording: mic off, keep what was heard
      void ctx.audio(false)
      try { const s = store(ctx); s.update(m.sessionId, { ended: Date.now(), transcript: transcript(m), title: 'Interrupted by a reload' }); s.finish(m.sessionId) } catch {}
    }
    m.stream?.close(); m.stream = null
    try { m.store?.db.close() } catch {}
    m.store = null
  },

  render(ctx) {
    const m = ctx.mem, s = ctx.state
    const header = (/** @type {string} */ t) => ({ type: /** @type {const} */ ('text'), name: 'header', x: 0, y: 0, w: W, h: HEADER, padding: PAD, textColor: 2, text: ctx.ui.fit(t, W - 16) })
    if (m.error && m.screen !== 'live') return { text: `Transcribe\n\n${m.error}\n\ntap: back` }

    if (m.screen === 'live' || m.screen === 'insight' || m.screen === 'insights') {
      const lines = Math.max(2, Math.min(s.lines || 3, 5))
      const capH = lines * LINE + 2 * PAD
      const live = `${transcript(m).slice(-CAPTION_KEEP)} ${m.interim}`.trim()
      const captions = ctx.ui.wrap(live, W - 16).slice(-lines).join('\n') || (m.status || '…')
      /** @type {import('../../../shared/view.ts').Container[]} */
      const top = []

      if (m.screen === 'insights') {
        const rows = ['‹ back to the captions',
          ...(m.insights.length ? m.insights.slice(-20).reverse().map((c) => ctx.ui.fit(`${BULB} ${c.header}`, 540)) : ['(nothing yet)'])]
        top.push({ type: 'list', name: 'insights', x: 0, y: 0, w: W, h: LIST_H, capture: true, items: rows })
      } else if (m.screen === 'insight') {
        const c = m.insights[m.insightAt] || m.cue
        const body = c ? `${BULB} ${c.header}\n${c.text}${c.todo ? '\nswipe up: add to Todoist' : ''}` : '(gone)'
        top.push({ type: 'text', name: 'insight', x: 0, y: 0, w: W, h: EXPANDED_H, padding: PAD, border: BOX, text: ctx.ui.wrap(body, W - 2 * PAD - 10).slice(0, 4).join('\n') })
      } else {
        if (m.cue) top.push({ type: 'text', name: 'badge', x: 0, y: 0, w: BADGE_W, h: BOX_LINE, padding: PAD, border: BOX, text: ctx.ui.fit(`${BULB} ${m.cue.header}`, BADGE_W - 2 * PAD - 10) })
        else if (m.insights.length) top.push({ type: 'text', name: 'badge', x: 0, y: 0, w: 150, h: BOX_LINE, padding: PAD, textColor: 2, text: `${m.insights.length} insight${m.insights.length > 1 ? 's' : ''}` })
        const bars = '▌'.repeat(Math.max(1, Math.min(3, 1 + Math.round(m.level * 2))))
        const time = new Date().toLocaleTimeString(ctx.locale, { hour: 'numeric', minute: '2-digit', timeZone: ctx.tz })
        top.push({ type: 'text', name: 'clock', x: W - CLOCK_W, y: 0, w: CLOCK_W, h: BOX_LINE, padding: PAD, textColor: 3,
          text: ctx.ui.align(`${m.audioOut ? '●' : '○'} ${bars}  ${time}`, CLOCK_W - 2 * PAD - 8, 'right') })
      }

      return {
        containers: [...top,
          { type: 'text', name: 'captions', x: 0, y: H - capH, w: W, h: capH, padding: PAD, capture: m.screen !== 'insights', text: captions }],
        menu: [
          ...(m.insights.length ? [{ id: 'insights', label: 'Insights' }] : []),
          ...((m.screen === 'insight' ? m.insights[m.insightAt]?.todo : m.cue?.todo) ? [{ id: 'add-cue', label: 'Add to-do to Todoist' }] : []),
          { id: 'stop', label: 'End & summarize' }, { id: 'discard', label: 'End & discard' },
          ...(m.repassing ? [{ id: 'noop', label: 'Re-transcribing…' }] : []),
        ],
      }
    }

    if (m.screen === 'confirm') {
      // A small box in the middle rather than a full screen, with "No" first so
      // the highlighted row is the safe one.
      const secs = (Date.now() - m.startedAt) / 1000
      const bx = 96, bw = W - 2 * bx
      return {
        containers: [
          { type: /** @type {const} */ ('text'), name: 'ask', x: bx, y: 40, w: bw, h: BOX_LINE, padding: PAD, border: BOX, textColor: 4,
            text: ctx.ui.align(`Stop recording?  ${clock(secs)}`, bw - 2 * PAD - 10, 'center') },
          { type: /** @type {const} */ ('list'), name: 'confirm', x: bx, y: 40 + BOX_LINE + 6, w: bw, h: 150, capture: true,
            items: ['No — keep recording', 'Yes — stop & summarize', 'Stop & discard'] }],
        menu: [{ id: 'resume', label: 'No — keep recording' }, { id: 'stop', label: 'Yes — stop & summarize' }, { id: 'discard', label: 'Stop & discard' }],
      }
    }

    if (m.screen === 'review' && m.review) {
      const r = m.review
      if (m.summarizing) return { containers: [header('Summarizing…'), { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: H - HEADER, padding: PAD, capture: true, text: `${words(r.transcript)} words saved.\n\nWriting the title, summary and action items…` }] }
      const rec = r.audio ? `\n\nRecording: ${clock(r.audioSecs || 0)}${m.repassing ? ' · re-transcribing…' : r.transcriptSource && r.transcriptSource !== 'live' ? ` · ${r.transcriptSource} transcript` : ''} — play it on the phone page.` : ''
      const body = `${r.summary}${rec}${r.actions.length ? `\n\nAction items:\n${r.actions.map((a, i) => `${i + 1}. ${a.text}${a.due ? ` (${a.due})` : ''}`).join('\n')}` : ''}${r.terms.length ? `\n\nTerms:\n${r.terms.map((t) => `${t.term}: ${t.definition}`).join('\n')}` : ''}`
      const pages = ctx.ui.paginate(body, { widthPx: W - 16, lines: Math.floor((H - HEADER - 2 * PAD) / LINE) })
      const page = Math.min(m.page, pages.length - 1)
      return {
        containers: [header(`${r.title}  ·  ${page + 1}/${pages.length}  ·  tap: next  ·  double-tap: back`),
          { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: H - HEADER, padding: PAD, capture: true, text: pages[page] }],
        menu: [
          ...(r.actions.length ? [{ id: 'todo-all', label: `Add ${r.actions.length} to-do${r.actions.length > 1 ? 's' : ''} to Todoist` }] : []),
          ...r.actions.slice(0, 5).map((a, i) => ({ id: `todo-${i}`, label: ctx.ui.fit(`+ ${a.text}`, 190) })),
          { id: 'sessions', label: 'Sessions' }, { id: 'back', label: 'Back' },
        ],
      }
    }

    if (m.screen === 'note' && m.note) {
      const page = Math.min(m.page, m.note.pages.length - 1)
      return { containers: [header(`${m.note.title}  ·  ${page + 1}/${m.note.pages.length}  ·  tap: next  ·  double-tap: back`),
        { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: H - HEADER, padding: PAD, capture: true, text: m.note.pages[page] }] }
    }
    if (m.screen === 'notes') {
      if (!m.noteFolder) {
        const folders = [...new Set(m.noteList.map((n) => (n.path.includes('/') ? n.path.split('/')[0] : '(overview)')))].sort()
        return { containers: [header(`Knowledge  ·  ${m.noteList.length} notes  ·  double-tap: back`),
          folders.length ? { type: 'list', name: 'folders', x: 0, y: HEADER, w: W, h: H - HEADER, capture: true, items: folders.slice(0, 20).map((f) => ctx.ui.fit(`${f}  (${m.noteList.filter((n) => (n.path.includes('/') ? n.path.split('/')[0] : '(overview)') === f).length})`, 540)) }
            : { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: H - HEADER, padding: PAD, capture: true, text: 'No notes yet — run the brain map from the phone page (menu: Update brain map).' }],
          menu: [{ id: 'brain-map', label: m.brainMapRunning ? 'Brain map: running…' : 'Update brain map' }, { id: 'back', label: 'Back' }] }
      }
      const inFolder = m.noteList.filter((n) => (n.path.includes('/') ? n.path.split('/')[0] : '(overview)') === m.noteFolder)
      const start = Math.max(0, Math.min(m.noteWindow, inFolder.length - 20))
      const slice = inFolder.slice(start, start + 20)
      return { containers: [header(`${m.noteFolder}  ·  ${start + 1}–${start + slice.length} of ${inFolder.length}  ·  double-tap: back`),
        { type: 'list', name: 'notes', x: 0, y: HEADER, w: W, h: H - HEADER, capture: true, items: slice.map((n) => ctx.ui.fit(n.title, 540)) }],
        menu: [...(inFolder.length > 20 ? [{ id: 'earlier', label: 'Earlier notes' }, { id: 'later', label: 'Later notes' }] : []), { id: 'back', label: 'Back' }] }
    }
    if (m.screen === 'sessions') {
      const items = m.sessions.map((x) => ctx.ui.fit(`${new Date(x.started).toLocaleDateString(ctx.locale, { month: 'short', day: 'numeric', timeZone: ctx.tz })}  ${x.title || 'Untitled'}`, 540))
      return { containers: [header(`Sessions  ·  ${m.sessions.length}  ·  tap: open  ·  double-tap: back`),
        items.length ? { type: 'list', name: 'sessions', x: 0, y: HEADER, w: W, h: H - HEADER, capture: true, items: items.slice(0, 20) }
          : { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: H - HEADER, padding: PAD, capture: true, text: 'No sessions yet.' }] }
    }

    // idle
    const prep = s.prep ? ctx.ui.wrap(s.prep, W - 16).slice(0, 5).join('\n') : 'No prep notes — write some on the phone (people, agenda, things to ask).'
    return {
      containers: [header(`Transcribe  ·  tap: start  ·  cues ${s.cues ? 'on' : 'off'}`),
        { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: H - HEADER, padding: PAD, capture: true, text: `Prep notes:\n${prep}` }],
      menu: [{ id: 'start', label: 'Start' }, { id: 'sessions', label: 'Sessions' }, { id: 'knowledge', label: 'Knowledge' }, ...(s.prep ? [{ id: 'clear-prep', label: 'Clear prep notes' }] : [])],
    }
  },

  onEvent(ctx, ev) {
    const m = ctx.mem
    if (m.error && m.screen !== 'live') { if (ev.type === 'tap' || ev.type === 'double') { m.error = ''; m.screen = 'idle'; ctx.render(); return true } return }
    switch (m.screen) {
      case 'idle':
        if (ev.type === 'tap') { void start(ctx); return true }
        return
      case 'live':
        // tap opens the badge (or the list); double-tap always asks to stop
        if (ev.type === 'tap') {
          if (m.cue) { m.insightAt = Math.max(0, m.insights.lastIndexOf(m.cue)); m.screen = 'insight'; ctx.render() }
          else if (m.insights.length) { m.screen = 'insights'; ctx.render() }
          else hint(ctx, 'double-tap to stop · insights appear here')
          return true
        }
        if (ev.type === 'double') { m.screen = 'confirm'; ctx.render(); return true }
        if (ev.type === 'up') { if (m.cue?.todo) { const t = m.cue.todo; m.cue = null; void addTodo(ctx, t); ctx.render() } return true }
        if (ev.type === 'down') { m.cue = null; ctx.render(); return true }
        return
      case 'insight': {
        const c = m.insights[m.insightAt]
        if (ev.type === 'tap') { m.screen = 'live'; ctx.render(); return true }
        if (ev.type === 'double') { m.screen = 'confirm'; ctx.render(); return true }
        if (ev.type === 'up') { if (c?.todo) { void addTodo(ctx, c.todo); if (m.cue === c) m.cue = null; m.screen = 'live'; ctx.render() } return true }
        if (ev.type === 'down') { if (m.cue === c) m.cue = null; m.screen = 'live'; ctx.render(); return true }
        return
      }
      case 'insights':
        if (ev.type === 'select') {
          if (ev.index === 0) { m.screen = 'live'; ctx.render(); return true }   // "‹ back to the captions"
          const c = m.insights.slice(-20).reverse()[ev.index - 1]
          if (c) { m.insightAt = m.insights.lastIndexOf(c); m.screen = 'insight'; ctx.render() }
          else { m.screen = 'live'; ctx.render() }
          return true
        }
        if (ev.type === 'double') { m.screen = 'confirm'; ctx.render(); return true }
        return
      case 'confirm':
        if (ev.type === 'select') {
          if (ev.index === 1) void stop(ctx)
          else if (ev.index === 2) void stop(ctx, false)
          else { m.screen = 'live'; ctx.render() }
          return true
        }
        if (ev.type === 'double' || ev.type === 'tap') { m.screen = 'live'; ctx.render(); return true }
        return
      case 'review':
        if (ev.type === 'tap') { m.page++; ctx.render(); return true }
        if (ev.type === 'up') { m.page = Math.max(0, m.page - 1); ctx.render(); return true }
        if (ev.type === 'double') { m.screen = 'idle'; ctx.render(); return true }
        return
      case 'sessions':
        if (ev.type === 'select') { const x = m.sessions[ev.index]; if (x) { m.review = x; m.page = 0; m.screen = 'review'; ctx.render() } return true }
        if (ev.type === 'double') { m.screen = 'idle'; ctx.render(); return true }
        return
      case 'notes': {
        if (ev.type === 'double') { if (m.noteFolder) m.noteFolder = ''; else m.screen = 'idle'; ctx.render(); return true }
        if (ev.type !== 'select') return
        if (!m.noteFolder) {
          const folders = [...new Set(m.noteList.map((n) => (n.path.includes('/') ? n.path.split('/')[0] : '(overview)')))].sort()
          if (folders[ev.index]) { m.noteFolder = folders[ev.index]; m.noteWindow = 0; ctx.render() }
          return true
        }
        const inFolder = m.noteList.filter((n) => (n.path.includes('/') ? n.path.split('/')[0] : '(overview)') === m.noteFolder)
        const start = Math.max(0, Math.min(m.noteWindow, inFolder.length - 20))
        const n = inFolder[start + ev.index]
        if (n) {
          const text = (store(ctx).readNote(n.path) || '').replace(/^---[\s\S]*?---\n/, '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_, p) => p.split('/').pop()).replace(/^#+\s*/gm, '').replace(/\*\*/g, '')
          m.note = { title: n.title, pages: ctx.ui.paginate(text, { widthPx: W - 16, lines: Math.floor((H - HEADER - 2 * PAD) / LINE) }) }
          m.page = 0; m.screen = 'note'; ctx.render()
        }
        return true
      }
      case 'note':
        if (ev.type === 'tap') { m.page++; ctx.render(); return true }
        if (ev.type === 'up') { m.page = Math.max(0, m.page - 1); ctx.render(); return true }
        if (ev.type === 'double') { m.screen = 'notes'; ctx.render(); return true }
        return
    }
  },

  onMenu(ctx, id) {
    const m = ctx.mem
    if (id === 'start') return void start(ctx)
    if (id === 'stop') return void stop(ctx)
    if (id === 'discard') return void stop(ctx, false)
    if (id === 'resume') { if (m.screen === 'confirm') { m.screen = 'live'; ctx.render() } return }
    if (id === 'insights') { m.screen = 'insights'; ctx.render(); return }
    if (id === 'noop') return
    if (id === 'add-cue' && m.cue?.todo) { const t = m.cue.todo; m.cue = null; ctx.render(); return void addTodo(ctx, t) }
    if (id === 'sessions') { m.sessions = store(ctx).list(20); m.screen = 'sessions'; return ctx.render() }
    if (id === 'knowledge') { indexNotes(ctx, true); m.noteList = store(ctx).listNotes(); m.noteFolder = ''; m.screen = 'notes'; return ctx.render() }
    if (id === 'brain-map') { runBrainMap(ctx) ? ctx.notify('Brain map: running (a few minutes)…', { ms: 2000 }) : ctx.notify('Brain map already running', { ms: 1500 }); return }
    if (id === 'earlier') { m.noteWindow -= 20; return ctx.render() }
    if (id === 'later') { m.noteWindow += 20; return ctx.render() }
    if (id === 'back') { m.screen = 'idle'; return ctx.render() }
    if (id === 'clear-prep') { ctx.state.prep = ''; ctx.save(); return ctx.render() }
    if (id === 'todo-all' && m.review) { for (const a of m.review.actions) void addTodo(ctx, a); return }
    if (id.startsWith('todo-') && m.review) { const a = m.review.actions[Number(id.slice(5))]; if (a) void addTodo(ctx, a) }
  },

  onAudio(ctx, pcm) {
    const m = ctx.mem
    m.stream?.send(pcm)
    if (m.audioOut) { m.audioBytes += pcm.length; m.audioOut.write(Buffer.from(pcm)) }
    const buf = Buffer.from(pcm)
    let sum = 0
    for (let i = 0; i + 1 < buf.length; i += 2) { const v = buf.readInt16LE(i) / 32768; sum += v * v }
    const rms = Math.sqrt(sum / Math.max(1, buf.length / 2))
    m.level = Math.max(m.level * 0.7, Math.min(1, rms * 6))   // decay, so the meter falls back
  },

  onMessage(ctx, msg) {
    // Action items other apps can work through (Todoist shows them in its inbox).
    if (msg?.pending) return { actions: store(ctx).openActions(30) }
    if (msg?.markAction?.text) {
      const s = store(ctx)
      if (msg.markAction.session) s.markAction(Number(msg.markAction.session), String(msg.markAction.text))
      else for (const a of s.openActions(50)) if (a.text === msg.markAction.text) s.markAction(a.session, a.text)
      return { ok: true, left: store(ctx).openActions(30).length }
    }
    if (msg?.clearPending) { const s = store(ctx); for (const a of s.openActions(50)) s.markAction(a.session, a.text); return { ok: true, left: 0 } }
    // {"insight":{"type":"recall","header":"SAP feed outage","text":"…"}} — used by
    // the demo/test harness and by other apps that want to raise something.
    if (msg?.insight?.header) {
      const i = msg.insight
      /** @type {Cue} */ const cue = { type: i.type || 'prep', header: String(i.header).slice(0, 26), text: String(i.text || i.header).slice(0, 140), todo: i.todo, shownAt: Date.now() }
      ctx.mem.insights.push(cue); ctx.mem.cue = cue
      ctx.render()
    }
    if (typeof msg.prep === 'string') { ctx.state.prep = msg.prep.slice(0, 4000); ctx.save(); ctx.render() }
    if (msg.start && ctx.mem.screen === 'idle') { ctx.open(); void start(ctx) }
    if (msg.stop && ctx.mem.screen === 'live') void stop(ctx)
    return { screen: ctx.mem.screen, words: words(transcript(ctx.mem)), prep: ctx.state.prep }
  },

  http(ctx, req) {
    const s = store(ctx)
    if (req.path === '/sessions') return { sessions: s.list(50).map((x) => ({ id: x.id, started: x.started, title: x.title, summary: x.summary, actions: x.actions })) }
    if (req.path.startsWith('/session/') && req.method === 'GET') { const x = s.get(Number(req.path.slice(9))); return x ? { session: x } : { status: 404, json: { error: 'no such session' } } }
    if (req.path === '/prep' && req.method === 'POST') { const b = /** @type {any} */ (req.body); ctx.state.prep = String(b?.prep ?? '').slice(0, 4000); ctx.save(); ctx.render(); return { ok: true } }
    if (req.path === '/todo' && req.method === 'POST') { const b = /** @type {any} */ (req.body); if (b?.text) void addTodo(ctx, { text: String(b.text), due: b.due }); return { ok: true } }
    if (req.path === '/audio') {
      const dir = join(ctx.dataDir, 'audio')
      const f = resolve(dir, String(req.query.file || ''))
      if (!f.startsWith(dir + sep) || !existsSync(f)) return { status: 404, json: { error: 'no such recording' } }
      const size = statSync(f).size
      const name = basename(f)
      const type = audioType(f)
      const range = String(req.headers.range || '').match(/bytes=(\d*)-(\d*)/)
      if (range) {
        const start = range[1] ? Number(range[1]) : 0
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        const len = Math.max(0, end - start + 1)
        const buf = Buffer.alloc(len)
        const fd = openSync(f, 'r'); readSync(fd, buf, 0, len, start); closeSync(fd)
        return { status: 206, headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(len) }, body: buf }
      }
      return { status: 200, headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size), ...(req.query.download ? { 'content-disposition': `attachment; filename="${name}"` } : {}) }, body: readFileSync(f) }
    }
    if (req.path === '/live') return { screen: ctx.mem.screen, text: transcript(ctx.mem), interim: ctx.mem.interim, cue: ctx.mem.cue }
    if (req.path === '/brain-map' && req.method === 'POST') { const started = runBrainMap(ctx, !!req.query.all); return { ok: started, running: true, ...(started ? {} : { note: 'already running' }) } }
    if (req.path === '/brain-map') return brainMapStatus(ctx)
    if (req.path === '/notes') { indexNotes(ctx); return { notes: s.listNotes() } }
    if (req.path === '/note') { const t = s.readNote(String(req.query.path || '')); return t == null ? { status: 404, json: { error: 'no such note' } } : { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: t } }
    if (req.path === '/repass' && req.method === 'POST') {
      const id = Number(req.query.id || /** @type {any} */ (req.body)?.id)
      if (!s.get(id)) return { status: 404, json: { error: 'no such session' } }
      void rePass(ctx, id)
      return { ok: true, running: true }
    }
    if (req.path === '/resummarize' && req.method === 'POST') {
      const id = Number(req.query.id || /** @type {any} */ (req.body)?.id)
      const x = s.get(id)
      if (!x) return { status: 404, json: { error: 'no such session' } }
      return summarize(ctx, id, x.transcript, x.prep).then(() => { s.finish(id); const y = s.get(id); return { ok: true, title: y?.title, summary: y?.summary, actions: y?.actions } })
    }
    if (req.path === '/import' && req.method === 'POST') {
      const b = /** @type {any} */ (req.body)
      const text = typeof b === 'string' ? b : String(b?.text ?? '')
      const name = req.query.name || (typeof b === 'object' && b ? String(b.name || '') : '')
      if (!text.trim()) return { status: 400, json: { error: 'text required (raw body or {"name","text"})' } }
      return importConversate(ctx, text, name).then(({ session: x, duplicate }) => ({ ok: true, duplicate, session: x && { id: x.id, title: x.title, started: x.started } }))
        .catch((err) => ({ status: 400, json: { error: err instanceof Error ? err.message : String(err) } }))
    }
    if (req.path.startsWith('/session/') && req.method === 'DELETE') { const id = Number(req.path.slice(9)); if (!s.get(id)) return { status: 404, json: { error: 'no such session' } }; s.remove(id); return { ok: true } }
  },

  phone(ctx) {
    const m = ctx.mem
    const esc = (/** @type {string} */ t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c)
    const sessions = store(ctx).list(30)
    const cards = sessions.map((x) => `<details class="card"><summary><b>${esc(x.title || 'Untitled')}</b> <small class="muted">${new Date(x.started).toLocaleString(ctx.locale, { timeZone: ctx.tz })} · ${words(x.transcript)} words</small></summary>
      <p>${esc(x.summary)}</p>
      ${x.audio ? `<p class="row"><audio controls preload="none" data-file="${esc(x.audio)}" style="flex:1"></audio><a class="muted" href="#" data-dl="${esc(x.audio)}">download</a> <small class="muted">${clock(x.audioSecs || 0)}</small></p>` : ''}
      <p class="muted">transcript: ${esc(x.transcriptSource || 'live')}${x.audio ? ` · <a href="#" data-repass="${x.id}">re-transcribe</a>` : ''}${x.liveTranscript ? ' · <a href="#" data-live="' + x.id + '">show the live one</a>' : ''}</p>
      ${x.liveTranscript ? `<details id="live-${x.id}"><summary class="muted">live transcript (before the second pass)</summary><pre style="white-space:pre-wrap">${esc(x.liveTranscript)}</pre></details>` : ''}
      ${x.actions.length ? `<ul class="rows">${x.actions.map((a) => `<li><span>${esc(a.text)}${a.due ? ` <small class="muted">· ${esc(a.due)}</small>` : ''}</span><button data-todo="${esc(a.text)}" data-due="${esc(a.due || '')}">→ Todoist</button></li>`).join('')}</ul>` : ''}
      ${x.terms.length ? `<p class="muted">${x.terms.map((t) => `<b>${esc(t.term)}</b> — ${esc(t.definition)}`).join('<br>')}</p>` : ''}
      <details><summary class="muted">Transcript${x.source && x.source !== 'glasses' ? ` (${esc(x.source)})` : ''}</summary><pre>${esc(x.transcript)}</pre></details>
      <p class="row"><button data-resum="${x.id}">Re-summarize</button><button data-del="${x.id}">Delete</button></p></details>`).join('')
    return `<h1>Transcribe <small class="muted">${m.screen === 'live' ? '● recording' : `${sessions.length} sessions`}</small></h1>
      <div class="card"><b>Prep notes for the next conversation</b>
        <p class="muted">Who you're meeting, the agenda, numbers and questions. Cues draw on these.</p>
        <textarea id="prep" rows="6" style="width:100%">${esc(ctx.state.prep)}</textarea>
        <div class="row" style="margin-top:8px"><button id="save-prep" class="primary">Save prep notes</button>${m.screen === 'idle' ? '<button id="start">Start on the glasses</button>' : m.screen === 'live' ? '<button id="stop">Stop</button>' : ''}</div>
      </div>
      <div class="card"><b>Brain map</b> <small class="muted" id="bm-status"></small>
        <p class="muted">A knowledge vault distilled from your sessions — people, tools, terms, projects, decisions, open items. Cues quote it during conversations. Runs nightly; update now after importing.</p>
        <div class="row"><button id="bm-run">Update brain map</button></div>
        <div id="bm-notes" style="margin-top:8px"></div>
        <pre id="bm-view" style="display:none;white-space:pre-wrap;margin-top:8px"></pre>
      </div>
      <div class="card"><b>Import from Conversate</b>
        <p class="muted">In the Even app open a conversation → Share → TXT, then pick the file(s) here. Each becomes a session with a summary, searchable for cues.</p>
        <input type="file" id="import" accept=".txt,text/plain" multiple /> <span id="import-status" class="muted"></span>
      </div>
      ${cards || '<p class="muted">No sessions yet — tap the glasses to start one.</p>'}
      <script>
        for (const a of document.querySelectorAll('audio[data-file]')) a.src = omni.url('/audio?file=' + encodeURIComponent(a.dataset.file))
        for (const a of document.querySelectorAll('[data-dl]')) a.href = omni.url('/audio?download=1&file=' + encodeURIComponent(a.dataset.dl))
        for (const a of document.querySelectorAll('[data-repass]')) a.onclick = (e) => { e.preventDefault(); a.textContent = 're-transcribing…'; omni.api('/repass?id=' + a.dataset.repass, { method: 'POST' }).then(() => setTimeout(omni.reload, 20000)) }
        const bmStatus = () => omni.api('/brain-map').then((s) => { document.getElementById('bm-status').textContent = (s.running ? '● running… ' : '') + s.notes + ' notes · ' + s.sessionsFolded + ' sessions folded' + (s.lastRun ? ' · last run ' + new Date(s.lastRun.at).toLocaleString() + ' (' + s.lastRun.secs + ' s)' : ''); if (s.running) setTimeout(bmStatus, 5000) })
        bmStatus()
        document.getElementById('bm-run').onclick = () => omni.api('/brain-map', { method: 'POST' }).then(bmStatus)
        omni.api('/notes').then(({ notes }) => {
          const byFolder = {}; for (const n of notes) { const f = n.path.includes('/') ? n.path.split('/')[0] : 'overview'; (byFolder[f] ??= []).push(n) }
          const el = document.getElementById('bm-notes')
          el.innerHTML = Object.keys(byFolder).sort().map((f) => '<details><summary>' + f + ' (' + byFolder[f].length + ')</summary><ul class="rows">' + byFolder[f].map((n) => '<li><a href="#" data-note="' + n.path + '">' + n.title + '</a></li>').join('') + '</ul></details>').join('') || '<span class="muted">no notes yet</span>'
          for (const a of el.querySelectorAll('[data-note]')) a.onclick = (e) => { e.preventDefault(); fetch(omni.url('/note?path=' + encodeURIComponent(a.dataset.note))).then((r) => r.text()).then((t) => { const v = document.getElementById('bm-view'); v.style.display = 'block'; v.textContent = t; v.scrollIntoView() }) }
        })
        document.getElementById('import').onchange = async (e) => {
          const st = document.getElementById('import-status'); const files = [...e.target.files]; let n = 0, dup = 0; const failed = []
          for (const f of files) {
            st.textContent = 'importing ' + (n + dup + failed.length + 1) + '/' + files.length + ': ' + f.name + '…'
            try { const r = await omni.api('/import', { method: 'POST', body: { name: f.name, text: await f.text() } }); if (r.duplicate) dup++; else n++ } catch (err) { failed.push(f.name) }
          }
          st.textContent = 'imported ' + n + (dup ? ', ' + dup + ' already there' : '') + (failed.length ? ', failed: ' + failed.join(', ') : '') + '. Summaries are being written in the background.'
          setTimeout(omni.reload, 1500)
        }
        document.getElementById('save-prep').onclick = () => omni.api('/prep', { method: 'POST', body: { prep: document.getElementById('prep').value } }).then(() => omni.reload())
        const st = document.getElementById('start'); if (st) st.onclick = () => omni.api('/message', { method: 'POST', body: { start: true } }).then(() => omni.reload())
        const sp = document.getElementById('stop'); if (sp) sp.onclick = () => omni.api('/message', { method: 'POST', body: { stop: true } }).then(() => setTimeout(omni.reload, 4000))
        for (const b of document.querySelectorAll('[data-del]')) b.onclick = () => { if (confirm('Delete this session?')) omni.api('/session/' + b.dataset.del, { method: 'DELETE' }).then(() => omni.reload()) }
        for (const b of document.querySelectorAll('[data-resum]')) b.onclick = () => { b.textContent = 'working…'; omni.api('/resummarize?id=' + b.dataset.resum, { method: 'POST' }).then(() => omni.reload()) }
        for (const b of document.querySelectorAll('[data-todo]')) b.onclick = () => omni.api('/todo', { method: 'POST', body: { text: b.dataset.todo, due: b.dataset.due || undefined } }).then(() => { b.textContent = 'added ✓' })
      </script>`
  },
}

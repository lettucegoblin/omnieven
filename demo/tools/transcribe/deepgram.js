// Deepgram speech-to-text: streaming (Flux turn-based, or nova-3 with speaker
// labels) for the live captions, and the pre-recorded API for the accurate
// second pass over the saved audio.
//
// Input is always 16 kHz s16le mono PCM, the format the glasses' mic sends.
// Keyterms (names, acronyms, jargon) are passed to both so the model knows the
// vocabulary of this conversation: https://developers.deepgram.com/docs/keyterm

import WebSocket from 'ws'

const HOST = 'api.deepgram.com'
const KEEPALIVE_MS = 5000
/** ≤500 tokens across all keyterms; Deepgram suggests staying well under 50 terms */
export const MAX_KEYTERMS = 45

/** @param {URLSearchParams} params @param {string[]} keyterms */
function addKeyterms(params, keyterms) {
  for (const k of (keyterms || []).slice(0, MAX_KEYTERMS)) {
    const t = String(k).trim()
    if (t && t.length <= 40) params.append('keyterm', t)
  }
}

/**
 * Open a live transcription socket.
 * @param {{ key: string, engine?: 'flux'|'nova-3', language?: string, keyterms?: string[],
 *   onSegment: (seg: { text: string, final: boolean, speaker: number | null, turn?: number }) => void,
 *   onError: (msg: string) => void, onClose?: () => void, log?: (msg: string) => void }} opts
 */
export function openStream(opts) {
  const flux = (opts.engine || 'flux') === 'flux'
  const params = new URLSearchParams(flux
    ? { model: 'flux-general-en', encoding: 'linear16', sample_rate: '16000', eot_threshold: '0.75' }
    : {
      model: 'nova-3', encoding: 'linear16', sample_rate: '16000', channels: '1',
      interim_results: 'true', smart_format: 'true', punctuate: 'true', diarize: 'true',
      endpointing: '500', utterance_end_ms: '1200', language: opts.language || 'en',
    })
  addKeyterms(params, opts.keyterms || [])
  const url = `wss://${HOST}/${flux ? 'v2' : 'v1'}/listen?${params}`
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${opts.key}` } })
  let open = false, closed = false
  /** Flux revises the turn in progress; keep it so it can be flushed if the
   * stream ends before the speaker does. @type {{ text: string, turn: number } | null} */
  let pending = null
  /** @type {Uint8Array[]} */ const queue = []
  let lastSent = Date.now()
  const keep = setInterval(() => {
    if (open && !closed && !flux && Date.now() - lastSent > KEEPALIVE_MS - 500) { try { ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch {} }
  }, KEEPALIVE_MS)

  ws.on('open', () => { open = true; opts.log?.(`deepgram: ${flux ? 'flux' : 'nova-3'} connected${opts.keyterms?.length ? ` (${Math.min(opts.keyterms.length, MAX_KEYTERMS)} keyterms)` : ''}`); for (const q of queue) ws.send(q); queue.length = 0 })
  ws.on('message', (data) => {
    /** @type {any} */ let msg
    try { msg = JSON.parse(String(data)) } catch { return }
    if (flux) {
      // Flux reports whole turns: Update while the turn is in progress,
      // EndOfTurn when the speaker has finished. `transcript` is the turn so far.
      if (msg.type !== 'TurnInfo') return
      const text = String(msg.transcript || '').trim()
      if (!text) return
      if (msg.event === 'EndOfTurn') { pending = null; opts.onSegment({ text, final: true, speaker: null, turn: msg.turn_index }) }
      else if (msg.event === 'Update' || msg.event === 'StartOfTurn' || msg.event === 'EagerEndOfTurn') { pending = { text, turn: msg.turn_index }; opts.onSegment({ text, final: false, speaker: null, turn: msg.turn_index }) }
      return
    }
    if (msg.type !== 'Results') return
    const alt = msg.channel?.alternatives?.[0]
    const text = (alt?.transcript || '').trim()
    if (!text) return
    const speaker = alt?.words?.length ? (alt.words[0].speaker ?? null) : null
    opts.onSegment({ text, final: !!msg.is_final, speaker })
  })
  ws.on('error', (err) => { if (!closed) opts.onError(`Deepgram: ${err.message}`) })
  ws.on('close', (code, reason) => {
    clearInterval(keep)
    if (pending?.text) { opts.onSegment({ text: pending.text, final: true, speaker: null, turn: pending.turn }); pending = null }
    if (!closed && code !== 1000) opts.onError(`Deepgram closed (${code} ${String(reason || '')})`.trim())
    closed = true
    opts.onClose?.()
  })

  return {
    /** @param {Uint8Array} pcm */
    send(pcm) {
      if (closed) return
      lastSent = Date.now()
      if (open) ws.send(pcm); else if (queue.length < 200) queue.push(pcm)
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(keep)
      try {
        // A little trailing silence lets Flux decide the last turn has ended
        // (and nova-3 flush its final); anything still open is flushed on close.
        if (open) { const quiet = Buffer.alloc(2560); for (let i = 0; i < 8; i++) ws.send(quiet) }
        if (open) ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {}
      setTimeout(() => { try { ws.close(1000) } catch {} }, 900)
    },
    get open() { return open && !closed },
  }
}

/**
 * Pre-recorded pass over a finished recording: the model sees the whole
 * conversation instead of a moving window, so it is measurably more accurate
 * than the live stream, and it labels speakers.
 * @param {{ key: string, file: Uint8Array, contentType: string, keyterms?: string[], language?: string }} opts
 * @returns {Promise<{ text: string, confidence: number, words: number }>}
 */
export async function transcribeFile(opts) {
  const params = new URLSearchParams({
    model: 'nova-3', smart_format: 'true', punctuate: 'true', paragraphs: 'true',
    diarize: 'true', utterances: 'true', language: opts.language || 'en',
  })
  addKeyterms(params, opts.keyterms || [])
  const r = await fetch(`https://${HOST}/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${opts.key}`, 'Content-Type': opts.contentType },
    body: opts.file,
  })
  if (!r.ok) throw new Error(`Deepgram ${r.status}: ${(await r.text()).slice(0, 200)}`)
  /** @type {any} */ const j = await r.json()
  const alt = j.results?.channels?.[0]?.alternatives?.[0] || {}
  /** @type {any[]} */ const utts = j.results?.utterances || []
  // One line per utterance keeps the speaker changes visible; fall back to the
  // paragraph-formatted transcript when diarization returned nothing.
  const text = utts.length
    ? utts.map((u) => `${u.speaker != null ? `[${u.speaker}] ` : ''}${String(u.transcript || '').trim()}`).filter((l) => l.trim()).join('\n')
    : String(alt.paragraphs?.transcript || alt.transcript || '').trim()
  return { text, confidence: Number(alt.confidence || 0), words: (alt.words || []).length }
}

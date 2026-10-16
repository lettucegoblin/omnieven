// Text layout helpers for apps. Measurements come from @evenrealities/pretext,
// which replicates the firmware's LVGL font metrics, so wrapping and
// truncation match what the glasses actually draw.
import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import { SCREEN } from './renderer.ts'
import type { TextContainer } from '../shared/view.ts'
export { digitsSize } from './png.ts'

export const LINE = SCREEN.lineHeight
export { getTextWidth, pxTruncate }

/** Pixel width → how many text lines fit in `heightPx`. */
export function linesFor(heightPx: number, padding = 0): number { return Math.max(1, Math.floor((heightPx - 2 * padding) / LINE)) }

/** No glyph is narrower than this, so a line can never hold more characters than width/this. */
const MIN_ADVANCE_PX = 4
/** Hard ceilings: text this long is a bug upstream, and wrapping it would block the server. */
const MAX_WRAP_CHARS = 200_000, MAX_WRAP_LINES = 20_000

/**
 * How many characters of `s` fit in `widthPx` — at least one, so wrapping
 * always makes progress. Binary search over a bounded range (a line can hold
 * at most width/MIN_ADVANCE_PX characters), which keeps this cheap no matter
 * how long the string is: a linear scan here once cost the server three days
 * in a 100% CPU loop on an article with a huge unbroken token.
 */
function fitChars(s: string, widthPx: number): number {
  const cap = Math.max(1, Math.min(s.length, Math.ceil(Math.max(widthPx, MIN_ADVANCE_PX) / MIN_ADVANCE_PX) + 2))
  if (getTextWidth(s.slice(0, cap)) <= widthPx) return cap
  let lo = 1, hi = cap
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (getTextWidth(s.slice(0, mid)) <= widthPx) lo = mid
    else hi = mid - 1
  }
  return Math.max(1, lo)
}

/** Wrap `text` to `widthPx` and return the resulting lines (firmware rules). */
export function wrap(text: string, widthPx: number): string[] {
  const width = Number.isFinite(widthPx) && widthPx > MIN_ADVANCE_PX ? widthPx : MIN_ADVANCE_PX
  const cap = Math.max(1, Math.ceil(width / MIN_ADVANCE_PX) + 2)   // no line can hold more than this
  const out: string[] = []
  /** Emit full lines of a chunk that is too wide to fit, and return the rest. */
  const breakUp = (chunk: string): string => {
    let pos = 0
    while (chunk.length - pos > 1) {
      if (chunk.length - pos <= cap && getTextWidth(chunk.slice(pos)) <= width) break
      const cut = fitChars(chunk.slice(pos, pos + cap), width)
      out.push(chunk.slice(pos, pos + cut))
      pos += cut
      if (out.length > MAX_WRAP_LINES) break
    }
    return chunk.slice(pos)
  }
  const src = String(text ?? '')
  for (const para of (src.length > MAX_WRAP_CHARS ? src.slice(0, MAX_WRAP_CHARS) : src).split('\n')) {
    if (out.length > MAX_WRAP_LINES) break
    if (!para) { out.push(''); continue }
    let line = ''
    for (const w of para.split(/(\s+)/)) {
      const cand = line + w
      if (getTextWidth(cand) <= width) line = cand
      else if (!line) line = breakUp(cand)                                  // one word, wider than the box
      else { out.push(line.trimEnd()); line = breakUp(w.trimStart()) }
      if (out.length > MAX_WRAP_LINES) break
    }
    out.push(line.trimEnd())
  }
  return out
}

/** Split long text into screen-sized pages of wrapped lines. */
export function paginate(text: string, { widthPx = SCREEN.width - 8, lines = linesFor(SCREEN.height, 4) } = {}): string[] {
  const all = wrap(text, widthPx)
  const step = Math.max(1, Math.floor(lines) || 1)   // a zero would never advance
  const pages: string[] = []
  for (let i = 0; i < all.length; i += step) pages.push(all.slice(i, i + step).join('\n'))
  return pages.length ? pages : ['']
}

/** Fit a single line into `widthPx`, adding an ellipsis when needed. */
export function fit(text: string | number, widthPx: number): string { return pxTruncate(String(text ?? ''), widthPx) }

/** Measure wrapped height in px. */
export function measure(text: string, widthPx: number) { return measureTextWrap(String(text ?? ''), widthPx) }

/** Progress bar built from block characters the firmware font has. */
export function bar(fraction: number, cells = 20, fill = '━', empty = '─'): string {
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * cells)
  return fill.repeat(n) + empty.repeat(cells - n)
}

/** Rendered width of a single line of text in px. */
export function width(text: string | number): number { return getTextWidth(String(text ?? '')) }

/**
 * Pad a single line with leading spaces so it sits centred or at the right
 * edge of `widthPx` (the firmware only left-aligns). Text wider than the box
 * is cut with an ellipsis.
 */
export function align(text: string | number, widthPx: number, how: 'left' | 'center' | 'right'): string {
  const t = pxTruncate(String(text ?? ''), widthPx)
  if (how === 'left') return t
  const space = getTextWidth(' ') || 6
  const gap = widthPx - getTextWidth(t)
  let n = Math.max(0, Math.floor((how === 'right' ? gap : gap / 2) / space))
  // advances don't add up exactly; never let the padded line exceed the box
  while (n > 0 && getTextWidth(' '.repeat(n) + t) > widthPx) n--
  return ' '.repeat(n) + t
}

/** Two-column line: left text, right text pushed to `widthPx` using spaces. */
export function spread(left: string | number, right: string | number, widthPx = SCREEN.width - 8): string {
  left = String(left ?? ''); right = String(right ?? '')
  const space = getTextWidth(' ') || 6
  let gap = widthPx - getTextWidth(left) - getTextWidth(right)
  if (gap < space) return `${left} ${right}`
  return left + ' '.repeat(Math.floor(gap / space)) + right
}

/** Stack N rows of full-width text containers (equal heights). */
export function rows(texts: string[], { capture = 0, padding = 4, gap = 0 } = {}): TextContainer[] {
  const h = Math.floor((SCREEN.height - gap * (texts.length - 1)) / texts.length)
  return texts.map((text, i) => ({
    type: 'text', name: `row${i + 1}`, x: 0, y: i * (h + gap), w: SCREEN.width, h,
    text, padding, capture: i === capture,
  }))
}

/** Header line + body area. Body is the capture container (scrolls). */
export function headerBody(header: string, body: string, { headerHeight = 36, bodyOpts = {} as Partial<TextContainer> } = {}): TextContainer[] {
  return [
    { type: 'text', name: 'header', x: 0, y: 0, w: SCREEN.width, h: headerHeight, text: header, padding: 4, textColor: 2 },
    { type: 'text', name: 'body', x: 0, y: headerHeight, w: SCREEN.width, h: SCREEN.height - headerHeight, text: body, padding: 4, capture: true, ...bodyOpts },
  ]
}

export function clock(date = new Date(), { seconds = false, hour12 = false, tz = undefined as string | undefined, locale = undefined as string | undefined } = {}): string {
  return date.toLocaleTimeString(locale || [], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12, timeZone: tz })
}

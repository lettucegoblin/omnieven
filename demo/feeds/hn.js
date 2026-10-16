// Hacker News — top stories you can actually read on the glasses.
//   list  →  tap a story  →  article text, paginated (swipe up/down, or tap for next page)
//   tap-and-hold menu: Comments / Article, Back to list, Refresh
//   double-tap: back (comments → article → list → home)
// Article text is extracted server-side from the page (no dependencies);
// comments come from the HN API. Both are cached per story in ctx.mem.
const API = 'https://hacker-news.firebaseio.com/v0'
const REFRESH_MS = 5 * 60 * 1000
const STORIES = 20
const COMMENTS = 12
const MAX_ARTICLE_CHARS = 120_000   // a readable article; anything bigger is a dump
const PAGE_LINES = 8          // 36 px header + 8 × 27 px lines fits 288 px

/** @typedef {{ id: number, title: string, score: number, by: string, url?: string, text?: string, descendants?: number, kids?: number[] }} Story */
/** @typedef {{ by?: string, text?: string, deleted?: boolean, dead?: boolean }} Comment */
/** @typedef {{ stories: Story[], selected: number | null, view: 'article'|'comments', page: number, loading: boolean,
 *   fetchedAt?: number, error?: string, failures?: number, articles: Record<number, string[]>, comments: Record<number, string[]>, busy: Record<string, boolean> }} Mem */

// ── text extraction ──────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
/** @param {string} s */
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (e.toLowerCase())] ?? m
  })
}
/** @param {string} html */
function stripTags(html) { return decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim() }

/**
 * Plain paragraphs from an HTML page in one linear pass (no backtracking, so a
 * huge page cannot stall the server). Prefers <article>/<main>; collects the
 * text of block elements, skipping script/style/nav/header/footer/aside/forms.
 * @param {string} html
 */
function articleText(html) {
  const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'figure'])
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'pre', 'div', 'section', 'td', 'dd', 'dt', 'br', 'tr'])
  const HEAD = new Set(['h1', 'h2', 'h3'])
  /** @type {string[]} */ const scoped = []   // blocks inside <article>/<main>
  /** @type {string[]} */ const all = []      // every block, fallback
  let skip = 0, inScope = 0, buf = '', headDepth = 0
  const flush = () => {
    const t = decode(buf).replace(/\s+/g, ' ').trim()
    buf = ''
    if (!t) return
    const isHead = headDepth > 0
    if (!isHead && t.length < 40) return
    // Menus and separators ("· Posts · Videos ·") are mostly punctuation.
    const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length
    if (letters / t.length < 0.6) return
    // Minified script, base64 or a hash: not prose, and a huge unbroken token
    // is expensive for every layout step downstream.
    if (/\S{120}/.test(t)) return
    const line = isHead ? t.toUpperCase() : t
    all.push(line)
    if (inScope > 0) scoped.push(line)
  }
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|[^<]+/g
  let m
  while ((m = re.exec(html))) {
    const tok = m[0]
    if (tok.startsWith('<!--')) continue
    const tag = m[1]?.toLowerCase()
    if (!tag) { if (!skip) buf += tok; continue }
    const closing = tok[1] === '/'
    const selfClosing = tok.endsWith('/>') || tag === 'br'
    if (SKIP.has(tag)) { if (!selfClosing) skip += closing ? -1 : 1; if (skip < 0) skip = 0; continue }
    // an unclosed <script>/<style> (truncated page) must not swallow the article
    if (skip && !closing && (tag === 'article' || tag === 'main' || tag === 'body')) skip = 0
    if (skip) continue
    if (tag === 'article' || tag === 'main') { flush(); inScope += closing ? -1 : 1; if (inScope < 0) inScope = 0; continue }
    if (BLOCK.has(tag)) {
      flush()
      if (HEAD.has(tag)) headDepth += closing ? -1 : 1
      if (headDepth < 0) headDepth = 0
    } else if (!closing && !selfClosing) buf += ' '
  }
  flush()
  const pick = scoped.join('\n\n').length > 200 ? scoped : all
  return pick.join('\n\n').slice(0, MAX_ARTICLE_CHARS)
}

/** @param {string} url */
async function fetchText(url, ms = 10000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; OmniGlasses/1.0)', accept: 'text/html,*/*' }, redirect: 'follow' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (!/html|text|xml/.test(ct)) throw new Error(`not a page (${ct.split(';')[0]})`)
    let html = ''
    const reader = r.body?.getReader()
    if (!reader) return await r.text()
    const dec = new TextDecoder()
    while (html.length < 6e5) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }) }
    reader.cancel().catch(() => {})
    return html
  } finally { clearTimeout(t) }
}

// ── data ─────────────────────────────────────────────────────────────
/** @param {import('../../shared/app.ts').AppContext<{}, Mem>} ctx */
async function loadStories(ctx) {
  if (ctx.mem.loading) return
  ctx.mem.loading = true
  ctx.render()
  try {
    const ids = /** @type {number[]} */ (await (await ctx.fetch(`${API}/topstories.json`)).json()).slice(0, STORIES)
    const items = await Promise.all(ids.map(async (id) => /** @type {Promise<Story>} */ ((await ctx.fetch(`${API}/item/${id}.json`)).json())))
    ctx.mem.stories = items.filter((s) => s && s.title)
    ctx.mem.fetchedAt = Date.now()
    ctx.mem.error = undefined
    ctx.mem.failures = 0
    void prefetch(ctx)
  } catch (err) {
    ctx.mem.error = err instanceof Error ? err.message : String(err)
    ctx.log(`stories failed: ${ctx.mem.error}`)
    // Retry soon with backoff (30 s → 4 min) instead of waiting a full refresh cycle.
    ctx.mem.failures = (ctx.mem.failures || 0) + 1
    ctx.setTimeout(() => void loadStories(ctx), Math.min(240_000, 30_000 * 2 ** (ctx.mem.failures - 1)))
  } finally {
    ctx.mem.loading = false
    ctx.render()
  }
}

/** Warm the article cache one story at a time so a tap in the list is instant. @param {import('../../shared/app.ts').AppContext<{}, Mem>} ctx */
async function prefetch(ctx) {
  if (ctx.mem.busy.prefetch) return
  ctx.mem.busy.prefetch = true
  try { for (const s of [...ctx.mem.stories]) if (!ctx.mem.articles[s.id]) await loadArticle(ctx, s, false) }
  finally { delete ctx.mem.busy.prefetch }
}

/** @param {import('../../shared/app.ts').AppContext<{}, Mem>} ctx @param {Story} s */
async function loadArticle(ctx, s, rerender = true) {
  const key = `a${s.id}`
  if (ctx.mem.articles[s.id] || ctx.mem.busy[key]) return
  ctx.mem.busy[key] = true
  try {
    let text = s.text ? stripTags(s.text) : ''          // Ask HN / text posts
    if (!text && s.url) {
      try { text = articleText(await fetchText(s.url)) } catch (err) { text = `Could not load the article (${err instanceof Error ? err.message : err}).` }
    }
    if (!text) text = 'No readable text on that page (video, image, or paywall). Try the comments.'
    ctx.mem.articles[s.id] = ctx.ui.paginate(`${s.title}\n\n${text}`, { lines: PAGE_LINES })
  } finally {
    delete ctx.mem.busy[key]
    if (rerender || current(ctx) === s) ctx.render()
  }
}

/** @param {import('../../shared/app.ts').AppContext<{}, Mem>} ctx @param {Story} s */
async function loadComments(ctx, s) {
  const key = `c${s.id}`
  if (ctx.mem.comments[s.id] || ctx.mem.busy[key]) return
  ctx.mem.busy[key] = true
  try {
    const kids = (s.kids || []).slice(0, COMMENTS)
    const items = await Promise.all(kids.map(async (id) => { try { return /** @type {Comment | null} */ (await (await ctx.fetch(`${API}/item/${id}.json`)).json()) } catch { return null } }))
    const parts = items
      .filter((c) => !!c && !c.deleted && !c.dead && !!c.text)
      .map((c) => `${c?.by}:  ${stripTags(String(c?.text))}`)
    const text = parts.length ? parts.join('\n\n') : 'No comments yet.'
    ctx.mem.comments[s.id] = ctx.ui.paginate(`${s.descendants ?? 0} comments on: ${s.title}\n\n${text}`, { lines: PAGE_LINES })
  } finally {
    delete ctx.mem.busy[key]
    ctx.render()
  }
}

/** @param {import('../../shared/app.ts').AppContext<{}, Mem>} ctx */
function current(ctx) { return ctx.mem.selected != null ? ctx.mem.stories[ctx.mem.selected] : null }
/** @param {import('../../shared/app.ts').AppContext<{}, Mem>} ctx @param {Story} s */
function pages(ctx, s) { return (ctx.mem.view === 'comments' ? ctx.mem.comments : ctx.mem.articles)[s.id] || null }

// ── app ──────────────────────────────────────────────────────────────
/** @type {import('../../shared/app.ts').OmniApp<{}, Mem>} */
export default {
  title: 'Hacker News',
  order: 4,
  menu: [{ id: 'refresh', label: 'Refresh' }],

  init(ctx) {
    ctx.mem.stories ??= []
    // navigation state survives a hot reload (mem persists)
    ctx.mem.selected ??= null
    ctx.mem.view ??= 'article'
    ctx.mem.page ??= 0
    ctx.mem.loading = false
    ctx.mem.articles ??= {}
    ctx.mem.comments ??= {}
    ctx.mem.busy = {}
    void loadStories(ctx)
    ctx.setInterval(() => void loadStories(ctx), REFRESH_MS)
  },

  render(ctx) {
    const m = ctx.mem
    const s = current(ctx)
    if (s) {
      const host = s.url ? new URL(s.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com'
      const pg = pages(ctx, s)
      const menu = [
        { id: 'toggle', label: m.view === 'comments' ? 'Article' : `Comments (${s.descendants ?? 0})` },
        { id: 'back', label: 'Back to list' }, { id: 'refresh', label: 'Refresh' },
      ]
      if (!pg) {
        void (m.view === 'comments' ? loadComments(ctx, s) : loadArticle(ctx, s))
        return { containers: ctx.ui.headerBody(`${s.score} pts  ·  ${host}  ·  loading ${m.view}…`, `${s.title}\n\nby ${s.by}`), menu }
      }
      m.page = Math.max(0, Math.min(m.page, pg.length - 1))
      const header = `${s.score} pts  ·  ${host}  ·  ${m.view}  ·  ${m.page + 1}/${pg.length}  ·  ${m.page + 1 < pg.length ? 'tap: next' : 'double-tap: back'}`
      return { containers: ctx.ui.headerBody(header, pg[m.page]), menu }
    }
    if (!m.stories.length) return m.loading ? 'Loading Hacker News…' : `Hacker News\n\n${m.error || 'nothing loaded'}\n\nmenu → Refresh`
    const age = m.fetchedAt ? `${Math.round((Date.now() - m.fetchedAt) / 60000)} min ago` : ''
    return {
      containers: [
        { type: 'text', name: 'header', x: 0, y: 0, w: 576, h: 36, padding: 4, textColor: 2,
          text: ctx.ui.spread('Hacker News  ·  tap to read', m.loading ? 'refreshing…' : age) },
        { type: 'list', name: 'stories', x: 0, y: 36, w: 576, h: 252, capture: true,
          items: m.stories.map((st) => ctx.ui.fit(`${st.score} ${st.title}`, 540)) },
      ],
    }
  },

  onEvent(ctx, ev) {
    const m = ctx.mem
    const s = current(ctx)
    if (!s) {
      if (ev.type === 'select') { m.selected = ev.index; m.view = 'article'; m.page = 0; ctx.render() }
      return
    }
    const pg = pages(ctx, s)
    if (ev.type === 'double') {
      if (m.view === 'comments') { m.view = 'article'; m.page = 0 } else m.selected = null
      ctx.render(); return true
    }
    if (ev.type === 'tap' || ev.type === 'down') { if (pg && m.page < pg.length - 1) { m.page++; ctx.render() } return true }
    if (ev.type === 'up') { if (m.page > 0) { m.page--; ctx.render() } return true }
  },

  onMenu(ctx, id) {
    const m = ctx.mem
    if (id === 'back') { m.selected = null }
    if (id === 'toggle') { m.view = m.view === 'comments' ? 'article' : 'comments'; m.page = 0 }
    if (id === 'refresh') { const s = current(ctx); if (s) { delete m.articles[s.id]; delete m.comments[s.id] } else void loadStories(ctx) }
    ctx.render()
  },
}

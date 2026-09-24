// Todoist — your open tasks on the glasses; add tasks from anywhere.
//   glasses: list of tasks (project or today view) → tap a task → detail; tap: complete · double-tap: back
//   menu: Refresh · Today / Project / All views · Postpone (detail)
//   POST /api/apps/todoist/message {"add":"text", "due":"tomorrow", "priority":3}   (what the cue system uses)
//   POST /api/apps/todoist/add?text=…&due=…                                        (webhook-friendly)
//   GET  /api/apps/todoist/list
// Needs TODOIST_TOKEN in .env (Settings → Integrations → Developer → API token);
// TODOIST_PROJECT (name, optional) picks the project tasks are added to and listed from.

/** @typedef {{ id: string, content: string, priority: number, project_id: string, due: { date: string, string?: string } | null, checked?: boolean, is_completed?: boolean }} Task */
/** @typedef {{ id: string, name: string, is_inbox_project?: boolean }} Project */
/** @typedef {{ view: 'today'|'project'|'all' }} State */
/** @typedef {{ session: number, text: string, due?: string }} Suggestion */
/** @typedef {{ tasks: Task[], projects: Project[], project: Project | null, open: Task | null, error: string, loading: boolean, fetched: number, lastAdded: string, suggestions: Suggestion[] }} Mem */

const API = 'https://api.todoist.com/api/v1'
const W = 576, HEADER = 36

/**
 * @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx @param {string} path @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function api(ctx, path, init = {}) {
  const token = ctx.env.TODOIST_TOKEN
  if (!token) throw new Error('TODOIST_TOKEN not set in .env')
  const r = await ctx.fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } })
  if (r.status === 204) return null
  const text = await r.text()
  if (!r.ok) throw new Error(`Todoist ${r.status}: ${text.slice(0, 120)}`)
  return text ? JSON.parse(text) : null
}
/** v1 lists are `{results, next_cursor}`; tolerate a bare array too. @param {any} res @returns {any[]} */
const results = (res) => (Array.isArray(res) ? res : res?.results ?? [])

/** All pages of a paginated list. @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx @param {string} path */
async function listAll(ctx, path) {
  /** @type {any[]} */ const out = []
  let cursor = ''
  for (let i = 0; i < 20; i++) {
    const res = await api(ctx, `${path}${path.includes('?') ? '&' : '?'}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    out.push(...results(res))
    cursor = res?.next_cursor || ''
    if (!cursor) break
  }
  return out
}

/** @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx */
async function loadProjects(ctx) {
  const m = ctx.mem
  if (m.projects.length) return
  m.projects = await listAll(ctx, '/projects')
  const want = (ctx.env.TODOIST_PROJECT || '').toLowerCase()
  m.project = (want && m.projects.find((p) => p.name.toLowerCase() === want)) || m.projects.find((p) => p.is_inbox_project || /** @type {any} */ (p).inbox_project) || m.projects[0] || null
}

/**
 * Action items the Transcribe app noted in conversations and that have not been
 * filed anywhere yet — they sit at the top of the list, one tap to add.
 * @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx
 */
function loadSuggestions(ctx) {
  try {
    const r = /** @type {any} */ (ctx.message('transcribe', { pending: true }))
    ctx.mem.suggestions = Array.isArray(r?.actions) ? r.actions.map((/** @type {any} */ a) => ({ session: a.session, text: String(a.text), due: a.due })) : []
  } catch { ctx.mem.suggestions = [] }   // no Transcribe app installed
}
/** @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx */
async function refresh(ctx) {
  const m = ctx.mem
  m.loading = true; m.error = ''; ctx.render()
  try {
    await loadProjects(ctx)
    /** @type {Task[]} */ let tasks
    if (ctx.state.view === 'project' && m.project) tasks = await listAll(ctx, `/tasks?project_id=${encodeURIComponent(m.project.id)}`)
    else tasks = await listAll(ctx, '/tasks')
    tasks = tasks.filter((t) => !t.checked && !t.is_completed)
    if (ctx.state.view === 'today') { const today = isoToday(ctx); tasks = tasks.filter((t) => t.due && t.due.date.slice(0, 10) <= today) }
    tasks.sort((a, b) => (a.due?.date || '9999').localeCompare(b.due?.date || '9999') || b.priority - a.priority)
    m.tasks = tasks
    loadSuggestions(ctx)
    m.fetched = Date.now()
  } catch (err) { m.error = err instanceof Error ? err.message : String(err) }
  m.loading = false
  ctx.render()
}

/** Local date in the phone's time zone. @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx */
function isoToday(ctx) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const g = (/** @type {string} */ t) => p.find((x) => x.type === t)?.value
  return `${g('year')}-${g('month')}-${g('day')}`
}
/** "today" / "tomorrow" / "overdue" / "Sep 20". @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx @param {Task} t */
function dueLabel(ctx, t) {
  if (!t.due) return ''
  const d = t.due.date.slice(0, 10), today = isoToday(ctx)
  if (d < today) return 'overdue'
  if (d === today) return 'today'
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10)
  if (d === tomorrow) return 'tomorrow'
  return new Date(d + 'T12:00:00Z').toLocaleDateString(ctx.locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Add a task (what cues, webhooks and the phone page call).
 * @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx
 * @param {{ text: string, due?: string, priority?: number, project?: string }} t
 */
async function addTask(ctx, t) {
  const m = ctx.mem
  await loadProjects(ctx)
  const project = (t.project && m.projects.find((p) => p.name.toLowerCase() === String(t.project).toLowerCase())) || m.project
  /** @type {Record<string, unknown>} */ const body = { content: t.text }
  if (project) body.project_id = project.id
  if (t.due) body.due_string = t.due
  if (t.priority) body.priority = Math.min(4, Math.max(1, Number(t.priority)))
  /** @type {Task} */ const task = await api(ctx, '/tasks', { method: 'POST', body: JSON.stringify(body) })
  m.lastAdded = task.content
  ctx.notify(`Todoist: added "${ctx.ui.fit(task.content, 420)}"${t.due ? `  (${t.due})` : ''}`)
  void refresh(ctx)
  return task
}

/** @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx @param {Task} t */
async function complete(ctx, t) {
  await api(ctx, `/tasks/${t.id}/close`, { method: 'POST' })
  ctx.mem.tasks = ctx.mem.tasks.filter((x) => x.id !== t.id)
  ctx.mem.open = null
  ctx.notify(`Done: ${ctx.ui.fit(t.content, 440)}`)
}
/** @param {import('../../shared/app.ts').AppContext<State, Mem>} ctx @param {Task} t @param {string} due */
async function postpone(ctx, t, due) {
  await api(ctx, `/tasks/${t.id}`, { method: 'POST', body: JSON.stringify({ due_string: due }) })
  ctx.mem.open = null
  void refresh(ctx)
}

/** @type {import('../../shared/app.ts').OmniApp<State, Mem>} */
export default {
  title: 'Todoist',
  refresh: 60,
  settings: [{ key: 'view', label: 'Show', options: [{ value: 'today', label: 'today + overdue' }, { value: 'project', label: 'my project' }, { value: 'all', label: 'everything' }] }],

  init(ctx) {
    ctx.state.view ??= 'project'
    ctx.mem.tasks ??= []; ctx.mem.projects ??= []; ctx.mem.project ??= null
    ctx.mem.open = null; ctx.mem.error = ''; ctx.mem.loading = false; ctx.mem.fetched ??= 0; ctx.mem.lastAdded = ''; ctx.mem.suggestions ??= []
  },
  onOpen(ctx) { if (Date.now() - ctx.mem.fetched > 30_000) void refresh(ctx) },
  onSettingsChange(ctx) { void refresh(ctx) },

  render(ctx) {
    const m = ctx.mem, s = ctx.state
    const header = (/** @type {string} */ t) => ({ type: /** @type {const} */ ('text'), name: 'header', x: 0, y: 0, w: W, h: HEADER, padding: 4, textColor: 2, text: ctx.ui.fit(t, W - 16) })
    const viewName = s.view === 'today' ? 'today' : s.view === 'project' ? (m.project?.name ?? 'project') : 'all'
    if (m.error) return { text: `Todoist\n\n${m.error}\n\ntap: retry  ·  double-tap: back` }
    if (m.open) {
      const t = m.open
      const due = dueLabel(ctx, t)
      return {
        containers: [header(`${due ? `due ${due}` : 'no date'}${t.priority > 1 ? `  ·  p${5 - t.priority}` : ''}  ·  tap: complete  ·  double-tap: back`),
          { type: 'text', name: 'body', x: 0, y: HEADER, w: W, h: 288 - HEADER, padding: 4, capture: true, text: ctx.ui.wrap(t.content, W - 16).slice(0, 8).join('\n') }],
        menu: [{ id: 'done', label: 'Complete' }, { id: 'tomorrow', label: 'Postpone to tomorrow' }, { id: 'nextweek', label: 'Postpone a week' }, { id: 'back', label: 'Back to list' }],
      }
    }
    // From the conversations first ("+ …" adds it), then the real tasks.
    const sugg = m.suggestions.slice(0, 8)
    const items = [
      ...sugg.map((x) => ctx.ui.fit(`+ ${x.text}${x.due ? `  · ${x.due}` : ''}`, 540)),
      ...m.tasks.slice(0, 20 - sugg.length - (sugg.length ? 1 : 0)).map((t) => {
        const due = dueLabel(ctx, t)
        const mark = due === 'overdue' ? '! ' : t.priority === 4 ? '* ' : ''
        return ctx.ui.fit(`${mark}${t.content}${due ? `  · ${due}` : ''}`, 540)
      }),
      ...(sugg.length ? ['— clear the suggestions'] : []),
    ]
    return {
      containers: [header(`Todoist  ·  ${viewName}  ·  ${m.loading ? 'refreshing…' : `${sugg.length ? `${sugg.length} from talks  ·  ` : ''}${m.tasks.length} open`}`),
        items.length
          ? { type: 'list', name: 'tasks', x: 0, y: HEADER, w: W, h: 288 - HEADER, capture: true, items }
          : { type: 'text', name: 'empty', x: 0, y: HEADER, w: W, h: 288 - HEADER, padding: 4, capture: true, textColor: 2, text: m.loading ? 'loading…' : 'Nothing open here.\n\nmenu: switch view · refresh' }],
      menu: [{ id: 'refresh', label: 'Refresh' }, { id: 'v-today', label: 'View: today' }, { id: 'v-project', label: 'View: my project' }, { id: 'v-all', label: 'View: everything' }],
    }
  },

  onEvent(ctx, ev) {
    const m = ctx.mem
    if (m.error) { if (ev.type === 'tap') void refresh(ctx); return }
    if (m.open) {
      if (ev.type === 'double') { m.open = null; ctx.render(); return true }
      if (ev.type === 'tap') { void complete(ctx, m.open).catch((e) => { m.error = e.message; ctx.render() }); return true }
      return
    }
    if (ev.type === 'select') {
      const sugg = m.suggestions.slice(0, 8)
      const shown = m.tasks.slice(0, 20 - sugg.length - (sugg.length ? 1 : 0))
      if (ev.index < sugg.length) {   // "+ …": add it and tick it off in Transcribe
        const x = sugg[ev.index]
        void addTask(ctx, { text: x.text, due: x.due }).then(() => { try { ctx.message('transcribe', { markAction: { session: x.session, text: x.text } }) } catch {} loadSuggestions(ctx); ctx.render() })
        return true
      }
      if (ev.index === sugg.length + shown.length && sugg.length) {   // "— clear the suggestions"
        try { ctx.message('transcribe', { clearPending: true }) } catch {}
        loadSuggestions(ctx); ctx.notify('Suggestions cleared', { ms: 1200 }); ctx.render()
        return true
      }
      const t = shown[ev.index - sugg.length]
      if (t) { m.open = t; ctx.render() }
      return true
    }
  },
  onMenu(ctx, id) {
    const m = ctx.mem
    if (id === 'refresh') return void refresh(ctx)
    if (id.startsWith('v-')) { ctx.state.view = /** @type {State['view']} */ (id.slice(2)); ctx.save(); return void refresh(ctx) }
    if (!m.open) return
    if (id === 'done') return void complete(ctx, m.open).catch((e) => { m.error = e.message; ctx.render() })
    if (id === 'tomorrow') return void postpone(ctx, m.open, 'tomorrow').catch((e) => { m.error = e.message; ctx.render() })
    if (id === 'nextweek') return void postpone(ctx, m.open, 'in 7 days').catch((e) => { m.error = e.message; ctx.render() })
    if (id === 'back') { m.open = null; ctx.render() }
  },

  async onMessage(ctx, msg) {
    if (msg.add) {
      const task = await addTask(ctx, { text: String(msg.add), due: msg.due ? String(msg.due) : undefined, priority: msg.priority, project: msg.project })
      return { ok: true, id: task.id, content: task.content, due: task.due?.string ?? null }
    }
    if (msg.refresh) { await refresh(ctx); }
    return { open: ctx.mem.tasks.length, project: ctx.mem.project?.name ?? null }
  },
  async http(ctx, req) {
    if (req.path === '/add') {
      const b = /** @type {any} */ (req.body && typeof req.body === 'object' ? req.body : {})
      const text = req.query.text || b.text
      if (!text) return { status: 400, json: { error: 'text required' } }
      const task = await addTask(ctx, { text: String(text), due: req.query.due || b.due, priority: req.query.priority || b.priority, project: req.query.project || b.project })
      const session = Number(req.query.session || b.session || 0)
      if (session) { try { ctx.message('transcribe', { markAction: { session, text: String(text) } }) } catch {} ; loadSuggestions(ctx) }
      return { ok: true, id: task.id, content: task.content }
    }
    if (req.path === '/clear-suggestions' && req.method === 'POST') { try { ctx.message('transcribe', { clearPending: true }) } catch {} ; loadSuggestions(ctx); ctx.render(); return { ok: true } }
    if (req.path === '/suggestions') { loadSuggestions(ctx); return { suggestions: ctx.mem.suggestions } }
    if (req.path === '/list') {
      if (Date.now() - ctx.mem.fetched > 30_000) await refresh(ctx)
      return { view: ctx.state.view, project: ctx.mem.project?.name ?? null, tasks: ctx.mem.tasks.map((t) => ({ id: t.id, content: t.content, due: t.due?.date ?? null, priority: t.priority })) }
    }
    if (req.path === '/complete' && req.method === 'POST') {
      const id = req.query.id || /** @type {any} */ (req.body)?.id
      const t = ctx.mem.tasks.find((x) => x.id === String(id))
      if (!t) return { status: 404, json: { error: 'not in the current list' } }
      await complete(ctx, t)
      return { ok: true }
    }
  },

  async phone(ctx) {
    const m = ctx.mem
    if (!ctx.env.TODOIST_TOKEN) return '<h1>Todoist</h1><p class="muted">Set <code>TODOIST_TOKEN</code> in the server\'s .env (Todoist → Settings → Integrations → Developer).</p>'
    if (Date.now() - m.fetched > 30_000) await refresh(ctx)
    const esc = (/** @type {string} */ t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c)
    const sugg = m.suggestions.map((x) => `<li><span>${esc(x.text)}${x.due ? ` <small class="muted">· ${esc(x.due)}</small>` : ''}</span><button data-add="${esc(x.text)}" data-session="${x.session}" data-due="${esc(x.due || '')}">+ add</button></li>`).join('')
    const rows = m.tasks.map((t) => `<li><span>${esc(t.content)}${t.due ? ` <small class="muted">· ${esc(dueLabel(ctx, t))}</small>` : ''}</span><button data-done="${t.id}">Done</button></li>`).join('')
    return `<h1>Todoist <small class="muted">${esc(m.project?.name ?? '')} · ${ctx.state.view}</small></h1>
      ${m.error ? `<p class="bad">${esc(m.error)}</p>` : ''}
      ${sugg ? `<div class="card"><b>From your conversations</b> <small class="muted">${m.suggestions.length}</small><ul class="rows">${sugg}</ul><div class="row"><button id="clear-sugg" class="secondary">Clear all</button></div></div>` : ''}
      <form id="add"><input name="text" placeholder="Add a task…" required /><input name="due" placeholder="due (tomorrow, fri 3pm)…" style="max-width:40%" /><button>Add</button></form>
      <ul class="rows">${rows || '<li class="muted">nothing open</li>'}</ul>
      <script>
        document.getElementById('add').onsubmit = (e) => { e.preventDefault(); const f = e.target; omni.api('/add', { method: 'POST', body: { text: f.text.value, due: f.due.value || undefined } }).then(() => omni.reload()) }
        for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => { b.textContent = 'adding…'; omni.api('/add', { method: 'POST', body: { text: b.dataset.add, due: b.dataset.due || undefined, session: b.dataset.session } }).then(() => omni.reload()) }
        const cs = document.getElementById('clear-sugg'); if (cs) cs.onclick = () => omni.api('/clear-suggestions', { method: 'POST' }).then(() => omni.reload())
        for (const b of document.querySelectorAll('[data-done]')) b.onclick = () => omni.api('/complete?id=' + b.dataset.done, { method: 'POST' }).then(() => omni.reload())
      </script>`
  },
}

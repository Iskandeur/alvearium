// Alvearium mod (Claude Code v2.1.287+): draws the board inside the terminal.
//  · a status line under the prompt — "2 for you · 3 in progress · 5 to do", refreshed every 20 s
//  · /board — prints the whole ticket board at once, with no Claude turn (runs even while Claude works)
// Older Claude Code versions ignore this file; the settings hooks in hooks.json still report.
// Mods cannot open SQLite: in local mode the hooks keep ~/.claude/session-board/summary.json fresh.
//
// Self-contained on purpose (no imports): the directory reviewer wants to know exactly what runs.
// Rendering logic is a subset of lib/core.mjs, duplicated here.

const REFRESH_MS = 20_000
let lastStatus

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    // Cloud session with the agent proxy's credential: this mod's fetch would not carry it (see
    // notJson). Stay out of the way, so /board is the plugin's Node command, which goes through the proxy.
    if ((await remote($, options).catch(() => ({}))).token === 'proxy') return next(e)
    $.clock.every(REFRESH_MS, async () => {
      await refreshStatus($, options)
    })
    refreshStatus($, options).catch(() => {})
    try {
      await $.command.register({
        name: 'board',
        description: 'Show the ticket board of every Claude Code session: waiting on you, in progress, to do',
        immediate: true,
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    try {
      return { text: '\n' + (await boardText($, options)) }
    } catch (err) {
      return { text: 'board unavailable: ' + (err && err.message ? err.message : String(err)) }
    }
  })
}

async function refreshStatus($, options) {
  let text
  try {
    text = await statusFor($, options)
  } catch {
    text = 'board offline'
  }
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function readJson($, path) {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

async function localDir($) {
  const custom = await $.env.get('SESSION_BOARD_DIR')
  if (custom) return custom
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  return home + '/.claude/session-board'
}

async function remote($, options) {
  const dir = await localDir($)
  const file = (await readJson($, dir + '/config.json')) || {}
  const opts = options || {}
  const url = (opts.server_url || (await $.env.get('SESSION_BOARD_URL')) || file.url || '').trim().replace(/\/+$/, '')
  const token = (opts.token || (await $.env.get('SESSION_BOARD_TOKEN')) || file.token || '').trim()
  return { dir, url, token, on: Boolean(url && token) }
}

async function get($, cfg, path) {
  const headers = cfg.token === 'proxy' ? {} : { authorization: 'Bearer ' + cfg.token }
  const res = await $.http.fetch(cfg.url + path, { headers })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  try {
    return JSON.parse(res.text)
  } catch {
    throw new Error(notJson(cfg, res.text))
  }
}

// A login gateway in front of the board answers with its login page. In a claude.ai/code cloud
// session (token "proxy"), this fetch is Claude Code's own and does not carry the API credential
// that the agent proxy adds; the /alvearium:board command runs in Node and goes through the proxy.
function notJson(cfg, text) {
  const page = /^\s*</.test(text || '') ? 'the server answered with a login page instead of the board' : 'the server did not answer with the board'
  return cfg.token === 'proxy'
    ? page + ' (this request does not carry the cloud API credential). The plugin\'s board command goes through the proxy: /alvearium:board.'
    : page + ' (is the token right?). /alvearium:board doctor says more.'
}

/** Status line: tickets waiting on you first. Old servers (no ticket counts) fall back to sessions. */
async function statusFor($, options) {
  const cfg = await remote($, options)
  if (cfg.on) {
    const b = await get($, cfg, '/api/board')
    return (b.tickets ? ticketStatusText(b.tickets.counts) : statusText(b.counts)) || undefined
  }
  const s = await readJson($, cfg.dir + '/summary.json')
  return s ? ticketStatusText(s.counts) || undefined : undefined
}

async function boardText($, options) {
  const cfg = await remote($, options)
  if (cfg.on) {
    try {
      return renderTicketsText(await get($, cfg, '/api/tickets/board?limit=50'))
    } catch {
      return renderText(await get($, cfg, '/api/board'))
    }
  }
  const s = await readJson($, cfg.dir + '/summary.json')
  return s ? s.text : 'No tickets yet on this machine.'
}

// ---- rendering helpers (subset of lib/core.mjs)

function truncate(text, max) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function statusText(counts) {
  const parts = []
  if (counts.waiting) parts.push(`${counts.waiting} waiting`)
  if (counts.working) parts.push(`${counts.working} working`)
  if (counts.review) parts.push(`${counts.review} review`)
  return parts.join(' · ')
}

function ticketStatusText(counts) {
  const parts = []
  if (counts.waiting) parts.push(`${counts.waiting} for you`)
  if (counts.inProgress) parts.push(`${counts.inProgress} in progress`)
  if (counts.todo) parts.push(`${counts.todo} to do`)
  return parts.join(' · ')
}

function renderText(board) {
  const lines = []
  const now = board.now
  const label = (rec) => {
    const where = rec.repo || (rec.cwd ? rec.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || 'session'
    const branch = rec.branch && rec.branch !== 'HEAD' ? `@${rec.branch}` : ''
    return rec.name ? `${rec.name} (${where}${branch})` : `${where}${branch}`
  }
  const line = (r) => {
    const where = r.surface === 'cloud' ? '☁' : '⌨'
    const badge = r.display === 'failed' ? ' [FAILED]' : r.display === 'stale' ? ' [stale]' : ''
    const out = [`  ${where} ${label(r)}${badge} · ${ago(r.since ?? r.lastSeen, now)}`]
    if (r.title) out.push(`      task: ${truncate(r.title, 100)}`)
    if (r.detail) out.push(`      ${truncate(r.detail, 160)}`)
    if (r.pr) out.push(`      PR: ${r.pr}`)
    if (r.url) out.push(`      open: ${r.url}`)
    return out.join('\n')
  }
  const section = (title, list) => {
    lines.push(`${title} (${list.length})`)
    lines.push(list.length ? list.map(line).join('\n') : '  —')
    lines.push('')
  }
  section('WAITING ON YOU', board.waiting || [])
  section('IN PROGRESS', board.inProgress || [])
  section('READY FOR REVIEW', board.review || [])
  if (board.idle?.length) lines.push(`(${board.idle.length} idle session${board.idle.length > 1 ? 's' : ''} not shown)`)
  return lines.join('\n').trimEnd()
}

function renderTicketsText(board, { now = board.now ?? Date.now() } = {}) {
  const out = []
  const line = (t) => {
    const where = [t.repo ? t.repo.split('/').pop() : '', t.branch && t.branch !== 'HEAD' ? t.branch : ''].filter(Boolean).join('@')
    const flag = (t.status === 'failed' ? ' [FAILED]' : t.status === 'review' ? ' [review]' : t.stale ? ' [stale]' : '') + (t.blocked ? ' [blocked]' : '')
    const rows = [`  ${t.origin === 'cloud' ? '☁' : '⌨'} ${t.key}${t.priority ? ' ' + t.priority : ''} ${truncate(t.title, 90)}${flag} · ${ago(t.status_at ?? t.updated_at, now)}${where ? ' · ' + where : ''}`]
    const pr = (t.links || []).find((l) => l.type === 'pr')
    if (pr) rows.push(`      PR: ${pr.url}`)
    const sess = (t.links || []).find((l) => l.type === 'session')
    if (sess) rows.push(`      open: ${sess.url}`)
    return rows.join('\n')
  }
  const section = (title, col) => {
    const list = board.columns?.[col] || []
    const total = board.counts?.[col] ?? list.length
    out.push(`${title} (${total})`)
    out.push(list.length ? list.map(line).join('\n') : '  —')
    if (total > list.length) out.push(`  … ${total - list.length} more`)
    out.push('')
  }
  section('WAITING ON YOU', 'waiting')
  section('IN PROGRESS', 'inProgress')
  section('TO DO', 'todo')
  if (board.counts?.done) out.push(`(${board.counts.done} done, not shown)`)
  return out.join('\n').trimEnd()
}

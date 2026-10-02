// session-board mod (Claude Code v2.1.287+): draws the board inside the terminal.
//  · a status line under the prompt — "2 for you · 3 in progress · 5 to do", refreshed every 20 s
//  · /board — prints the whole ticket board at once, with no Claude turn (runs even while Claude works)
// Older Claude Code versions ignore this file; the settings hooks in hooks.json still report,
// and /session-board:board still prints the board through Claude.
// Mods cannot open SQLite: in local mode the hooks keep ~/.claude/session-board/summary.json fresh.
import { renderText, renderTicketsText, statusText, ticketStatusText } from '../lib/core.mjs'

const REFRESH_MS = 20_000
let lastStatus

export function register(on, options) {
  on('session.start', async ($, e, next) => {
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
  const url = ((await $.env.get('SESSION_BOARD_URL')) || opts.server_url || file.url || '').trim().replace(/\/+$/, '')
  const token = ((await $.env.get('SESSION_BOARD_TOKEN')) || opts.token || file.token || '').trim()
  return { dir, url, token, on: Boolean(url && token) }
}

async function get($, cfg, path) {
  const headers = cfg.token === 'proxy' ? {} : { authorization: 'Bearer ' + cfg.token }
  const res = await $.http.fetch(cfg.url + path, { headers })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return JSON.parse(res.text)
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

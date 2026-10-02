// session-board mod (Claude Code v2.1.287+): draws the board inside the terminal.
//  · a status line under the prompt — "3 waiting · 5 working · 2 review", refreshed every 20 s
//  · /board — prints the whole board at once, with no Claude turn (runs even while Claude works)
// Older Claude Code versions ignore this file; the settings hooks in hooks.json still report,
// and /session-board:board still prints the board through Claude.
import { buildBoard, renderText, statusText } from '../lib/core.mjs'

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
        description: 'Show every Claude Code session: waiting on you, in progress, ready for review',
        immediate: true,
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    try {
      const board = await loadBoard($, options)
      return { text: '\n' + renderText(board) }
    } catch (err) {
      return { text: 'board unavailable: ' + (err && err.message ? err.message : String(err)) }
    }
  })
}

async function refreshStatus($, options) {
  let text
  try {
    const board = await loadBoard($, options)
    text = statusText(board.counts) || undefined
  } catch {
    text = 'board offline'
  }
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function readConfig($, dir) {
  try {
    return JSON.parse(await $.fs.read(dir + '/config.json'))
  } catch {
    return {}
  }
}

async function localDir($) {
  const custom = await $.env.get('SESSION_BOARD_DIR')
  if (custom) return custom
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  return home + '/.claude/session-board'
}

async function loadBoard($, options) {
  const dir = await localDir($)
  const file = await readConfig($, dir)
  const opts = options || {}
  const url = ((await $.env.get('SESSION_BOARD_URL')) || opts.server_url || file.url || '').trim().replace(/\/+$/, '')
  const token = ((await $.env.get('SESSION_BOARD_TOKEN')) || opts.token || file.token || '').trim()
  if (url && token) {
    const headers = token === 'proxy' ? {} : { authorization: 'Bearer ' + token }
    const res = await $.http.fetch(url + '/api/board', { headers })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return JSON.parse(res.text)
  }
  let entries = []
  try {
    entries = await $.fs.list(dir + '/sessions')
  } catch {}
  const records = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    try {
      const stored = JSON.parse(await $.fs.read(dir + '/sessions/' + entry.name))
      if (stored && stored.record) records.push(stored.record)
    } catch {}
  }
  return buildBoard(records, await $.clock.now())
}

// Ticket actions: buttons an installation declares, each one a webhook that the server calls for a
// ticket. Typical use: "Open a coding session on this ticket", "Start a deploy", "Create a branch".
//
//   GET  /api/actions                    any caller: [{ id, label, icon, allow_hosts }], and can_run
//   POST /api/tickets/:key/actions/:id   owner, admin (`runAction`): the server POSTs
//                                        { ticket, actor, action } to the webhook and answers
//                                        { open_url?, message? }
//
// Configuration: SESSION_BOARD_ACTIONS_FILE, a JSON array (at most MAX_ACTIONS entries):
//   [{ "id": "deploy", "label": "Deploy preview", "icon": "🚀",
//      "url": "https://hooks.example.com/board-action", "token_env": "DEPLOY_HOOK_TOKEN",
//      "allow_hosts": ["preview.example.com"], "timeout_ms": 20000 }]
// The webhook token is never in the file: it is read from the environment variable `token_env`
// names, and sent as `Authorization: Bearer <token>`. An unreadable or invalid file, or a missing
// token, stops the server at startup: a typo must not leave a button that silently does nothing.
//
// What the webhook gets is the ticket KEY, who clicked and which action: never the ticket's title,
// body or comments. A webhook that needs more reads the ticket through the API with its own token.
// What comes back is checked: `open_url` must be https on a host listed in `allow_hosts` (the page
// checks it again before opening it), `message` is plain text, shortened.
// Each click is rate limited per actor, one action runs at a time per ticket, and every run goes to
// the audit log (`action.run`).
import { readFileSync } from 'node:fs';
import { OWNER_ID, can } from '../lib/accounts.mjs';
import { VERSION } from '../lib/core.mjs';

export const MAX_ACTIONS = 8;
export const ACTION_COOLDOWN_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
/** A webhook answer larger than this is not read further (its JSON would not parse: no link, no message). */
export const MAX_REPLY_BYTES = 16 * 1024;
export const MAX_MESSAGE_CHARS = 300;

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const fail = (msg) => new Error(`ticket actions: ${msg}`);

/**
 * Validates the configuration text. Throws with a readable message on the first problem; returns the
 * actions with their token resolved from `env`.
 */
export function parseActions(text, env = process.env) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    throw fail(`not valid JSON (${e.message})`);
  }
  if (!Array.isArray(list)) throw fail('the file must hold a JSON array');
  if (list.length > MAX_ACTIONS) throw fail(`at most ${MAX_ACTIONS} actions`);
  const seen = new Set();
  return list.map((a, i) => {
    const at = `action ${i + 1}`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail(`${at}: expected an object`);
    const known = ['id', 'label', 'icon', 'url', 'token_env', 'allow_hosts', 'timeout_ms'];
    const extra = Object.keys(a).filter((k) => !known.includes(k));
    if (extra.length) throw fail(`${at}: unknown field(s) ${extra.join(', ')}`);
    if (typeof a.id !== 'string' || !ID.test(a.id)) throw fail(`${at}: "id" must be 1 to 32 lowercase letters, digits, - or _`);
    if (seen.has(a.id)) throw fail(`${at}: the id "${a.id}" is used twice`);
    seen.add(a.id);
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    if (!label || label.length > 40 || /[\p{Cc}]/u.test(label)) throw fail(`${at} (${a.id}): "label" must be 1 to 40 characters on one line`);
    const icon = a.icon == null ? '' : String(a.icon).trim();
    if ([...icon].length > 4 || /[\p{Cc}<>&"']/u.test(icon)) throw fail(`${at} (${a.id}): "icon" must be at most 4 characters (an emoji)`);
    let url;
    try {
      url = new URL(String(a.url ?? ''));
    } catch {
      throw fail(`${at} (${a.id}): "url" is not a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail(`${at} (${a.id}): "url" must be http or https`);
    if (url.username || url.password) throw fail(`${at} (${a.id}): no credentials in "url": put the token in the variable named by "token_env"`);
    if (typeof a.token_env !== 'string' || !ENV_NAME.test(a.token_env)) throw fail(`${at} (${a.id}): "token_env" must name an environment variable (A-Z, 0-9, _)`);
    const token = String(env[a.token_env] ?? '').trim();
    if (token.length < 16) throw fail(`${at} (${a.id}): the variable ${a.token_env} must hold the webhook token (at least 16 characters)`);
    if (!Array.isArray(a.allow_hosts)) throw fail(`${at} (${a.id}): "allow_hosts" must be a list of host names (it may be empty when the action opens nothing)`);
    const hosts = a.allow_hosts.map((h) => String(h).trim().toLowerCase());
    for (const h of hosts) if (!HOST.test(h)) throw fail(`${at} (${a.id}): "${h}" is not a host name (no scheme, port or path)`);
    const timeout = a.timeout_ms == null ? DEFAULT_TIMEOUT_MS : Number(a.timeout_ms);
    if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) throw fail(`${at} (${a.id}): "timeout_ms" must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    return { id: a.id, label, icon, url: url.href, token, allow_hosts: [...new Set(hosts)], timeout_ms: timeout };
  });
}

/** The actions of this installation: none without SESSION_BOARD_ACTIONS_FILE; throws on a bad file. */
export function loadActions(env = process.env) {
  const file = env.SESSION_BOARD_ACTIONS_FILE?.trim();
  if (!file) return [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw fail(`cannot read ${file} (${e.code || e.message})`);
  }
  return parseActions(text, env);
}

/** `url` if it is https, on the default port, without credentials, on a listed host; else null. */
export function safeOpenUrl(url, allowHosts) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  return (allowHosts || []).includes(u.hostname.toLowerCase()) ? u.href : null;
}

/** Plain text of at most MAX_MESSAGE_CHARS characters, or undefined. */
export function cleanMessage(m) {
  if (typeof m !== 'string') return undefined;
  const t = m.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > MAX_MESSAGE_CHARS ? t.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : t;
}

async function readReply(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** What the page lists: no URL, no token variable. */
export const publicAction = (a) => ({ id: a.id, label: a.label, icon: a.icon, allow_hosts: a.allow_hosts });

export function actionRoutes({ actions = [], fetchFn = fetch, now = () => Date.now(), cooldownMs = ACTION_COOLDOWN_MS } = {}) {
  const lastClick = new Map();
  const running = new Set();
  return {
    actions,
    /** After authentication (and the CSRF check of a cookie session). */
    async private(req, res, url, { store, accounts, auth, send, forbidden }) {
      const path = url.pathname;
      if (path === '/api/actions') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }), true;
        return send(res, 200, { actions: actions.map(publicAction), can_run: can(auth, 'runAction') }), true;
      }
      const m = path.match(/^\/api\/tickets\/([\w-]{1,64})\/actions\/([^/]{1,64})$/);
      if (!m) return false;
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }), true;
      if (!can(auth, 'runAction')) return forbidden(res, 'run ticket actions', auth), true;
      const action = actions.find((a) => a.id === m[2]);
      if (!action) return send(res, 404, { error: 'unknown action' }), true;
      const ticket = store.getTicket(m[1]);
      if (!ticket) return send(res, 404, { error: 'ticket not found' }), true;
      const actor = auth.member || OWNER_ID;
      const t = now();
      const last = lastClick.get(actor);
      if (last !== undefined && t - last < cooldownMs) {
        res.setHeader('retry-after', String(Math.ceil((cooldownMs - (t - last)) / 1000)));
        return send(res, 429, { error: `one action at a time: try again in ${Math.ceil((cooldownMs - (t - last)) / 1000)} s` }), true;
      }
      if (running.has(ticket.key)) return send(res, 409, { error: 'an action is already running on this ticket' }), true;
      lastClick.set(actor, t);
      if (lastClick.size > 1000) for (const [k, v] of lastClick) if (t - v >= cooldownMs) lastClick.delete(k);
      running.add(ticket.key);
      const audit = (outcome, detail = {}) => accounts.audit(actor, 'action.run', ticket.key, { action: action.id, outcome, ...detail });
      try {
        let r;
        try {
          r = await fetchFn(action.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${action.token}`, 'user-agent': `alvearium/${VERSION}` },
            // The key, who and what: never the ticket's content.
            body: JSON.stringify({ ticket: ticket.key, actor, action: action.id }),
            redirect: 'error',
            signal: AbortSignal.timeout(action.timeout_ms),
          });
        } catch (e) {
          const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
          audit(timedOut ? 'timeout' : 'unreachable');
          return send(res, timedOut ? 504 : 502, { error: timedOut ? `the action did not answer within ${Math.round(action.timeout_ms / 1000)} s` : 'the action could not be reached' }), true;
        }
        const text = await readReply(r).catch(() => null);
        let reply = {};
        try {
          reply = text ? JSON.parse(text) : {};
        } catch {}
        if (!reply || typeof reply !== 'object') reply = {};
        const message = cleanMessage(reply.message) ?? cleanMessage(reply.error);
        if (!r.ok) {
          audit('failed', { status: r.status });
          return send(res, 502, { error: message || `the action failed (HTTP ${r.status})` }), true;
        }
        const out = {};
        if (reply.open_url !== undefined && reply.open_url !== null && reply.open_url !== '') {
          const safe = safeOpenUrl(reply.open_url, action.allow_hosts);
          if (!safe) {
            audit('refused_url', { status: r.status });
            return send(res, 502, { error: 'the action answered with a link outside its allowed hosts: nothing was opened' }), true;
          }
          out.open_url = safe;
        }
        if (message) out.message = message;
        audit('ok', { status: r.status, ...(out.open_url ? { host: new URL(out.open_url).hostname } : {}) });
        return send(res, 200, out), true;
      } finally {
        running.delete(ticket.key);
      }
    },
  };
}

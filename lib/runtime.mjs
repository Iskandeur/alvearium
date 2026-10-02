// session-board — I/O side: config, identity, local store, remote calls.
// Every function here is defensive: a hook must never fail or block the session.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  applyTransition,
  classify,
  isExpired,
  parseFilters,
  renderTicketsText,
  repoFromRemote,
  sanitizeEvent,
  shouldSend,
} from './core.mjs';

export const NETWORK_TIMEOUT_MS = 2000;
const GIT_REFRESH_MS = 60 * 1000;
const FAILURE_BACKOFF_MS = 30 * 1000;

/** Where local state lives. Fixed path so hooks, /board and the statusline agree without plumbing. */
export function dataDir(env = process.env) {
  return env.SESSION_BOARD_DIR || join(homedir(), '.claude', 'session-board');
}

/**
 * Remote config, first match wins:
 *   1. SESSION_BOARD_URL / SESSION_BOARD_TOKEN environment variables
 *   2. the plugin's userConfig (exported to hooks as CLAUDE_PLUGIN_OPTION_SERVER_URL / _TOKEN)
 *   3. ~/.claude/session-board/config.json  ({ "url": "...", "token": "..." })
 * Token `proxy` means: send no Authorization header, a proxy adds it (claude.ai/code API credential).
 */
export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(dataDir(env), 'config.json'), 'utf8'));
  } catch {}
  const url = (env.SESSION_BOARD_URL || env.CLAUDE_PLUGIN_OPTION_SERVER_URL || file.url || '').trim().replace(/\/+$/, '');
  const token = (env.SESSION_BOARD_TOKEN || env.CLAUDE_PLUGIN_OPTION_TOKEN || file.token || '').trim();
  const sendText = (env.SESSION_BOARD_SEND_TEXT ?? String(file.sendText ?? '1')) !== '0';
  const mirrorTasks = (env.SESSION_BOARD_MIRROR_TASKS ?? String(file.mirrorTasks ?? '1')) !== '0';
  return { url, token, remote: Boolean(url && token), sendText, mirrorTasks };
}

export function authHeaders(cfg) {
  return cfg.token && cfg.token !== 'proxy' ? { authorization: `Bearer ${cfg.token}` } : {};
}

function sessionFile(dir, id) {
  return join(dir, 'sessions', `${id.replace(/[^\w.-]/g, '_')}.json`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Who is this session? Git info is cached per session and refreshed at most once a minute. */
export function identify(input, cached, env = process.env, now = Date.now()) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  let gitInfo = cached?.git;
  if (!gitInfo || now - gitInfo.at > GIT_REFRESH_MS || gitInfo.cwd !== cwd) {
    gitInfo = {
      at: now,
      cwd,
      repo: repoFromRemote(git(cwd, ['remote', 'get-url', 'origin'])),
      branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    };
  }
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  // Documented link: https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}
  const remoteId = (env.CLAUDE_CODE_REMOTE_SESSION_ID || '').replace(/^cse_/, 'session_');
  return {
    identity: {
      sessionId: String(input.session_id || 'unknown'),
      name: input.session_name || input.session_title || env.SESSION_BOARD_NAME || undefined,
      cwd,
      repo: gitInfo.repo,
      branch: gitInfo.branch,
      host: cloud ? 'claude.ai/code' : hostname(),
      surface: cloud ? 'cloud' : 'terminal',
      url: cloud && remoteId && /^[\w-]+$/.test(remoteId) ? `https://claude.ai/code/${remoteId}` : undefined,
    },
    git: gitInfo,
  };
}

/** Read the tail of the transcript to find the last assistant text (fallback for Stop). */
export function lastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.slice(-400_000).split('\n').reverse();
  for (const l of lines) {
    if (!l.includes('"assistant"')) continue;
    try {
      const j = JSON.parse(l);
      const content = j.message?.content;
      if (j.type !== 'assistant' || !Array.isArray(content)) continue;
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) return text;
    } catch {}
  }
  return '';
}

export async function postEvent(cfg, payload, fetchImpl = fetch, timeoutMs = NETWORK_TIMEOUT_MS) {
  const res = await fetchImpl(`${cfg.url}/api/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(cfg), 'user-agent': 'session-board-hook/0.1' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status;
}

/**
 * Handle one hook invocation end to end. Returns a short status string (for tests / debugging).
 * Never throws for expected failures; the caller still wraps it.
 */
export async function handleHook(event, input, { env = process.env, now = Date.now(), fetchImpl = fetch } = {}) {
  const cfg = loadConfig(env);
  if (event === 'Stop' && typeof input.last_assistant_message !== 'string' && cfg.sendText) {
    input = { ...input, last_assistant_message: lastAssistantText(input.transcript_path) };
  }
  const t = classify(event, input, { sendText: cfg.sendText, mirrorTasks: cfg.mirrorTasks });
  if (!t || !input.session_id) return 'ignored';

  const dir = dataDir(env);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const path = sessionFile(dir, String(input.session_id));
  const stored = readJson(path) || {};
  if (!shouldSend(stored.lastSent, t, now)) return 'throttled';

  const { identity, git: gitInfo } = identify(input, stored, env, now);
  // `record` is kept for the throttle and older readers; tickets live in SQLite or on the server.
  const record = applyTransition(stored.record, t, identity, now);
  const next = { record, git: gitInfo, lastSent: stored.lastSent, failedAt: stored.failedAt, v: 2 };
  const payload = { v: 1, session: identity, transition: t, at: now };

  let status = 'local';
  if (cfg.remote) {
    if (stored.failedAt && now - stored.failedAt < FAILURE_BACKOFF_MS) {
      status = 'backoff';
    } else {
      try {
        // SessionEnd hooks share a 1.5 s budget (hooks reference), so that one gets a shorter fuse.
        const timeoutMs = event === 'SessionEnd' ? 1200 : NETWORK_TIMEOUT_MS;
        await postEvent(cfg, payload, fetchImpl, timeoutMs);
        next.failedAt = undefined;
        status = 'sent';
      } catch {
        next.failedAt = now;
        status = 'send-failed';
      }
    }
  } else {
    const evt = sanitizeEvent(payload);
    let store;
    try {
      store = await openLocalStore(env);
      if (evt) store.ingest(evt, now);
      writeSummary(dir, store, now);
    } catch {
      status = 'local-failed';
    } finally {
      store?.close();
    }
  }
  // A mirrored task is not a state change of the session: it must not reset the throttle either.
  if (t.task) next.record = stored.record ?? record;
  else if (status === 'sent' || status === 'local') next.lastSent = { state: t.state, at: now };
  writeJsonAtomic(path, next);
  rememberSessionCwd(dir, identity, now);
  if (t.state === 'closed') pruneLocal(dir, now);
  return status;
}

/** Local mode keeps every ticket in this SQLite file (same schema and queries as the server). */
export function localDbPath(env = process.env) {
  return join(dataDir(env), 'board.db');
}

/** Open the local store; on first use, import the v0.1 per-session JSON files (left in place). */
export async function openLocalStore(env = process.env) {
  const { openStore } = await import('./store.mjs');
  const store = await openStore(localDbPath(env));
  const done = store.q("SELECT value FROM meta WHERE key = 'legacy_local_import'").get();
  if (!done) {
    store.importLegacy(readLocalRecords(dataDir(env)));
    store.q("INSERT OR REPLACE INTO meta(key, value) VALUES ('legacy_local_import', ?)").run(String(Date.now()));
  }
  return store;
}

/**
 * Small summary next to the database, for readers that cannot open SQLite (the terminal mod, the
 * self-contained statusline): ticket counts and the text board.
 */
export function writeSummary(dir, store, now = Date.now()) {
  try {
    const board = store.ticketBoard({}, { perColumn: 12, doneShown: 0, now });
    writeJsonAtomic(join(dir, 'summary.json'), { at: now, counts: board.counts, text: renderTicketsText(board, { now }) });
  } catch {}
}

/** Last session seen in a directory: the MCP server gets no session id, it looks it up by cwd. */
function cwdFile(dir, cwd) {
  return join(dir, 'cwd', createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16) + '.json');
}

export function rememberSessionCwd(dir, identity, now = Date.now()) {
  if (!identity.cwd || !identity.sessionId || identity.sessionId === 'unknown') return;
  try {
    mkdirSync(join(dir, 'cwd'), { recursive: true });
    writeJsonAtomic(cwdFile(dir, identity.cwd), { sessionId: identity.sessionId, cwd: identity.cwd, repo: identity.repo, branch: identity.branch, at: now });
  } catch {}
}

export function sessionForCwd(dir, cwd) {
  return readJson(cwdFile(dir, cwd));
}

/** All locally known session records (v0.1 files, still written for the throttle). */
export function readLocalRecords(dir = dataDir()) {
  let names = [];
  try {
    names = readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJson(join(dir, 'sessions', n))?.record).filter(Boolean);
}

export function pruneLocal(dir = dataDir(), now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, 'sessions', n);
    const rec = readJson(p)?.record;
    if (!rec || isExpired(rec, now)) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
}

// ---- one backend for the CLI, the MCP server and the mod: HTTP when configured, else SQLite ------

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    for (const x of [v].flat()) u.append(k, String(x));
  }
  const s = u.toString();
  return s ? '?' + s : '';
};

export class HttpBackend {
  constructor(cfg, { actor = 'user', fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    this.cfg = cfg;
    this.actor = actor;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.source = cfg.url;
  }
  async call(method, path, body) {
    const res = await this.fetch(`${this.cfg.url}${path}`, {
      method,
      headers: {
        ...authHeaders(this.cfg),
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-session-board-actor': this.actor,
        'user-agent': 'session-board-client/0.2',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }
  list(params) {
    return this.call('GET', '/api/tickets' + qs(params));
  }
  board(params) {
    return this.call('GET', '/api/tickets/board' + qs(params));
  }
  get(key) {
    return this.call('GET', '/api/tickets/' + encodeURIComponent(key));
  }
  create(body) {
    return this.call('POST', '/api/tickets', body);
  }
  update(key, body) {
    return this.call('POST', '/api/tickets/' + encodeURIComponent(key), body);
  }
  comment(key, text) {
    return this.call('POST', '/api/tickets/' + encodeURIComponent(key) + '/comments', { text });
  }
  facets() {
    return this.call('GET', '/api/facets');
  }
  close() {}
}

export class LocalBackend {
  constructor(store, { actor = 'user' } = {}) {
    this.store = store;
    this.actor = actor;
    this.source = 'local';
  }
  async list(params) {
    return this.store.listTickets(parseFilters(params));
  }
  async board(params) {
    return this.store.ticketBoard(parseFilters(params));
  }
  async get(key) {
    const t = this.store.getTicket(key);
    if (!t) throw Object.assign(new Error('ticket not found'), { status: 404 });
    return t;
  }
  async create(body) {
    return this.store.createTicket(body, { actor: this.actor });
  }
  async update(key, body) {
    return this.store.updateTicket(key, body, { actor: this.actor });
  }
  async comment(key, text) {
    return this.store.comment(key, text, { actor: this.actor });
  }
  async facets() {
    return this.store.facets();
  }
  close() {
    this.store.close();
  }
}

export async function openBackend({ env = process.env, actor = 'user', fetchImpl = fetch } = {}) {
  const cfg = loadConfig(env);
  if (cfg.remote) return new HttpBackend(cfg, { actor, fetchImpl });
  return new LocalBackend(await openLocalStore(env), { actor });
}

/** Ticket board from the server when configured, else from the local store. */
export async function loadBoard({ env = process.env, fetchImpl = fetch, params = {} } = {}) {
  const backend = await openBackend({ env, fetchImpl });
  try {
    return { source: backend.source, board: await backend.board(params) };
  } finally {
    backend.close();
  }
}

export { sanitizeEvent };

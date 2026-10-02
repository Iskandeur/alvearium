// session-board — I/O side: config, identity, local store, remote calls.
// Every function here is defensive: a hook must never fail or block the session.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { applyTransition, buildBoard, classify, isExpired, repoFromRemote, sanitizeEvent, shouldSend } from './core.mjs';

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
  return { url, token, remote: Boolean(url && token), sendText };
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
  const t = classify(event, input, { sendText: cfg.sendText });
  if (!t || !input.session_id) return 'ignored';

  const dir = dataDir(env);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const path = sessionFile(dir, String(input.session_id));
  const stored = readJson(path) || {};
  if (!shouldSend(stored.lastSent, t, now)) return 'throttled';

  const { identity, git: gitInfo } = identify(input, stored, env, now);
  const record = applyTransition(stored.record, t, identity, now);
  const next = { record, git: gitInfo, lastSent: stored.lastSent, failedAt: stored.failedAt };

  let status = 'local';
  if (cfg.remote) {
    if (stored.failedAt && now - stored.failedAt < FAILURE_BACKOFF_MS) {
      status = 'backoff';
    } else {
      try {
        // SessionEnd hooks share a 1.5 s budget (hooks reference), so that one gets a shorter fuse.
        const timeoutMs = event === 'SessionEnd' ? 1200 : NETWORK_TIMEOUT_MS;
        await postEvent(cfg, { v: 1, session: identity, transition: t, at: now }, fetchImpl, timeoutMs);
        next.failedAt = undefined;
        status = 'sent';
      } catch {
        next.failedAt = now;
        status = 'send-failed';
      }
    }
  }
  if (status === 'sent' || status === 'local') next.lastSent = { state: t.state, at: now };
  writeJsonAtomic(path, next);
  if (t.state === 'closed') pruneLocal(dir, now);
  return status;
}

/** All locally known session records. */
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

/** Board from the server when configured, else from the local store. */
export async function loadBoard({ env = process.env, now = Date.now(), fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const cfg = loadConfig(env);
  if (cfg.remote) {
    const res = await fetchImpl(`${cfg.url}/api/board`, {
      headers: { ...authHeaders(cfg), 'user-agent': 'session-board-cli/0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`board server answered HTTP ${res.status}`);
    return { source: cfg.url, board: await res.json() };
  }
  return { source: 'local', board: buildBoard(readLocalRecords(dataDir(env)), now) };
}

export { sanitizeEvent };

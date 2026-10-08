// session-board — keep tickets when the storage changes.
//
// Local mode keeps tickets in ~/.claude/session-board/board.db. When a machine switches to a server
// (or when a bug kept some tickets local, as the MCP server did in 0.2.0), those tickets are sent to
// the server once, through the idempotent POST /api/import, and board.db is renamed to
// board.db.uploaded-<date>. Nothing is ever deleted. Server → local and server → other server are
// not migrated: the SessionStart hook says so, once.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { authHeaders, boardFetch, dataDir, explainReply, loadConfig, localDbPath } from './runtime.mjs';

const CHUNK_TICKETS = 25;
// Under the 2 MB a relay in front of the server may accept for /api/import (the server takes 4 MB).
const CHUNK_BYTES = 1_000_000;
export const SYNC_COMMAND = '/alvearium:board sync';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {}
}

const stamp = (now) => new Date(now).toISOString().slice(0, 19).replace(/:/g, '-');
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Split the export in requests of at most CHUNK_TICKETS tickets / CHUNK_BYTES bytes. Sessions go first. */
export function chunkExport({ sessions, tickets }) {
  const chunks = [];
  let cur = { sessions, tickets: [] };
  let size = JSON.stringify(sessions).length;
  for (const t of tickets) {
    const n = JSON.stringify(t).length;
    if (cur.tickets.length && (cur.tickets.length >= CHUNK_TICKETS || size + n > CHUNK_BYTES)) {
      chunks.push(cur);
      cur = { sessions: [], tickets: [] };
      size = 0;
    }
    cur.tickets.push(t);
    size += n;
  }
  if (cur.tickets.length || cur.sessions.length) chunks.push(cur);
  return chunks;
}

async function postImport(cfg, body, fetchImpl, timeoutMs) {
  const res = await fetchImpl(`${cfg.url}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(cfg), 'user-agent': 'session-board-sync/0.2' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status === 404) throw new Error('the server has no /api/import yet (update the server to 0.2.3 or later)');
  const why = explainReply(res, text, { url: cfg.url, token: cfg.token, env: cfg.env || process.env });
  if (why) throw new Error(why);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(text);
}

/**
 * Send the local board.db to the server, once. Returns
 *   { status: 'local-mode' | 'none' | 'uploaded' | 'partial' | 'failed', total, imported, skipped,
 *     duplicate, invalid, pending, file, error }
 * `pending` = tickets still only on this machine. Never throws.
 */
export async function syncLocalToServer({ env = process.env, fetchImpl = boardFetch, now = Date.now(), deadlineMs = 2500, requestTimeoutMs = 2000 } = {}) {
  const cfg = loadConfig(env);
  const out = { status: 'none', total: 0, imported: 0, skipped: 0, duplicate: 0, invalid: 0, pending: 0, server: cfg.url ? hostOf(cfg.url) : null };
  if (!cfg.remote) return { ...out, status: 'local-mode' };
  const path = localDbPath(env);
  if (!existsSync(path)) return out;
  const started = Date.now();
  let store;
  let data;
  try {
    const { openStore } = await import('./store.mjs');
    store = await openStore(path);
    data = { board: store.boardId(), ...store.exportForImport() };
  } catch (e) {
    store?.close();
    return { ...out, status: 'failed', error: `cannot read ${path}: ${e?.message || e}` };
  }
  out.total = data.tickets.length;
  const machine = hostname();
  let error = null;
  for (const chunk of chunkExport(data)) {
    const left = deadlineMs - (Date.now() - started);
    if (left < 200) {
      error = 'out of time, the rest goes at the next start';
      break;
    }
    try {
      const r = await postImport(cfg, { board: data.board, machine, ...chunk }, fetchImpl, Math.min(requestTimeoutMs, left));
      for (const k of ['imported', 'skipped', 'duplicate', 'invalid']) out[k] += Number(r[k]) || 0;
    } catch (e) {
      error = e?.name === 'TimeoutError' ? 'the server did not answer in time' : String(e?.message || e);
      break;
    }
  }
  out.pending = out.total - out.imported - out.skipped - out.duplicate - out.invalid;
  if (error || out.pending > 0) {
    store.close();
    return { ...out, status: out.imported || out.skipped || out.duplicate ? 'partial' : 'failed', error: error || 'incomplete answer from the server' };
  }
  // Everything is on the server: put the file aside (never deleted) so local mode starts clean later.
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  store.close();
  // A rename onto an existing file replaces it: never reuse the name of an earlier upload.
  let target = `${path}.uploaded-${stamp(now)}`;
  for (let i = 2; existsSync(target); i++) target = `${path}.uploaded-${stamp(now)}-${i}`;
  try {
    renameSync(path, target);
    for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) renameSync(path + ext, target + ext);
    out.file = target;
  } catch (e) {
    // Another process holds it (Windows). The server import is idempotent: the next start retries.
    out.renameError = String(e?.code || e?.message || e);
  }
  return { ...out, status: 'uploaded' };
}

/** One line for a person, or null when there is nothing to say. */
export function describeSync(r) {
  const where = r.server ? ` on ${r.server}` : '';
  if (r.status === 'uploaded') {
    if (!r.imported && !r.invalid) return null;
    const kept = r.file ? ` The local file is kept as ${r.file.split(/[\\/]/).pop()}.` : '';
    const bad = r.invalid ? ` ${r.invalid} could not be read and stay only in that file.` : '';
    return `session-board: ${r.imported} ticket${r.imported === 1 ? '' : 's'} from this machine's local board moved to the board${where}.${bad}${kept}`;
  }
  if (r.status === 'partial' || r.status === 'failed') {
    return (
      `session-board: ${r.pending} ticket${r.pending === 1 ? '' : 's'} of this machine's local board (board.db) are not on the board${where} yet ` +
      `(${r.error}). Retried at every start; to retry now: ${SYNC_COMMAND}`
    );
  }
  return null;
}

/**
 * SessionStart: warn when the storage moved away from a server (no automatic migration that way),
 * then send a leftover local board to the server. Returns the text to show the user, or null.
 * Each distinct warning is shown once.
 */
export async function sessionStartNotice({ env = process.env, fetchImpl = boardFetch, now = Date.now(), deadlineMs = 2500 } = {}) {
  const dir = dataDir(env);
  const cfg = loadConfig(env);
  const statePath = join(dir, 'storage.json');
  const prev = readJson(statePath) || {};
  const current = cfg.remote ? { mode: 'remote', url: cfg.url } : { mode: 'local' };
  const lines = [];
  if (prev.mode === 'remote' && prev.url && (current.mode === 'local' || current.url !== prev.url)) {
    lines.push(
      current.mode === 'local'
        ? `session-board: this machine is in local mode now. Tickets on ${hostOf(prev.url)} stay there and are not shown here; set the server URL and token again to see them.`
        : `session-board: the board server changed from ${hostOf(prev.url)} to ${hostOf(current.url)}. Tickets on the old server are not moved.`,
    );
  }
  let notice = prev.notice || null;
  if (cfg.remote) {
    const r = await syncLocalToServer({ env, fetchImpl, now, deadlineMs, requestTimeoutMs: Math.min(2000, deadlineMs) });
    const text = describeSync(r);
    if (r.status === 'uploaded') {
      notice = null;
      if (text) lines.push(text);
    } else if (text) {
      // Same failure, same count: say it once, not at every start.
      const sig = `${r.status}:${r.pending}:${r.error}`;
      if (prev.notice !== sig) lines.push(text);
      notice = sig;
    }
  }
  writeJson(statePath, { ...current, notice, at: now });
  return lines.length ? lines.join('\n') : null;
}

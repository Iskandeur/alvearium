#!/usr/bin/env node
// session-board doctor: one command that says whether this session can write to the board, and if
// not, what to fix. Uses the plugin's own HTTP path (lib/net.mjs), not curl: curl honours the proxy
// variables, Node's fetch does not, and that difference is exactly what hid the 0.3.3 cloud failure.
//
//   node .claude/session-board/scripts/doctor.mjs              cloud copy (in a claude.ai/code session)
//   /session-board:board doctor                                 plugin, on a terminal
//   … doctor.mjs --ticket "test cloud"                          also create a ticket (origin, repo, session
//                                                               as the MCP tool would) and print its key
//   … --json                                                    the report as JSON
// Never prints a token. Exit code 0 when the board answers as the board, 1 otherwise.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/core.mjs';
import { boardFetch, explainReply, proxyFor, routeOf } from '../lib/net.mjs';
import { HttpBackend, authHeaders, dataDir, loadConfig } from '../lib/runtime.mjs';

const argv = process.argv.slice(2).filter((a) => a !== '--cloud-only' && a !== 'doctor');
const redact = (u) => {
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`);
    return `${x.protocol}//${x.username ? '***@' : ''}${x.host}`;
  } catch {
    return '(unparsable)';
  }
};

const env = process.env;
const pick = (n) => env[n.toLowerCase()] || env[n.toUpperCase()] || '';

/** Last hook failure recorded on this machine (lib/runtime.mjs handleHook), if any. */
function lastHookError() {
  let best = null;
  try {
    const dir = join(dataDir(env), 'sessions');
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      try {
        const e = JSON.parse(readFileSync(join(dir, n), 'utf8')).lastError;
        if (e && (!best || e.at > best.at)) best = e;
      } catch {}
    }
  } catch {}
  return best;
}

export async function runDoctor({ ticket } = {}) {
  const r = { version: VERSION, node: process.version, cloud: env.CLAUDE_CODE_REMOTE === 'true', checks: [], fixes: [] };
  const ok = (name, detail) => r.checks.push({ name, ok: true, detail });
  const bad = (name, detail, fix) => {
    r.checks.push({ name, ok: false, detail });
    if (fix) r.fixes.push(fix);
  };
  const info = (name, detail) => r.checks.push({ name, ok: null, detail });

  info('environment', `${r.cloud ? 'claude.ai/code cloud session' : 'terminal'} · node ${process.version} · session-board ${VERSION}`);
  const cfg = loadConfig(env);
  if (!cfg.url) {
    bad('server URL', 'not set: local mode (this machine only)', r.cloud ? 'Set SESSION_BOARD_URL in the cloud environment (claude.ai/code → environment → edit), then start a new session.' : null);
  } else ok('server URL', cfg.url);
  const tokenKind = !cfg.token ? 'not set' : cfg.token === 'proxy' ? '`proxy` (no header sent; a proxy must add the credential)' : `set (${cfg.token.length} characters, not shown)`;
  if (cfg.url && !cfg.token)
    bad('token', tokenKind, 'Set SESSION_BOARD_TOKEN: the board token, or `proxy` with an API credential for the board host on the cloud environment.');
  else if (cfg.url) (cfg.token === 'proxy' && !r.cloud ? bad : ok)('token', tokenKind, cfg.token === 'proxy' && !r.cloud ? 'SESSION_BOARD_TOKEN=proxy only works in claude.ai/code with an API credential; on this machine use the real token.' : null);

  const proxyVar = pick('https_proxy') || pick('all_proxy');
  const noProxy = pick('no_proxy');
  if (proxyVar) info('proxy variables', `HTTPS_PROXY=${redact(proxyVar)}${noProxy ? ` · NO_PROXY=${noProxy.slice(0, 120)}` : ''}`);
  else info('proxy variables', 'none (HTTPS_PROXY / https_proxy unset)');
  if (cfg.url) {
    const route = routeOf(cfg.url, env);
    const proxied = Boolean(proxyFor(cfg.url, env));
    if (r.cloud && cfg.token === 'proxy' && !proxied)
      bad('route', `${route}: the agent proxy will not see these requests, so it cannot attach the credential`, proxyVar ? `NO_PROXY covers ${new URL(cfg.url).host}: remove it from NO_PROXY in the environment.` : 'No HTTPS_PROXY in this process: the credential cannot be added. Check the environment\'s network access, or put the real token in SESSION_BOARD_TOKEN.');
    else ok('route', `${route} (plugin requests, lib/net.mjs)`);
    info('node fetch', env.NODE_USE_ENV_PROXY === '1' ? 'NODE_USE_ENV_PROXY=1 (global fetch also uses the proxy)' : 'the global fetch ignores the proxy variables here; session-board does not use it (0.3.4+)');
  }

  if (cfg.url && cfg.token) {
    // 1. reachability + identity of the thing that answers
    try {
      const res = await boardFetch(`${cfg.url}/api/version`, { headers: { ...authHeaders(cfg), 'user-agent': `session-board-doctor/${VERSION}` }, signal: AbortSignal.timeout(8000) }, { env });
      const text = await res.text();
      const why = explainReply(res, text, { url: cfg.url, token: cfg.token, env });
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      if (why) bad('GET /api/version', why, 'The request reached a gateway or a login page, not the board: see the line above.');
      else if (!res.ok || typeof body?.version !== 'string') bad('GET /api/version', `HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`, 'Is SESSION_BOARD_URL the board base URL (the page you open, without /api)?');
      else ok('GET /api/version', `HTTP ${res.status}, server ${body.version}${body.version !== VERSION ? ` (this copy: ${VERSION})` : ''}`);
    } catch (e) {
      bad('GET /api/version', `${e?.name === 'TimeoutError' ? 'timed out after 8 s' : e?.message || e}${e?.cause ? ` (${e.cause.message || e.cause})` : ''}`, /certificate|self.signed|UNABLE_TO|CERT_/i.test(String(e?.message || e?.code)) ? 'TLS: the proxy certificate is not trusted by Node; set NODE_EXTRA_CA_CERTS to the system bundle (e.g. /etc/ssl/certs/ca-certificates.crt).' : 'The server cannot be reached from here: URL, network access level of the environment, proxy.');
    }
    // 2. an authenticated read through the backend the MCP tools use
    const backend = new HttpBackend(cfg, { actor: cfg.actor || 'claude', timeoutMs: 8000 });
    let authed = false;
    try {
      const list = await backend.list({ limit: 1 });
      if (!Array.isArray(list?.tickets)) throw new Error(`unexpected reply ${JSON.stringify(list).slice(0, 120)}`);
      authed = true;
      ok('authenticated read', `GET /api/tickets: ${list.total ?? list.tickets.length} ticket(s) visible`);
    } catch (e) {
      bad('authenticated read', e?.message || String(e), e?.status === 401 || e?.status === 403 ? 'The board refused the credential: check SESSION_BOARD_TOKEN, or the API credential value and its host.' : null);
    }
    // 3. optional write, exactly as ticket_create does it
    if (ticket && authed) {
      try {
        const { callTool, currentContext } = await import('../mcp/server.mjs');
        const text = await callTool('ticket_create', { title: String(ticket), assignee: 'user', kind: 'note', body: `Created by session-board doctor ${VERSION} (${r.cloud ? 'cloud' : 'terminal'}).` }, { backend, context: currentContext(env) });
        ok('ticket_create', text);
        r.ticket = text;
      } catch (e) {
        bad('ticket_create', e?.message || String(e));
      }
    } else if (ticket) info('ticket_create', 'skipped: the authenticated read failed');
  }

  const last = lastHookError();
  if (last) info('last hook failure', `${new Date(last.at).toISOString().slice(0, 19).replace('T', ' ')} UTC: ${last.error}`);
  r.ok = r.checks.every((c) => c.ok !== false);
  return r;
}

export function renderDoctor(r) {
  const mark = (c) => (c.ok === true ? 'ok ' : c.ok === false ? 'BAD' : ' · ');
  const out = [`session-board doctor — ${r.ok ? 'the board answers as the board' : 'problem found'}`, ''];
  for (const c of r.checks) out.push(`${mark(c)} ${c.name}: ${c.detail}`);
  if (r.fixes.length) out.push('', 'To fix:', ...[...new Set(r.fixes)].map((f) => `- ${f}`));
  return out.join('\n');
}

/** CLI entry, also used by `board.mjs doctor`. */
export async function doctorMain(args = argv) {
  const i = args.indexOf('--ticket');
  const r = await runDoctor({ ticket: i >= 0 ? args[i + 1] : undefined });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : renderDoctor(r));
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await doctorMain();

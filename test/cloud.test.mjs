// 0.3.1: the cloud copy (/session-board:install-cloud) carries the MCP tools, the skill and the
// commands into a repository, silent outside claude.ai/code cloud sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION, compareVersions, parseFilters } from '../lib/core.mjs';
import { cloudCopyGuard, handleHook, staleCopyNotice } from '../lib/runtime.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';
import {
  COMMAND_TAG,
  MCP_MARKER,
  MCP_NAME,
  SKILL_NAME,
  mergeLocalSettings,
  mergeMcpJson,
  vendoredSkill,
} from '../scripts/install-repo.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const INSTALL = join(ROOT, 'scripts', 'install-repo.mjs');
const TOKEN = 'c'.repeat(32);
const tmp = () => mkdtempSync(join(tmpdir(), 'sb-cloud-'));
// Nor the user's global git ignore (~/.config/git/ignore), which may already list settings.local.json.
const NO_XDG = tmp();
// Never inherit the session that runs the tests (Claude Code exports these to its children).
const CLEAN = { SESSION_BOARD_URL: '', SESSION_BOARD_TOKEN: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CODE_REMOTE: '', CLAUDE_PLUGIN_OPTION_SERVER_URL: '', CLAUDE_PLUGIN_OPTION_TOKEN: '', SESSION_BOARD_ACTOR: '' };

function gitRepo() {
  const dir = tmp();
  // No global config: the user's global ignore must not hide .claude/settings.local.json from the test.
  execFileSync('git', ['-C', dir, 'init', '-q'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: NO_XDG } });
  return dir;
}
const install = (repo, ...flags) => execFileSync(process.execPath, [INSTALL, repo, ...flags], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: NO_XDG } });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The vendored MCP server, spoken to over stdio as Claude Code does. */
function client(serverPath, env, cwd) {
  const child = spawn(process.execPath, [serverPath, '--cloud-only'], { env: { ...process.env, ...CLEAN, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  let id = 0;
  return {
    request(method, params) {
      const mid = ++id;
      return new Promise((res, rej) => {
        waiting.set(mid, res);
        setTimeout(() => rej(new Error(`timeout on ${method}; stderr: ${stderr}`)), 5000).unref();
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
      return stderr;
    },
  };
}

async function withBoard(fn) {
  const store = await openStore(join(tmp(), 'board.db'));
  const app = createServer(createApp({ token: TOKEN, store, page: '<html></html>' }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  // What a claude.ai/code "API credential" does: the session sends no token, the proxy adds it.
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(base + req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(req.headers['x-session-board-actor'] ? { 'x-session-board-actor': req.headers['x-session-board-actor'] } : {}) },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxied = `http://127.0.0.1:${proxy.address().port}`;
  try {
    await fn({ base, proxied, store });
  } finally {
    proxy.close();
    app.close();
    store.close();
  }
}

test('versions compare numerically, and the server says its version', async () => {
  assert.ok(compareVersions('0.3.0', '0.3.1') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.3.1', '0.3.1'), 0);
  assert.ok(compareVersions('', '0.0.1') < 0);
  for (const f of ['package.json', '.claude-plugin/plugin.json']) assert.equal(readJson(join(ROOT, f)).version, VERSION, `${f} carries ${VERSION}`);
  await withBoard(async ({ base }) => {
    const v = await (await fetch(`${base}/api/version`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(v.version, VERSION);
  });
});

test('.mcp.json: our server is added next to the others, idempotently, never over a foreign one', () => {
  const existing = { mcpServers: { db: { command: 'npx', args: ['db-mcp'] } }, other: 1 };
  const once = mergeMcpJson(existing).config;
  assert.deepEqual(mergeMcpJson(once).config, once, 'idempotent');
  assert.deepEqual(once.mcpServers.db, existing.mcpServers.db, 'other servers untouched');
  assert.equal(once.other, 1);
  assert.deepEqual(once.mcpServers[MCP_NAME].args, [`\${CLAUDE_PROJECT_DIR:-.}/${MCP_MARKER}`, '--cloud-only']);
  assert.deepEqual(mergeMcpJson(once, { remove: true }).config, existing, 'uninstall restores');
  assert.equal(mergeMcpJson(mergeMcpJson({}).config, { remove: true }).config, null, 'a file holding only ours is deleted');
  const foreign = { mcpServers: { [MCP_NAME]: { command: 'other' } } };
  assert.deepEqual(mergeMcpJson(foreign), { config: foreign, conflict: true });
});

test('settings.local.json: the copy is quieted on the installing machine, the user settings kept', () => {
  const mine = { permissions: { allow: ['Bash(ls)'] }, disabledMcpjsonServers: ['x'], skillOverrides: { board: 'on' } };
  const once = mergeLocalSettings(mine);
  assert.deepEqual(mergeLocalSettings(once), once, 'idempotent');
  assert.deepEqual(once.disabledMcpjsonServers, ['x', MCP_NAME]);
  assert.equal(once.skillOverrides[SKILL_NAME], 'off');
  assert.equal(once.skillOverrides.board, 'on', 'an explicit choice of the user wins');
  assert.equal(once.skillOverrides.ticket, 'off');
  assert.deepEqual(mergeLocalSettings(once, { remove: true }), mine);
  assert.deepEqual(mergeLocalSettings(mergeLocalSettings({}), { remove: true }), {});
});

test('the vendored skill is renamed and fenced, its body kept', () => {
  const src = readFileSync(join(ROOT, 'skills', 'tickets', 'SKILL.md'), 'utf8');
  const out = vendoredSkill(src);
  assert.match(out, new RegExp(`^---\\nname: ${SKILL_NAME}\\ndescription: Track action items`));
  assert.match(out, /cloud sessions/);
  assert.ok(out.includes('## The feedback inbox: say what wastes your time'));
  assert.equal(out.match(/^---$/gm).length, 2, 'one frontmatter block');
});

test('install-cloud: full copy, idempotent, keeps foreign files, uninstalls cleanly', () => {
  const repo = gitRepo();
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db' } } }));
  mkdirSync(join(repo, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'commands', 'ticket.md'), 'my own /ticket\n');
  const first = install(repo);
  assert.match(first, /ticket\.md exists and is not session-board's/);
  assert.match(first, /\.git\/info\/exclude/);
  const files = ['.claude/session-board/VERSION', '.claude/session-board/mcp/server.mjs', '.claude/session-board/lib/store.mjs', '.claude/session-board/scripts/board.mjs', `.claude/skills/${SKILL_NAME}/SKILL.md`, '.claude/commands/board.md'];
  for (const f of files) assert.ok(existsSync(join(repo, f)), f);
  assert.equal(readFileSync(join(repo, '.claude/session-board/VERSION'), 'utf8').trim(), VERSION);
  assert.ok(readFileSync(join(repo, '.claude/commands/board.md'), 'utf8').includes(COMMAND_TAG));
  assert.equal(readFileSync(join(repo, '.claude/commands/ticket.md'), 'utf8'), 'my own /ticket\n');
  const snapshot = () => Object.fromEntries(['.mcp.json', '.claude/settings.json', '.claude/settings.local.json', ...files].map((f) => [f, readFileSync(join(repo, f), 'utf8')]));
  const before = snapshot();
  install(repo);
  assert.deepEqual(snapshot(), before, 'a second run changes nothing');
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/settings\.local\.json/g).length, 1);
  // What git would commit: everything but settings.local.json.
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '-uall'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: NO_XDG } });
  assert.ok(status.includes('.mcp.json') && status.includes('.claude/settings.json'));
  assert.ok(!status.includes('settings.local.json'));

  install(repo, '--uninstall');
  assert.deepEqual(readJson(join(repo, '.mcp.json')), { mcpServers: { db: { command: 'db' } } });
  for (const f of files) assert.ok(!existsSync(join(repo, f)), `${f} removed`);
  assert.equal(readFileSync(join(repo, '.claude/commands/ticket.md'), 'utf8'), 'my own /ticket\n');
  assert.ok(!existsSync(join(repo, '.claude/settings.local.json')), 'emptied local settings are removed');
  assert.equal(readJson(join(repo, '.claude/settings.json')).hooks, undefined);
});

test('vendored MCP server: zero tools outside the cloud, a setup hint in an unconfigured cloud', async () => {
  const repo = gitRepo();
  install(repo);
  const server = join(repo, MCP_MARKER);
  const off = client(server, { SESSION_BOARD_DIR: tmp() }, repo);
  const init = await off.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.version, VERSION);
  assert.equal(init.result.instructions, undefined, 'no instructions to load locally');
  assert.deepEqual((await off.request('tools/list', {})).result.tools, []);
  assert.ok((await off.request('tools/call', { name: 'ticket_create', arguments: { title: 'x' } })).error);
  assert.equal(await off.close(), '', 'nothing on stderr');

  const bare = client(server, { SESSION_BOARD_DIR: tmp(), CLAUDE_CODE_REMOTE: 'true' }, repo);
  await bare.request('initialize', {});
  assert.equal((await bare.request('tools/list', {})).result.tools.length, 7);
  const r = await bare.request('tools/call', { name: 'ticket_create', arguments: { title: 'x' } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /SESSION_BOARD_URL/);
  assert.equal(await bare.close(), '');
});

test('vendored MCP server in the cloud: tickets reach the server, through an API-credential proxy too', async () => {
  const repo = gitRepo();
  install(repo);
  const server = join(repo, MCP_MARKER);
  await withBoard(async ({ base, proxied, store }) => {
    for (const [url, token, sid] of [
      [base, TOKEN, 'cloud-direct'],
      [proxied, 'proxy', 'cloud-proxy'],
    ]) {
      const c = client(server, { SESSION_BOARD_DIR: tmp(), CLAUDE_CODE_REMOTE: 'true', SESSION_BOARD_URL: url, SESSION_BOARD_TOKEN: token, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: repo }, repo);
      await c.request('initialize', {});
      const r = await c.request('tools/call', { name: 'ticket_create', arguments: { title: `Add the secret (${sid})` } });
      assert.ok(!r.result.isError, r.result.content[0].text);
      assert.match(r.result.content[0].text, /^Created SB-\d+/);
      await c.close();
      const t = store.listTickets(parseFilters({ session: sid })).tickets;
      assert.equal(t.length, 1);
      assert.equal(t[0].origin, 'cloud');
      assert.equal(t[0].machine, 'claude.ai/code');
    }
  });
});

test('cloud copy guard for /board and /ticket, and the once-only stale-copy notice', () => {
  assert.match(cloudCopyGuard('board', {}), /use \/alvearium:board/);
  assert.match(cloudCopyGuard('ticket', { CLAUDE_CODE_REMOTE: 'true', SESSION_BOARD_DIR: tmp() }), /SESSION_BOARD_URL/);
  assert.equal(cloudCopyGuard('board', { CLAUDE_CODE_REMOTE: 'true', SESSION_BOARD_URL: 'https://b', SESSION_BOARD_TOKEN: 'proxy', SESSION_BOARD_DIR: tmp() }), '');
  const repo = gitRepo();
  install(repo);
  const out = spawnSync(process.execPath, [join(repo, '.claude/session-board/scripts/board.mjs'), '--cloud-only'], { encoding: 'utf8', env: { ...process.env, ...CLEAN } });
  assert.match(out.stdout, /on this machine use \/alvearium:board/);

  const env = { SESSION_BOARD_DIR: tmp() };
  assert.equal(staleCopyNotice('0.3.1', '0.3.1', env), '');
  assert.equal(staleCopyNotice('0.3.2', '0.3.1', env), '', 'a newer copy is fine');
  assert.equal(staleCopyNotice('0.3.1', undefined, env), '', 'an older server says nothing');
  assert.match(staleCopyNotice('0.3.1', '0.4.0', env), /0\.3\.1.*0\.4\.0.*install-cloud/);
  assert.equal(staleCopyNotice('0.3.1', '0.4.0', env), '', 'once');
  assert.match(staleCopyNotice('0.3.1', '0.5.0', env), /0\.5\.0/, 'again for the next server version');
});

test('a hook reads the server version from the event reply', async () => {
  const out = {};
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, state: 'working', server_version: '9.9.9' }), { status: 202 });
  const env = { SESSION_BOARD_DIR: tmp(), SESSION_BOARD_URL: 'https://b.example', SESSION_BOARD_TOKEN: 't' };
  assert.equal(await handleHook('SessionStart', { session_id: 'v', cwd: tmp(), source: 'startup' }, { env, fetchImpl, out }), 'sent');
  assert.equal(out.serverVersion, '9.9.9');
});

test('the vendored hook prints the stale-copy notice once at a cloud SessionStart', async () => {
  const repo = gitRepo();
  install(repo);
  // A copy older than the server: rewrite its VERSION constant.
  const corePath = join(repo, '.claude/session-board/lib/core.mjs');
  writeFileSync(corePath, readFileSync(corePath, 'utf8').replace(`VERSION = '${VERSION}'`, "VERSION = '0.0.1'"));
  await withBoard(async ({ base }) => {
    const dir = tmp();
    const run = () =>
      new Promise((res) => {
        const child = spawn(process.execPath, [join(repo, '.claude/session-board/hooks/report.mjs'), 'SessionStart', '--cloud-only'], {
          env: { ...process.env, ...CLEAN, CLAUDE_CODE_REMOTE: 'true', SESSION_BOARD_URL: base, SESSION_BOARD_TOKEN: TOKEN, SESSION_BOARD_DIR: dir },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('exit', () => res(out));
        child.stdin.end(JSON.stringify({ session_id: 'sb-stale', cwd: repo, source: 'startup' }));
      });
    const first = await run();
    assert.match(JSON.parse(first).systemMessage, new RegExp(`0\\.0\\.1.*${VERSION.replaceAll('.', '\\.')}`));
    assert.equal(await run(), '', 'not twice');
  });
});

test('session of a cloud MCP call: the hooks record wins over the env; locally the env wins', async () => {
  const { currentContext } = await import('../mcp/server.mjs');
  const { rememberSessionCwd } = await import('../lib/runtime.mjs');
  const dir = tmp();
  const cwd = tmp();
  rememberSessionCwd(dir, { cwd, sessionId: 'from-hooks', repo: null, branch: null });
  const base = { SESSION_BOARD_DIR: dir, CLAUDE_CODE_SESSION_ID: 'from-env' };
  const cloud = currentContext({ ...base, CLAUDE_CODE_REMOTE: 'true' }, cwd);
  assert.equal(cloud.session_id, 'from-hooks');
  assert.equal(cloud.origin, 'cloud');
  assert.equal(currentContext(base, cwd).session_id, 'from-env');
  assert.equal(currentContext({ CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_SESSION_ID: 'from-env', SESSION_BOARD_DIR: tmp() }, cwd).session_id, 'from-env', 'env as the fallback');
});

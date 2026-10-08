import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleHook } from '../lib/runtime.mjs';
import { parse, splitArgs, run } from '../scripts/ticket.mjs';
import { openBackend } from '../lib/runtime.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER = join(ROOT, 'mcp', 'server.mjs');

/** Talk to the MCP server over stdio, the way Claude Code does: one JSON-RPC message per line. */
function client(env, cwd = ROOT) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, SESSION_BOARD_URL: '', SESSION_BOARD_TOKEN: '', SESSION_BOARD_ACTOR: '', SESSION_BOARD_ACTOR_NAME: '', SESSION_BOARD_THREAD: '', SESSION_BOARD_SESSION_TICKETS: '', SESSION_BOARD_STOP_STATUS: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
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
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
      return stderr;
    },
  };
}

test('mcp over stdio: initialize, tools/list, ticket_create attached to the current session, ticket_list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-mcp-'));
  // The hooks have seen a session in this directory: the MCP server attaches tickets to it.
  await handleHook('UserPromptSubmit', { session_id: 'mcp-sess', cwd: ROOT, prompt: 'set up CI' }, { env: { SESSION_BOARD_DIR: dir } });

  const c = client({ SESSION_BOARD_DIR: dir });
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'alvearium');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    c.notify('notifications/initialized');

    const list = await c.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['ticket_create', 'ticket_update', 'ticket_next', 'board_feedback', 'ticket_list', 'ticket_comment', 'ticket_get']);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

    const created = await c.request('tools/call', { name: 'ticket_create', arguments: { title: 'Add the NPM_TOKEN secret to the repo', body: 'Settings → Secrets → Actions', labels: ['ci'] } });
    assert.equal(created.result.isError, undefined);
    const key = created.result.content[0].text.match(/SB-\d+/)[0];

    const listed = await c.request('tools/call', { name: 'ticket_list', arguments: {} });
    const text = listed.result.content[0].text;
    assert.match(text, new RegExp(`${key} \\[todo, on user\\] Add the NPM_TOKEN secret`));
    assert.match(text, /SB-1 \[in_progress\] set up CI/, 'the session ticket from the hooks');

    const upd = await c.request('tools/call', { name: 'ticket_update', arguments: { key, status: 'done', comment: 'user confirmed' } });
    assert.match(upd.result.content[0].text, /\[done/);
    const shown = await c.request('tools/call', { name: 'ticket_get', arguments: { key } });
    assert.match(shown.result.content[0].text, /claude: comment: user confirmed/);

    const bad = await c.request('tools/call', { name: 'ticket_update', arguments: { key: 'SB-999', status: 'done' } });
    assert.equal(bad.result.isError, true);
    const unknown = await c.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const missing = await c.request('resources/list', {});
    assert.equal(missing.error.code, -32601);
    assert.deepEqual((await c.request('ping')).result, {});

  } finally {
    const stderr = await c.close();
    assert.doesNotMatch(stderr, /ExperimentalWarning/, 'stdio stays clean');
  }

  // Claude Code exports CLAUDE_CODE_SESSION_ID to its children: it wins over the cwd lookup.
  const c2 = client({ SESSION_BOARD_DIR: dir, CLAUDE_CODE_SESSION_ID: 'from-env' });
  try {
    await c2.request('initialize', {});
    const r = await c2.request('tools/call', { name: 'ticket_create', arguments: { title: 'Env session' } });
    assert.equal(r.result.isError, undefined);
    const l = await c2.request('tools/call', { name: 'ticket_list', arguments: {} });
    assert.match(l.result.content[0].text, /^1 ticket \(session, open\):\nSB-\d+ \[todo, on user\] Env session/);
  } finally {
    await c2.close();
  }
});

test('/ticket CLI: argument parsing and commands', async () => {
  assert.deepEqual(splitArgs(['new "Fix the build" --label ci,urgent']), ['new', 'Fix the build', '--label', 'ci,urgent']);
  assert.deepEqual(parse(['list', '--all', 'billing']), { cmd: 'list', rest: ['billing'], flags: { all: true } });
  const dir = mkdtempSync(join(tmpdir(), 'sb-cli-'));
  const backend = await openBackend({ env: { SESSION_BOARD_DIR: dir }, actor: 'user' });
  const context = { session_id: null, repo: 'acme/cli', branch: 'main', cwd: '/w', machine: 'mac', origin: 'terminal' };
  const out = await run(splitArgs(['new "Renew the TLS cert" --label ops --priority high']), { backend, context });
  assert.match(out, /Created SB-1 P1 \[todo, on user\] Renew the TLS cert · acme\/cli@main · #ops/);
  assert.match(await run(['list'], { backend, context }), /1 ticket \(repo, open\)/);
  assert.match(await run(['done', 'SB-1', 'renewed'], { backend, context }), /\[done/);
  assert.match(await run(['list'], { backend, context }), /No open tickets/);
  assert.match(await run(['status', 'SB-1', 'bogus'], { backend, context }), /usage/);
  assert.match(await run(['frobnicate'], { backend, context }), /usage/);
  const detail = await run(['show', 'SB-1'], { backend, context });
  assert.match(detail, /user: comment: renewed/);
  backend.close();
});

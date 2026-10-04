import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeaders, handleHook, identify, lastAssistantText, loadBoard, loadConfig, readLocalRecords } from '../lib/runtime.mjs';
import { THROTTLE_MS } from '../lib/core.mjs';
import { mergeRepoHooks, MARKER } from '../scripts/install-repo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'sb-test-'));

test('local mode: zero config, a session goes working → review on disk', async () => {
  const env = { SESSION_BOARD_DIR: tmp() };
  const base = { session_id: 'abc', cwd: ROOT };
  assert.equal(await handleHook('UserPromptSubmit', { ...base, prompt: 'write the tests' }, { env, now: 1000 }), 'local');
  assert.equal(await handleHook('Stop', { ...base, last_assistant_message: 'Tests written.' }, { env, now: 2000 }), 'local');
  const [rec] = readLocalRecords(env.SESSION_BOARD_DIR);
  assert.equal(rec.state, 'review');
  assert.equal(rec.title, 'write the tests');
  assert.equal(rec.detail, 'Tests written.');
  assert.equal(rec.surface, 'terminal');
  const { source, board } = await loadBoard({ env });
  assert.equal(source, 'local');
  assert.equal(board.counts.waiting, 1);
  const [t] = board.columns.waiting;
  assert.deepEqual([t.status, t.kind, t.title, t.body], ['review', 'session', 'write the tests', 'Tests written.']);
  const summary = JSON.parse(readFileSync(join(env.SESSION_BOARD_DIR, 'summary.json'), 'utf8'));
  assert.equal(summary.counts.waiting, 1, 'summary for the mod and the statusline');
  assert.match(summary.text, /WAITING ON YOU \(1\)/);
});

test('local mode: v0.1 session files are imported into SQLite once, and left on disk', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'sessions'));
  const old = { sessionId: 'old1', state: 'review', detail: 'Merged.', title: 'ship v1', repo: 'acme/api', lastSeen: Date.now() - 1000, pr: 'https://github.com/acme/api/pull/3' };
  writeFileSync(join(dir, 'sessions', 'old1.json'), JSON.stringify({ record: old }));
  const { board } = await loadBoard({ env: { SESSION_BOARD_DIR: dir } });
  assert.equal(board.counts.waiting, 1);
  assert.equal(board.columns.waiting[0].title, 'ship v1');
  assert.equal(board.columns.waiting[0].links.find((l) => l.type === 'pr').url, old.pr);
  assert.ok(readdirSync(join(dir, 'sessions')).includes('old1.json'));
  const again = await loadBoard({ env: { SESSION_BOARD_DIR: dir } });
  assert.equal(again.board.counts.waiting, 1, 'not imported twice');
});

test('task mirror: TaskCreated / TaskCompleted become claude tickets; SESSION_BOARD_MIRROR_TASKS=0 turns it off', async () => {
  const env = { SESSION_BOARD_DIR: tmp() };
  const base = { session_id: 'tm', cwd: ROOT };
  await handleHook('UserPromptSubmit', { ...base, prompt: 'refactor' }, { env, now: Date.now() });
  await handleHook('TaskCreated', { ...base, task_id: '7', task_title: 'Extract module' }, { env, now: Date.now() + 1 });
  let { board } = await loadBoard({ env });
  assert.equal(board.columns.todo[0].title, 'Extract module');
  assert.equal(board.columns.todo[0].source, 'claude');
  await handleHook('TaskCompleted', { ...base, task_id: '7', task_title: 'Extract module' }, { env, now: Date.now() + 2 });
  ({ board } = await loadBoard({ env }));
  assert.equal(board.counts.todo, 0);
  assert.equal(board.counts.inProgress, 1, 'the session itself is still in progress');
  const off = { ...env, SESSION_BOARD_MIRROR_TASKS: '0' };
  assert.equal(await handleHook('TaskCreated', { ...base, task_id: '8', task_title: 'Nope' }, { env: off }), 'ignored');
});

test('throttle on disk: PreToolUse heartbeats are rate-limited per session', async () => {
  const env = { SESSION_BOARD_DIR: tmp() };
  const ev = { session_id: 's', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'ls' } };
  assert.equal(await handleHook('PreToolUse', ev, { env, now: 0 }), 'local');
  assert.equal(await handleHook('PreToolUse', ev, { env, now: 1000 }), 'throttled');
  assert.equal(await handleHook('PermissionRequest', ev, { env, now: 2000 }), 'local', 'a state change is never throttled');
  assert.equal(await handleHook('PostToolUse', ev, { env, now: 3000 }), 'local', 'back to working after approval');
  assert.equal(await handleHook('PostToolUse', ev, { env, now: 3000 + THROTTLE_MS }), 'local');
});

test('remote mode: posts with bearer; failures back off and never throw', async () => {
  const env = { SESSION_BOARD_DIR: tmp(), SESSION_BOARD_URL: 'https://board.test/', SESSION_BOARD_TOKEN: 't0k' };
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    // 0.3.4: a reply must be the board's JSON; a bare 2xx (a login page, a proxy page) is a failure
    return new Response(JSON.stringify({ ok: true, state: 'working' }), { status: 202 });
  };
  const base = { session_id: 'r1', cwd: ROOT };
  assert.equal(await handleHook('UserPromptSubmit', { ...base, prompt: 'hi' }, { env, now: 0, fetchImpl: ok }), 'sent');
  assert.equal(calls[0].url, 'https://board.test/api/event');
  assert.equal(calls[0].init.headers.authorization, 'Bearer t0k');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.transition.state, 'working');
  assert.equal(body.session.sessionId, 'r1');

  const boom = async () => {
    throw new Error('network down');
  };
  assert.equal(await handleHook('Stop', { ...base, last_assistant_message: 'x' }, { env, now: 10, fetchImpl: boom }), 'send-failed');
  assert.equal(await handleHook('StopFailure', { ...base, error: 'rate_limit' }, { env, now: 20, fetchImpl: ok }), 'backoff');
  assert.equal(await handleHook('StopFailure', { ...base, error: 'rate_limit' }, { env, now: 40_000, fetchImpl: ok }), 'sent');
});

test('config: plugin userConfig, config file, proxy token', () => {
  const dir = tmp();
  assert.equal(loadConfig({ SESSION_BOARD_DIR: dir }).remote, false);
  const viaPlugin = loadConfig({ SESSION_BOARD_DIR: dir, CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://x.test', CLAUDE_PLUGIN_OPTION_TOKEN: 'abc' });
  assert.deepEqual([viaPlugin.url, viaPlugin.token, viaPlugin.remote], ['https://x.test', 'abc', true]);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ url: 'https://file.test', token: 'f' }));
  assert.equal(loadConfig({ SESSION_BOARD_DIR: dir }).url, 'https://file.test');
  assert.equal(loadConfig({ SESSION_BOARD_DIR: dir, SESSION_BOARD_URL: 'https://env.test' }).url, 'https://env.test');
  assert.deepEqual(authHeaders({ token: 'proxy' }), {}, 'proxy: the claude.ai agent proxy adds the credential');
  assert.deepEqual(authHeaders({ token: 'abc' }), { authorization: 'Bearer abc' });
});

test('identity: cloud marker and documented session link', () => {
  const { identity } = identify({ session_id: 'x', cwd: ROOT }, null, { CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01ABC' });
  assert.equal(identity.surface, 'cloud');
  assert.equal(identity.url, 'https://claude.ai/code/session_01ABC');
  const local = identify({ session_id: 'x', cwd: ROOT, session_title: 'Fix auth' }, null, {});
  assert.equal(local.identity.surface, 'terminal');
  assert.equal(local.identity.url, undefined);
  assert.equal(local.identity.name, 'Fix auth');
});

test('Stop without last_assistant_message falls back to the transcript tail', () => {
  const dir = tmp();
  const p = join(dir, 't.jsonl');
  writeFileSync(
    p,
    [
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PR: https://github.com/a/b/pull/7' }] } }),
    ].join('\n'),
  );
  assert.equal(lastAssistantText(p), 'PR: https://github.com/a/b/pull/7');
  assert.equal(lastAssistantText(join(dir, 'missing.jsonl')), '');
});

test('hook script: always exits 0, even on garbage stdin, and --cloud-only stays silent locally', () => {
  const dir = tmp();
  const script = join(ROOT, 'hooks', 'report.mjs');
  const env = { ...process.env, SESSION_BOARD_DIR: dir, SESSION_BOARD_URL: '', SESSION_BOARD_TOKEN: '', CLAUDE_CODE_REMOTE: '' };
  const bad = spawnSync(process.execPath, [script, 'Stop'], { input: 'not json', env });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.length, 0, 'prints nothing (stdout of some hooks becomes model context)');
  const quiet = spawnSync(process.execPath, [script, 'UserPromptSubmit', '--cloud-only'], { input: JSON.stringify({ session_id: 'q', prompt: 'x' }), env });
  assert.equal(quiet.status, 0);
  let files = [];
  try {
    files = readdirSync(join(dir, 'sessions'));
  } catch {}
  assert.equal(files.length, 0);
  const ok = spawnSync(process.execPath, [script, 'UserPromptSubmit'], { input: JSON.stringify({ session_id: 'q', prompt: 'x', cwd: ROOT }), env });
  assert.equal(ok.status, 0);
  assert.equal(readdirSync(join(dir, 'sessions')).length, 1);
});

test('install-repo: merges idempotently next to existing hooks, and uninstalls cleanly', () => {
  const existing = { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  const once = mergeRepoHooks(existing);
  const twice = mergeRepoHooks(once);
  assert.deepEqual(twice, once, 'idempotent');
  assert.equal(once.hooks.Stop.length, 2, 'keeps the user hook');
  assert.ok(once.hooks.PreToolUse[0].hooks[0].command.includes(MARKER));
  assert.ok(once.hooks.PreToolUse[0].hooks[0].command.endsWith('--cloud-only'));
  assert.equal(once.hooks.PreToolUse[0].hooks[0].async, true);
  const removed = mergeRepoHooks(once, { remove: true });
  assert.deepEqual(removed, existing);

  const repo = tmp();
  mkdirSync(join(repo, '.claude'));
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'install-repo.mjs'), repo]);
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.Stop);
  const copied = spawnSync(process.execPath, [join(repo, MARKER), 'Stop'], { input: '{}', env: { ...process.env, SESSION_BOARD_DIR: tmp() } });
  assert.equal(copied.status, 0, 'the vendored copy runs on its own');
});

// Regression (0.2.1): stdio MCP servers do NOT receive CLAUDE_PLUGIN_OPTION_* (only hooks do), so the
// manifest must forward the options through `env`, or Claude's tickets silently land in local mode.
test('manifest forwards plugin options to the MCP server, and they select remote mode', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const env = manifest.mcpServers.tickets.env;
  assert.equal(env.CLAUDE_PLUGIN_OPTION_SERVER_URL, '${user_config.server_url}');
  assert.equal(env.CLAUDE_PLUGIN_OPTION_TOKEN, '${user_config.token}');
  const cfg = loadConfig({ SESSION_BOARD_DIR: tmp(), CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://b.example/', CLAUDE_PLUGIN_OPTION_TOKEN: 't' });
  assert.equal(cfg.remote, true);
  assert.equal(cfg.url, 'https://b.example');
});

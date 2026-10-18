// 0.7.0: OpenAI Codex CLI. The same hook script and MCP server, started by Codex (scripts/codex-setup.mjs
// writes the config), with `--codex`: Codex's hook payloads, the `codex` actor, the files the setup writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyAgentFlag, handleHook, openBackend, rememberSessionCwd } from '../lib/runtime.mjs';
import { CODEX_EVENTS, MCP_ENV_VARS, TOML_BEGIN, TOML_END, codexSkill, hookCommand, mcpBlock, mergeCodexConfig, mergeCodexHooks, setup } from '../scripts/codex-setup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CLEAN = {
  SESSION_BOARD_URL: '',
  SESSION_BOARD_TOKEN: '',
  SESSION_BOARD_ACTOR: '',
  SESSION_BOARD_ACTOR_NAME: '',
  SESSION_BOARD_THREAD: '',
  SESSION_BOARD_SESSION_TICKETS: '',
  SESSION_BOARD_STOP_STATUS: '',
  SESSION_BOARD_PERMISSION_TICKETS: '',
  SESSION_BOARD: '',
  CLAUDE_CODE_SESSION_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_REMOTE: '',
};

/** A throwaway git repository with an origin, like the one Codex runs in. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'sb-codex-repo-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/codex-demo.git');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', 'feat/quickstart');
  return dir;
}

test('--codex: the session is the codex agent\'s, unless SESSION_BOARD_ACTOR already says who; Claude session variables are dropped', () => {
  assert.deepEqual(applyAgentFlag(['node', 'x'], { A: '1' }), { A: '1' }, 'no flag, nothing changes');
  const env = applyAgentFlag(['node', 'report.mjs', 'Stop', '--codex'], { CLAUDE_CODE_SESSION_ID: 'claude-sess', CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP: 'y' });
  assert.equal(env.SESSION_BOARD_ACTOR, 'codex');
  assert.equal(env.SESSION_BOARD_ACTOR_NAME, 'Codex');
  assert.equal(env.KEEP, 'y');
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_ENTRYPOINT']) assert.equal(k in env, false, k);
  const own = applyAgentFlag(['--codex'], { SESSION_BOARD_ACTOR: 'ci-bot' });
  assert.equal(own.SESSION_BOARD_ACTOR, 'ci-bot');
  assert.equal(own.SESSION_BOARD_ACTOR_NAME, undefined, 'its own name is not replaced by "Codex"');
});

test('codex hooks.json: every Codex event we handle, ours replaced on a rerun, other hooks kept', () => {
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit' }] };
  const merged = mergeCodexHooks({ hooks: { PreToolUse: [foreign] } }, { root: '/opt/alvearium' });
  assert.deepEqual(Object.keys(merged.hooks).sort(), Object.keys(CODEX_EVENTS).sort());
  for (const [ev, isAsync] of Object.entries(CODEX_EVENTS)) {
    const ours = merged.hooks[ev].at(-1).hooks[0];
    assert.equal(ours.type, 'command');
    assert.equal(ours.command, `node "${join('/opt/alvearium', 'hooks', 'report.mjs')}" ${ev} --codex`);
    assert.equal(ours.command, hookCommand(ev, '/opt/alvearium'));
    assert.equal(ours.async === true, isAsync, `${ev} async`);
    assert.equal(ours.timeout, ev === 'SessionEnd' ? 3 : 5, `${ev} timeout (Codex caps SessionEnd at 3 s)`);
  }
  assert.deepEqual(merged.hooks.PreToolUse[0], foreign, 'a hook of someone else stays first, untouched');
  for (const ev of ['Notification', 'StopFailure', 'TaskCreated', 'Elicitation']) assert.equal(ev in merged.hooks, false, `${ev}: no such Codex event`);

  const again = mergeCodexHooks(merged, { root: '/srv/alvearium' });
  assert.equal(again.hooks.Stop.length, 1, 'a rerun replaces, never duplicates');
  assert.match(again.hooks.Stop[0].hooks[0].command, /\/srv\/alvearium/);
  assert.equal(again.hooks.PreToolUse.length, 2);

  const removed = mergeCodexHooks(again, { remove: true });
  assert.deepEqual(removed.hooks, { PreToolUse: [foreign] });
});

test('codex hooks.json: a hook written on Windows (backslashes) is recognised as ours', () => {
  const win = { hooks: [{ type: 'command', command: `node ${JSON.stringify('C:\\Users\\me\\alvearium\\hooks\\report.mjs')} Stop --codex` }] };
  const merged = mergeCodexHooks({ hooks: { Stop: [win] } }, { root: '/opt/alvearium' });
  assert.equal(merged.hooks.Stop.length, 1, 'the Windows hook is replaced, not kept beside the new one');
  assert.deepEqual(mergeCodexHooks({ hooks: { Stop: [win] } }, { remove: true }).hooks, undefined);
});

test('codex config.toml: the MCP block is added once, replaced on a rerun, removed cleanly; a table we did not write is left alone', () => {
  const orig = 'model = "gpt-5"\n\n[projects."/w"]\ntrust_level = "trusted"\n';
  const one = mergeCodexConfig(orig, { root: '/opt/alvearium' });
  assert.equal(one.conflict, false);
  assert.ok(one.text.startsWith(orig), 'the existing settings stay first, as they were');
  assert.equal(one.text.split(TOML_BEGIN).length, 2);
  assert.match(one.text, /\[mcp_servers\.alvearium\]\ncommand = "node"\nargs = \["\/opt\/alvearium\/mcp\/server\.mjs", "--codex"\]/);
  assert.match(one.text, /default_tools_approval_mode = "approve"/);
  assert.match(one.text, new RegExp(`env_vars = \\[${MCP_ENV_VARS.map((v) => `"${v}"`).join(', ')}\\]`));
  const two = mergeCodexConfig(one.text, { root: '/srv/alvearium' });
  assert.equal(two.text.split(TOML_BEGIN).length, 2, 'never two blocks');
  assert.match(two.text, /\/srv\/alvearium\/mcp\/server\.mjs/);
  assert.doesNotMatch(two.text, /\/opt\/alvearium/);
  assert.equal(mergeCodexConfig(two.text, { remove: true }).text, orig, 'uninstall gives the file back as it was');
  assert.equal(mergeCodexConfig('', {}).text, mcpBlock() + '\n', 'an empty or missing file');

  const hand = orig + '\n[mcp_servers.alvearium]\ncommand = "npx"\n';
  assert.deepEqual(mergeCodexConfig(hand, {}), { text: hand, conflict: true });
  assert.equal(mergeCodexConfig('[mcp_servers."alvearium"]\n', {}).conflict, true);
  // A Windows checkout: the path is a valid TOML basic string.
  assert.match(mcpBlock('C:\\Users\\me\\alvearium'), /args = \["C:\\\\Users\\\\me\\\\alvearium[\\/]+mcp[\\/]+server\.mjs", "--codex"\]/);
  assert.ok(mcpBlock().endsWith(TOML_END));
});

test('codex-setup: writes config.toml, hooks.json and the skill, --print writes nothing, --uninstall takes it all back', () => {
  const home = mkdtempSync(join(tmpdir(), 'sb-codex-home-'));
  const data = mkdtempSync(join(tmpdir(), 'sb-codex-data-'));
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n');
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));

  const printed = setup({ home, print: true, url: 'https://board.example.com/', token: 'secret-token-123456789012345', env: { SESSION_BOARD_DIR: data } });
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'model = "gpt-5"\n', '--print changes nothing');
  assert.equal(existsSync(join(data, 'config.json')), false);
  assert.doesNotMatch(printed.join('\n'), /secret-token/, 'the token is never printed');

  const lines = setup({ home, url: 'https://board.example.com/', token: 'secret-token-123456789012345', env: { SESSION_BOARD_DIR: data } });
  assert.match(lines.join('\n'), /\/hooks/, 'says how to trust the hooks');
  assert.match(readFileSync(join(home, 'config.toml'), 'utf8'), /\[mcp_servers\.alvearium\]/);
  const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'say done');
  const skill = readFileSync(join(home, 'skills', 'alvearium-tickets', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: alvearium-tickets\ndescription: Track action items/);
  assert.equal(skill, codexSkill(readFileSync(join(ROOT, 'skills', 'tickets', 'SKILL.md'), 'utf8')));
  const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { url: 'https://board.example.com', token: 'secret-token-123456789012345' });
  if (process.platform !== 'win32') assert.equal(statSync(join(data, 'config.json')).mode & 0o777, 0o600);

  setup({ home, remove: true });
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'model = "gpt-5"\n');
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks, { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
  assert.equal(existsSync(join(home, 'skills', 'alvearium-tickets')), false);

  writeFileSync(join(home, 'hooks.json'), '{ not json');
  assert.throws(() => setup({ home }), /not valid JSON/);
  assert.throws(() => setup({ home: mkdtempSync(join(tmpdir(), 'sb-codex-home-')), url: 'https://b.example.com' }), /go together/);
});

test('Codex hook payloads: a session ticket with its repo and branch, in progress, then review with the last reply, then done; written by codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-codex-'));
  const cwd = repo();
  // Codex's transcript is its own rollout format: nothing in it must be mistaken for a Claude transcript.
  const rollout = join(dir, 'rollout.jsonl');
  writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }) + '\n');
  const env = applyAgentFlag(['--codex'], { SESSION_BOARD_DIR: dir });
  const sid = '01a15021-c97a-7da0-895f-30781c84983c';
  const base = { session_id: sid, cwd, transcript_path: rollout, model: 'gpt-5-codex', permission_mode: 'default' };
  let now = 1_800_000_000_000;
  const step = (event, extra) => handleHook(event, { ...base, hook_event_name: event, ...extra }, { env, now: (now += 30_000) });
  assert.equal(await step('SessionStart', { source: 'startup' }), 'local');
  assert.equal(await step('UserPromptSubmit', { turn_id: 't1', prompt: 'Add a quickstart to the README' }), 'local');
  assert.equal(await step('PreToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'git status --short' } }), 'local');
  assert.equal(await step('PostToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'git status --short' }, tool_response: '' }), 'local');

  const backend = await openBackend({ env, actor: 'user' });
  try {
    const session = async () => (await backend.list({ session: sid })).tickets.find((t) => t.kind === 'session');
    let t = await session();
    assert.equal(t.status, 'in_progress');
    assert.equal(t.title, 'Add a quickstart to the README');
    assert.equal(t.repo, 'acme/codex-demo');
    assert.equal(t.branch, 'feat/quickstart');
    assert.equal(t.created_by, 'codex');

    // Codex subagents: session_id is the parent's, agent_id + agent_type like Claude Code's.
    assert.equal(await step('SubagentStart', { turn_id: 't1', agent_id: 'a1', agent_type: 'explorer', permission_mode: 'default' }), 'local');
    assert.equal(await step('SubagentStop', { turn_id: 't1', agent_id: 'a1', agent_type: 'explorer', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: 'Found the README.' }), 'local');
    const lines = (await backend.get(t.key)).events.filter((e) => e.target || /explorer/.test(e.actor || ''));
    assert.ok(lines.some((e) => e.actor === 'codex' && /explorer/.test(e.target || '')), 'Codex → explorer');
    assert.ok(lines.some((e) => /explorer/.test(e.actor) && e.target === 'codex'), 'explorer → Codex');

    assert.equal(await step('Stop', { turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Added the quickstart. PR: https://github.com/acme/codex-demo/pull/7' }), 'local');
    t = await backend.get((await session()).key);
    assert.equal(t.status, 'review');
    assert.ok(t.links.some((l) => l.url === 'https://github.com/acme/codex-demo/pull/7'), 'the PR link of the last reply');

    // Codex: Stop's last_assistant_message may be null; the rollout is not read as a Claude transcript.
    assert.equal(await step('UserPromptSubmit', { turn_id: 't2', prompt: 'thanks' }), 'local');
    assert.notEqual(await step('Stop', { turn_id: 't2', stop_hook_active: false, last_assistant_message: null }), undefined);
    assert.equal((await session()).status, 'review');

    assert.equal(await step('SessionEnd', { reason: 'other' }), 'local');
    assert.equal((await backend.get(t.key)).status, 'done');
  } finally {
    backend.close();
  }
});

test('hooks/report.mjs --codex: exits 0 and prints nothing on stdout (Codex wants JSON or nothing from Stop)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-codex-'));
  const cwd = repo();
  for (const [event, extra] of [
    ['SessionStart', { source: 'startup' }],
    ['Stop', { turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Done.' }],
    ['SessionEnd', { reason: 'other' }],
  ]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'hooks', 'report.mjs'), event, '--codex'], {
      input: JSON.stringify({ session_id: 'codex-sess-1', cwd, hook_event_name: event, transcript_path: null, model: 'gpt-5-codex', ...extra }),
      env: { ...process.env, ...CLEAN, SESSION_BOARD_DIR: dir },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `${event}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${event} prints nothing`);
  }
  const rec = JSON.parse(readFileSync(join(dir, 'sessions', 'codex-sess-1.json'), 'utf8')).record;
  assert.equal(rec.actor, 'codex');
  assert.equal(rec.actorName, 'Codex');
  assert.equal(rec.state, 'closed');
});

/** The MCP server over stdio, as Codex starts it (`--codex`, only the variables it forwards). */
function client(env, cwd) {
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), '--codex'], { env: { ...process.env, ...CLEAN, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
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
  let id = 0;
  return {
    request(method, params) {
      const mid = ++id;
      return new Promise((res, rej) => {
        waiting.set(mid, res);
        setTimeout(() => rej(new Error(`timeout on ${method}`)), 5000).unref();
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
    },
  };
}

/** What Codex (and OpenAI function calling) needs from a tool's input schema. */
function assertPortableSchema(schema, where) {
  assert.equal(typeof schema.type, 'string', `${where}: a type`);
  if (schema.type === 'object' && schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) assertPortableSchema(v, `${where}.${k}`);
    for (const r of schema.required || []) assert.ok(r in schema.properties, `${where}: required ${r} is a property`);
  }
  if (schema.type === 'array') {
    assert.ok(schema.items && typeof schema.items === 'object', `${where}: an array says what it holds`);
    assertPortableSchema(schema.items, `${where}[]`);
  }
  if (schema.enum) for (const e of schema.enum) assert.equal(typeof e, schema.type === 'number' ? 'number' : 'string', `${where}: enum values match the type`);
}

test('MCP server --codex: portable schemas and annotations, `me` is codex, tickets attach to the Codex session the hooks recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-codex-mcp-'));
  const cwd = repo();
  rememberSessionCwd(dir, { sessionId: 'codex-session-42', cwd, repo: 'acme/codex-demo', branch: 'feat/quickstart' });
  // A `codex` started from a Claude Code shell: the Claude session id must not win.
  const c = client({ SESSION_BOARD_DIR: dir, CLAUDE_CODE_SESSION_ID: 'a-claude-session' }, cwd);
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.156.1' } });
    assert.equal(init.result.serverInfo.name, 'alvearium');
    const { tools } = (await c.request('tools/list', {})).result;
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assertPortableSchema(t.inputSchema, t.name);
      assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} says whether it writes`);
      assert.equal(t.annotations.destructiveHint, false, `${t.name} deletes nothing`);
    }
    const reads = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(reads, ['ticket_get', 'ticket_list', 'ticket_next']);

    const created = await c.request('tools/call', { name: 'ticket_create', arguments: { title: 'Write the Codex quickstart', assignee: 'me', priority: 'P2' } });
    assert.equal(created.result.isError, undefined, created.result.content[0].text);
    assert.match(created.result.content[0].text, /Created ALV-1 P2 \[todo, codex\] Write the Codex quickstart · acme\/codex-demo@feat\/quickstart/);
    const listed = await c.request('tools/call', { name: 'ticket_list', arguments: { scope: 'session' } });
    assert.match(listed.result.content[0].text, /^1 ticket \(session, open\):\nALV-1/);
    const mine = await c.request('tools/call', { name: 'ticket_next', arguments: { assignee: 'me' } });
    assert.match(mine.result.content[0].text, /1\. ALV-1 P2/);
    await c.request('tools/call', { name: 'ticket_comment', arguments: { key: 'ALV-1', text: 'started' } });
  } finally {
    await c.close();
  }
  const backend = await openBackend({ env: { SESSION_BOARD_DIR: dir }, actor: 'user' });
  try {
    const t = await backend.get('ALV-1');
    assert.equal(t.session_id, 'codex-session-42');
    assert.equal(t.assignee, 'codex');
    assert.equal(t.created_by, 'codex');
    assert.equal(t.events.at(-1).actor, 'codex');
  } finally {
    backend.close();
  }
});

test('README and AGENTS.md: the Codex section exists and says what does not work', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const head = readme.slice(0, 600);
  assert.match(head, /Claude Code/);
  assert.match(head, /OpenAI Codex CLI/, 'both agents in the first lines');
  assert.doesNotMatch(readme.split('\n')[0], /formerly/i, 'the title is not rename trivia');
  assert.match(readme, /^## Use with OpenAI Codex CLI$/m);
  const section = readme.slice(readme.indexOf('## Use with OpenAI Codex CLI'));
  assert.match(section, /scripts\/codex-setup\.mjs/);
  assert.match(section, /\/hooks/);
  assert.match(section, /What does not work/i);
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  for (const tool of ['ticket_create', 'ticket_update', 'ticket_next', 'ticket_list', 'ticket_comment', 'ticket_get', 'ticket_hold', 'board_feedback']) assert.match(agents, new RegExp(tool), tool);
  assert.match(agents, /npm test/);
  assert.match(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
});

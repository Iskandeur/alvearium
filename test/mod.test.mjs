// The /board mod (hooks/mod.mjs) runs inside Claude Code, with Claude Code's own fetch. In a
// claude.ai/code cloud session that fetch does not carry the API credential the agent proxy adds
// (SESSION_BOARD_TOKEN=proxy): a board behind a login gateway answers with its login page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../hooks/mod.mjs';

function harness(env, reply) {
  const handlers = {};
  const calls = [];
  const registered = [];
  const timers = [];
  const on = (name, a, b) => {
    handlers[name] = typeof a === 'function' ? a : b;
  };
  const $ = {
    env: { get: async (k) => env[k] },
    fs: { read: async () => { throw new Error('ENOENT'); } },
    http: { fetch: async (url, init) => { calls.push({ url, init }); return reply(url); } },
    ui: { status: () => {} },
    clock: { every: (ms) => timers.push(ms) },
    command: { register: async (c) => registered.push(c.name) },
  };
  register(on, {});
  return {
    run: () => handlers['command.run']($, { command: 'board' }),
    start: () => handlers['session.start']($, {}, async () => 'next'),
    calls,
    registered,
    timers,
  };
}

const html = () => ({ ok: true, status: 200, text: '<!doctype html><title>Login</title>' });

test('mod /board: a login page instead of JSON says what happened, not "JSON Parse error"', async () => {
  const h = harness({ SESSION_BOARD_URL: 'https://board.example/sb', SESSION_BOARD_TOKEN: 'proxy' }, html);
  const { text } = await h.run();
  assert.doesNotMatch(text, /JSON|Unexpected token|Unrecognized token/);
  assert.match(text, /login page/);
  assert.match(text, /\/alvearium:board/);
  assert.equal(h.calls[0].init.headers.authorization, undefined);
});

test('mod /board: with a real token the same page names the token, not the proxy', async () => {
  const h = harness({ SESSION_BOARD_URL: 'https://board.example/sb', SESSION_BOARD_TOKEN: 'abc' }, html);
  const { text } = await h.run();
  assert.match(text, /login page/);
  assert.match(text, /token/);
  assert.doesNotMatch(text, /JSON/);
});

test('mod /board: a JSON board still renders', async () => {
  const board = { tickets: { counts: {}, waiting: [], inProgress: [], todo: [] }, columns: {} };
  const h = harness({ SESSION_BOARD_URL: 'https://board.example/sb', SESSION_BOARD_TOKEN: 'abc' }, () => ({ ok: true, status: 200, text: JSON.stringify(board) }));
  const { text } = await h.run();
  assert.doesNotMatch(text, /unavailable/);
});

test('mod: in a cloud session with the proxy credential, /board is left to the plugin command', async () => {
  const h = harness({ SESSION_BOARD_URL: 'https://board.example/sb', SESSION_BOARD_TOKEN: 'proxy' }, html);
  assert.equal(await h.start(), 'next');
  assert.deepEqual([h.registered, h.timers, h.calls.length], [[], [], 0]);
});

test('mod: with a token, /board and the status line stay in the mod', async () => {
  const h = harness({ SESSION_BOARD_URL: 'https://board.example/sb', SESSION_BOARD_TOKEN: 'abc' }, html);
  assert.equal(await h.start(), 'next');
  assert.deepEqual([h.registered, h.timers.length], [['board'], 1]);
});

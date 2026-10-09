// Secrets in tool calls never reach the board: the hook redacts them, and so does the server
// (a client older than 0.4.2 still sends the raw command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, redactSecrets, sanitizeEvent } from '../lib/core.mjs';
import { waitTitle } from '../lib/store.mjs';

// Fake values, shaped like the real ones.
const KEY = 'key_' + 'Ab'.repeat(14);
const GH = 'ghp_' + 'a'.repeat(36);
const SK = 'sk-' + 'proj-' + 'Z'.repeat(40);
const JWT = ['ey', 'J'].join('') + 'a'.repeat(20) + '.' + ['ey', 'J'].join('') + 'b'.repeat(20) + '.' + 'c'.repeat(43);

// Placeholders built at run time: no literal in this file looks like a live credential.
const FAKE = (tag) => 'fake' + tag + 'x'.repeat(16);
const AUTH = 'Bear' + 'er';

const leaks = (text, secret) => String(text).includes(secret);

test('redact: header values, Bearer, query strings, env assignments, URL passwords', () => {
  const cases = [
    [`curl -s -H "X-Api-Key: ${KEY}" http://localhost:3000/api/files/x.jpeg`, KEY],
    [`curl -H 'Authorization: ${AUTH} ${FAKE('b')}' https://h/api`, FAKE('b')],
    [`curl -H "authorization:token ${FAKE('h')}" https://h`, FAKE('h')],
    [`open "https://h/api/files/x.jpeg?x-api-key=${KEY}&a=1"`, KEY],
    [`curl https://h/cb?access_token=${FAKE('q')}&page=2`, FAKE('q')],
    [`GH_TOKEN=${GH} gh pr list`, GH],
    [`export SESSION_BOARD_TOKEN=${FAKE('e')}`, FAKE('e')],
    [`OPENAI_API_KEY="${SK}" node x.js`, SK],
    [`git clone https://user:${FAKE('u')}@example.com/r.git`, FAKE('u')],
    [`node cli.js --token ${FAKE('t')} --verbose`, FAKE('t')],
    [`node cli.js --password=${FAKE('p')}`, FAKE('p')],
    [`echo ${GH}`, GH],
    [`echo ${SK}`, SK],
    [`echo ${JWT}`, JWT],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    assert.ok(!leaks(out, secret), `leaked: ${out}`);
    assert.match(out, /\[redacted\]/, input);
  }
});

test('redact: an ordinary command is left as it is', () => {
  for (const s of [
    'npm test',
    'rm -rf build',
    'git -C /opt/x pull --ff-only',
    'curl -s http://localhost:3000/api/sessions',
    'grep -n "Authorization" lib/runtime.mjs',
    'echo $SESSION_BOARD_TOKEN',
    'node --test test/*.test.mjs',
    'docker ps --format "{{.Names}} {{.Ports}}"',
    'TOKEN_FILE=/data/agent-tokens node x.js',
  ]) {
    assert.equal(redactSecrets(s), s);
  }
  assert.equal(redactSecrets(undefined), '');
});

test('hook: the permission ticket and the heartbeat never carry the secret', () => {
  const input = { tool_name: 'Bash', tool_input: { command: `for id in a b; do curl -s -H "X-Api-Key: ${KEY}" "http://localhost:3000/api/files/lupi/$id"; done` } };
  const perm = classify('PermissionRequest', input);
  assert.ok(!leaks(perm.detail, KEY), perm.detail);
  assert.match(perm.detail, /^Permission: Bash: for id in a b; do curl -s -H "X-Api-Key: \[redacted\]"/);
  assert.ok(!leaks(classify('PreToolUse', input).detail, KEY));
  const prompt = classify('UserPromptSubmit', { prompt: `use this token: ${GH}` });
  assert.ok(!leaks(prompt.detail, GH) && !leaks(prompt.prompt, GH));
});

test('server: an event from an older client is redacted on the way in', () => {
  const ev = sanitizeEvent({
    session: { sessionId: 'old-client' },
    transition: { state: 'waiting', kind: 'permission', detail: `Permission: Bash: curl -H "X-Api-Key: ${KEY}" http://h`, prompt: `GH_TOKEN=${GH}` },
  });
  assert.ok(!leaks(ev.transition.detail, KEY), ev.transition.detail);
  assert.ok(!leaks(ev.transition.prompt, GH), ev.transition.prompt);
  assert.ok(!leaks(waitTitle('permission', `Permission: Bash: curl -H "X-Api-Key: ${KEY}" http://h`), KEY));
});

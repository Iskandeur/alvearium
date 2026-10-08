// Secrets in tool calls never reach the board: the hook redacts them, and so does the server
// (a client older than 0.4.2 still sends the raw command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, redactSecrets, sanitizeEvent } from '../lib/core.mjs';
import { waitTitle } from '../lib/store.mjs';

// Fake values, shaped like the real ones.
const KEY = 'key_' + 'Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9v';
const GH = 'ghp_' + 'a'.repeat(36);
const SK = 'sk-' + 'proj-' + 'Z'.repeat(40);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.' + 'c'.repeat(43);

const leaks = (text, secret) => String(text).includes(secret);

test('redact: header values, Bearer, query strings, env assignments, URL passwords', () => {
  const cases = [
    [`curl -s -H "X-Api-Key: ${KEY}" http://localhost:3000/api/files/x.jpeg`, KEY],
    [`curl -H 'Authorization: Bearer abcdef0123456789abcdef' https://h/api`, 'abcdef0123456789abcdef'],
    [`curl -H "authorization:token zz11yy22xx33ww44vv55" https://h`, 'zz11yy22xx33ww44vv55'],
    [`open "https://h/api/files/x.jpeg?x-api-key=${KEY}&a=1"`, KEY],
    [`curl https://h/cb?access_token=Q1w2E3r4T5y6U7i8&page=2`, 'Q1w2E3r4T5y6U7i8'],
    [`GH_TOKEN=${GH} gh pr list`, GH],
    [`export SESSION_BOARD_TOKEN=s3cr3t-v4lu3-0123456789`, 's3cr3t-v4lu3-0123456789'],
    [`OPENAI_API_KEY="${SK}" node x.js`, SK],
    [`git clone https://user:hunter2hunter2@example.com/r.git`, 'hunter2hunter2'],
    [`node cli.js --token tok_9f8e7d6c5b4a39281706 --verbose`, 'tok_9f8e7d6c5b4a39281706'],
    [`node cli.js --password=correcthorsebattery`, 'correcthorsebattery'],
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

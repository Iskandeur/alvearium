// Board complaints of 2026-10-20: a merge ticket cannot wait for its own merge, ticket_update can change labels
// without replacing them, ticket_comment refuses a bare "@/path", the ✓ closes a ticket in every open state,
// and the Codex setup says that a refused token wrote nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTicketPr } from '../lib/hold.mjs';
import { openStore } from '../lib/store.mjs';
import { openBackend } from '../lib/runtime.mjs';
import { callTool } from '../mcp/server.mjs';
import { parseArgs, resolveToken } from '../scripts/codex-setup.mjs';

test('mergeTicketPr reads the pull request a merge ticket carries', () => {
  assert.equal(mergeTicketPr('Merge Acme/Repo#12'), 'acme/repo#12');
  assert.equal(mergeTicketPr('Fusionner Acme/Repo#12 (squash)'), 'acme/repo#12');
  assert.equal(mergeTicketPr('Merge pull request acme/repo#3.'), 'acme/repo#3');
  assert.equal(mergeTicketPr('Merge PR acme/repo#12'), 'acme/repo#12');
  assert.equal(mergeTicketPr('Fusionner la PR acme/repo#12'), 'acme/repo#12');
  assert.equal(mergeTicketPr('Merge the branch'), null);
  assert.equal(mergeTicketPr('Deploy after acme/repo#12 merges'), null);
  assert.equal(mergeTicketPr('Merge the branch'), null);
});

test('hold: a merge ticket cannot wait for the merge it carries, another ticket can', async () => {
  const s = await openStore(':memory:');
  const merge = s.createTicket({ title: 'Merge acme/repo#12' }, { actor: 'builder' });
  assert.throws(() => s.hold(merge.key, { condition: { type: 'pr_merged', pr: 'acme/repo#12' } }, { actor: 'builder' }), /cannot wait for its own merge/);
  assert.equal(s.getTicket(merge.key).status, 'todo');
  s.hold(merge.key, { condition: { type: 'pr_merged', pr: 'acme/repo#13' } }, { actor: 'builder' });
  const after = s.createTicket({ title: 'Deploy once acme/repo#12 is in' }, { actor: 'builder' });
  assert.equal(s.hold(after.key, { condition: { type: 'pr_merged', pr: 'acme/repo#12' } }, { actor: 'builder' }).status, 'on_hold');
});

test('update: labels_add / labels_remove keep the other labels, labels= replaces and says what it dropped', async () => {
  const s = await openStore(':memory:');
  const t = s.createTicket({ title: 'x', labels: ['a', 'b'] }, { actor: 'user' });
  assert.deepEqual(s.updateTicket(t.key, { labels_add: ['c'] }, { actor: 'job' }).labels, ['a', 'b', 'c']);
  assert.deepEqual(s.updateTicket(t.key, { labels_remove: ['a'], labels_add: ['D'] }, { actor: 'job' }).labels, ['b', 'c', 'd']);
  assert.deepEqual(s.updateTicket(t.key, { labels: ['z'], labels_add: ['y'] }, { actor: 'job' }).labels, ['z', 'y']);

  const dir = mkdtempSync(join(tmpdir(), 'sb-labels-'));
  const backend = await openBackend({ env: { SESSION_BOARD_DIR: dir }, actor: 'user' });
  const context = { session_id: null, repo: 'acme/x', branch: 'main', cwd: '/w', machine: 'm', origin: 'terminal' };
  try {
    await callTool('ticket_create', { title: 'labelled', labels: ['keep', 'other'] }, { backend, context });
    const out = await callTool('ticket_update', { key: 'ALV-1', labels: ['new'] }, { backend, context });
    assert.match(out, /Warning: labels replaced the whole list; removed #keep #other/);
    assert.doesNotMatch(await callTool('ticket_update', { key: 'ALV-1', labels_add: ['more'] }, { backend, context }), /Warning/);
    assert.match(await callTool('ticket_update', { key: 'ALV-1', labels_remove: ['more'] }, { backend, context }), /#new/);
  } finally {
    backend.close();
  }
});

test('ticket_comment refuses a text that is only an @/path, and posts one that has more', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-at-'));
  const backend = await openBackend({ env: { SESSION_BOARD_DIR: dir }, actor: 'user' });
  const context = { session_id: null, repo: 'acme/x', branch: 'main', cwd: '/w', machine: 'm', origin: 'terminal' };
  try {
    await callTool('ticket_create', { title: 'comment target' }, { backend, context });
    await assert.rejects(callTool('ticket_comment', { key: 'ALV-1', text: '@/tmp/c.txt' }, { backend, context }), /does not read files/);
    await assert.rejects(callTool('ticket_comment', { key: 'ALV-1', text: ' @./c.txt ' }, { backend, context }), /does not read files/);
    assert.match(await callTool('ticket_comment', { key: 'ALV-1', text: 'see @/tmp/c.txt for the log' }, { backend, context }), /Commented on ALV-1/);
    assert.match(await callTool('ticket_comment', { key: 'ALV-1', text: '@lupi done' }, { backend, context }), /Commented on ALV-1/);
  } finally {
    backend.close();
  }
});

test('done: the ✓ (status done) closes a ticket in every open state, held, blocked or with open children', async () => {
  const s = await openStore(':memory:');
  for (const status of ['todo', 'in_progress', 'waiting_on_user', 'review', 'failed', 'on_hold']) {
    const t = s.createTicket({ title: status, status }, { actor: 'user' });
    assert.equal(s.updateTicket(t.key, { status: 'done' }, { actor: 'user' }).status, 'done', status);
  }
  const a = s.createTicket({ title: 'a' }, { actor: 'user' });
  const b = s.createTicket({ title: 'b', blocked_by: [a.key] }, { actor: 'user' });
  assert.equal(s.updateTicket(b.key, { status: 'done' }, { actor: 'user' }).status, 'done');
  const p = s.createTicket({ title: 'p' }, { actor: 'user' });
  s.createTicket({ title: 'kid', parent: p.key }, { actor: 'user' });
  assert.equal(s.updateTicket(p.key, { status: 'done' }, { actor: 'user' }).status, 'done');
});

test('codex-setup: a refused token says nothing was installed, and --token - needs --url', async () => {
  const never = async () => assert.fail('must not read');
  await assert.rejects(resolveToken(parseArgs(['--token', 'abc']), { env: {}, read: never }), /Nothing was installed or uninstalled/);
  await assert.rejects(resolveToken(parseArgs(['--uninstall', '--token', 'abc']), { env: {}, read: never }), /Nothing was installed or uninstalled/);
  await assert.rejects(resolveToken(parseArgs(['--token', '-']), { env: {}, read: never }), /goes with --url/);
  assert.equal((await resolveToken(parseArgs(['--uninstall', '--token', '-']), { env: {}, read: never })).token, '-');
});

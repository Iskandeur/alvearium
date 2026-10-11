import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../lib/core.mjs';
import { handleHook, loadBoard, loadConfig, permissionTicketsOn, readLocalRecords } from '../lib/runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'sb-perm-'));

test('permissionTicketsOn: 1 / 0 decide; auto (the default) is "no" only for claude -p', () => {
  for (const v of ['1', 'on', 'TRUE', ' yes ']) assert.equal(permissionTicketsOn(v, 'sdk-cli'), true, v);
  for (const v of ['0', 'off', 'False', 'no']) assert.equal(permissionTicketsOn(v, 'cli'), false, v);
  assert.equal(permissionTicketsOn(undefined, 'sdk-cli'), false, 'claude -p: nobody at the prompt');
  assert.equal(permissionTicketsOn('auto', 'sdk-cli'), false);
  assert.equal(permissionTicketsOn(undefined, 'cli'), true, 'interactive terminal');
  assert.equal(permissionTicketsOn(undefined, undefined), true, 'unknown entrypoint: keep the ticket');
  for (const e of ['sdk-ts', 'sdk-py', 'claude-vscode', 'remote']) assert.equal(permissionTicketsOn(undefined, e), true, e);
  assert.equal(permissionTicketsOn(false, 'cli'), false, 'a boolean from config.json');
});

test('loadConfig reads the setting from the environment, then config.json', () => {
  assert.equal(loadConfig({ SESSION_BOARD_DIR: tmp(), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).permissionTickets, false);
  assert.equal(loadConfig({ SESSION_BOARD_DIR: tmp(), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', SESSION_BOARD_PERMISSION_TICKETS: '1' }).permissionTickets, true);
  assert.equal(loadConfig({ SESSION_BOARD_DIR: tmp(), CLAUDE_CODE_ENTRYPOINT: 'cli' }).permissionTickets, true);
  assert.equal(loadConfig({ SESSION_BOARD_DIR: tmp() }).permissionTickets, true);
});

test('classify: with permissionTickets false a permission request says nothing; every other wait still does', () => {
  const off = { permissionTickets: false };
  assert.equal(classify('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }, off), null);
  assert.equal(classify('Notification', { notification_type: 'permission_prompt', message: 'Allow?' }, off), null);
  assert.equal(classify('Notification', { notification_type: 'idle_prompt', message: 'Your turn' }, off)?.kind, 'idle');
  assert.equal(classify('Notification', { notification_type: 'elicitation_dialog', message: 'Pick one' }, off)?.kind, 'question');
  assert.equal(classify('Elicitation', { message: 'Pick a region' }, off)?.kind, 'question');
  assert.equal(classify('PermissionRequest', { tool_name: 'Bash' }, {})?.kind, 'permission', 'default: unchanged');
  assert.equal(classify('PermissionRequest', { tool_name: 'Bash' }, { permissionTickets: true })?.kind, 'permission');
});

async function permissionAsked(extraEnv) {
  const env = { SESSION_BOARD_DIR: tmp(), ...extraEnv };
  const ev = { session_id: 'p1', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'kubectl rollout restart' } };
  assert.equal(await handleHook('UserPromptSubmit', { ...ev, prompt: 'deploy' }, { env, now: 1000 }), 'local');
  const status = await handleHook('PermissionRequest', ev, { env, now: 2000 });
  const { board } = await loadBoard({ env });
  return { status, state: readLocalRecords(env.SESSION_BOARD_DIR)[0].state, waiting: board.columns.waiting.filter((t) => t.kind === 'permission').length };
}

test('a claude -p session: the permission request opens no ticket and the session stays in progress', async () => {
  assert.deepEqual(await permissionAsked({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), { status: 'ignored', state: 'working', waiting: 0 });
  assert.deepEqual(await permissionAsked({ SESSION_BOARD_PERMISSION_TICKETS: '0' }), { status: 'ignored', state: 'working', waiting: 0 });
});

test('an interactive session, or one that says a human answers: the ticket is there', async () => {
  assert.deepEqual(await permissionAsked({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), { status: 'local', state: 'waiting', waiting: 1 });
  assert.deepEqual(await permissionAsked({}), { status: 'local', state: 'waiting', waiting: 1 });
  assert.deepEqual(await permissionAsked({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', SESSION_BOARD_PERMISSION_TICKETS: '1' }), { status: 'local', state: 'waiting', waiting: 1 });
});

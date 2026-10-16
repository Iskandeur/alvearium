// An old session-board plugin (before the rename to Alvearium) still active next to Alvearium: found
// in installed_plugins.json or under plugins/synced/, unless enabledPlugins sets it to false; said once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oldPluginInstalls, oldPluginNotice } from '../lib/runtime.mjs';

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fake ~/.claude (CLAUDE_CONFIG_DIR), a project directory and a data directory, all temporary. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'sb-old-plugin-'));
  roots.push(root);
  const config = join(root, 'claude');
  const project = join(root, 'project');
  mkdirSync(join(config, 'plugins'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: config, SESSION_BOARD_DIR: join(config, 'session-board') };
  const write = (path, value) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const installed = (ids) =>
    write(join(config, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: Object.fromEntries(ids.map((id) => [id, [{ scope: 'user', installPath: '/x', version: '0.2.0' }]])),
    });
  return { config, project, env, write, installed };
}

test('nothing installed, or only Alvearium: nothing found, nothing said', () => {
  const m = machine();
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), []);
  assert.equal(oldPluginNotice(m.env, { cwd: m.project }), '');
  // Alvearium's own data directory is still ~/.claude/session-board: it must not count.
  mkdirSync(join(m.config, 'session-board'), { recursive: true });
  m.installed(['alvearium@session-board', 'other@session-board', 'session-board-extra@x']);
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), []);
  assert.equal(oldPluginNotice(m.env, { cwd: m.project }), '');
});

test('an old marketplace install is found, said once, with its uninstall command', () => {
  const m = machine();
  m.installed(['alvearium@session-board', 'session-board@session-board']);
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), ['session-board@session-board']);
  const text = oldPluginNotice(m.env, { cwd: m.project });
  assert.match(text, /old session-board install \(session-board@session-board\) is still active/);
  assert.match(text, /claude plugin uninstall session-board@session-board/);
  assert.equal(oldPluginNotice(m.env, { cwd: m.project }), '', 'already said');
});

test('a copy synced from claude.ai is found, and points at claude.ai/code → Plugins', () => {
  const m = machine();
  m.write(join(m.config, 'plugins', 'synced', 'abc123', '.claude-plugin', 'plugin.json'), { name: 'session-board', version: '0.2.1' });
  m.write(join(m.config, 'plugins', 'synced', 'def456', '.claude-plugin', 'plugin.json'), { name: 'alvearium' });
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), ['session-board@synced']);
  assert.match(oldPluginNotice(m.env, { cwd: m.project }), /claude\.ai\/code → Plugins.*claude plugin disable session-board@synced/);
  // Synced plugins off for the whole machine: Claude Code moves them to the trash and no longer loads them.
  m.write(join(m.config, 'settings.json'), { syncClaudeAiPlugins: false });
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), []);
});

test('a copy disabled in enabledPlugins does not count; a project re-enabling it does', () => {
  const m = machine();
  m.installed(['session-board@session-board']);
  m.write(join(m.config, 'settings.json'), { enabledPlugins: { 'session-board@session-board': false } });
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), []);
  m.write(join(m.project, '.claude', 'settings.json'), { enabledPlugins: { 'session-board@session-board': true } });
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), ['session-board@session-board']);
  m.write(join(m.project, '.claude', 'settings.local.json'), { enabledPlugins: { 'session-board@session-board': false } });
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), []);
});

test('said again only when a new copy shows up; broken files never throw', () => {
  const m = machine();
  m.installed(['session-board@session-board']);
  assert.notEqual(oldPluginNotice(m.env, { cwd: m.project }), '');
  m.write(join(m.config, 'plugins', 'synced', 'session-board', 'skills', 'x.md'), {});
  const again = oldPluginNotice(m.env, { cwd: m.project });
  assert.match(again, /session-board@session-board, session-board@synced/);
  assert.equal(oldPluginNotice(m.env, { cwd: m.project }), '');

  const b = machine();
  writeFileSync(join(b.config, 'plugins', 'installed_plugins.json'), '{not json');
  writeFileSync(join(b.config, 'settings.json'), '[]');
  assert.deepEqual(oldPluginInstalls(b.env, { cwd: join(b.project, 'missing') }), []);
});

test('CLAUDE_CODE_PLUGIN_CACHE_DIR moves the plugins root', () => {
  const m = machine();
  const elsewhere = join(m.config, '..', 'plugins-elsewhere');
  m.write(join(elsewhere, 'installed_plugins.json'), { plugins: { 'session-board@session-board': [] } });
  assert.deepEqual(oldPluginInstalls(m.env, { cwd: m.project }), []);
  assert.deepEqual(oldPluginInstalls({ ...m.env, CLAUDE_CODE_PLUGIN_CACHE_DIR: elsewhere }, { cwd: m.project }), ['session-board@session-board']);
});

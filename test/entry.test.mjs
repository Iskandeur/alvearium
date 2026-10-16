import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../lib/core.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('isEntryPoint: same file, through a symlink, and not at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alv-entry-'));
  try {
    const link = join(dir, 'plugin');
    symlinkSync(ROOT, link);
    const url = pathToFileURL(join(ROOT, 'mcp', 'server.mjs')).href;
    assert.equal(isEntryPoint(url, join(ROOT, 'mcp', 'server.mjs')), true);
    assert.equal(isEntryPoint(url, join(link, 'mcp', 'server.mjs')), true);
    assert.equal(isEntryPoint(url, join(ROOT, 'scripts', 'ticket.mjs')), false);
    assert.equal(isEntryPoint(url, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The plugin is often loaded through a link to the current release (--plugin-dir or
// CLAUDE_CODE_PLUGIN_DIRS). The MCP server used to exit at once there: CONNECTION_CLOSED, no tools.
test('the MCP server answers initialize when started through a symlinked plugin dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alv-entry-'));
  try {
    const link = join(dir, 'plugin');
    symlinkSync(ROOT, link);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const r = spawnSync(process.execPath, [join(link, 'mcp', 'server.mjs')], {
      input: JSON.stringify(init) + '\n',
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: link, SESSION_BOARD_DIR: dir, HOME: dir },
    });
    const first = r.stdout.split('\n').find((l) => l.trim());
    assert.ok(first, `no answer (exit ${r.status}, stderr: ${r.stderr})`);
    assert.equal(JSON.parse(first).result?.serverInfo?.name, 'alvearium');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

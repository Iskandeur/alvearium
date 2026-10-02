#!/usr/bin/env node
// session-board statusline — self-contained on purpose (no imports from the plugin), so it can be
// copied to a stable path (~/.claude/session-board/statusline.mjs) that survives plugin updates.
// Prints e.g. "⏳ 2 for you · ⚙ 3 in progress · ☐ 5 to do". Remote results are cached 15 s; in local
// mode it reads the summary the hooks keep next to the database.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.SESSION_BOARD_DIR || join(homedir(), '.claude', 'session-board');
const CACHE_MS = 15 * 1000;

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Ticket counts from a v0.2 server; a v0.1 server only has session counts. */
const fromBoard = (b) =>
  b.tickets ? b.tickets.counts : { waiting: b.counts?.waiting ?? 0, inProgress: b.counts?.working ?? 0, todo: 0 };

async function remoteCounts(url, token, now) {
  const cachePath = join(DIR, 'statusline-cache.json');
  const cached = readJson(cachePath);
  if (cached && now - cached.at < CACHE_MS && cached.v === 2) return cached.counts;
  try {
    const headers = token === 'proxy' ? {} : { authorization: `Bearer ${token}` };
    const res = await fetch(`${url}/api/board`, { headers, signal: AbortSignal.timeout(1200) });
    if (!res.ok) throw new Error(String(res.status));
    const counts = fromBoard(await res.json());
    try {
      writeFileSync(cachePath, JSON.stringify({ v: 2, at: now, counts }));
    } catch {}
    return counts;
  } catch {
    return cached?.v === 2 ? cached.counts : null;
  }
}

const now = Date.now();
const cfg = readJson(join(DIR, 'config.json')) || {};
const url = (process.env.SESSION_BOARD_URL || cfg.url || '').replace(/\/+$/, '');
const token = process.env.SESSION_BOARD_TOKEN || cfg.token || '';
const counts = url && token ? await remoteCounts(url, token, now) : readJson(join(DIR, 'summary.json'))?.counts ?? {};
if (!counts) {
  process.stdout.write('board offline');
} else {
  const parts = [];
  if (counts.waiting) parts.push(`⏳ ${counts.waiting} for you`);
  if (counts.inProgress) parts.push(`⚙ ${counts.inProgress} in progress`);
  if (counts.todo) parts.push(`☐ ${counts.todo} to do`);
  process.stdout.write(parts.join(' · ') || 'board clear');
}

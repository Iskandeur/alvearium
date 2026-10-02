#!/usr/bin/env node
// session-board statusline — self-contained on purpose (no imports from the plugin), so it can be
// copied to a stable path (~/.claude/session-board/statusline.mjs) that survives plugin updates.
// Prints e.g. "⏳ 3 waiting · ⚙ 5 working · ✅ 2 review". Remote results are cached 15 s.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.SESSION_BOARD_DIR || join(homedir(), '.claude', 'session-board');
const STALE_MS = 30 * 60 * 1000;
const CACHE_MS = 15 * 1000;

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function localCounts(now) {
  const c = { waiting: 0, working: 0, review: 0 };
  let names = [];
  try {
    names = readdirSync(join(DIR, 'sessions')).filter((n) => n.endsWith('.json'));
  } catch {}
  for (const n of names) {
    const r = readJson(join(DIR, 'sessions', n))?.record;
    if (!r || now - r.lastSeen > 7 * 86400000) continue;
    if (r.state === 'waiting' || r.state === 'failed') c.waiting++;
    else if (r.state === 'working' && now - r.lastSeen <= STALE_MS) c.working++;
    else if (r.state === 'review' && !r.dismissed) c.review++;
  }
  return c;
}

async function remoteCounts(url, token, now) {
  const cachePath = join(DIR, 'statusline-cache.json');
  const cached = readJson(cachePath);
  if (cached && now - cached.at < CACHE_MS) return cached.counts;
  try {
    const res = await fetch(`${url}/api/board`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1200) });
    if (!res.ok) throw new Error(String(res.status));
    const counts = (await res.json()).counts;
    try {
      writeFileSync(cachePath, JSON.stringify({ at: now, counts }));
    } catch {}
    return counts;
  } catch {
    return cached?.counts ?? null;
  }
}

const now = Date.now();
const cfg = readJson(join(DIR, 'config.json')) || {};
const url = (process.env.SESSION_BOARD_URL || cfg.url || '').replace(/\/+$/, '');
const token = process.env.SESSION_BOARD_TOKEN || cfg.token || '';
const counts = url && token ? await remoteCounts(url, token, now) : localCounts(now);
if (!counts) {
  process.stdout.write('board offline');
} else {
  const parts = [];
  if (counts.waiting) parts.push(`⏳ ${counts.waiting} waiting`);
  if (counts.working) parts.push(`⚙ ${counts.working} working`);
  if (counts.review) parts.push(`✅ ${counts.review} review`);
  process.stdout.write(parts.join(' · ') || 'board clear');
}

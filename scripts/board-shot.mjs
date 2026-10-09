#!/usr/bin/env node
// Headless screenshots for the web UI (no deps).
// Creates a tiny in-memory board server, then captures desktop + mobile screenshots via CDP.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const TOKEN = 'x'.repeat(32);
const OUT_DIR = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, '..', '..', 'deliverables');

async function withServer(fn) {
  const store = await openStore(':memory:');
  const page = await (await import('node:fs')).promises.readFile(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store });
  } finally {
    server.close();
    store.close();
  }
}

async function post(base, path, body, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status}`);
  return await res.json();
}
async function patch(base, path, body, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: HTTP ${res.status}`);
  return await res.json();
}

async function seed(base) {
  const md = [
    '### Title shows as a heading',
    '',
    '**bold** and _italic_ and `inline code`.',
    '',
    '- bullet 1',
    '- bullet 2',
    '',
    '> quote line',
    '',
    '[Example](https://example.com)',
    '',
    '| colA | colB |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```',
    'const x = 1;',
    '<script>alert(1)</script>',
    '```',
  ].join('\n');

  const t = await post(base, '/api/tickets', { title: 'Markdown rendering test', body: md, assignee: 'lupi/ticketmaster' }, { 'x-session-board-actor': 'lupi/ticketmaster' });
  await post(base, `/api/tickets/${t.key}/comments`, { text: '### Comment heading\n\n[x](javascript:alert(1))\n\n**ok**' });
  await patch(base, `/api/actors/${encodeURIComponent('lupi/ticketmaster')}`, { name: 'Ticketmaster' });
  return t.key;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function withChrome(fn) {
  const name = 'alvearium-cdp';
  try {
    run('docker', ['rm', '-f', name]);
  } catch {}
  run('docker', [
    'run', '-d', '--rm', '--name', name, '--network', 'host',
    'zenika/alpine-chrome:latest',
    '--no-sandbox', '--disable-gpu', '--headless',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222',
    'about:blank',
  ]);
  try {
    await fn();
  } finally {
    try { run('docker', ['rm', '-f', name]); } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget(timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < until) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
      lastErr = new Error('no CDP page target');
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw lastErr || new Error('CDP timeout');
}

async function connectCdp() {
  const page = await cdpTarget();
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('WebSocket is not available in this Node build');
  const ws = new WS(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let n = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      pending.set(id, (m) => {
        if (m.error) reject(new Error(m.error?.message || 'CDP error'));
        else resolve(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

async function shot(url, outPath, { width, height, dark = true } = {}) {
  const { ws, send } = await connectCdp();
  try {
    await send('Network.enable');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });

    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1200));

    const m = await send('Page.getLayoutMetrics');
    const fullH = Math.ceil(m.result?.cssContentSize?.height ?? height);
    await send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(fullH, 6000), deviceScaleFactor: 1, mobile: width < 700 });
    await new Promise((r) => setTimeout(r, 300));

    const img = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPath, Buffer.from(img.result.data, 'base64'));
    process.stdout.write(`${outPath}\n`);
  } finally {
    ws.close();
  }
}

await withServer(async ({ base }) => {
  const key = await seed(base);
  const url = `${base}/?ticket=${encodeURIComponent(key)}#token=${encodeURIComponent(TOKEN)}`;
  await withChrome(async () => {
    await shot(url, join(OUT_DIR, 'alvearium-markdown-desktop.png'), { width: 1200, height: 850, dark: true });
    await shot(url, join(OUT_DIR, 'alvearium-markdown-mobile.png'), { width: 390, height: 844, dark: true });
  });
});

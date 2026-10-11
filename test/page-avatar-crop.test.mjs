// Avatar crop on the board page: the pan clamp and the source square are pure functions, run here on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

const from = page.indexOf('function cropClamp(st) {');
const to = page.indexOf('function clampAvatarCrop() {', from);
assert.ok(from > 0 && to > from, 'cropClamp() and cropSourceRect() are in the page');
const { cropClamp, cropSourceRect } = new Function(`${page.slice(from, to)}; return { cropClamp, cropSourceRect };`)();

// A 1000x500 landscape, 260 px circle: at zoom 1 the short side fills the circle.
const state = (o = {}) => ({ w: 1000, h: 500, crop: 260, base: 260 / 500, zoom: 1, dx: 0, dy: 0, ...o });

test('crop: centered, zoom 1 takes the centered square of the short side', () => {
  const r = cropSourceRect(state());
  assert.deepEqual(r, { x: 250, y: 0, side: 500 });
});

test('crop: zoom 2 halves the source side around the same center', () => {
  const r = cropSourceRect(state({ zoom: 2 }));
  assert.equal(r.side, 250);
  assert.equal(r.x + r.side / 2, 500);
  assert.equal(r.y + r.side / 2, 250);
});

test('crop: dragging the image right shows its left part', () => {
  const st = cropClamp(state({ dx: 10_000 }));
  assert.equal(st.dx, 130 * (1000 / 500) - 130); // (1000*0.52 - 260) / 2
  assert.equal(st.dy, 0);
  const r = cropSourceRect(st);
  assert.ok(Math.abs(r.x) < 1e-9, 'flush with the left edge');
});

test('crop: the clamp never lets the circle leave the image', () => {
  for (const zoom of [1, 1.7, 3, 6]) {
    for (const [dx, dy] of [[-9e9, -9e9], [9e9, 9e9], [9e9, -9e9], [37, -12]]) {
      const r = cropSourceRect(cropClamp(state({ zoom, dx, dy })));
      assert.ok(r.x >= -1e-9 && r.y >= -1e-9, `inside top-left at zoom ${zoom}`);
      assert.ok(r.x + r.side <= 1000 + 1e-9 && r.y + r.side <= 500 + 1e-9, `inside bottom-right at zoom ${zoom}`);
    }
  }
});

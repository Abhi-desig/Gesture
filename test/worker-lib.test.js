import test from 'node:test';
import assert from 'node:assert/strict';

import '../public/worker-lib.js';

const { IDLE_AFTER_MS, IDLE_EVERY_MS, shouldDetect, lumaStats, pickPoints } = globalThis.GestureWorkerLib;

test('every frame while a hand is in view, and for a second after', () => {
  assert.equal(shouldDetect({ now: 1000, lastHandAt: 990, lastRunAt: 990, full: false }), true);
  assert.equal(shouldDetect({ now: 1000 + IDLE_AFTER_MS - 1, lastHandAt: 1000, lastRunAt: 1990, full: false }), true);
});

test('with nobody there, only every IDLE_EVERY_MS', () => {
  const lastHandAt = -Infinity;
  assert.equal(shouldDetect({ now: 5000, lastHandAt, lastRunAt: 5000 - IDLE_EVERY_MS + 1, full: false }), false);
  assert.equal(shouldDetect({ now: 5000, lastHandAt, lastRunAt: 5000 - IDLE_EVERY_MS, full: false }), true);
  // At 30 fps that is about one frame in four.
  let runs = 0;
  let lastRunAt = -Infinity;
  for (let now = 0; now < 1000; now += 1000 / 30) {
    if (shouldDetect({ now, lastHandAt, lastRunAt, full: false })) {
      runs += 1;
      lastRunAt = now;
    }
  }
  assert.ok(runs >= 7 && runs <= 9, `${runs} runs in a second`);
});

test('full rate when asked, hand or no hand', () => {
  assert.equal(shouldDetect({ now: 5000, lastHandAt: -Infinity, lastRunAt: 4999, full: true }), true);
});

test('brightness of a flat and a striped thumbnail', () => {
  const flat = new Uint8ClampedArray(16 * 9 * 4).fill(100);
  assert.deepEqual(lumaStats(flat), { mean: 100, spread: 0 });
  assert.equal(lumaStats(new Uint8ClampedArray(0)), null);
});

test('only the face points the page reads, at their own indices', () => {
  const face = Array.from({ length: 478 }, (_, i) => ({ x: i, y: 0, z: 0 }));
  const picked = pickPoints(face, [10, 152]);
  assert.equal(picked.length, 478, 'same length, so index checks still hold');
  assert.deepEqual(picked[10], { x: 10, y: 0, z: 0 });
  assert.equal(picked[11], undefined);
  assert.equal(Object.keys(picked).length, 2);
  assert.equal(pickPoints(null, [10]), null);
});

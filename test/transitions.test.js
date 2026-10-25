import test from 'node:test';
import assert from 'node:assert/strict';

import { CoverDetector } from '../public/cover.js';
import '../public/worker-lib.js';

const { lumaStats } = globalThis.GestureWorkerLib;
import { GrabDetector } from '../public/transitions.js';

// ---------------------------------------------------------- close your hand

/** Feed [shape, ms] runs at 30 fps; returns the times a grab fired. */
function grab(runs, options) {
  const d = new GrabDetector(options);
  const fired = [];
  let t = 0;
  for (const [shape, ms] of runs) {
    for (const end = t + ms; t < end; t += 33) if (d.update(shape, t)) fired.push(t);
  }
  return fired;
}

test('an open hand closing into a fist plays, once', () => {
  assert.equal(grab([['open_palm', 300], [null, 100], ['fist', 500]]).length, 1);
});

test('a fist on its own does nothing, and neither does a thumbs-up', () => {
  // The v1 fist played music for a resting hand and for a thumbs-up, which the
  // camera reads as a fist.
  assert.equal(grab([[null, 300], ['fist', 1000]]).length, 0);
  assert.equal(grab([['pinch', 300], ['fist', 500]]).length, 0);
});

test('a slow close does nothing', () => {
  assert.equal(grab([['open_palm', 300], [null, 800], ['fist', 500]]).length, 0);
});

test('a flash of open hand is not enough', () => {
  assert.equal(grab([['open_palm', 60], ['fist', 500]]).length, 0);
});

test('holding the fist does not repeat; opening and closing again does', () => {
  assert.equal(grab([['open_palm', 300], ['fist', 3000]]).length, 1);
  assert.equal(grab([['open_palm', 300], ['fist', 300], ['open_palm', 300], ['fist', 300]]).length, 2);
});

// --------------------------------------------------------- cover the camera

/** Feed [luma, ms] runs at 30 fps; returns the times a cover fired. */
function cover(runs, options) {
  const d = new CoverDetector(options);
  const fired = [];
  let t = 0;
  for (const [luma, ms] of runs) {
    for (const end = t + ms; t < end; t += 33) if (d.update(luma, t)) fired.push(t);
  }
  return fired;
}

const ROOM = { mean: 120, spread: 45 };
const COVERED = { mean: 12, spread: 4 };

test('a hand over the lens for a second fires once', () => {
  const fired = cover([[ROOM, 2000], [COVERED, 1500]]);
  assert.equal(fired.length, 1);
  assert.ok(fired[0] >= 2990 && fired[0] <= 3060, `after a second covered, at ${fired[0]}`);
});

test('a short dip does not', () => {
  assert.equal(cover([[ROOM, 2000], [COVERED, 300], [ROOM, 1000]]).length, 0);
});

test('it has to be uncovered before it can fire again', () => {
  assert.equal(cover([[ROOM, 2000], [COVERED, 3000]]).length, 1);
  assert.equal(cover([[ROOM, 2000], [COVERED, 1200], [ROOM, 500], [COVERED, 1200]]).length, 2);
});

test('a dim room is not a covered lens', () => {
  // Dark but still full of edges: not flat.
  assert.equal(cover([[ROOM, 2000], [{ mean: 20, spread: 30 }, 2000]]).length, 0);
  // Already dark before anything happened: nothing to compare against.
  assert.equal(cover([[{ mean: 15, spread: 5 }, 4000]]).length, 0);
});

test('a slow dusk is followed, not mistaken for a cover', () => {
  const d = new CoverDetector();
  let fired = 0;
  for (let t = 0; t < 60000; t += 33) {
    const mean = 120 - (t / 60000) * 100; // 120 → 20 over a minute
    if (d.update({ mean, spread: Math.max(3, mean / 4) }, t)) fired += 1;
  }
  assert.equal(fired, 0);
});

test('luma stats of a flat and a striped thumbnail', () => {
  const flat = new Uint8ClampedArray(16 * 9 * 4).fill(100);
  assert.deepEqual(lumaStats(flat), { mean: 100, spread: 0 });
  const striped = new Uint8ClampedArray(16 * 9 * 4);
  for (let i = 0; i < striped.length; i += 4) striped.fill((i / 4) % 2 ? 200 : 0, i, i + 3);
  const s = lumaStats(striped);
  assert.ok(Math.abs(s.mean - 100) < 1e-9 && Math.abs(s.spread - 100) < 1e-9);
});

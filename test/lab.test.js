import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomCoverage, handBox } from '../public/lab/plate.js';
import { DUST_SETTINGS, VanishTimeline, dustSettings, windInTexture } from '../public/lab/vanish.js';

// ------------------------------------------------------------------ timeline

test('a snap starts the dissolve, then you are gone, and a snap brings you back', () => {
  const tl = new VanishTimeline();
  tl.configure({ dissolveMs: 2000 });
  assert.equal(tl.update(0).phase, 'idle');
  assert.equal(tl.trigger(100), 'dissolving');

  const mid = tl.update(1100);
  assert.equal(mid.phase, 'dissolving');
  assert.equal(mid.t, 0.5);

  const gone = tl.update(2200);
  assert.equal(gone.phase, 'gone');
  assert.equal(gone.entered, 'gone');
  assert.equal(gone.t, 1);

  assert.equal(tl.trigger(3000), 'returning');
  const back = tl.update(3600); // 600 of 1200 ms (0.6 × the dissolve)
  assert.equal(back.phase, 'returning');
  assert.equal(back.t, 0.5, 'the same animation, backwards');

  const done = tl.update(4300);
  assert.equal(done.phase, 'idle', 'straight back to live: the return already ends on the live picture');
  assert.equal(done.entered, 'idle');
});

test('a snap in the middle of an animation is ignored, not queued', () => {
  const tl = new VanishTimeline();
  tl.configure({ dissolveMs: 2000 });
  tl.trigger(0);
  assert.equal(tl.trigger(500), null);
  assert.equal(tl.update(600).phase, 'dissolving');
  tl.update(2100);
  tl.trigger(2200);
  assert.equal(tl.trigger(2300), null, 'not while returning either');
});

test('after 10 s gone you come back on your own, and the caller is told so', () => {
  const tl = new VanishTimeline();
  tl.configure({ dissolveMs: 1000 });
  tl.trigger(0);
  tl.update(1000);
  assert.equal(tl.update(10999).phase, 'gone');
  const r = tl.update(11000);
  assert.equal(r.phase, 'returning');
  assert.equal(r.entered, 'returning', 'so a fresh snapshot is frozen for it');
});

test('a long gap between frames passes through phases at their real times', () => {
  const tl = new VanishTimeline();
  tl.configure({ dissolveMs: 1000 });
  tl.trigger(0);
  // 1000 dissolve + 10000 gone + 600 returning.
  assert.equal(tl.update(11500).phase, 'returning');
  assert.equal(tl.update(11500).t, 1 - 500 / 600);
  assert.equal(tl.update(20000).phase, 'idle');
});

test('with reduce motion on, both animations are a short cross-fade', () => {
  const tl = new VanishTimeline();
  tl.configure({ dissolveMs: 4000, reduced: true });
  tl.trigger(0);
  assert.equal(tl.update(299).phase, 'dissolving');
  assert.equal(tl.update(300).phase, 'gone');
  tl.trigger(400);
  assert.equal(tl.update(699).phase, 'returning');
  assert.equal(tl.update(700).phase, 'idle');
});

test('reset puts it back to idle at once', () => {
  const tl = new VanishTimeline();
  tl.trigger(0);
  tl.reset();
  assert.equal(tl.update(10).phase, 'idle');
});

// ------------------------------------------------------------------ settings

test('dust settings are clamped to the sliders, and default to ash', () => {
  const d = dustSettings();
  assert.equal(d.ash, DUST_SETTINGS.ash.value);
  assert.ok(d.ash > 0.5, 'ash by default, like the film');
  const wild = dustSettings({ seconds: 99, speed: -3, size: 'big', direction: 120 });
  assert.equal(wild.seconds, 5);
  assert.equal(wild.speed, 0.2);
  assert.equal(wild.size, DUST_SETTINGS.size.value);
  assert.equal(wild.direction, 120);
  assert.deepEqual(dustSettings(null), d);
});

test('the drift direction means what you see on the mirrored picture', () => {
  // Right, as seen, is toward texture x = 0 (the picture is mirrored); up, as
  // seen, is toward texture row 0.
  const right = windInTexture(0);
  assert.ok(right.x < -0.99 && Math.abs(right.y) < 1e-9);
  const up = windInTexture(90);
  assert.ok(Math.abs(up.x) < 1e-9 && up.y < -0.99);
});

// ------------------------------------------------------------------ coverage

/** A mask with a person-shaped block in the middle third. */
function maskWithPerson(w = 64, h = 36) {
  const m = new Float32Array(w * h);
  for (let y = 6; y < h; y += 1) for (let x = Math.floor(w / 3); x < Math.floor((2 * w) / 3); x += 1) m[y * w + x] = 1;
  return m;
}

/** The same mask, `n` updates in a row: about a second at 30 a second. */
function feed(cov, mask, w, h, n = 30, opts) {
  for (let k = 0; k < n; k += 1) cov.update(mask, w, h, opts);
}

test('the room counts as seen where nobody is, and not right beside you', () => {
  const cov = new RoomCoverage();
  assert.equal(cov.fraction, 0);
  feed(cov, maskWithPerson(), 64, 36);
  const seen = cov.fraction;
  assert.ok(seen > 0.5 && seen < 0.7, `seen ${seen}`);
  // Widened by one cell each side, so less than everything outside the block.
  const outside = 1 - ((64 - 2 * 21) * 30) / (64 * 36);
  assert.ok(seen < outside);
});

test('a spot must stay clear for a run of updates before it counts', () => {
  // The renderer won't learn a spot until you've been gone from it for about a
  // second; the meter must not claim more than the picture has.
  const cov = new RoomCoverage();
  feed(cov, new Float32Array(64 * 36), 64, 36, 19);
  assert.equal(cov.fraction, 0);
  cov.update(new Float32Array(64 * 36), 64, 36);
  assert.equal(cov.fraction, 1);

  // You flicker back for one update: the run starts again.
  const flicker = new RoomCoverage();
  feed(flicker, new Float32Array(64 * 36), 64, 36, 15);
  flicker.update(maskWithPerson(), 64, 36);
  feed(flicker, new Float32Array(64 * 36), 64, 36, 10);
  const f = flicker.fraction;
  assert.ok(f > 0.5 && f < 0.7, `only the area you never touched is seen (${f})`);
});

test('a smaller mask maps onto the same grid', () => {
  const cov = new RoomCoverage();
  feed(cov, maskWithPerson(256, 144), 256, 144);
  assert.ok(cov.fraction > 0.5 && cov.fraction < 0.7);
});

test('seen stays seen when you move, and stepping out fills the rest', () => {
  const cov = new RoomCoverage();
  feed(cov, maskWithPerson(), 64, 36);
  const before = cov.fraction;
  feed(cov, new Float32Array(64 * 36), 64, 36);
  assert.equal(cov.fraction, 1);
  assert.ok(before < 1);
});

test('nothing counts you as room, and a hand box counts as a person', () => {
  // "Capture the room" once counted everything, so anyone who stayed in view
  // was learned into the room and left a smeared copy when they vanished.
  const cov = new RoomCoverage();
  feed(cov, maskWithPerson(), 64, 36, 30, { all: true });
  assert.ok(cov.fraction < 0.7, 'the person block stays unseen');
  cov.reset();
  assert.equal(cov.fraction, 0);

  const fresh = new RoomCoverage();
  feed(fresh, new Float32Array(64 * 36), 64, 36, 30, { boxes: [{ x0: 0, y0: 0, x1: 0.5, y1: 1 }] });
  assert.ok(fresh.fraction < 0.5, 'the hand area is not learned as room');
});

test('the hand box pads the landmarks by half a palm', () => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.6 };
  lm[9] = { x: 0.5, y: 0.4 };
  const box = handBox(lm);
  assert.ok(Math.abs(box.y0 - 0.3) < 1e-9 && Math.abs(box.y1 - 0.7) < 1e-9);
  assert.equal(handBox(null), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CustomGestures,
  DEFAULT_MAX_DISTANCE,
  SampleRecorder,
  SAMPLES_PER_GESTURE,
  customName,
  distance,
  isCustomGesture,
  sampleProblem,
  toVector,
} from '../public/custom-gestures.js';
import { buildHand } from './hand-fixture.js';

// Two fingers up: matches none of the built-in poses, so it is exactly the kind
// of shape someone would teach.
const peace = (opts = {}) => buildHand({ pose: 'peace', ...opts });
// One finger different from peace — the closest a different gesture gets.
const three = (opts = {}) => buildHand({ pose: 'peace', fingers: { ring: 'extended' }, ...opts });

// Deterministic landmark jitter, in palm lengths, to stand in for camera noise.
function jitter(pts, amount, seed = 7) {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const scale = 0.12; // buildHand's default palm length
  return pts.map((p) => ({
    x: p.x + (rand() - 0.5) * 2 * amount * scale,
    y: p.y + (rand() - 0.5) * 2 * amount * scale,
  }));
}

const samples = (make, n = SAMPLES_PER_GESTURE) =>
  Array.from({ length: n }, (_, i) => toVector(jitter(make(), 0.05, 11 + i)));

test('custom names carry a prefix and a safe label', () => {
  assert.equal(customName('Peace'), 'custom:peace');
  assert.equal(customName('  rock_on2 '), 'custom:rock_on2');
  assert.equal(customName('2fast'), null, 'must start with a letter');
  assert.equal(customName('thumbs up'), null, 'no spaces');
  assert.equal(customName(''), null);

  assert.ok(isCustomGesture('custom:peace'));
  assert.ok(!isCustomGesture('fist'));
  assert.ok(!isCustomGesture('custom:Peace'));
  assert.ok(!isCustomGesture('custom:'));
});

test('the same shape matches near the camera, far away and tilted', () => {
  const near = toVector(peace());
  assert.ok(distance(near, toVector(peace({ scale: 0.06, origin: { x: 0.2, y: 0.3 } }))) < 1e-9);
  assert.ok(distance(near, toVector(peace({ rotation: 0.4 }))) < 1e-9, 'a 23° tilt is forgiven');
});

test('turning the hand past the tilt allowance makes it a different gesture', () => {
  // Thumb up and thumb down are the same shape rotated half a turn. Full
  // rotation invariance would merge them, so it stops at 30°.
  const upright = toVector(peace());
  assert.ok(distance(upright, toVector(peace({ rotation: Math.PI }))) > 1);
  assert.ok(distance(upright, toVector(peace({ rotation: 1.05 }))) > DEFAULT_MAX_DISTANCE);
});

test('one finger raised is outside the match threshold; camera-like jitter is inside it', () => {
  const base = toVector(peace());
  assert.ok(distance(base, toVector(three())) > DEFAULT_MAX_DISTANCE);
  assert.ok(distance(base, toVector(jitter(peace(), 0.1))) < DEFAULT_MAX_DISTANCE);
});

test('a taught gesture matches its own shape and nothing else', () => {
  const set = new CustomGestures([{ name: 'custom:peace', samples: samples(peace) }]);

  assert.equal(set.match(jitter(peace(), 0.08, 99)), 'custom:peace');
  assert.equal(set.match(three()), null);
  assert.equal(set.match(buildHand({ pose: 'fist' })), null);
  assert.equal(set.match(null), null);
});

test('a hand halfway between two taught gestures matches neither', () => {
  // Forcing a choice between two near-equal candidates presses a key on a coin
  // toss. With a deliberately loose threshold so both are in range, the
  // ambiguity rule is the only thing deciding.
  const set = new CustomGestures(
    [
      { name: 'custom:peace', samples: [toVector(peace())] },
      { name: 'custom:three', samples: [toVector(three())] },
    ],
    { maxDistance: 1 },
  );
  const between = buildHand({ pose: 'peace', fingers: { ring: 0.43 } });

  const near = set.nearest(between);
  assert.ok(near.distance <= 1, 'both are within the loose threshold');
  assert.equal(set.match(between), null);
  assert.equal(set.match(peace()), 'custom:peace', 'a clear case still matches');
});

test('built-in shapes and the swipe pose cannot be taught', () => {
  assert.match(sampleProblem(buildHand({ pose: 'fist' })), /built-in fist/);
  assert.match(sampleProblem(buildHand({ pose: 'open_palm' })), /built-in open_palm/);
  assert.match(sampleProblem(buildHand({ pose: 'four_finger' })), /swipe/);
  assert.match(sampleProblem(null), /no hand/);
  assert.equal(sampleProblem(peace()), null);
});

test('recording refuses samples that disagree, duplicates, and near-copies', () => {
  const set = new CustomGestures([{ name: 'custom:peace', samples: samples(peace) }]);

  assert.match(set.recordingProblem('custom:peace', samples(three)), /already exists/);
  assert.match(set.recordingProblem('custom:victory', samples(peace)), /too close to custom:peace/);
  assert.match(
    set.recordingProblem('custom:mixed', [toVector(three()), toVector(buildHand({ pose: 'peace', fingers: { pinky: 'extended' } }))]),
    /too different/,
  );
  assert.equal(set.recordingProblem('custom:three', samples(three)), null);
});

test('the recorder spaces samples out and keeps going past unusable frames', () => {
  const rec = new SampleRecorder({ count: 3, intervalMs: 250 });

  assert.equal(rec.offer(buildHand({ pose: 'fist' }), 0).problem, "that's the built-in fist gesture");
  assert.equal(rec.offer(peace(), 10).captured, 1);
  assert.equal(rec.offer(peace(), 100).captured, 1, 'too soon after the last sample');
  assert.equal(rec.offer(peace(), 300).captured, 2);
  assert.equal(rec.offer(peace(), 600).status, 'done');
  assert.equal(rec.samples.length, 3);
});

test('the recorder gives up rather than waiting forever', () => {
  const rec = new SampleRecorder({ timeoutMs: 1000 });
  rec.offer(null, 0);
  assert.equal(rec.offer(null, 1500).status, 'timeout');
});

test('storage round-trips, and a corrupt entry costs only itself', () => {
  const set = new CustomGestures([
    { name: 'custom:peace', samples: samples(peace) },
    { name: 'custom:three', samples: samples(three) },
  ]);
  const stored = JSON.parse(JSON.stringify(set.toJSON()));
  stored.gestures.push({ name: 'custom:broken', samples: [[1, 2, 3]] }, { name: 'fist', samples: samples(peace) });

  const { set: loaded, skipped } = CustomGestures.fromJSON(stored);
  assert.deepEqual(loaded.names, ['custom:peace', 'custom:three']);
  assert.deepEqual(skipped, ['custom:broken', 'fist']);
  assert.equal(loaded.match(jitter(three(), 0.05, 5)), 'custom:three');

  assert.equal(CustomGestures.fromJSON(null).set.size, 0);
});

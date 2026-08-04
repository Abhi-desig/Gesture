import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPose, isFourFingerPose } from '../public/gestures.js';
import {
  extendedFingers,
  handScale,
  indexReach,
  pinchGap,
  toPoints,
} from '../public/landmarks.js';
import { buildHand } from './hand-fixture.js';

test('classifies an open palm', () => {
  assert.equal(classifyPose(buildHand({ pose: 'open_palm' })), 'open_palm');
});

test('classifies a fist', () => {
  assert.equal(classifyPose(buildHand({ pose: 'fist' })), 'fist');
});

test('classifies a pinch', () => {
  assert.equal(classifyPose(buildHand({ pose: 'pinch' })), 'pinch');
});

test('returns null for a pose that is none of the three', () => {
  assert.equal(classifyPose(buildHand({ pose: 'peace' })), null);
});

test('a fist is not misread as a pinch even though the thumb rests on the index', () => {
  // This is the case the pinchMinIndexReach clause exists for. In a closed fist
  // the thumb folds across the index finger, so the thumb-index gap alone reads
  // as a pinch; only the index tip's distance from the wrist separates them.
  const fist = buildHand({ pose: 'fist' });

  assert.ok(
    pinchGap(fist) < 0.35,
    `thumb-index gap should look pinch-like (was ${pinchGap(fist).toFixed(3)})`,
  );
  assert.ok(
    indexReach(fist) < 1.15,
    `index should be curled in close (was ${indexReach(fist).toFixed(3)})`,
  );
  assert.equal(classifyPose(fist), 'fist');
});

test('a pinch keeps the index reaching away from the wrist', () => {
  const pinch = buildHand({ pose: 'pinch' });
  assert.ok(pinchGap(pinch) < 0.35);
  assert.ok(
    indexReach(pinch) > 1.15,
    `index should reach out (was ${indexReach(pinch).toFixed(3)})`,
  );
});

test('classification survives hand rotation', () => {
  // The extension test compares distances from the wrist rather than raw y
  // ordering, so tilting or inverting the hand must not change the result.
  for (const pose of ['open_palm', 'fist', 'pinch']) {
    for (const turns of [0, 0.25, 0.5, 0.75]) {
      const pts = buildHand({ pose, rotation: turns * 2 * Math.PI });
      assert.equal(classifyPose(pts), pose, `${pose} at ${turns} turns`);
    }
  }
});

test('classification is independent of distance from the camera', () => {
  for (const pose of ['open_palm', 'fist', 'pinch']) {
    for (const scale of [0.05, 0.12, 0.3]) {
      assert.equal(classifyPose(buildHand({ pose, scale })), pose, `${pose} at scale ${scale}`);
    }
  }
});

test('handScale is the wrist-to-middle-knuckle distance', () => {
  const scale = 0.17;
  assert.ok(Math.abs(handScale(buildHand({ scale })) - scale) < 1e-9);
});

test('extendedFingers counts the four non-thumb fingers', () => {
  assert.equal(extendedFingers(buildHand({ pose: 'open_palm' })).count, 4);
  assert.equal(extendedFingers(buildHand({ pose: 'fist' })).count, 0);

  const peace = extendedFingers(buildHand({ pose: 'peace' }));
  assert.equal(peace.count, 2);
  assert.equal(peace.index, true);
  assert.equal(peace.middle, true);
  assert.equal(peace.ring, false);
  assert.equal(peace.pinky, false);
});

test('isFourFingerPose ignores the thumb', () => {
  // Same four fingers out, thumb out vs tucked — both are valid swipe poses.
  assert.equal(isFourFingerPose(buildHand({ pose: 'open_palm' })), true);
  assert.equal(isFourFingerPose(buildHand({ pose: 'four_finger' })), true);
  assert.equal(isFourFingerPose(buildHand({ pose: 'fist' })), false);
  assert.equal(isFourFingerPose(buildHand({ pose: 'peace' })), false);
});

test('a tucked-thumb four-finger pose is not an open palm', () => {
  // Held still it should do nothing; it only means something while moving.
  assert.equal(classifyPose(buildHand({ pose: 'four_finger' })), null);
});

test('toPoints corrects for frame aspect ratio', () => {
  const raw = [
    { x: 0.5, y: 0.5 },
    { x: 0.6, y: 0.5 },
  ];
  const pts = toPoints(raw, 640 / 480);
  assert.ok(Math.abs(pts[1].x - pts[0].x - 0.1 * (640 / 480)) < 1e-9);
  assert.equal(pts[0].y, 0.5);
});

test('rejects malformed landmark input', () => {
  assert.equal(classifyPose(null), null);
  assert.equal(classifyPose([]), null);
  assert.equal(classifyPose(buildHand().slice(0, 10)), null);
  assert.equal(isFourFingerPose(null), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPose, fingerPattern, isFourFingerPose, isShh } from '../public/gestures.js';
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

test('returns null for a pose that is none of them', () => {
  assert.equal(classifyPose(buildHand({ pose: 'peace' })), null);
});

test('fingerPattern spells out which fingers are up, and ignores the thumb', () => {
  const horns = buildHand({ pose: 'peace', fingers: { middle: 'curled', pinky: 'extended' } });
  assert.equal(fingerPattern(horns), 'I--P');
  assert.equal(fingerPattern(buildHand({ pose: 'peace' })), 'IM--');
  assert.equal(fingerPattern(buildHand({ pose: 'fist' })), '----');
  assert.equal(fingerPattern(buildHand({ pose: 'fist', thumb: 'out' })), '----', 'a thumbs-up is a fist to it too');
  assert.equal(fingerPattern(buildHand({ pose: 'open_palm' })), 'IMRP');
  assert.equal(fingerPattern(buildHand({ pose: 'peace', rotation: Math.PI })), 'IM--', 'upside down too');
  assert.equal(fingerPattern(null), null);
});

test('classifies an OK sign, and it is not a pinch', () => {
  // The same thumb-on-index circle as a pinch; only the three fingers up tell
  // them apart. OK arms the page and pinch focuses a screen, so a mix-up would
  // aim at a screen every time you meant to arm.
  assert.equal(classifyPose(buildHand({ pose: 'ok_sign' })), 'ok_sign');
  assert.equal(classifyPose(buildHand({ pose: 'pinch' })), 'pinch');
  assert.equal(classifyPose(buildHand({ pose: 'ok_sign', fingers: { ring: 'curled' } })), 'pinch', 'without all three fingers up it is still a pinch');
});

test('neither a fist nor a thumbs-up is an OK sign', () => {
  assert.equal(classifyPose(buildHand({ pose: 'fist' })), 'fist');
  assert.equal(classifyPose(buildHand({ pose: 'fist', thumb: 'out' })), 'fist');
  assert.equal(classifyPose(buildHand({ pose: 'open_palm' })), 'open_palm');
});

test('a pointing hand is no longer a gesture', () => {
  assert.equal(classifyPose(buildHand({ pose: 'point' })), null);
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
  for (const pose of ['open_palm', 'fist', 'pinch', 'ok_sign']) {
    for (const turns of [0, 0.25, 0.5, 0.75]) {
      const pts = buildHand({ pose, rotation: turns * 2 * Math.PI });
      assert.equal(classifyPose(pts), pose, `${pose} at ${turns} turns`);
    }
  }
});

test('classification is independent of distance from the camera', () => {
  for (const pose of ['open_palm', 'fist', 'pinch', 'ok_sign']) {
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

// ------------------------------------------------------------------ shh

/**
 * A mouth `off` palm lengths to the side of the index finger's top section,
 * `along` of the way from the middle joint to the tip.
 */
function mouthBeside(pts, { along = 0.5, off = 0.15 } = {}) {
  const pip = pts[6];
  const tip = pts[8];
  const len = Math.hypot(tip.x - pip.x, tip.y - pip.y);
  const scale = handScale(pts);
  const nx = -(tip.y - pip.y) / len;
  const ny = (tip.x - pip.x) / len;
  return {
    x: pip.x + (tip.x - pip.x) * along + nx * off * scale,
    y: pip.y + (tip.y - pip.y) * along + ny * off * scale,
  };
}

const finger = (opts = {}) => buildHand({ pose: 'point', ...opts });

test('a finger upright on the lips is a shh', () => {
  const pts = finger();
  assert.equal(isShh(pts, mouthBeside(pts)), true);
  // Tip up at the nose, the finger still across the lips.
  assert.equal(isShh(pts, mouthBeside(pts, { along: 0.2 })), true);
});

test('a shh survives a tilt and any distance, but not a sideways finger', () => {
  for (const rotation of [-0.5, 0.5]) {
    const pts = finger({ rotation });
    assert.equal(isShh(pts, mouthBeside(pts)), true, `tilted ${rotation} rad`);
  }
  for (const scale of [0.06, 0.25]) {
    const pts = finger({ scale });
    assert.equal(isShh(pts, mouthBeside(pts)), true, `scale ${scale}`);
  }
  // Pointing sideways or down near the mouth is a hand on the chin.
  for (const rotation of [Math.PI / 2, Math.PI]) {
    const pts = finger({ rotation });
    assert.equal(isShh(pts, mouthBeside(pts)), false, `rotated ${rotation} rad`);
  }
});

test('no face, a finger at the cheek, or two fingers up is not a shh', () => {
  const pts = finger();
  assert.equal(isShh(pts, null), false, 'no face, no mouth, no shh');
  assert.equal(isShh(pts, mouthBeside(pts, { off: 0.8 })), false, 'at the cheek');
  const peace = buildHand({ pose: 'peace' });
  assert.equal(isShh(peace, mouthBeside(peace)), false);
  assert.equal(classifyPose(pts), null, 'the hand alone is no pose at all');
});

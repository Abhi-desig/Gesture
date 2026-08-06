import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SWIPE_OPTIONS, SwipeTracker } from '../public/swipe.js';
import { buildHand, motionStream } from './hand-fixture.js';

// Sign convention reminder: the tracker negates raw dx because the camera faces
// the user, so a *decreasing* raw x is the hand moving to the user's own right.
const RIGHTWARD = -0.25;
const LEFTWARD = 0.25;

function run(tracker, stream) {
  const fires = [];
  for (const { pts, t } of stream) {
    const result = tracker.update(pts, t);
    if (result.swipe) fires.push({ swipe: result.swipe, t });
  }
  return fires;
}

/** Concatenate streams onto a continuous timeline. */
function sequence(...streams) {
  const out = [];
  let t = 1000;
  for (const stream of streams) {
    const base = stream[0].t;
    for (const frame of stream) out.push({ pts: frame.pts, t: t + (frame.t - base) });
    t = out[out.length - 1].t + 16;
  }
  return out;
}

test('detects a swipe to the user right', () => {
  const fires = run(new SwipeTracker(), motionStream({ dx: RIGHTWARD }));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].swipe, 'swipe_right');
});

test('detects a swipe to the user left', () => {
  const fires = run(new SwipeTracker(), motionStream({ dx: LEFTWARD }));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].swipe, 'swipe_left');
});

test('a swept open palm also swipes — the thumb is not what decides', () => {
  const fires = run(new SwipeTracker(), motionStream({ pose: 'open_palm', dx: RIGHTWARD }));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].swipe, 'swipe_right');
});

test('a still hand does not swipe and reports near-zero velocity', () => {
  const tracker = new SwipeTracker();
  const fires = run(tracker, motionStream({ dx: 0, durationMs: 600, frames: 36 }));
  assert.equal(fires.length, 0);

  const { velocity } = tracker.update(buildHand({ pose: 'four_finger' }), 2000);
  assert.ok(velocity < 0.01, `expected a still hand to read ~0 (was ${velocity})`);
});

test('reports high velocity mid-swipe, which is what gates the static poses', () => {
  // app.js suppresses fist/pinch/open_palm above stillnessMaxVelocity (0.8).
  // Without that, a swipe would trip the open-palm binding on its way across.
  const tracker = new SwipeTracker();
  let peak = 0;
  for (const { pts, t } of motionStream({ dx: RIGHTWARD })) {
    peak = Math.max(peak, tracker.update(pts, t).velocity);
  }
  assert.ok(peak > 0.8, `expected a swipe to exceed the stillness gate (peak ${peak})`);
});

test('rejects travel that is too short', () => {
  assert.equal(run(new SwipeTracker(), motionStream({ dx: -0.1 })).length, 0);
});

test('rejects a diagonal wave', () => {
  const fires = run(new SwipeTracker(), motionStream({ dx: RIGHTWARD, dy: 0.2 }));
  assert.equal(fires.length, 0);
});

test('rejects a slow drift that covers the distance', () => {
  // minVelocity cannot bind at default settings, because windowMs already caps
  // how slowly minTravel can be covered. Widening the window exposes the guard.
  const tracker = new SwipeTracker({ windowMs: 1200 });
  const fires = run(tracker, motionStream({ dx: -0.2, durationMs: 1000, frames: 60 }));
  assert.equal(fires.length, 0);
});

test('ignores motion while the pose is not held', () => {
  assert.equal(run(new SwipeTracker(), motionStream({ pose: 'fist', dx: RIGHTWARD })).length, 0);
  assert.equal(run(new SwipeTracker(), motionStream({ pose: 'peace', dx: RIGHTWARD })).length, 0);
});

test('the return stroke does not fire the opposite direction', () => {
  // The whole reason swipeRearmRequiresPoseBreak exists. Swipe left, bring your
  // hand back with fingers still out, and a naive implementation fires the
  // opposite swipe and silently undoes what you just did.
  const fires = run(
    new SwipeTracker(),
    sequence(
      motionStream({ dx: RIGHTWARD, start: { x: 0.5, y: 0.6 } }),
      motionStream({ dx: LEFTWARD, start: { x: 0.25, y: 0.6 } }),
    ),
  );
  assert.equal(fires.length, 1, 'exactly one swipe for one out-and-back motion');
  assert.equal(fires[0].swipe, 'swipe_right');
});

test('without the guard, the return stroke does undo the swipe', () => {
  // Confirms the guard is load-bearing rather than decorative.
  const fires = run(
    new SwipeTracker({ rearmRequiresPoseBreak: false }),
    sequence(
      motionStream({ dx: RIGHTWARD, durationMs: 500, frames: 30 }),
      motionStream({ dx: LEFTWARD, durationMs: 500, frames: 30, start: { x: 0.25, y: 0.6 } }),
    ),
  );
  assert.ok(fires.length >= 2, `expected the return stroke to fire too (got ${fires.length})`);
  assert.equal(fires[0].swipe, 'swipe_right');
  assert.equal(fires[1].swipe, 'swipe_left');
});

test('breaking the pose re-arms for the next swipe', () => {
  const fires = run(
    new SwipeTracker(),
    sequence(
      motionStream({ dx: RIGHTWARD }),
      // Curl the fingers to re-arm.
      motionStream({ pose: 'fist', dx: 0, durationMs: 150, frames: 10, start: { x: 0.25, y: 0.6 } }),
      // Long enough for the window to refill entirely with post-pose samples.
      motionStream({ dx: -0.3, durationMs: 500, frames: 30, start: { x: 0.5, y: 0.6 } }),
    ),
  );
  assert.equal(fires.length, 2);
  assert.deepEqual(
    fires.map((f) => f.swipe),
    ['swipe_right', 'swipe_right'],
  );
});

test('travel from before the pose formed does not count', () => {
  // Hand already moving with a fist, then the fingers come up mid-motion. Only
  // the post-pose portion is short, so nothing should fire.
  const fires = run(
    new SwipeTracker(),
    sequence(
      motionStream({ pose: 'fist', dx: -0.22, durationMs: 300, frames: 20 }),
      motionStream({ dx: -0.03, durationMs: 60, frames: 4, start: { x: 0.28, y: 0.6 } }),
    ),
  );
  assert.equal(fires.length, 0);
});

test('a swipe starting the moment the fingers come up still fires', () => {
  // The first gesture of every run used to be swallowed. Samples are pushed on
  // every hand-present frame, not only four-finger ones, and the old check
  // required the *oldest* sample in the buffer to already be in-pose — so you
  // had to hold four fingers still for a full windowMs before moving. Raise and
  // swipe in one motion and nothing happened; you'd settle, retry, and the
  // second attempt worked.
  //
  // Here the buffer is pre-loaded with a stationary fist, then the fingers come
  // up and the hand leaves immediately.
  const tracker = new SwipeTracker();
  let poseStart = null;
  let firedAt = null;
  let swipe = null;

  for (const { pts, t } of sequence(
    motionStream({ pose: 'fist', dx: 0, durationMs: 300, frames: 20, start: { x: 0.5, y: 0.6 } }),
    motionStream({ dx: RIGHTWARD, durationMs: 200, frames: 13, start: { x: 0.5, y: 0.6 } }),
  )) {
    const result = tracker.update(pts, t);
    // Captured on the first four-finger frame, before a fire resets it to null.
    poseStart ??= tracker.poseHeldSince;
    if (result.swipe && firedAt === null) {
      firedAt = t;
      swipe = result.swipe;
    }
  }

  assert.equal(swipe, 'swipe_right', 'raise-and-swipe in one motion should fire');

  // The window at fire time still reaches back past the moment the pose formed,
  // so the fist samples were genuinely still buffered. Without this the test
  // could pass for the old reason — the window having aged out — rather than
  // because the evaluation now slices.
  const oldestInWindow = firedAt - DEFAULT_SWIPE_OPTIONS.windowMs;
  assert.ok(
    oldestInWindow < poseStart,
    `pre-pose samples should still be in the window at fire time ` +
      `(window starts ${poseStart - oldestInWindow}ms before the pose did)`,
  );

  // And the behavioural promise: roughly half a window of in-pose motion is
  // enough, rather than a full window plus however long the pre-pose samples
  // take to age out.
  const inPoseMs = firedAt - poseStart;
  assert.ok(
    inPoseMs < DEFAULT_SWIPE_OPTIONS.windowMs,
    `expected to fire on under a full window of in-pose motion (took ${inPoseMs}ms)`,
  );
});

test('invertDirection flips the mapping for already-mirrored cameras', () => {
  const fires = run(new SwipeTracker({ invertDirection: true }), motionStream({ dx: RIGHTWARD }));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].swipe, 'swipe_left');
});

test('losing the hand clears the window and re-arms', () => {
  const tracker = new SwipeTracker();
  run(tracker, motionStream({ dx: RIGHTWARD }));
  assert.equal(tracker.armed, false);

  tracker.handLost();
  assert.equal(tracker.armed, true);
  assert.equal(tracker.samples.length, 0);

  const fires = run(tracker, motionStream({ dx: RIGHTWARD, startT: 5000 }));
  assert.equal(fires.length, 1);
});

test('detection is independent of distance from the camera', () => {
  for (const scale of [0.06, 0.12, 0.25]) {
    // Same travel in hand-widths, so the same gesture at any apparent hand size.
    const dx = -(2.0 * scale);
    const fires = run(new SwipeTracker(), motionStream({ dx, scale }));
    assert.equal(fires.length, 1, `scale ${scale}`);
    assert.equal(fires[0].swipe, 'swipe_right');
  }
});

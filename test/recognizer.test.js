import test from 'node:test';
import assert from 'node:assert/strict';

import { Recognizer } from '../public/recognizer.js';
import { buildHand, motionStream } from './hand-fixture.js';

const RIGHTWARD = -0.25; // raw dx decreasing == hand moving to the user's right

/**
 * Hold one pose still. Prefer `ms` over `frames`: hold times are durations now, so
 * a frame count obscures whether a test is above or below the threshold.
 */
function hold({ pose, ms, frames, startT = 1000, stepMs = 1000 / 60, scale = 0.12 }) {
  const count = ms !== undefined ? Math.ceil(ms / stepMs) + 1 : (frames ?? 12);
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * stepMs,
    pts: buildHand({ pose, scale }),
  }));
}

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

function run(recognizer, stream) {
  const fired = [];
  for (const { pts, t } of stream) {
    const view = recognizer.update(pts, t);
    if (view.gesture) fired.push(view.gesture);
  }
  return fired;
}

test('a held pose fires once, after its hold time', () => {
  const r = new Recognizer();
  const fired = [];
  // 30 frames at 16ms is ~480ms, comfortably past the 180ms default hold.
  hold({ pose: 'fist', frames: 30 }).forEach(({ pts, t }) => {
    const view = r.update(pts, t);
    if (view.gesture) fired.push({ gesture: view.gesture, heldMs: view.heldMs });
  });

  assert.equal(fired.length, 1, 'a held fist should not repeat');
  assert.equal(fired[0].gesture, 'fist');
  assert.ok(fired[0].heldMs >= 180, `fired after ${fired[0].heldMs}ms, expected >= 180`);
  assert.ok(fired[0].heldMs < 220, `fired late at ${fired[0].heldMs}ms`);
});

test('a pose released before its hold time never fires', () => {
  // ~100ms, under the 180ms default.
  assert.deepEqual(run(new Recognizer(), hold({ pose: 'fist', frames: 6 })), []);
});

test('hold time is measured in milliseconds, not frames', () => {
  // The same 200ms hold at very different frame rates must behave identically.
  // A frame count could not do this: 4 frames is 67ms at 60fps but 133ms at 30fps.
  for (const [label, stepMs, frames] of [['60fps', 1000 / 60, 40], ['15fps', 1000 / 15, 10]]) {
    const fired = run(new Recognizer(), hold({ pose: 'fist', frames, stepMs }));
    assert.deepEqual(fired, ['fist'], label);
  }
});

test('releasing and re-forming a pose allows a second fire', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 0 }),
    sequence(
      hold({ pose: 'fist', ms: 400 }),
      hold({ pose: 'peace', ms: 300 }), // release
      hold({ pose: 'fist', ms: 400 }),
    ),
  );
  assert.deepEqual(fired, ['fist', 'fist']);
});

test('cooldown blocks a re-fire even after a release', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 5000 }),
    sequence(
      hold({ pose: 'fist', ms: 400 }),
      hold({ pose: 'peace', ms: 300 }),
      hold({ pose: 'fist', ms: 400 }),
    ),
  );
  assert.deepEqual(fired, ['fist']);
});

test('an open palm held still fires open_palm', () => {
  const stream = hold({ pose: 'open_palm', ms: 1500 }); // past its 1200ms hold
  assert.deepEqual(run(new Recognizer(), stream), ['open_palm']);
});

test('a moving hand does not fire a static pose', () => {
  // The stillness gate. Without it, sweeping an open hand across the frame would
  // trip open_palm — which is bound to lock-screen by default.
  const fired = run(new Recognizer(), motionStream({ pose: 'open_palm', dx: RIGHTWARD }));
  assert.ok(!fired.includes('open_palm'), `expected no open_palm, got ${fired.join(',')}`);
});

test('sweeping an open hand fires exactly one swipe and nothing else', () => {
  const fired = run(new Recognizer(), motionStream({ pose: 'open_palm', dx: RIGHTWARD }));
  assert.deepEqual(fired, ['swipe_right']);
});

test('a hand coming to rest after a swipe does NOT fire open_palm', () => {
  // The dangerous case: swipe with an open hand, then hold still. The hand is
  // already in a valid open_palm, so without post-swipe suppression the screen
  // locks a few frames after every swipe.
  const fired = run(
    new Recognizer(),
    sequence(
      motionStream({ pose: 'open_palm', dx: RIGHTWARD }),
      // Hand stops, fingers still out, for longer than open_palm's hold time.
      hold({ pose: 'open_palm', ms: 1500, startT: 0 }),
    ),
  );
  assert.deepEqual(fired, ['swipe_right'], 'the swipe must not be followed by open_palm');
});

test('breaking the pose after a swipe restores static poses', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 0 }),
    sequence(
      motionStream({ pose: 'open_palm', dx: RIGHTWARD }),
      // Suppressed no matter how long it's held, until the pose breaks.
      hold({ pose: 'open_palm', ms: 1500, startT: 0 }),
      hold({ pose: 'fist', ms: 400, startT: 0 }), // breaks the swipe pose
      hold({ pose: 'open_palm', ms: 1500, startT: 0 }), // allowed again
    ),
  );
  assert.deepEqual(fired, ['swipe_right', 'fist', 'open_palm']);
});

test('raising an open hand to swipe does not fire open_palm first', () => {
  // The leading edge of a swipe, and the one users actually hit. The swipe pose is
  // a subset of the open-palm pose, so getting into position means holding a
  // stationary open palm for a moment. With a short global hold time that fired
  // open_palm — cmd+ctrl+q, locking the screen — before the swipe was attempted.
  const fired = run(
    new Recognizer(),
    sequence(
      // ~200ms getting ready: hand up, open, still.
      hold({ pose: 'open_palm', frames: 12, stepMs: 1000 / 60 }),
      motionStream({ pose: 'open_palm', dx: RIGHTWARD, start: { x: 0.5, y: 0.75 } }),
    ),
  );
  assert.deepEqual(fired, ['swipe_right'], 'only the swipe should fire');
});

test('a deliberately held open palm still fires, after its longer hold', () => {
  // The flip side: open_palm must remain usable, just deliberate. 1200ms default.
  const r = new Recognizer();
  const fired = [];
  hold({ pose: 'open_palm', frames: 120, stepMs: 1000 / 60 }).forEach(({ pts, t }) => {
    const view = r.update(pts, t);
    if (view.gesture) fired.push({ gesture: view.gesture, heldMs: Math.round(view.heldMs) });
  });

  assert.equal(fired.length, 1);
  assert.equal(fired[0].gesture, 'open_palm');
  assert.ok(fired[0].heldMs >= 1200, `fired after ${fired[0].heldMs}ms, expected >= 1200`);
});

test('per-gesture hold times are independent', () => {
  const r = new Recognizer();
  assert.equal(r.holdFor('open_palm'), 1200);
  assert.equal(r.holdFor('fist'), 180);
  assert.equal(r.holdFor('pinch'), 180);

  r.setTuning({ holdMs: 500 });
  assert.equal(r.holdFor('open_palm'), 500, 'a bare number applies to every pose');
  assert.equal(r.holdFor('fist'), 500);

  r.setTuning({ holdMs: { default: 90, pinch: 700 } });
  assert.equal(r.holdFor('pinch'), 700);
  assert.equal(r.holdFor('fist'), 90);
  assert.equal(r.holdFor('open_palm'), 90, 'falls back to default when not overridden');
});

test('suppression is reported so the UI can explain itself', () => {
  const r = new Recognizer();
  run(r, motionStream({ pose: 'open_palm', dx: RIGHTWARD }));
  assert.equal(r.poseSuppressed, true);

  const view = r.update(buildHand({ pose: 'fist' }), 9000);
  assert.equal(view.poseSuppressed, false, 'curling the fingers clears suppression');
});

test('losing the hand clears suppression and the pose run', () => {
  const r = new Recognizer();
  run(r, motionStream({ pose: 'open_palm', dx: RIGHTWARD }));

  const view = r.update(null, 9000);
  assert.equal(view.handPresent, false);
  assert.equal(view.poseSuppressed, false);
  assert.equal(view.pose, null);
  assert.equal(view.gesture, null);
});

test('a pinch held still fires pinch', () => {
  assert.deepEqual(run(new Recognizer(), hold({ pose: 'pinch', ms: 400 })), ['pinch']);
});

test('different poses keep independent cooldowns', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 5000 }),
    sequence(hold({ pose: 'fist', ms: 400 }), hold({ pose: 'pinch', ms: 400 })),
  );
  assert.deepEqual(fired, ['fist', 'pinch']);
});

test('requireReleaseBetweenFires off lets a held pose repeat on cooldown', () => {
  const r = new Recognizer({ requireReleaseBetweenFires: false, cooldownMs: 100 });
  const fired = run(r, hold({ pose: 'fist', ms: 1500 }));
  assert.ok(fired.length > 1, `expected repeats, got ${fired.length}`);
  assert.ok(fired.every((g) => g === 'fist'));
});

test('tuning can be swapped at runtime, as config hot-reload does', () => {
  const r = new Recognizer();
  r.setTuning({ holdMs: 0 });
  r.update(buildHand({ pose: 'fist' }), 1000);
  const view = r.update(buildHand({ pose: 'fist' }), 1016);
  assert.equal(view.gesture, 'fist', 'a zero hold fires as soon as the frame floor is met');
});

test('a pose recognized while disarmed leaves no cooldown residue', () => {
  // The page drops gestures while disarmed, but the recognizer used to record
  // them as fired anyway. That burned the pose's cooldown *and*, with
  // requireReleaseBetweenFires on, demanded a full pose break — so a fist made
  // between "Start camera" and "Arm" silently ate the first real gesture.
  const r = new Recognizer();

  const disarmed = [];
  for (const { pts, t } of hold({ pose: 'fist', ms: 400, startT: 1000 })) {
    const view = r.update(pts, t, false);
    if (view.gesture) disarmed.push(view.gesture);
  }

  // Still reported, because the live readout has to show what it can see.
  assert.ok(disarmed.length > 0, 'the pose should still be recognized while disarmed');
  assert.ok(disarmed.every((g) => g === 'fist'));
  assert.equal(r.lastFired.get('fist'), undefined, 'nothing should be recorded as fired');
  assert.equal(r.run.fired, false, 'the one-fire-per-run slot should be untouched');
});

test('the first armed gesture after a disarmed one still fires', () => {
  // The end-to-end version of the above: hold a fist while disarmed, keep
  // holding it, arm, and it must still fire. No pose break, no cooldown wait.
  const r = new Recognizer();
  const stream = hold({ pose: 'fist', ms: 800, startT: 1000 });
  const half = Math.floor(stream.length / 2);

  for (const { pts, t } of stream.slice(0, half)) r.update(pts, t, false);

  const fired = [];
  for (const { pts, t } of stream.slice(half)) {
    const view = r.update(pts, t, true);
    if (view.gesture) fired.push(view.gesture);
  }

  assert.deepEqual(fired, ['fist'], 'arming mid-hold should fire exactly once');
});

test('an armed pose still fires only once', () => {
  // Guards the obvious way to get the above wrong: skipping the bookkeeping
  // unconditionally rather than only while disarmed.
  const r = new Recognizer();
  assert.deepEqual(run(r, hold({ pose: 'fist', ms: 800 })), ['fist']);
  assert.ok(r.lastFired.get('fist') > 0);
});

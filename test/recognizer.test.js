import test from 'node:test';
import assert from 'node:assert/strict';

import { Recognizer } from '../public/recognizer.js';
import { buildHand, motionStream } from './hand-fixture.js';

const RIGHTWARD = -0.25; // raw dx decreasing == hand moving to the user's right

/** Hold one pose still for a stretch of frames. */
function hold({ pose, frames = 12, startT = 1000, stepMs = 16, scale = 0.12 }) {
  return Array.from({ length: frames }, (_, i) => ({
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

test('a held pose fires once, after confirmFrames', () => {
  const r = new Recognizer();
  const fired = [];
  hold({ pose: 'fist', frames: 10 }).forEach(({ pts, t }, i) => {
    const view = r.update(pts, t);
    if (view.gesture) fired.push({ gesture: view.gesture, frameIndex: i });
  });

  assert.equal(fired.length, 1, 'a held fist should not repeat');
  assert.equal(fired[0].gesture, 'fist');
  assert.equal(fired[0].frameIndex, 3, 'fires on the 4th frame (confirmFrames = 4)');
});

test('a pose held for fewer than confirmFrames never fires', () => {
  assert.deepEqual(run(new Recognizer(), hold({ pose: 'fist', frames: 3 })), []);
});

test('releasing and re-forming a pose allows a second fire', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 0 }),
    sequence(
      hold({ pose: 'fist', frames: 8 }),
      hold({ pose: 'peace', frames: 8 }), // release
      hold({ pose: 'fist', frames: 8 }),
    ),
  );
  assert.deepEqual(fired, ['fist', 'fist']);
});

test('cooldown blocks a re-fire even after a release', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 5000 }),
    sequence(
      hold({ pose: 'fist', frames: 8 }),
      hold({ pose: 'peace', frames: 8 }),
      hold({ pose: 'fist', frames: 8 }),
    ),
  );
  assert.deepEqual(fired, ['fist']);
});

test('an open palm held still fires open_palm', () => {
  assert.deepEqual(run(new Recognizer(), hold({ pose: 'open_palm', frames: 10 })), ['open_palm']);
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
      // Hand stops, fingers still out, for well over confirmFrames.
      hold({ pose: 'open_palm', frames: 40, startT: 0 }),
    ),
  );
  assert.deepEqual(fired, ['swipe_right'], 'the swipe must not be followed by open_palm');
});

test('breaking the pose after a swipe restores static poses', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 0 }),
    sequence(
      motionStream({ pose: 'open_palm', dx: RIGHTWARD }),
      hold({ pose: 'open_palm', frames: 20, startT: 0 }), // still suppressed
      hold({ pose: 'fist', frames: 8, startT: 0 }), // breaks the swipe pose
      hold({ pose: 'open_palm', frames: 20, startT: 0 }), // allowed again
    ),
  );
  assert.deepEqual(fired, ['swipe_right', 'fist', 'open_palm']);
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
  assert.deepEqual(run(new Recognizer(), hold({ pose: 'pinch', frames: 10 })), ['pinch']);
});

test('different poses keep independent cooldowns', () => {
  const fired = run(
    new Recognizer({ cooldownMs: 5000 }),
    sequence(hold({ pose: 'fist', frames: 8 }), hold({ pose: 'pinch', frames: 8 })),
  );
  assert.deepEqual(fired, ['fist', 'pinch']);
});

test('requireReleaseBetweenFires off lets a held pose repeat on cooldown', () => {
  const r = new Recognizer({ requireReleaseBetweenFires: false, cooldownMs: 100 });
  // 60 frames at 16ms is ~960ms, enough for several 100ms cooldown windows.
  const fired = run(r, hold({ pose: 'fist', frames: 60 }));
  assert.ok(fired.length > 1, `expected repeats, got ${fired.length}`);
  assert.ok(fired.every((g) => g === 'fist'));
});

test('tuning can be swapped at runtime, as config hot-reload does', () => {
  const r = new Recognizer();
  r.setTuning({ confirmFrames: 1 });
  const view = r.update(buildHand({ pose: 'fist' }), 1000);
  assert.equal(view.gesture, 'fist', 'should fire on the very first frame now');
});

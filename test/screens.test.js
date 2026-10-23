import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Carry,
  FACE,
  ScreenTracker,
  angleBetween,
  crowdedScreens,
  headPose,
  summarizeHead,
} from '../public/screens.js';

/**
 * A face mesh with only the four points headPose reads, placed on a head of
 * radius `r` turned by `yaw` and tilted by `pitch` (degrees). Every other
 * landmark sits at the centre — headPose must not care about them.
 */
function face({ yaw = 0, pitch = 0, r = 0.08, centre = { x: 0.5, y: 0.5 } } = {}) {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  const pts = Array.from({ length: 478 }, () => ({ ...centre, z: 0 }));
  // Eye corners swing about the vertical axis; forehead and chin about the
  // horizontal one. z grows away from the camera.
  pts[FACE.RIGHT_EYE_OUTER] = { x: centre.x - r * Math.cos(y), y: centre.y, z: -r * Math.sin(y) };
  pts[FACE.LEFT_EYE_OUTER] = { x: centre.x + r * Math.cos(y), y: centre.y, z: r * Math.sin(y) };
  pts[FACE.FOREHEAD] = { x: centre.x, y: centre.y - r * Math.cos(p), z: -r * Math.sin(p) };
  pts[FACE.CHIN] = { x: centre.x, y: centre.y + r * Math.cos(p), z: r * Math.sin(p) };
  return pts;
}

const BUILTIN = { id: 1, name: 'Built-in', yaw: 0, pitch: 0 };
const BENQ = { id: 2, name: 'BenQ', yaw: 30, pitch: 0 };

test('headPose reads the turn it was given, and is null without a full face', () => {
  for (const yaw of [-35, -10, 0, 10, 35]) {
    const pose = headPose(face({ yaw }));
    assert.ok(Math.abs(pose.yaw - yaw) < 0.01, `yaw ${yaw} read as ${pose.yaw}`);
    assert.ok(Math.abs(pose.pitch) < 0.01);
  }
  assert.ok(Math.abs(headPose(face({ pitch: 20 })).pitch - 20) < 0.01);
  assert.equal(headPose(null), null);
  assert.equal(headPose(face().slice(0, 100)), null);
});

test('headPose is unchanged by where the face sits in the frame or how far away it is', () => {
  // Calibration is recorded in one spot; the gesture happens wherever you
  // happen to be sitting. Only the turn may move the number.
  const base = headPose(face({ yaw: 20 }));
  const moved = headPose(face({ yaw: 20, centre: { x: 0.3, y: 0.6 } }));
  const closer = headPose(face({ yaw: 20, r: 0.14 }));
  assert.ok(angleBetween(base, moved) < 0.01);
  assert.ok(angleBetween(base, closer) < 0.01);
});

test('headPose corrects pitch for a non-square frame', () => {
  // y is a fraction of frame height, z of frame width. On a 16:9 frame a pitch
  // measured without the correction comes out wrong.
  const aspect = 16 / 9;
  const pts = face({ pitch: 25 });
  // Squash y as a 16:9 frame would: the same physical distance is a larger
  // fraction of the shorter side.
  const squashed = pts.map((p) => ({ ...p, y: 0.5 + (p.y - 0.5) * aspect }));
  assert.ok(Math.abs(headPose(squashed, aspect).pitch - 25) < 0.01);
});

test('summarizeHead takes the median, so a frame from mid-turn does not drag it', () => {
  const settled = Array.from({ length: 9 }, () => ({ yaw: 30, pitch: 2 }));
  const reading = summarizeHead([{ yaw: 5, pitch: 0 }, ...settled]);
  assert.equal(reading.yaw, 30);
  assert.equal(reading.pitch, 2);
  assert.equal(reading.spread, 0);
  assert.equal(summarizeHead([]), null);
});

test('the tracker picks the calibrated screen you face', () => {
  const t = new ScreenTracker({ smoothing: 1 });
  t.setCalibration([BUILTIN, BENQ]);
  assert.equal(t.update({ yaw: 2, pitch: 0 }).screen, 1);
  assert.equal(t.update({ yaw: 28, pitch: 1 }).screen, 2);
});

test('facing nothing in particular is not facing the nearest screen', () => {
  // Looking down at a notebook must not aim at whichever screen is closest.
  const t = new ScreenTracker({ smoothing: 1, maxAngle: 20 });
  t.setCalibration([BUILTIN, BENQ]);
  const view = t.update({ yaw: 0, pitch: 35 });
  assert.equal(view.screen, null);
  assert.equal(view.nearest, 1, 'the readout still says which one was closest');
  assert.ok(view.distance > 20);
});

test('a head held between two screens does not flip on noise', () => {
  const t = new ScreenTracker({ smoothing: 1, switchMargin: 4 });
  t.setCalibration([BUILTIN, BENQ]);
  assert.equal(t.update({ yaw: 13, pitch: 0 }).screen, 1);
  // Just past the midpoint, but not by the margin: attention stays put.
  assert.equal(t.update({ yaw: 16, pitch: 0 }).screen, 1);
  assert.equal(t.update({ yaw: 14, pitch: 0 }).screen, 1);
  // Clearly over: it moves.
  assert.equal(t.update({ yaw: 19, pitch: 0 }).screen, 2);
});

test('smoothing damps a single jittery frame', () => {
  const t = new ScreenTracker({ smoothing: 0.35 });
  t.setCalibration([BUILTIN, BENQ]);
  for (let i = 0; i < 10; i += 1) t.update({ yaw: 0, pitch: 0 });
  assert.equal(t.update({ yaw: 30, pitch: 0 }).screen, 1, 'one frame is not a turn');
  for (let i = 0; i < 10; i += 1) t.update({ yaw: 30, pitch: 0 });
  assert.equal(t.update({ yaw: 30, pitch: 0 }).screen, 2, 'a held turn is');
});

test('losing the face forgets the screen rather than holding a stale one', () => {
  const t = new ScreenTracker({ smoothing: 1 });
  t.setCalibration([BUILTIN, BENQ]);
  t.update({ yaw: 30, pitch: 0 });
  assert.equal(t.update(null).screen, null);
  assert.equal(t.update({ yaw: 1, pitch: 0 }).screen, 1, 'and starts fresh when it comes back');
});

test('an uncalibrated tracker reports the head but no screen', () => {
  const t = new ScreenTracker();
  const view = t.update({ yaw: 10, pitch: 0 });
  assert.equal(view.screen, null);
  assert.deepEqual(view.pose, { yaw: 10, pitch: 0 });
});

test('crowdedScreens names screens calibrated too close together', () => {
  assert.deepEqual(crowdedScreens([BUILTIN, BENQ], 8), []);
  assert.deepEqual(
    crowdedScreens([BUILTIN, { id: 3, name: 'Left', yaw: 5, pitch: 0 }], 8),
    [['Built-in', 'Left']],
  );
});

// -------------------------------------------------------------- carrying

const RELEASE_MS = 200;

/** Feed a carry `ms` worth of frames at 30fps with a fixed pose and screen. */
function hold(carry, { pose, screen, from, ms }) {
  const drops = [];
  for (let t = from; t <= from + ms; t += 33) {
    const drop = carry.update(pose, screen, t);
    if (drop) drops.push(drop);
  }
  return drops;
}

test('point, turn to another screen, let go: the window moves there', () => {
  const c = new Carry({ releaseMs: RELEASE_MS });
  c.start('point', 1, 0);
  assert.deepEqual(hold(c, { pose: 'point', screen: 1, from: 0, ms: 300 }), []);
  assert.deepEqual(hold(c, { pose: 'point', screen: 2, from: 333, ms: 300 }), []);
  assert.deepEqual(hold(c, { pose: null, screen: 2, from: 666, ms: 400 }), [
    { gesture: 'point', from: 1, to: 2 },
  ]);
  assert.equal(c.active, false);
});

test('pointing and letting go on the same screen moves nothing', () => {
  // The common case — point to focus — must never turn into a move.
  const c = new Carry({ releaseMs: RELEASE_MS });
  c.start('point', 1, 0);
  hold(c, { pose: 'point', screen: 1, from: 0, ms: 300 });
  assert.deepEqual(hold(c, { pose: null, screen: 1, from: 333, ms: 400 }), []);
  assert.equal(c.active, false);
});

test('one dropped tracking frame is not letting go', () => {
  const c = new Carry({ releaseMs: RELEASE_MS });
  c.start('point', 1, 0);
  assert.equal(c.update('point', 2, 100), null);
  assert.equal(c.update(null, 2, 133), null);
  assert.equal(c.update('point', 2, 166), null);
  assert.equal(c.active, true);
});

test('losing the face mid-turn keeps the last screen faced', () => {
  const c = new Carry({ releaseMs: RELEASE_MS });
  c.start('point', 1, 0);
  c.update('point', 2, 100);
  c.update('point', null, 133);
  assert.deepEqual(hold(c, { pose: null, screen: null, from: 166, ms: 300 }), [
    { gesture: 'point', from: 1, to: 2 },
  ]);
});

test('a forgotten hold expires instead of moving a window much later', () => {
  const c = new Carry({ releaseMs: RELEASE_MS, timeoutMs: 1000 });
  c.start('point', 1, 0);
  c.update('point', 2, 500);
  assert.equal(c.update('point', 2, 1500), null);
  assert.equal(c.active, false);
  assert.deepEqual(hold(c, { pose: null, screen: 2, from: 1533, ms: 300 }), []);
});

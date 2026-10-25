import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACE,
  OneEuroFilter,
  ScreenTracker,
  angleBetween,
  crowdedScreens,
  screenDuring,
  headPose,
  spokenLabels,
  summarizeHead,
} from '../public/screens.js';
import { seededRandom } from '../public/stats.js';

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

// -------------------------------------------------------------- 1€ filter

test('the 1€ filter passes a steady value through unchanged', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0.1 });
  for (let t = 0; t <= 1000; t += 50) assert.ok(Math.abs(f.filter(12, t) - 12) < 1e-9);
});

test('beta opens the filter on a fast turn; at 0 it is just a slow EMA', () => {
  const stepAfterOne = (beta) => {
    const f = new OneEuroFilter({ minCutoff: 1, beta });
    f.filter(0, 0);
    return f.filter(30, 50);
  };
  const still = stepAfterOne(0);
  const quick = stepAfterOne(0.1);
  // minCutoff 1 Hz at 20 Hz readings: alpha = 1/(1 + 1/(2π·1·0.05)) ≈ 0.239.
  assert.ok(Math.abs(still - 30 * 0.239) < 0.1, `beta 0 moved ${still.toFixed(2)}°`);
  assert.ok(quick > 20, `beta 0.1 should cover most of a 30° turn at once, got ${quick.toFixed(2)}°`);
});

test('at rest the 1€ filter damps jitter', () => {
  const rng = seededRandom(5);
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0.1 });
  const raw = [];
  const smooth = [];
  for (let t = 0; t <= 3000; t += 50) {
    const x = 10 + (rng() - 0.5) * 2;
    raw.push({ yaw: x, pitch: 0 });
    smooth.push({ yaw: f.filter(x, t), pitch: 0 });
  }
  assert.ok(summarizeHead(smooth.slice(20)).spread < summarizeHead(raw.slice(20)).spread);
});

test('two readings in the same millisecond do not break the filter', () => {
  const f = new OneEuroFilter();
  f.filter(0, 100);
  assert.ok(Number.isFinite(f.filter(5, 100)));
});

test('the tracker uses 1€ only when given timestamps, and EMA otherwise', () => {
  const euro = new ScreenTracker({ filter: 'oneEuro', minCutoff: 1, beta: 0.1 });
  euro.setCalibration([BUILTIN, BENQ]);
  euro.update({ yaw: 0, pitch: 0 }, 0);
  assert.equal(euro.update({ yaw: 30, pitch: 0 }, 50).screen, 2, 'one reading is enough to cross over');

  const ema = new ScreenTracker({ filter: 'ema', smoothing: 0.35 });
  ema.setCalibration([BUILTIN, BENQ]);
  ema.update({ yaw: 0, pitch: 0 }, 0);
  assert.equal(ema.update({ yaw: 30, pitch: 0 }, 50).screen, 1, 'the EMA is still on the way');
});

test('spoken labels are short, and tell identical monitors apart', () => {
  assert.deepEqual(
    spokenLabels([
      { id: 1, name: 'Built-in Retina Display', x: 0, builtin: true },
      { id: 2, name: 'BenQ GW2480', x: 1440, builtin: false },
    ]),
    { 1: 'laptop', 2: 'BenQ' },
  );
  assert.deepEqual(
    spokenLabels([
      { id: 5, name: 'DELL U2720Q', x: 1920 },
      { id: 4, name: 'DELL U2720Q', x: 0 },
    ]),
    { 4: 'left DELL', 5: 'right DELL' },
  );
});

// ------------------------------------------------- the screen a pinch means

test('a pinch aims at the screen faced during its own hold', () => {
  const history = [{ t: 0, screen: 1 }, { t: 1000, screen: 2 }];
  // Turned to screen 2 at 1000, pinched from 1100 to 1300: screen 2.
  assert.deepEqual(screenDuring(history, 1100, 1300), { screen: 2, share: 1 });
  // Pinched entirely before the turn: screen 1, even if the head moves after.
  assert.deepEqual(screenDuring(history, 700, 950), { screen: 1, share: 1 });
});

test('mid-turn, with no screen holding most of the hold, it answers nothing', () => {
  const history = [{ t: 0, screen: 1 }, { t: 1000, screen: null }, { t: 1100, screen: 2 }];
  assert.equal(screenDuring(history, 950, 1150), null);
  assert.equal(screenDuring(history, 950, 1150, { minShare: 0.2 }).screen, null, 'the longest stretch faced nothing');
});

test('facing no screen for most of the hold is an answer too', () => {
  const history = [{ t: 0, screen: null }];
  assert.deepEqual(screenDuring(history, 100, 300), { screen: null, share: 1 });
  assert.equal(screenDuring([], 100, 300), null);
  assert.equal(screenDuring(history, 300, 300), null);
});

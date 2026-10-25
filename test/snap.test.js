import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRACTICE_DEFAULTS,
  SnapDetector,
  SnapPractice,
  decodeFrame,
  encodeFrame,
  replaySnaps,
  snapFeatures,
  snapPracticePlan,
  summarizeSnapPractice,
} from '../public/snap.js';
import { seededRandom } from '../public/stats.js';
import { buildHand } from './hand-fixture.js';

// Made-up hands only prove the rules do what they say: where the test puts the
// thumb decides the outcome. Real traces from snap practice are what tune them.

// Thumb pressed on the middle fingertip, middle finger out, index out beside it.
const setHand = (opts = {}) =>
  buildHand({ pose: 'point', fingers: { index: 'extended', middle: 'pinching' }, thumb: { x: -0.08, y: 1.5 }, ...opts });

// A frame later: the middle finger folded into the palm, the thumb slid forward.
const snappedHand = (opts = {}) =>
  buildHand({ pose: 'point', fingers: { index: 'extended', middle: 'curled' }, thumb: { x: -0.5, y: 1.15 }, ...opts });

/** Feed [t, pts] frames; returns each frame's answer. */
function run(frames, options) {
  const detector = new SnapDetector(options);
  return frames.map(([t, pts]) => detector.update(pts, t));
}

/** A set held for `holdMs`, at `fps`, ending at the returned time. */
function heldSet(fps, holdMs = 100, opts = {}) {
  const step = 1000 / fps;
  const frames = [];
  for (let t = 0; t <= holdMs; t += step) frames.push([t, setHand(opts)]);
  return { frames, end: frames[frames.length - 1][0], step };
}

const snapped = (answers) => answers.filter((a) => a.snap).length;

test('the fixture hands measure as intended', () => {
  const set = snapFeatures(setHand());
  assert.ok(set.gap < 0.35 && set.gap < set.indexGap && set.reach > 1.3, JSON.stringify(set));
  const after = snapFeatures(snappedHand());
  assert.ok(set.reach - after.reach >= 0.4, JSON.stringify(after));
});

test('a set, then the finger in the palm on the next frame, is a snap at 30 and 60 fps', () => {
  for (const fps of [30, 60]) {
    const { frames, end, step } = heldSet(fps);
    const answers = run([...frames, [end + step, snappedHand()]]);
    assert.equal(answers.at(-2).state, 'set', `${fps} fps`);
    assert.equal(answers.at(-1).snap, true, `${fps} fps`);
    assert.equal(snapped(answers), 1);
  }
});

test('up to two frames with no hand may sit between set and snap', () => {
  const { frames, end, step } = heldSet(30);
  const gap = (n) => Array.from({ length: n }, (_, k) => [end + step * (k + 1), null]);
  const after = (n) => [end + step * (n + 1), snappedHand()];
  assert.equal(snapped(run([...frames, ...gap(1), after(1)])), 1);
  assert.equal(snapped(run([...frames, ...gap(2), after(2)])), 1);
  assert.equal(snapped(run([...frames, ...gap(3), after(3)])), 0, 'three is too long a gap to trust');
});

test('it does not care how big the hand is or which way it points', () => {
  for (const opts of [{ scale: 0.06 }, { scale: 0.2 }, { rotation: Math.PI / 2 }, { rotation: -2.5 }]) {
    const { frames, end, step } = heldSet(30, 100, opts);
    assert.equal(snapped(run([...frames, [end + step, snappedHand(opts)]])), 1, JSON.stringify(opts));
  }
});

test('a slow opening is not a snap, even though it ends in the same place', () => {
  for (const fps of [30, 60]) {
    const { frames, end, step } = heldSet(fps);
    const steps = Math.round(300 / step);
    const opening = [];
    for (let k = 1; k <= steps; k += 1) {
      const f = k / steps;
      opening.push([
        end + k * step,
        buildHand({
          pose: 'point',
          fingers: { index: 'extended', middle: 0.5 + (-0.15 - 0.5) * f },
          thumb: { x: -0.08 + (-0.5 + 0.08) * f, y: 1.5 + (1.15 - 1.5) * f },
        }),
      ]);
    }
    assert.equal(snapped(run([...frames, ...opening])), 0, `${fps} fps`);
  }
});

test('a set with the index resting on the thumb still snaps', () => {
  // A common way to snap: the index curls over and rests on the thumb, so the
  // thumb is as close to the index tip as to the middle tip.
  const resting = (opts = {}) => buildHand({
    pose: 'point',
    fingers: { index: 0.48, middle: 'pinching' },
    thumb: { x: -0.25, y: 1.45 },
    ...opts,
  });
  const f = snapFeatures(resting());
  assert.ok(f.gap <= 0.35, `thumb on the middle tip (${f.gap.toFixed(2)})`);
  assert.ok(f.indexGap < f.gap, `and nearer still to the index tip (${f.indexGap.toFixed(2)}), which the first rule refused`);
  const frames = [];
  for (let t = 0; t <= 100; t += 33) frames.push([t, resting()]);
  frames.push([133, snappedHand()]);
  assert.equal(snapped(run(frames)), 1);
});

test('an OK sign is not a set: the thumb is on the index, not the middle', () => {
  const frames = [];
  for (let t = 0; t <= 300; t += 33) frames.push([t, buildHand({ pose: 'ok_sign' })]);
  frames.push([333, buildHand({ pose: 'fist' })]);
  const answers = run(frames);
  assert.ok(answers.every((a) => a.state === 'none'));
  assert.equal(snapped(answers), 0);
});

test('a pinch is never a set, so letting it go is not a snap', () => {
  const frames = [];
  for (let t = 0; t <= 200; t += 33) frames.push([t, buildHand({ pose: 'pinch' })]);
  frames.push([233, buildHand({ pose: 'open_palm' })]);
  const answers = run(frames);
  assert.ok(answers.every((a) => a.state === 'none'));
  assert.equal(snapped(answers), 0);
});

test('a fist is not a set, and opening it to a thumbs-up is not a snap', () => {
  // A fist also has the thumb near the middle fingertip; only the folded finger
  // tells it apart.
  const fist = snapFeatures(buildHand({ pose: 'fist' }));
  assert.ok(fist.gap < 0.35, 'the fist really is close by this measure');
  const frames = [];
  for (let t = 0; t <= 200; t += 33) frames.push([t, buildHand({ pose: 'fist' })]);
  frames.push([233, buildHand({ pose: 'fist', thumb: 'out' })]);
  assert.equal(snapped(run(frames)), 0);
});

test('a set held but never released stays a set', () => {
  const { frames } = heldSet(30, 1000);
  const answers = run(frames);
  assert.equal(answers.at(-1).state, 'set');
  assert.equal(snapped(answers), 0);
});

test('a set too brief to be held does not arm', () => {
  assert.equal(snapped(run([[0, setHand()], [33, snappedHand()]])), 0);
});

test('a second snap within 800 ms is ignored, and one after it counts', () => {
  const sequence = (start) => {
    const { frames, end, step } = heldSet(30);
    return [...frames.map(([t, p]) => [start + t, p]), [start + end + step, snappedHand()]];
  };
  assert.equal(snapped(run([...sequence(0), ...sequence(300)])), 1);
  assert.equal(snapped(run([...sequence(0), ...sequence(1000)])), 2);
});

// ------------------------------------------------------------ snap practice

test('a frame survives being saved as thousandths', () => {
  const pts = setHand();
  const { ms, pts: back } = decodeFrame(encodeFrame(12.4, pts));
  assert.equal(ms, 12);
  assert.equal(back.length, 21);
  assert.ok(Math.abs(back[12].x - pts[12].x) <= 0.0005);
  assert.deepEqual(decodeFrame(encodeFrame(40, null)), { ms: 40, pts: null });
});

test('the plan is ten snaps, then a stretch of not snapping', () => {
  const plan = snapPracticePlan({ rng: seededRandom(1) });
  assert.equal(plan.filter((t) => t.kind === 'snap').length, 10);
  assert.equal(plan.at(-1).kind, 'free');
  for (const t of plan.filter((x) => x.kind === 'snap')) {
    assert.ok(t.foreperiodMs >= 800 && t.foreperiodMs <= 1500);
  }
});

/**
 * Drive a practice run at 30 fps on a fake clock. `handAt(trial, msFromGo)`
 * returns the hand to show; the live detector runs on it like in the app.
 */
function drive(options, handAt) {
  const plan = snapPracticePlan({ rng: seededRandom(7), ...options });
  const runner = new SnapPractice(plan, options);
  const detector = new SnapDetector();
  const commands = [];
  let goAt = null;
  for (let now = 0; now < 120000 && !runner.finished; now += 33) {
    const trial = runner.trial;
    const pts = goAt === null ? buildHand({ pose: 'open_palm' }) : handAt(trial, now - goAt);
    const { snap } = detector.update(pts, now);
    for (const c of runner.tick(now, { pts, snap })) {
      commands.push(c);
      if (c.type === 'say') runner.speechEnded(now + 400);
      if (c.type === 'chime') goAt = now;
      if (c.type === 'save') goAt = c.record.trial === 'free' ? goAt : null;
    }
  }
  return { commands, records: commands.filter((c) => c.type === 'save').map((c) => c.record) };
}

// Snap 400 ms after the chime on snap trials; just an open hand otherwise.
const snapAt400 = (trial, ms) => {
  if (trial?.kind !== 'snap') return buildHand({ pose: 'open_palm' });
  if (ms < 250) return buildHand({ pose: 'open_palm' });
  return ms < 400 ? setHand() : snappedHand();
};

test('practice saves one record per snap trial and per chunk of free movement', () => {
  const { commands, records } = drive({ snaps: 3, freeChunks: 2 }, snapAt400);
  assert.equal(records.filter((r) => r.trial === 'snap').length, 3);
  assert.equal(records.filter((r) => r.trial === 'free').length, 2);
  assert.equal(commands.at(-1).type, 'done');

  const first = records[0];
  assert.equal(first.kind, 'snap');
  assert.ok(first.detectedMs >= 380 && first.detectedMs <= 450, `detected at ${first.detectedMs}`);
  assert.ok(first.frames.length <= PRACTICE_DEFAULTS.maxFrames);
  assert.ok(first.frames[0][0] < 0, 'frames from before the chime are kept, so a replay sees the set');
  assert.ok(JSON.stringify(first).length < 32 * 1024);
});

test('the summary counts hits and misfires, and a replay can change the answer', () => {
  const { records } = drive({ snaps: 4, freeChunks: 3 }, snapAt400);
  const summary = summarizeSnapPractice(records);
  assert.equal(summary.trials, 4);
  assert.equal(summary.hits, 4);
  assert.equal(summary.misfires, 0);
  assert.equal(summary.freeSeconds, 6);
  assert.equal(summary.misfiresPerMin, 0);

  assert.equal(replaySnaps(records).hits, 4, 'the same settings find the same snaps');
  assert.equal(replaySnaps(records, { minDrop: 2 }).hits, 0, 'an impossible drop finds none');
});

test('stopping practice saves why, and says done', () => {
  const runner = new SnapPractice(snapPracticePlan({ rng: seededRandom(1) }));
  runner.tick(0, { pts: null, snap: false });
  const out = runner.abort(10, 'cancelled');
  assert.equal(out[0].record.kind, 'aborted');
  assert.equal(out[1].type, 'done');
  assert.deepEqual(runner.abort(20, 'again'), []);
});

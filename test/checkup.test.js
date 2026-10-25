import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKUP_DEFAULTS,
  CheckupRunner,
  checkupPlan,
  gateA,
  replayFacing,
  scoreFacing,
  summarizeCheckup,
} from '../public/checkup.js';
import { seededRandom } from '../public/stats.js';

const LABELS = { 1: 'laptop', 2: 'BenQ' };
const STEP = 25; // a 40 fps camera; the face model reports every other frame

/**
 * Drive a runner with a fake clock, the way app.js does from camera frames.
 *
 * `world(t, runner)` returns what the camera "sees" this frame:
 * `{ screen, yaw, view, pattern }`. Speech takes `speechMs` to finish, or never
 * when it is null.
 */
function simulate(plan, world, { speechMs = 300, maxMs = 60000, options } = {}) {
  const runner = new CheckupRunner(plan, options);
  const log = [];
  let speechEndsAt = null;
  for (let t = 0; t <= maxMs && !runner.finished; t += STEP) {
    if (speechEndsAt !== null && t >= speechEndsAt) {
      runner.speechEnded(t);
      speechEndsAt = null;
    }
    const seen = world(t, runner);
    const faceAt = t - (t % 50);
    const commands = runner.tick(t, {
      head: seen.yaw === null ? null : { yaw: seen.yaw ?? 0, pitch: 0 },
      headAt: faceAt,
      facing: { screen: seen.screen ?? null, pose: { yaw: seen.yaw ?? 0, pitch: 0 }, distance: 2 },
      view: seen.view ?? { handPresent: false },
      pattern: seen.pattern ?? null,
      movement: seen.movement ?? null,
      covered: seen.covered ?? false,
    });
    for (const command of commands) {
      log.push({ t, ...command });
      if (command.type === 'say' && speechMs !== null) speechEndsAt = t + speechMs;
    }
  }
  return { runner, log, saved: log.filter((c) => c.type === 'save').map((c) => c.record) };
}

/** Time since the go chime, or -Infinity before it. */
const sinceGo = (t, runner) => (runner.phase === 'observe' || runner.phase === 'gap' ? t - runner.goAt : -Infinity);

const facingTrial = (target, foreperiodMs = 1000) => ({ i: 0, kind: 'facing', target, say: `look at ${LABELS[target]}`, foreperiodMs });
const poseTrial = (target, foreperiodMs = 1000) => ({ i: 0, kind: 'pose', target, say: target, foreperiodMs });

test('the plan turns your head on every facing trial, and asks for each pose in turn', () => {
  const plan = checkupPlan({ screens: [1, 2], labels: LABELS, rng: seededRandom(3) });
  const facing = plan.filter((t) => t.kind === 'facing');
  const poses = plan.filter((t) => t.kind === 'pose');

  assert.equal(facing.length, CHECKUP_DEFAULTS.facingTrials + CHECKUP_DEFAULTS.awayTrials);
  assert.equal(poses.length, CHECKUP_DEFAULTS.poseTrials * 7);
  assert.notEqual(facing[0].target, null, 'it opens on a screen');
  assert.equal(facing.filter((t) => t.target === null).length, 2);

  for (let i = 1; i < facing.length; i += 1) {
    const [a, b] = [facing[i - 1].target, facing[i].target];
    if (a !== null && b !== null) assert.notEqual(a, b, `trials ${i - 1} and ${i} ask for the same screen`);
  }
  assert.ok(facing.some((t) => t.say === 'look at BenQ'));
  assert.deepEqual(poses.slice(0, 7).map((t) => t.target), ['pinch', 'ok_sign', 'grab', 'cover', 'shh', 'swipe_up', 'swipe_down']);
  assert.ok(plan.every((t) => t.foreperiodMs >= 800 && t.foreperiodMs <= 1500));
  assert.deepEqual(plan.map((t) => t.i), plan.map((_, i) => i));
});

test('a facing trial: cue, a wait, the chime, then a scored look with its trace', () => {
  const { log, saved } = simulate([facingTrial(2)], (t, r) => ({ screen: sinceGo(t, r) >= 300 ? 2 : 1, yaw: sinceGo(t, r) >= 300 ? 30 : 0 }));
  const types = log.map((c) => c.type);
  assert.deepEqual(types.filter((x) => x !== 'status'), ['say', 'chime', 'save', 'done']);

  const say = log.find((c) => c.type === 'say');
  const go = log.find((c) => c.type === 'chime');
  assert.equal(go.cue, 'go');
  // Speech is kept out of the timing: the wait starts when the words end.
  assert.ok(go.t - say.t >= 300 + 1000 && go.t - say.t <= 300 + 1000 + STEP);

  const [record] = saved;
  assert.equal(record.kind, 'facing');
  assert.equal(record.answer, 2);
  assert.equal(record.correct, true);
  assert.ok(record.settleMs >= 300 && record.settleMs <= 350);
  assert.ok(record.trace[0][0] < 0, 'readings from before the chime are kept for replays');
});

test('if speech never reports finishing, the trial still goes on', () => {
  const { log } = simulate([facingTrial(1)], () => ({ screen: 1 }), { speechMs: null });
  const say = log.find((c) => c.type === 'say');
  const go = log.find((c) => c.type === 'chime');
  assert.ok(go.t - say.t >= CHECKUP_DEFAULTS.cueTimeoutMs + 1000);
});

test('an away trial is right when it reads no screen', () => {
  const { saved } = simulate([facingTrial(null)], () => ({ screen: null, yaw: 0 }));
  assert.equal(saved[0].answer, null);
  assert.equal(saved[0].correct, true);
});

test('a late turn is wrong at the answer time, and settles later', () => {
  const { saved } = simulate([facingTrial(2)], (t, r) => ({ screen: sinceGo(t, r) >= 1150 ? 2 : 1 }));
  assert.equal(saved[0].answer, 1);
  assert.equal(saved[0].correct, false);
  assert.ok(saved[0].settleMs >= 1150);
});

test('settling needs a stable stretch, not a last-frame flicker', () => {
  const trace = [[0, 0, 0, 1], [500, 0, 0, 1], [1450, 0, 0, 2], [1500, 0, 0, 2]];
  assert.equal(scoreFacing(trace, 2, CHECKUP_DEFAULTS).settleMs, null);
});

test('a pinch is measured with its real hold, from the chime to the fire', () => {
  const { saved } = simulate([poseTrial('pinch')], (t, r) => {
    const s = sinceGo(t, r);
    const shape = s >= 200 ? 'pinch' : null;
    return { view: { handPresent: s >= 0, shape, gesture: s >= 400 && s < 425 ? 'pinch' : null } };
  });
  const [record] = saved;
  assert.equal(record.success, true);
  assert.equal(record.shapeMs, 200);
  assert.equal(record.firedMs, 400);
  assert.ok(record.seen.pinch > 0);
});

test('horns, not yet a gesture, counts once its finger pattern is held', () => {
  const { saved } = simulate([poseTrial('horns')], (t, r) => {
    const s = sinceGo(t, r);
    return { view: { handPresent: true, shape: null }, pattern: s >= 100 ? 'I--P' : '----' };
  });
  assert.equal(saved[0].success, true);
  assert.ok(saved[0].firedMs >= 100 + CHECKUP_DEFAULTS.patternHoldMs);
  assert.ok(saved[0].firedMs <= 100 + CHECKUP_DEFAULTS.patternHoldMs + STEP);
});

test('closing your hand counts when the movement fires, not when a fist is held', () => {
  const { saved } = simulate([poseTrial('grab')], (t, r) => {
    const s = sinceGo(t, r);
    return { view: { handPresent: true, shape: s >= 300 ? 'fist' : 'open_palm' }, movement: s >= 300 && s < 325 ? 'grab' : null };
  });
  assert.equal(saved[0].success, true);
  assert.equal(saved[0].firedMs, 300);
});

test('covering the camera counts when the cover fires, after it was uncovered first', () => {
  const { saved, log } = simulate([poseTrial('cover')], (t, r) => {
    const s = sinceGo(t, r);
    if (t < 1500) return { covered: true };
    return { covered: s >= 200, movement: s >= 1200 && s < 1225 ? 'cover' : null };
  });
  const say = log.find((c) => c.type === 'say');
  assert.ok(say.t >= 1500 + CHECKUP_DEFAULTS.releaseMs, 'it waits for the lens to be uncovered first');
  assert.equal(saved[0].success, true);
  assert.equal(saved[0].firedMs, 1200);
});

test('palm up counts when the recogniser reports the flick, and shh like a pose', () => {
  const up = simulate([poseTrial('swipe_up')], (t, r) => {
    const s = sinceGo(t, r);
    return { view: { handPresent: true, shape: 'open_palm', gesture: s >= 500 && s < 525 ? 'swipe_up' : null } };
  });
  assert.equal(up.saved[0].success, true);
  assert.equal(up.saved[0].firedMs, 500);

  const shh = simulate([poseTrial('shh')], (t, r) => {
    const s = sinceGo(t, r);
    return { view: { handPresent: true, shape: s >= 200 ? 'shh' : null, gesture: s >= 600 && s < 625 ? 'shh' : null } };
  });
  assert.equal(shh.saved[0].success, true);
  assert.equal(shh.saved[0].shapeMs, 200);
});

test('a missed pose times out, and says what the hand was taken for', () => {
  const { saved, log } = simulate([poseTrial('horns')], () => ({ view: { handPresent: true, shape: null }, pattern: 'I-RP' }));
  const go = log.find((c) => c.type === 'chime');
  const save = log.find((c) => c.type === 'save');
  assert.equal(saved[0].success, false);
  assert.equal(saved[0].firedMs, null);
  assert.ok(save.t - go.t >= CHECKUP_DEFAULTS.poseTimeoutMs);
  assert.ok(saved[0].patterns['I-RP'] > 0, 'the ring finger came up with the pinky');
});

test('a pose already held when the trial starts must be let go first', () => {
  const { log } = simulate([poseTrial('horns')], (t) => ({ pattern: t < 2000 ? 'I--P' : '----', view: { handPresent: true } }));
  const say = log.find((c) => c.type === 'say');
  assert.ok(say.t >= 2000 + CHECKUP_DEFAULTS.releaseMs);
});

test('abort saves what happened and ends', () => {
  const runner = new CheckupRunner([facingTrial(1)]);
  runner.tick(0, {});
  const out = runner.abort(10, 'cancelled');
  assert.equal(out[0].record.kind, 'aborted');
  assert.equal(out[0].record.reason, 'cancelled');
  assert.deepEqual(out[1], { type: 'done', aborted: true });
  assert.deepEqual(runner.tick(20, {}), []);
});

test('the summary and the gate read the records honestly', () => {
  const records = [
    { kind: 'facing', target: 1, answer: 1, correct: true, settleMs: 200, restJitter: 0.4, smoothJitter: 0.2, faceFrac: 1 },
    { kind: 'facing', target: 2, answer: 1, correct: false, settleMs: null, restJitter: 0.6, smoothJitter: 0.3, faceFrac: 1 },
    { kind: 'facing', target: null, answer: null, correct: true, settleMs: 0, restJitter: 0.5, smoothJitter: 0.2, faceFrac: 1 },
    { kind: 'pose', target: 'pinch', success: true, shapeMs: 300, firedMs: 500, seen: { pinch: 10, fist: 2 } },
    { kind: 'pose', target: 'pinch', success: false, shapeMs: null, firedMs: null, seen: { fist: 12 } },
    { kind: 'pose', target: 'horns', success: true, shapeMs: 100, firedMs: 600, patterns: { 'I--P': 20, 'I-RP': 3 } },
  ];
  const calibration = [{ id: 1, name: 'Built-in', yaw: 0, pitch: 0, spread: 0.8 }, { id: 2, name: 'BenQ', yaw: 30, pitch: 0, spread: 1.1 }];
  const s = summarizeCheckup(records, { calibration });

  assert.equal(s.facing.accuracy, 0.5);
  assert.equal(s.facing.awayNullRate, 1);
  assert.equal(s.poses.pinch.successRate, 0.5);
  assert.equal(s.poses.pinch.topConfusion, 'fist');
  assert.equal(s.poses.horns.topConfusion, 'I-RP');
  assert.equal(s.separation[0].deg, 30);

  const gate = gateA(s);
  const byName = Object.fromEntries(gate.map((g) => [g.name, g]));
  assert.equal(byName['Facing accuracy'].pass, false);
  assert.equal(byName['Away reads as no screen'].pass, true);
  assert.equal(byName['Pinch fires within'].pass, true);
});

test('a replay through a faster filter settles sooner on the same head', () => {
  // A head turning 30° to the BenQ right at the chime, read at 20 Hz.
  const trace = [];
  for (let ms = -500; ms <= 1500; ms += 50) trace.push([ms, ms < 0 ? 0 : 30, 0, null, null, null]);
  const records = [{ kind: 'facing', target: 2, trace }];
  const calibration = [{ id: 1, name: 'laptop', yaw: 0, pitch: 0 }, { id: 2, name: 'BenQ', yaw: 30, pitch: 0 }];

  const raw = replayFacing(records, calibration, { filter: 'none' });
  const ema = replayFacing(records, calibration, { filter: 'ema', smoothing: 0.35 });
  const euro = replayFacing(records, calibration, { filter: 'oneEuro', minCutoff: 1, beta: 0.1 });

  assert.equal(raw.accuracy, 1);
  assert.equal(ema.accuracy, 1);
  assert.equal(euro.accuracy, 1);
  assert.equal(raw.settleMedian, 0);
  assert.ok(euro.settleMedian < ema.settleMedian, `1€ ${euro.settleMedian} ms vs EMA ${ema.settleMedian} ms`);
});

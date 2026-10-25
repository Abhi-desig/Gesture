// The check-up: a few minutes of prompted trials that measure, on a real face
// and a real hand at a real desk, the three things Spatial Desk depends on.
//
//   1. Does it know which screen you face?   (facing trials, plus "away" ones)
//   2. Does it see the gestures it needs?     (pinch, OK sign, close your hand,
//                                              cover the camera: the locked v2 set;
//                                              shh and swipe up/down: office additions)
//   3. How steady is the head reading?        (calibration spread, jitter at rest)
//
// It exists because the first version was designed without any of these
// numbers, and in its first real session fired nothing in 80 seconds. Nothing
// is redesigned until this says what to change.
//
// Pure: no DOM, no timers, no network. `CheckupRunner.tick()` is fed every
// camera frame and answers with commands (say this, play the go chime, save
// this record) that app.js carries out. Frames rather than setTimeout because
// the page is usually hidden while you look at other screens, and Chrome
// throttles a hidden page's timers to as little as once a minute — the camera
// worker's messages keep arriving regardless.
//
// Each trial: cue (spoken), a random wait, then a chime. Time zero is the
// chime. Speech takes a variable 100–500 ms to start and finish, so it is kept
// out of every timed interval; the random wait stops anyone timing the chime.

import { fingerPattern } from './gestures.js';
import { ScreenTracker, angleBetween, summarizeHead } from './screens.js';
import { median, randomBetween } from './stats.js';

export const CHECKUP_DEFAULTS = {
  facingTrials: 12,
  awayTrials: 2,
  poseTrials: 6,
  poses: ['pinch', 'ok_sign', 'grab', 'cover', 'shh', 'swipe_up', 'swipe_down'],
  // Random wait between the end of the cue and the chime.
  forePeriodMs: [800, 1500],
  // When the facing answer is read, after the chime: a deliberate look, not a reflex.
  answerAtMs: 1000,
  observeMs: 1500,
  // Head readings kept from before the chime, so a replay can warm its filter up.
  preMs: 500,
  poseTimeoutMs: 3000,
  // A pose trial waits for the hand to leave the target shape first, so a
  // shape carried over from the last trial can't count.
  releaseMs: 300,
  releaseTimeoutMs: 5000,
  // Candidate shapes that are not gestures yet (POSE_PATTERNS, such as horns or
  // peace) count once held this long: the hold an arming gesture would get.
  patternHoldMs: 500,
  // If speech never reports finishing, move on anyway.
  cueTimeoutMs: 4000,
  gapMs: 600,
  // How long the tracker must sit on the target, to the end of the window, to
  // call the head "settled".
  settleMinMs: 300,
};

/**
 * Candidate poses measured by finger pattern, before any is built in. None of
 * the locked set needs it; it stays for trying the next candidate.
 */
export const POSE_PATTERNS = { horns: 'I--P', peace: 'IM--' };

const POSE_WORDS = {
  pinch: 'pinch',
  ok_sign: 'OK sign',
  grab: 'close your hand',
  cover: 'cover the camera',
  shh: 'shh, a finger on your lips',
  swipe_up: 'swipe up',
  swipe_down: 'swipe down',
  horns: 'horns',
  peace: 'peace sign',
  fist: 'fist',
  open_palm: 'open hand',
};

/** Proposed pass marks. Proposals, not facts — the gate exists to be argued with. */
export const GATE_A = [
  { name: 'Facing accuracy', key: (s) => s.facing.accuracy, min: 0.95, format: 'percent' },
  { name: 'Away reads as no screen', key: (s) => s.facing.awayNullRate, min: 0.8, format: 'percent' },
  { name: 'Pinch success', key: (s) => s.poses.pinch?.successRate, min: 0.9, format: 'percent' },
  { name: 'OK sign success', key: (s) => s.poses.ok_sign?.successRate, min: 0.9, format: 'percent' },
  { name: 'Close your hand success', key: (s) => s.poses.grab?.successRate, min: 0.9, format: 'percent' },
  { name: 'Cover the camera success', key: (s) => s.poses.cover?.successRate, min: 0.9, format: 'percent' },
  // A candidate: no study tests a "shh" for mute. It stays only if it passes.
  { name: 'Shh success', key: (s) => s.poses.shh?.successRate, min: 0.9, format: 'percent' },
  { name: 'Swipe up success', key: (s) => s.poses.swipe_up?.successRate, min: 0.9, format: 'percent' },
  { name: 'Swipe down success', key: (s) => s.poses.swipe_down?.successRate, min: 0.9, format: 'percent' },
  { name: 'Pinch fires within', key: (s) => s.poses.pinch?.firedMedian, max: 800, format: 'ms' },
];

/**
 * The trials, in order: facing first (screens and a couple of "away" looks),
 * then poses in rotation.
 *
 * @param {object} args
 * @param {number[]} args.screens Calibrated, connected display ids.
 * @param {Record<number,string>} args.labels Spoken names, from spokenLabels().
 * @param {() => number} args.rng Seeded, from stats.seededRandom().
 */
export function checkupPlan({ screens, labels, rng, ...options }) {
  const o = { ...CHECKUP_DEFAULTS, ...options };
  const trials = [];
  const fore = () => randomBetween(rng, o.forePeriodMs[0], o.forePeriodMs[1]);

  // Every facing trial needs a turn: never the same screen twice in a row.
  let previous = null;
  const facing = [];
  for (let i = 0; i < o.facingTrials && screens.length > 0; i += 1) {
    const choices = screens.length > 1 ? screens.filter((s) => s !== previous) : screens;
    previous = choices[Math.floor(rng() * choices.length)];
    facing.push(previous);
  }
  // "Away" looks go anywhere but first, so the run opens on a screen.
  for (let k = 0; k < o.awayTrials && facing.length > 0; k += 1) {
    facing.splice(1 + Math.floor(rng() * facing.length), 0, null);
  }
  for (const target of facing) {
    trials.push({
      kind: 'facing',
      target,
      say: target === null ? 'look at your keyboard' : `look at ${labels[target] ?? `screen ${target}`}`,
      foreperiodMs: fore(),
    });
  }

  for (let round = 0; round < o.poseTrials; round += 1) {
    for (const pose of o.poses) {
      trials.push({ kind: 'pose', target: pose, say: POSE_WORDS[pose] ?? pose, foreperiodMs: fore() });
    }
  }
  return trials.map((t, i) => ({ i, ...t }));
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/**
 * Score one facing trial from its trace.
 *
 * @param {Array<[number, number|null, number|null, number|null, number|null, number|null]>} trace
 *   `[ms from chime, raw yaw, raw pitch, tracker screen, filtered yaw, filtered pitch]`.
 * @param {number|null} target A display id, or null for an "away" trial.
 */
export function scoreFacing(trace, target, { answerAtMs, observeMs, settleMinMs } = CHECKUP_DEFAULTS) {
  const after = trace.filter(([ms]) => ms >= 0 && ms <= observeMs);
  const atAnswer = [...after].reverse().find(([ms]) => ms <= answerAtMs) ?? null;
  const answer = atAnswer ? atAnswer[3] : null;

  // Settled: from this reading to the end of the window, the tracker never
  // left the target — and that stretch lasted long enough to mean it.
  let settleMs = null;
  for (let i = after.length - 1; i >= 0 && after[i][3] === target; i -= 1) settleMs = after[i][0];
  if (settleMs !== null && after.length > 0 && after[after.length - 1][0] - settleMs < settleMinMs) settleMs = null;

  const tail = after.filter(([ms]) => ms >= observeMs - 500);
  const raw = tail.filter((e) => e[1] !== null).map((e) => ({ yaw: e[1], pitch: e[2] }));
  const smooth = tail.filter((e) => e[4] !== null).map((e) => ({ yaw: e[4], pitch: e[5] }));

  return {
    answer,
    correct: answer === target,
    settleMs,
    faceFrac: after.length ? after.filter((e) => e[1] !== null).length / after.length : 0,
    restJitter: round1(summarizeHead(raw)?.spread),
    smoothJitter: round1(summarizeHead(smooth)?.spread),
  };
}

/**
 * Run the check-up, one camera frame at a time.
 *
 * obs, per frame: `{ head, headAt, facing, view, pattern, movement, covered }`
 * — the raw head pose and when it was read, the tracker's answer, the
 * recognizer's view, fingerPattern() of the hand, a movement gesture that fired
 * this frame ('grab' or 'cover'), and whether the lens reads as covered.
 *
 * Commands returned: `{type:'say', text}`, `{type:'chime', cue}`,
 * `{type:'save', record}`, `{type:'status', text}`, `{type:'done'}`.
 */
export class CheckupRunner {
  constructor(plan, options = {}) {
    this.plan = plan;
    this.o = { ...CHECKUP_DEFAULTS, ...options };
    this.index = 0;
    this.phase = 'start';
    this.since = 0;
    this.finished = false;
    this.buffer = [];
    this.lastHeadAt = null;
  }

  get total() {
    return this.plan.length;
  }

  get trial() {
    return this.plan[this.index] ?? null;
  }

  /** The speech for the current cue has finished (or failed). */
  speechEnded(now) {
    if (this.phase === 'cue') this.#enter('fore', now);
  }

  abort(now, reason) {
    if (this.finished) return [];
    this.finished = true;
    return [
      { type: 'save', record: { kind: 'aborted', at: this.index, of: this.total, reason } },
      { type: 'done', aborted: true },
    ];
  }

  tick(now, obs) {
    if (this.finished) return [];
    this.#remember(obs);
    const out = [];
    const trial = this.trial;
    const o = this.o;

    if (!trial) {
      this.finished = true;
      return [{ type: 'done' }];
    }

    switch (this.phase) {
      case 'start':
        out.push({ type: 'status', text: `${trial.i + 1}/${this.total}: ${trial.say}` });
        if (trial.kind === 'pose') {
          this.releasedSince = null;
          this.#enter('release', now);
        } else {
          out.push({ type: 'say', text: trial.say });
          this.#enter('cue', now);
        }
        break;

      case 'release': {
        const holding = this.#inShape(trial.target, obs);
        if (holding) this.releasedSince = null;
        else this.releasedSince ??= now;
        const released = this.releasedSince !== null && now - this.releasedSince >= o.releaseMs;
        if (released || now - this.since >= o.releaseTimeoutMs) {
          this.released = released;
          out.push({ type: 'say', text: trial.say });
          this.#enter('cue', now);
        }
        break;
      }

      case 'cue':
        if (now - this.since >= o.cueTimeoutMs) this.#enter('fore', now);
        break;

      case 'fore':
        if (now - this.since >= trial.foreperiodMs) {
          out.push({ type: 'chime', cue: 'go' });
          this.goAt = now;
          this.observed = { frames: 0, hand: 0, seen: {}, patterns: {}, shapeAt: null, patternSince: null, firedAt: null };
          this.#enter('observe', now);
        }
        break;

      case 'observe': {
        const record = trial.kind === 'facing' ? this.#observeFacing(now) : this.#observePose(now, obs);
        if (record) {
          out.push({ type: 'save', record });
          this.#enter('gap', now);
        }
        break;
      }

      case 'gap':
        if (now - this.since >= o.gapMs) {
          this.index += 1;
          this.#enter('start', now);
          if (!this.trial) {
            this.finished = true;
            out.push({ type: 'done' });
          }
        }
        break;

      default:
        break;
    }
    return out;
  }

  #enter(phase, now) {
    this.phase = phase;
    this.since = now;
  }

  /** Keep the last two seconds of head readings, once per new reading. */
  #remember(obs) {
    if (obs.headAt === undefined || obs.headAt === null || obs.headAt === this.lastHeadAt) return;
    this.lastHeadAt = obs.headAt;
    this.buffer.push({
      t: obs.headAt,
      yaw: obs.head?.yaw ?? null,
      pitch: obs.head?.pitch ?? null,
      screen: obs.facing?.screen ?? null,
      fyaw: obs.facing?.pose?.yaw ?? null,
      fpitch: obs.facing?.pose?.pitch ?? null,
      distance: obs.facing?.distance ?? null,
    });
    while (this.buffer.length > 0 && this.buffer[0].t < obs.headAt - 2000) this.buffer.shift();
  }

  #inShape(target, obs) {
    // Movements have no shape of their own: "in it" means where they end.
    if (target === 'cover') return obs.covered === true;
    if (target === 'grab') return obs.view?.shape === 'fist';
    const pattern = POSE_PATTERNS[target];
    return pattern ? obs.pattern === pattern : obs.view?.shape === target;
  }

  #observeFacing(now) {
    const { observeMs, preMs } = this.o;
    if (now - this.goAt < observeMs) return null;

    const trial = this.trial;
    const entries = this.buffer.filter((e) => e.t >= this.goAt - preMs && e.t <= this.goAt + observeMs);
    const trace = entries.map((e) => [
      Math.round(e.t - this.goAt), round1(e.yaw), round1(e.pitch), e.screen, round1(e.fyaw), round1(e.fpitch),
    ]);
    const score = scoreFacing(trace, trial.target, this.o);
    const atAnswer = [...entries].reverse().find((e) => e.t - this.goAt <= this.o.answerAtMs);
    return {
      kind: 'facing',
      i: trial.i,
      target: trial.target,
      foreperiodMs: trial.foreperiodMs,
      ...score,
      distance: round1(atAnswer?.distance),
      trace,
    };
  }

  #observePose(now, obs) {
    const trial = this.trial;
    const s = this.observed;
    const elapsed = now - this.goAt;
    const view = obs.view ?? {};
    const pattern = POSE_PATTERNS[trial.target];

    s.frames += 1;
    if (view.handPresent) s.hand += 1;
    const shapeKey = view.handPresent ? (view.shape ?? 'none') : 'no hand';
    s.seen[shapeKey] = (s.seen[shapeKey] ?? 0) + 1;
    const patternKey = obs.pattern ?? 'no hand';
    s.patterns[patternKey] = (s.patterns[patternKey] ?? 0) + 1;

    const inShape = this.#inShape(trial.target, obs);
    if (inShape && s.shapeAt === null) s.shapeAt = elapsed;

    let success = false;
    if (pattern) {
      // Not a gesture yet: count it once held for the hold an arming pose would get.
      if (inShape) s.patternSince ??= elapsed;
      else s.patternSince = null;
      success = s.patternSince !== null && elapsed - s.patternSince >= this.o.patternHoldMs;
    } else {
      success = view.gesture === trial.target || obs.movement === trial.target;
    }
    if (success) s.firedAt = elapsed;

    if (!success && elapsed < this.o.poseTimeoutMs) return null;
    return {
      kind: 'pose',
      i: trial.i,
      target: trial.target,
      foreperiodMs: trial.foreperiodMs,
      released: this.released !== false,
      success,
      shapeMs: s.shapeAt === null ? null : Math.round(s.shapeAt),
      firedMs: s.firedAt === null ? null : Math.round(s.firedAt),
      handPresentFrac: s.frames ? round1((s.hand / s.frames) * 100) / 100 : 0,
      seen: s.seen,
      patterns: s.patterns,
    };
  }
}

/**
 * Turn the saved records into the numbers the gate is judged on.
 *
 * @param {object[]} records facing and pose records from one session.
 * @param {{calibration?: object[], maxAngle?: number}} context
 */
export function summarizeCheckup(records, { calibration = [] } = {}) {
  const facing = records.filter((r) => r.kind === 'facing');
  const onScreen = facing.filter((r) => r.target !== null);
  const away = facing.filter((r) => r.target === null);

  const perScreen = {};
  for (const r of onScreen) {
    perScreen[r.target] ??= { n: 0, correct: 0 };
    perScreen[r.target].n += 1;
    if (r.correct) perScreen[r.target].correct += 1;
  }

  const poses = {};
  for (const r of records.filter((x) => x.kind === 'pose')) {
    poses[r.target] ??= { n: 0, hits: 0, shapeMs: [], firedMs: [], confusion: {} };
    const p = poses[r.target];
    p.n += 1;
    if (r.success) p.hits += 1;
    if (r.shapeMs !== null) p.shapeMs.push(r.shapeMs);
    if (r.firedMs !== null) p.firedMs.push(r.firedMs);
    // What it was taken for, when it wasn't the target — the reason a pose fails.
    const table = POSE_PATTERNS[r.target] ? r.patterns : r.seen;
    const want = POSE_PATTERNS[r.target] ?? r.target;
    for (const [shape, n] of Object.entries(table ?? {})) {
      if (shape !== want) p.confusion[shape] = (p.confusion[shape] ?? 0) + n;
    }
  }

  const rate = (hit, n) => (n > 0 ? hit / n : null);
  const separation = [];
  for (let i = 0; i < calibration.length; i += 1) {
    for (let j = i + 1; j < calibration.length; j += 1) {
      separation.push({
        a: calibration[i].name,
        b: calibration[j].name,
        deg: round1(angleBetween(calibration[i], calibration[j])),
      });
    }
  }

  return {
    calibration: calibration.map((c) => ({ id: c.id, name: c.name, spread: round1(c.spread), samples: c.samples ?? null })),
    separation,
    facing: {
      trials: onScreen.length,
      accuracy: rate(onScreen.filter((r) => r.correct).length, onScreen.length),
      perScreen,
      awayTrials: away.length,
      awayNullRate: rate(away.filter((r) => r.answer === null).length, away.length),
      settleMedian: median(onScreen.map((r) => r.settleMs)),
      restJitter: median(facing.map((r) => r.restJitter)),
      smoothJitter: median(facing.map((r) => r.smoothJitter)),
      faceFrac: median(facing.map((r) => r.faceFrac)),
    },
    poses: Object.fromEntries(
      Object.entries(poses).map(([name, p]) => {
        const top = Object.entries(p.confusion).sort((x, y) => y[1] - x[1])[0];
        return [name, {
          n: p.n,
          successRate: rate(p.hits, p.n),
          shapeMedian: median(p.shapeMs),
          firedMedian: median(p.firedMs),
          topConfusion: top ? top[0] : null,
        }];
      }),
    ),
  };
}

/** Each gate row with its measured value and whether it passed. */
export function gateA(summary, gate = GATE_A) {
  return gate.map((g) => {
    const value = g.key(summary);
    const pass = value === null || value === undefined
      ? null
      : (g.min === undefined || value >= g.min) && (g.max === undefined || value <= g.max);
    return { name: g.name, value: value ?? null, min: g.min, max: g.max, format: g.format, pass };
  });
}

/**
 * Re-run recorded facing trials through a different tracker setting.
 *
 * The traces keep the raw head angles, so any filter can be tried on the same
 * heads after the fact — which is how the 1€ settings get chosen from data
 * instead of by feel.
 */
export function replayFacing(facingRecords, calibration, trackerOptions = {}, options = CHECKUP_DEFAULTS) {
  const replayed = facingRecords.map((r) => {
    const tracker = new ScreenTracker(trackerOptions);
    tracker.setCalibration(calibration);
    const trace = r.trace.map(([ms, yaw, pitch]) => {
      const view = tracker.update(yaw === null ? null : { yaw, pitch }, ms);
      return [ms, yaw, pitch, view.screen, view.pose?.yaw ?? null, view.pose?.pitch ?? null];
    });
    return { ...r, ...scoreFacing(trace, r.target, { ...CHECKUP_DEFAULTS, ...options }) };
  });
  return summarizeCheckup(replayed, { calibration }).facing;
}

// The finger snap, seen by a camera that can't see it.
//
// A snap is over in about 7 ms (Acharya, Challita, Bhamla & Ilton, J. R. Soc.
// Interface, 2021). The camera delivers a frame every 25–33 ms, so the motion
// itself is never in a frame. What the camera does see is the pair around it:
// the *set* (thumb pressed on the middle fingertip, middle finger out), and on
// the very next frame the middle finger already folded into the palm. That pair
// is what this detects.
//
// - "Next frame", not a time window: a hand that opens slowly also goes from set
//   to folded, but over several frames, each a small step.
// - The middle tip's distance to the *wrist* is what drops. The palm centre is
//   the wrong reference: a real snap drives the tip into the thumb's base, which
//   is far from the knuckles.
// - A set needs the middle finger out. A fist also has the thumb near the middle
//   fingertip, but folded.
//
// The starting thresholds are guesses until snap practice has been replayed
// through scripts/replay-snaps.mjs. Pure: no DOM, no timers.

import { LANDMARK, dist, handScale } from './landmarks.js';
import { median, randomBetween } from './stats.js';

export const SNAP_DEFAULTS = {
  // Thumb tip to middle tip, in palm lengths, for the set.
  setMaxGap: 0.35,
  // Middle tip to wrist, in palm lengths: the finger is out.
  setMinReach: 1.3,
  setHoldMs: 60,
  // How much closer to the wrist the middle tip is on the next frame.
  minDrop: 0.4,
  // Frames with no hand allowed between set and snap. Motion blur can make
  // MediaPipe lose the hand for a frame; that is a guess, so it is allowed for.
  maxMissingFrames: 2,
  refractoryMs: 800,
};

/** The three distances a snap is judged on, in palm lengths. */
export function snapFeatures(pts) {
  const scale = handScale(pts);
  const thumb = pts[LANDMARK.THUMB_TIP];
  return {
    gap: dist(thumb, pts[LANDMARK.MIDDLE_TIP]) / scale,
    indexGap: dist(thumb, pts[LANDMARK.INDEX_TIP]) / scale,
    reach: dist(pts[LANDMARK.MIDDLE_TIP], pts[LANDMARK.WRIST]) / scale,
  };
}

/**
 * Thumb on the middle fingertip, middle finger out.
 *
 * The index may rest on the thumb too, as it does for many people's snap, so
 * the thumb being near the index is not held against it. A pinch is kept out
 * by the middle finger instead: in a pinch it is folded, nowhere near the
 * reach a set needs.
 */
export function isSnapSet(f, o = SNAP_DEFAULTS) {
  return f.gap <= o.setMaxGap && f.reach >= o.setMinReach;
}

export class SnapDetector {
  constructor(options = {}) {
    this.o = { ...SNAP_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.setSince = null;
    // The reach of the last set frame held long enough, waiting for the next frame.
    this.armed = null;
    this.missing = 0;
    this.lastSnapAt = -Infinity;
  }

  /**
   * @param {{x:number,y:number}[]|null} pts Isotropic points, or null with no hand.
   * @returns {{state: 'none'|'set', snap: boolean}}
   */
  update(pts, now) {
    if (!pts) {
      this.setSince = null;
      if (this.armed !== null) {
        this.missing += 1;
        if (this.missing > this.o.maxMissingFrames) this.armed = null;
      }
      return { state: 'none', snap: false };
    }

    const f = snapFeatures(pts);
    const armed = this.armed;
    this.armed = null;
    this.missing = 0;

    if (armed !== null && armed - f.reach >= this.o.minDrop && now - this.lastSnapAt >= this.o.refractoryMs) {
      this.lastSnapAt = now;
      this.setSince = null;
      return { state: 'none', snap: true };
    }

    if (isSnapSet(f, this.o)) {
      this.setSince ??= now;
      if (now - this.setSince >= this.o.setHoldMs) this.armed = f.reach;
      return { state: 'set', snap: false };
    }
    this.setSince = null;
    return { state: 'none', snap: false };
  }
}

// ------------------------------------------------------------ snap practice
//
// About a minute: "snap" ten times, then twenty seconds of moving the hand
// without snapping. Built like the check-up (frame-driven, commands for app.js
// to carry out) so hit rate and misfires come from real hands, and the saved
// traces can be replayed through other thresholds.

export const PRACTICE_DEFAULTS = {
  snaps: 10,
  freeChunks: 10,
  chunkMs: 2000,
  forePeriodMs: [800, 1500],
  // After the chime, for the snap.
  windowMs: 2000,
  // Frames kept from before the chime (or the chunk), so a replay can see the set.
  preMs: 300,
  cueTimeoutMs: 4000,
  gapMs: 700,
  // A record must stay under the server's 32 kB: about 2.3 s at 60 fps.
  maxFrames: 150,
};

const FREE_SAY = 'now move your hand around. Wave, pinch, make a fist, but do not snap';

export function snapPracticePlan({ rng, ...options }) {
  const o = { ...PRACTICE_DEFAULTS, ...options };
  const trials = [];
  for (let k = 0; k < o.snaps; k += 1) {
    trials.push({ kind: 'snap', say: 'snap', foreperiodMs: randomBetween(rng, o.forePeriodMs[0], o.forePeriodMs[1]) });
  }
  trials.push({ kind: 'free', say: FREE_SAY, foreperiodMs: o.forePeriodMs[0] });
  return trials.map((t, i) => ({ i, ...t }));
}

/** Points as thousandths, so a trace is small enough to save. */
export function encodeFrame(ms, pts) {
  const frame = [Math.round(ms)];
  if (pts) for (const p of pts) frame.push(Math.round(p.x * 1000), Math.round(p.y * 1000));
  return frame;
}

export function decodeFrame(frame) {
  if (frame.length < 43) return { ms: frame[0], pts: null };
  const pts = [];
  for (let k = 1; k < frame.length; k += 2) pts.push({ x: frame[k] / 1000, y: frame[k + 1] / 1000 });
  return { ms: frame[0], pts };
}

/**
 * Commands, like CheckupRunner's: `{type:'say', text}`, `{type:'chime', cue}`,
 * `{type:'save', record}`, `{type:'status', text}`, `{type:'done'}`.
 *
 * obs, per frame: `{ pts, snap }`, the hand and whether the live detector fired.
 */
export class SnapPractice {
  constructor(plan, options = {}) {
    this.plan = plan;
    this.o = { ...PRACTICE_DEFAULTS, ...options };
    this.index = 0;
    this.phase = 'start';
    this.since = 0;
    this.finished = false;
    this.frames = [];
  }

  get total() {
    return this.plan.length;
  }

  get trial() {
    return this.plan[this.index] ?? null;
  }

  speechEnded(now) {
    if (this.phase === 'cue') this.#enter('fore', now);
  }

  abort(now, reason) {
    if (this.finished) return [];
    this.finished = true;
    return [
      { type: 'save', record: { kind: 'aborted', mode: 'snap_practice', at: this.index, of: this.total, reason } },
      { type: 'done', aborted: true },
    ];
  }

  tick(now, obs) {
    if (this.finished) return [];
    this.#remember(now, obs);
    const out = [];
    const trial = this.trial;
    const o = this.o;
    if (!trial) {
      this.finished = true;
      return [{ type: 'done' }];
    }

    switch (this.phase) {
      case 'start':
        out.push({ type: 'status', text: `${trial.i + 1}/${this.total}: ${trial.kind === 'snap' ? 'snap' : 'move freely, no snapping'}` });
        out.push({ type: 'say', text: trial.say });
        this.#enter('cue', now);
        break;

      case 'cue':
        if (now - this.since >= o.cueTimeoutMs) this.#enter('fore', now);
        break;

      case 'fore':
        if (now - this.since >= trial.foreperiodMs) {
          out.push({ type: 'chime', cue: 'go' });
          this.goAt = now;
          this.chunk = 0;
          this.#enter('observe', now);
        }
        break;

      case 'observe':
        if (trial.kind === 'snap') {
          if (now - this.goAt >= o.windowMs) {
            out.push({ type: 'save', record: this.#record(trial, this.goAt, o.windowMs) });
            this.#enter('gap', now);
          }
        } else {
          const start = this.goAt + this.chunk * o.chunkMs;
          if (now - start >= o.chunkMs) {
            out.push({ type: 'save', record: { ...this.#record(trial, start, o.chunkMs), chunk: this.chunk } });
            this.chunk += 1;
            if (this.chunk >= o.freeChunks) this.#enter('gap', now);
          }
        }
        break;

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

  #remember(now, obs) {
    this.frames.push({ t: now, pts: obs.pts ?? null, snap: obs.snap === true });
    const keep = this.o.preMs + Math.max(this.o.windowMs, this.o.chunkMs) + 500;
    while (this.frames.length > 0 && this.frames[0].t < now - keep) this.frames.shift();
  }

  /** One trial's (or chunk's) frames and the snaps the live detector saw in it. */
  #record(trial, start, lengthMs) {
    const inside = this.frames.filter((f) => f.t >= start - this.o.preMs && f.t < start + lengthMs);
    const snaps = inside.filter((f) => f.snap && f.t >= start).map((f) => Math.round(f.t - start));
    const record = {
      kind: 'snap',
      trial: trial.kind,
      i: trial.i,
      lengthMs,
      snaps,
      frames: inside.slice(-this.o.maxFrames).map((f) => encodeFrame(f.t - start, f.pts)),
    };
    if (trial.kind === 'snap') {
      record.foreperiodMs = trial.foreperiodMs;
      record.detectedMs = snaps[0] ?? null;
    }
    return record;
  }
}

/** Hits out of the snap trials, and misfires per minute of not snapping. */
export function summarizeSnapPractice(records) {
  const snapTrials = records.filter((r) => r.kind === 'snap' && r.trial === 'snap');
  const free = records.filter((r) => r.kind === 'snap' && r.trial === 'free');
  const hits = snapTrials.filter((r) => r.snaps.length > 0);
  const freeMs = free.reduce((sum, r) => sum + r.lengthMs, 0);
  const misfires = free.reduce((sum, r) => sum + r.snaps.length, 0);
  return {
    trials: snapTrials.length,
    hits: hits.length,
    hitRate: snapTrials.length ? hits.length / snapTrials.length : null,
    detectedMedian: median(hits.map((r) => r.snaps[0])),
    freeSeconds: Math.round(freeMs / 100) / 10,
    misfires,
    misfiresPerMin: freeMs > 0 ? Math.round((misfires / (freeMs / 60000)) * 10) / 10 : null,
  };
}

/** Run saved traces through a detector with other settings, then summarize. */
export function replaySnaps(records, options = {}) {
  const replayed = records
    .filter((r) => r.kind === 'snap' && Array.isArray(r.frames))
    .map((r) => {
      const detector = new SnapDetector(options);
      const snaps = [];
      for (const frame of r.frames) {
        const { ms, pts } = decodeFrame(frame);
        if (detector.update(pts, ms).snap && ms >= 0) snaps.push(ms);
      }
      return { ...r, snaps };
    });
  return summarizeSnapPractice(replayed);
}

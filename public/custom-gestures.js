// Gestures the user teaches by example, matched by nearest neighbour.
//
// Pure and camera-free, like gestures.js, so the whole thing is testable with
// generated hands. app.js owns recording I/O and storage; the recognizer only
// asks "is this hand one of the taught gestures?" when no built-in pose matched.
//
// A taught gesture is a handful of snapshots of the hand. Each snapshot is the
// 21 landmarks translated so the wrist is the origin and divided by palm length,
// so the same shape matches near the camera or across the desk.
//
// Orientation is only partly normalized. Comparison forgives up to MAX_TILT of
// rotation, because nobody holds a hand at exactly the same angle twice — but no
// more, because a taught gesture may be defined by which way it points: thumb up
// and thumb down are the same shape rotated half a turn, and must stay apart.

import { classifyPose, isFourFingerPose } from './gestures.js';
import { handScale } from './landmarks.js';

/** Custom gesture names travel on the wire, and in config.json, with this prefix. */
export const CUSTOM_PREFIX = 'custom:';

/** What may follow the prefix: short, lowercase, safe as a JSON key and a log token. */
export const CUSTOM_LABEL = /^[a-z][a-z0-9_]{0,31}$/;

/** Snapshots taken per gesture when recording. */
export const SAMPLES_PER_GESTURE = 5;

/**
 * Largest distance, in palm lengths, that still counts as a match.
 *
 * Measured on generated hands: one finger raised or lowered is 0.25–0.28 away,
 * the built-in shapes 0.32–0.42, while a re-made gesture with landmark jitter of
 * ±0.1 palm lengths is about 0.09. Configurable as `customMaxDistance`, and shown live on the page, because
 * real cameras are noisier than generated hands.
 */
export const DEFAULT_MAX_DISTANCE = 0.18;

/** Rotation forgiven when comparing two hands. See the header. */
export const MAX_TILT = Math.PI / 6;

/**
 * The nearest gesture must be clearly nearer than the next one: its distance at
 * most this fraction of the runner-up's. A hand halfway between two taught
 * shapes then matches neither, which is the safe answer for something that
 * presses keys.
 */
export const AMBIGUITY_RATIO = 0.8;

export const isCustomGesture = (name) =>
  typeof name === 'string' &&
  name.startsWith(CUSTOM_PREFIX) &&
  CUSTOM_LABEL.test(name.slice(CUSTOM_PREFIX.length));

/** "peace" -> "custom:peace", or null when the label isn't usable. */
export function customName(label) {
  const clean = String(label ?? '').trim().toLowerCase();
  return CUSTOM_LABEL.test(clean) ? `${CUSTOM_PREFIX}${clean}` : null;
}

/** Wrist-relative, palm-length-scaled landmarks as a flat [x0, y0, x1, y1, …]. */
export function toVector(pts) {
  const wrist = pts[0];
  const scale = handScale(pts);
  const out = new Array(pts.length * 2);
  for (let i = 0; i < pts.length; i += 1) {
    out[i * 2] = (pts[i].x - wrist.x) / scale;
    out[i * 2 + 1] = (pts[i].y - wrist.y) / scale;
  }
  return out;
}

/**
 * Root-mean-square distance between corresponding landmarks, in palm lengths,
 * after rotating `b` about the wrist to best fit `a` — within ±MAX_TILT.
 *
 * RMS rather than a plain mean: two different shapes usually differ at only a
 * few fingertips, and averaging those over all 21 landmarks drowns them in the
 * ones that agree. Squaring keeps a raised finger from hiding.
 */
export function distance(a, b) {
  const n = a.length / 2;

  // Closed-form best rotation of b onto a (2-D Procrustes about the wrist).
  let dot = 0;
  let cross = 0;
  for (let i = 0; i < n; i += 1) {
    const [ax, ay, bx, by] = [a[i * 2], a[i * 2 + 1], b[i * 2], b[i * 2 + 1]];
    dot += ax * bx + ay * by;
    cross += ay * bx - ax * by;
  }
  const angle = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan2(cross, dot)));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const bx = b[i * 2] * cos - b[i * 2 + 1] * sin;
    const by = b[i * 2] * sin + b[i * 2 + 1] * cos;
    total += (a[i * 2] - bx) ** 2 + (a[i * 2 + 1] - by) ** 2;
  }
  return Math.sqrt(total / n);
}

/**
 * Why a hand can't be used as a sample, or null when it can.
 *
 * Built-in poses are refused rather than shadowed: the recognizer checks them
 * first, so a taught copy of the fist would never fire, and silently never
 * firing is the worst way for this to fail. The four-finger shape is refused
 * because it is how every swipe starts — a taught gesture there would fire
 * while you were getting ready to change desktops.
 */
export function sampleProblem(pts) {
  if (!pts || pts.length < 21) return 'no hand in view';
  const builtIn = classifyPose(pts);
  if (builtIn) return `that's the built-in ${builtIn} gesture`;
  if (isFourFingerPose(pts)) return 'four fingers out is how a swipe starts';
  return null;
}

function isVector(v) {
  return Array.isArray(v) && v.length === 42 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export class CustomGestures {
  /**
   * @param {{name: string, samples: number[][]}[]} [entries]
   * @param {{maxDistance?: number, ambiguityRatio?: number}} [options]
   */
  constructor(entries = [], { maxDistance = DEFAULT_MAX_DISTANCE, ambiguityRatio = AMBIGUITY_RATIO } = {}) {
    this.maxDistance = maxDistance;
    this.ambiguityRatio = ambiguityRatio;
    this.gestures = new Map();
    for (const { name, samples } of entries) this.add(name, samples);
  }

  get names() {
    return [...this.gestures.keys()];
  }

  get size() {
    return this.gestures.size;
  }

  samplesFor(name) {
    return this.gestures.get(name) ?? [];
  }

  add(name, samples) {
    if (!isCustomGesture(name)) throw new Error(`"${name}" is not a custom gesture name`);
    if (!Array.isArray(samples) || samples.length === 0 || !samples.every(isVector)) {
      throw new Error(`"${name}" needs at least one sample of 21 landmarks`);
    }
    this.gestures.set(name, samples.map((v) => [...v]));
  }

  remove(name) {
    return this.gestures.delete(name);
  }

  /**
   * The closest taught gesture and how close it is, whether or not that counts as
   * a match. For the readout: watching the distance against the threshold is how
   * you find out why a gesture isn't firing.
   *
   * @returns {{name: string, distance: number, runnerUp: number}|null}
   */
  nearest(pts) {
    if (!pts || pts.length < 21 || this.gestures.size === 0) return null;
    const v = toVector(pts);

    let best = null;
    let runnerUp = Infinity;
    for (const [name, samples] of this.gestures) {
      let d = Infinity;
      for (const s of samples) d = Math.min(d, distance(v, s));
      if (!best || d < best.distance) {
        if (best) runnerUp = best.distance;
        best = { name, distance: d };
      } else if (d < runnerUp) {
        runnerUp = d;
      }
    }
    return { ...best, runnerUp };
  }

  /** The taught gesture this hand is, or null. */
  match(pts) {
    const near = this.nearest(pts);
    if (!near || near.distance > this.maxDistance) return null;
    if (near.distance > near.runnerUp * this.ambiguityRatio) return null;
    return near.name;
  }

  /**
   * Why a freshly recorded set of samples shouldn't be saved, or null.
   *
   * Two checks, both about the gesture still being matchable later: the samples
   * must agree with each other (a hand that drifted mid-recording teaches noise),
   * and the new shape must be clearly apart from every gesture already taught, or
   * the ambiguity rule would leave both unable to fire.
   */
  recordingProblem(name, samples) {
    if (this.gestures.has(name)) return `${name} already exists — delete it first`;

    for (let i = 0; i < samples.length; i += 1) {
      for (let j = i + 1; j < samples.length; j += 1) {
        if (distance(samples[i], samples[j]) > this.maxDistance) {
          return 'the samples were too different — hold one shape steady';
        }
      }
    }

    for (const [other, existing] of this.gestures) {
      for (const s of samples) {
        for (const e of existing) {
          if (distance(s, e) <= this.maxDistance) return `too close to ${other}`;
        }
      }
    }
    return null;
  }

  toJSON() {
    return { version: 1, gestures: this.names.map((name) => ({ name, samples: this.samplesFor(name) })) };
  }

  /**
   * Rebuild from storage, skipping anything malformed rather than throwing: this
   * runs at page load, and one bad entry must not cost the user every other
   * gesture they taught.
   */
  static fromJSON(data, options) {
    const set = new CustomGestures([], options);
    const skipped = [];
    for (const entry of data?.gestures ?? []) {
      try {
        set.add(entry?.name, entry?.samples);
      } catch {
        skipped.push(entry?.name ?? '(unnamed)');
      }
    }
    return { set, skipped };
  }
}

/**
 * Collects samples while the user holds a new shape.
 *
 * Fed one frame at a time, like the recognizer. Unusable frames are reported but
 * don't abort the recording, because the first frames are usually the hand still
 * arriving in position.
 */
export class SampleRecorder {
  constructor({ count = SAMPLES_PER_GESTURE, intervalMs = 250, timeoutMs = 10000 } = {}) {
    this.count = count;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.samples = [];
    this.startedAt = null;
    this.lastAt = -Infinity;
  }

  /**
   * @returns {{status: 'recording'|'done'|'timeout', captured: number, problem: string|null}}
   */
  offer(pts, now) {
    if (this.startedAt === null) this.startedAt = now;
    if (now - this.startedAt > this.timeoutMs) {
      return { status: 'timeout', captured: this.samples.length, problem: null };
    }

    const problem = sampleProblem(pts);
    if (!problem && now - this.lastAt >= this.intervalMs) {
      this.samples.push(toVector(pts));
      this.lastAt = now;
    }

    const done = this.samples.length >= this.count;
    return { status: done ? 'done' : 'recording', captured: this.samples.length, problem };
  }
}

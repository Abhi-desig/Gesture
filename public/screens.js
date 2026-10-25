// Which of your screens you are facing, worked out from where your head points.
//
// This is the spatial half of the app. The hand says *what* to do; the head
// says *where*. Look at a screen and pinch, and that screen's front window comes
// forward.
//
// Pure and camera-free, like gestures.js: face landmarks in, a display id out.
// app.js feeds it from the camera, the tests feed it synthetic faces.
//
// Why the head and not the eyes: a laptop webcam cannot resolve where your
// pupils point to better than a few degrees, but monitors sit tens of degrees
// apart, and you turn your head — not just your eyes — to look at one that far
// away. Head direction is the coarse, honest signal that matches the question.

import { median } from './stats.js';

// MediaPipe face mesh indices. Subject's right is image left.
export const FACE = {
  RIGHT_EYE_OUTER: 33,
  LEFT_EYE_OUTER: 263,
  FOREHEAD: 10,
  CHIN: 152,
  // Inner lip centres, top and bottom: their midpoint is the mouth for "shh".
  UPPER_LIP: 13,
  LOWER_LIP: 14,
};

const FACE_POINTS = 468;
const DEG = 180 / Math.PI;

/**
 * Head direction from one frame of face landmarks, in degrees.
 *
 * Read from the face mesh's own depth rather than its 2D outline: turn your
 * head and one eye corner comes toward the camera while the other goes away, so
 * the angle of the line between them in the x–z plane is the yaw. Pitch is the
 * same idea on the forehead–chin line.
 *
 * These are not degrees you could check with a protractor — MediaPipe's z is
 * only "roughly the scale of x" — and they do not need to be. A screen is found
 * by comparing against the angles recorded while you looked at it during
 * calibration, so all that matters is that the number moves the same way every
 * time your head does.
 *
 * @param {{x:number,y:number,z:number}[]|null} face Normalized landmarks.
 * @param {number} aspect Frame width / height. x and z are in frame-width units
 *   and y in frame-height units, so y is converted before it meets z.
 * @returns {{yaw:number,pitch:number}|null}
 */
export function headPose(face, aspect = 1) {
  if (!face || face.length < FACE_POINTS) return null;
  const right = face[FACE.RIGHT_EYE_OUTER];
  const left = face[FACE.LEFT_EYE_OUTER];
  const top = face[FACE.FOREHEAD];
  const chin = face[FACE.CHIN];

  const yaw = Math.atan2(left.z - right.z, left.x - right.x) * DEG;
  const pitch = Math.atan2(chin.z - top.z, (chin.y - top.y) / aspect) * DEG;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  return { yaw, pitch };
}

/**
 * The middle of the mouth, in the hand's aspect-corrected units, so a hand
 * gesture can be measured against it ("shh").
 */
export function mouthPoint(face, aspect = 1) {
  if (!face || face.length < FACE_POINTS) return null;
  const a = face[FACE.UPPER_LIP];
  const b = face[FACE.LOWER_LIP];
  return { x: ((a.x + b.x) / 2) * aspect, y: (a.y + b.y) / 2 };
}

/** Angular distance between two head directions, in the same loose degrees. */
export function angleBetween(a, b) {
  return Math.hypot(a.yaw - b.yaw, a.pitch - b.pitch);
}

/**
 * One calibration reading from a burst of head poses.
 *
 * The median, not the mean: the burst starts while you are still settling on
 * the screen, and one frame from mid-turn would drag a mean toward the screen
 * you came from.
 *
 * @param {{yaw:number,pitch:number}[]} samples
 * @returns {{yaw:number,pitch:number,spread:number}|null} `spread` is the
 *   median distance from that centre — how still you held while it recorded.
 */
export function summarizeHead(samples) {
  const good = samples.filter(Boolean);
  if (good.length === 0) return null;
  const centre = { yaw: median(good.map((s) => s.yaw)), pitch: median(good.map((s) => s.pitch)) };
  return { ...centre, spread: median(good.map((s) => angleBetween(s, centre))) };
}

/**
 * Pairs of calibrated screens too close together to tell apart.
 *
 * Two screens recorded a few degrees apart mean the tracker will flip between
 * them on noise alone. Better to say so at calibration time than to have the
 * wrong window come forward later with no explanation.
 *
 * @param {{id:number,name:string,yaw:number,pitch:number}[]} screens
 * @param {number} minAngle
 * @returns {[string, string][]}
 */
export function crowdedScreens(screens, minAngle) {
  const out = [];
  for (let i = 0; i < screens.length; i += 1) {
    for (let j = i + 1; j < screens.length; j += 1) {
      if (angleBetween(screens[i], screens[j]) < minAngle) out.push([screens[i].name, screens[j].name]);
    }
  }
  return out;
}

/** One-pole low-pass: the building block of both filters below. */
class LowPass {
  constructor() {
    this.y = null;
  }

  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
}

const alphaFor = (cutoffHz, dtSec) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dtSec));

/**
 * The 1€ filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass whose cutoff
 * rises with speed. Held still, it smooths hard and the reading stops
 * jittering; turning, it lets go and follows almost at once.
 *
 * That is exactly the trade a fixed EMA cannot make. At the 20 Hz face rate an
 * EMA of 0.35 takes ~270 ms to cover 90% of a head turn, longer than a pinch
 * takes to fire, so a quick turn-and-pinch can aim at the screen you came from.
 *
 * `minCutoff` (Hz) sets how much a still head is smoothed; `beta` how fast the
 * cutoff opens with speed, here in degrees per second. With beta 0 it is just
 * a slower EMA — the setting has to be measured, which is what
 * scripts/replay-facing.mjs does with real head traces.
 */
export class OneEuroFilter {
  constructor({ minCutoff = 1, beta = 0.1, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastT = null;
  }

  /** @param {number} value @param {number} tMs Monotonic milliseconds. */
  filter(value, tMs) {
    if (this.lastT === null) {
      this.lastT = tMs;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    // A floor, not a skip: two readings landing in the same millisecond (a
    // stalled worker catching up) must still be filtered, not divide by zero.
    const dt = Math.max((tMs - this.lastT) / 1000, 0.001);
    this.lastT = tMs;
    const speed = this.dx.filter((value - this.x.y) / dt, alphaFor(this.dCutoff, dt));
    return this.x.filter(value, alphaFor(this.minCutoff + this.beta * Math.abs(speed), dt));
  }
}

export const DEFAULT_SCREEN_OPTIONS = {
  // How far your head may point from a screen's calibrated direction and still
  // count as facing it. Past this you are looking at something else — your
  // notebook, the window, the person next to you — and a pinch does nothing.
  maxAngle: 20,

  // A screen has to beat the current one by this much before attention moves.
  // Without it, a head held half-way between two screens flips between them on
  // every frame of tracking noise.
  switchMargin: 4,

  // Which smoothing runs on the raw angles: 'ema', 'oneEuro' or 'none'. EMA is
  // still the live default — it changes only once the check-up's recorded
  // head traces show which setting actually picks screens better.
  filter: 'ema',

  // EMA weight per face reading.
  smoothing: 0.35,

  // 1€ settings, used when filter is 'oneEuro'.
  minCutoff: 1,
  beta: 0.1,
};

/**
 * Turns a stream of head poses into "the screen you are facing".
 */
export class ScreenTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULT_SCREEN_OPTIONS, ...options };
    this.screens = [];
    this.reset();
  }

  setOptions(options = {}) {
    this.options = { ...this.options, ...options };
    this.#makeFilters();
  }

  #makeFilters() {
    const { minCutoff, beta } = this.options;
    this.yawFilter = new OneEuroFilter({ minCutoff, beta });
    this.pitchFilter = new OneEuroFilter({ minCutoff, beta });
  }

  /** @param {{id:number,name:string,yaw:number,pitch:number}[]} screens */
  setCalibration(screens) {
    this.screens = Array.isArray(screens) ? screens.filter((s) => Number.isFinite(s?.yaw)) : [];
    this.current = null;
  }

  get calibrated() {
    return this.screens.length > 0;
  }

  reset() {
    this.smoothed = null;
    this.current = null;
    this.#makeFilters();
  }

  /** The raw angles through whichever filter is configured. */
  #smooth(pose, t) {
    const { filter, smoothing: a } = this.options;
    if (filter === 'none') return { ...pose };
    if (filter === 'oneEuro' && Number.isFinite(t)) {
      return { yaw: this.yawFilter.filter(pose.yaw, t), pitch: this.pitchFilter.filter(pose.pitch, t) };
    }
    // EMA — also the fallback when no timestamp came with the reading.
    return this.smoothed
      ? {
          yaw: this.smoothed.yaw + a * (pose.yaw - this.smoothed.yaw),
          pitch: this.smoothed.pitch + a * (pose.pitch - this.smoothed.pitch),
        }
      : { ...pose };
  }

  /**
   * Feed one head pose.
   *
   * @param {{yaw:number,pitch:number}|null} pose null when no face is in view.
   * @param {number} [t] Monotonic ms of the reading. The 1€ filter needs it;
   *   the EMA does not.
   * @returns {{screen: number|null, pose: {yaw:number,pitch:number}|null,
   *   distance: number|null, nearest: number|null}} `screen` is who has your
   *   attention; `nearest` and `distance` are for the readout, and are reported
   *   even when you are too far from every screen to count as facing one.
   */
  update(pose, t) {
    if (!pose) {
      // Lost the face: say so rather than holding a stale answer. A turn
      // that happened while the face was out of view must not act on the
      // screen you were facing before it.
      this.reset();
      return { screen: null, pose: null, distance: null, nearest: null };
    }

    this.smoothed = this.#smooth(pose, t);

    if (!this.calibrated) return { screen: null, pose: this.smoothed, distance: null, nearest: null };

    let best = null;
    for (const s of this.screens) {
      const d = angleBetween(this.smoothed, s);
      if (!best || d < best.distance) best = { id: s.id, distance: d };
    }

    if (best.distance > this.options.maxAngle) {
      this.current = null;
    } else if (this.current === null || best.id === this.current) {
      this.current = best.id;
    } else {
      const held = this.screens.find((s) => s.id === this.current);
      const heldDistance = held ? angleBetween(this.smoothed, held) : Infinity;
      if (best.distance + this.options.switchMargin < heldDistance) this.current = best.id;
    }

    return { screen: this.current, pose: this.smoothed, distance: best.distance, nearest: best.id };
  }
}

/**
 * Short spoken names for the displays: "laptop" for the built-in one, the first
 * word of the name otherwise ("BenQ"). Prompts are heard while you look away
 * from this page, so they have to be short and unmistakable; two monitors with
 * the same first word become "left Dell" and "right Dell".
 *
 * @param {{id:number,name:string,x:number,builtin?:boolean}[]} displays
 * @returns {Record<number, string>}
 */
export function spokenLabels(displays) {
  const base = (d) => (d.builtin ? 'laptop' : (d.name.split(/\s+/)[0] || `screen ${d.id}`));
  const groups = new Map();
  for (const d of displays) groups.set(base(d), [...(groups.get(base(d)) ?? []), d]);

  const labels = {};
  for (const [label, group] of groups) {
    const byX = [...group].sort((a, b) => a.x - b.x);
    byX.forEach((d, i) => {
      if (byX.length === 1) labels[d.id] = label;
      else if (byX.length === 2) labels[d.id] = `${i === 0 ? 'left' : 'right'} ${label}`;
      else labels[d.id] = `${label} ${i + 1}`;
    });
  }
  return labels;
}

/**
 * The screen you faced for most of a span: the pinch's own hold.
 *
 * Asked when a pinch fires, it answers where you were looking *while* you
 * pinched, not where your head is the instant the hold completes. Turning and
 * pinching on arrival lands on the new screen; pinching mid-turn, with no
 * screen holding most of the span, is "still turning" rather than a guess.
 *
 * @param {{t:number, screen:number|null}[]} history Facing readings, oldest first.
 * @param {number} from
 * @param {number} to
 * @returns {{screen:number|null, share:number}|null} The dominant screen (null
 *   for "no screen") and its share of the span, or null when nothing reached
 *   `minShare` or there were no readings.
 */
export function screenDuring(history, from, to, { minShare = 0.6 } = {}) {
  if (!(to > from)) return null;
  const time = new Map();
  let total = 0;
  for (let i = 0; i < history.length; i += 1) {
    const start = Math.max(history[i].t, from);
    const end = Math.min(history[i + 1]?.t ?? to, to);
    if (end <= start) continue;
    time.set(history[i].screen, (time.get(history[i].screen) ?? 0) + end - start);
    total += end - start;
  }
  if (total === 0) return null;
  let best = null;
  for (const [screen, ms] of time) if (!best || ms > best.ms) best = { screen, ms };
  const share = best.ms / total;
  return share >= minShare ? { screen: best.screen, share } : null;
}

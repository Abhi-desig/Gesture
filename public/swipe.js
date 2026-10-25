// Motion gestures: a 4-finger swipe sideways (desktops), and a flick of the
// open hand up or down (scroll a page).
//
// Unlike the static poses in gestures.js, a swipe can't be read from a single
// frame — it needs palm position tracked over a window plus a direction. This
// tracker is stateful, but all state is fed in explicitly (points + a timestamp),
// so it's still fully testable with a synthetic sample stream and no camera.
//
// It also owns the palm-velocity readout that gates the static poses. That gate
// is not optional: a 4-finger swipe passes straight through the open-palm test on
// its way across the frame, so without it every swipe attempt would be a coin
// flip on firing whatever open_palm is bound to (lock screen, by default).

import { handScale, palmCenter } from './landmarks.js';
import { isFourFingerPose } from './gestures.js';

/** Gesture names this tracker can emit. */
export const SWIPES = ['swipe_left', 'swipe_right', 'swipe_up', 'swipe_down'];

export const DEFAULT_SWIPE_OPTIONS = {
  windowMs: 350,
  minTravel: 1.2, // hand-scale units of travel
  minVelocity: 3.0, // hand-scale units per second
  maxVerticalRatio: 0.5, // the off-axis travel must stay under this fraction
  rearmRequiresPoseBreak: true,
  invertDirection: false,
  // Up and down follow exactly the sideways rules by default (your choice on
  // 25 Oct: the extra guards made it too hard to do). Two optional guards
  // against a hand rising into view or dropping out of it, off at 0:
  // - stillFirstMs: the hand must have been still in view this long first;
  // - confirmMs: it must still be in view this long after.
  stillFirstMs: 0,
  stillVelocity: 0.8, // hand-scale units per second, over the last 150 ms
  confirmMs: 0,
};

// A window shorter than this fraction of windowMs isn't enough evidence — a
// couple of noisy frames could otherwise clear the travel threshold on their own.
const MIN_SPAN_FRACTION = 0.5;

export class SwipeTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULT_SWIPE_OPTIONS, ...options };
    this.reset();
  }

  setOptions(options = {}) {
    this.options = { ...this.options, ...options };
  }

  reset() {
    /** @type {{t:number,x:number,y:number,scale:number}[]} */
    this.samples = [];
    this.poseHeldSince = null;
    this.armed = true;
    this.lastFlick = null;
    this.#forgetStill();
  }

  /**
   * Call on any frame with no hand detected. Losing the hand counts as breaking
   * the pose, which re-arms the tracker — and cancels a vertical flick waiting
   * to be confirmed: that was a hand being lowered out of view.
   */
  handLost() {
    this.samples = [];
    this.poseHeldSince = null;
    this.armed = true;
    this.#forgetStill();
  }

  #forgetStill() {
    this.stillSince = null;
    // When a long-enough still spell last ended, i.e. when moving began.
    this.stillEndedAt = null;
    if (this.pending) this.#verdict({ ...this.pending.move, verdict: 'left the view' }, this.pending.at);
    else if (this.candidate) this.#verdict(this.candidate, this.candidate.at);
    this.pending = null;
    this.candidate = null;
    this.afterFire = false;
  }

  /**
   * Why the last up/down movement of the hand did or didn't scroll:
   * `{dir, verdict, travel, need, speed, at}`, where verdict is "scrolled",
   * "too short", "too slow", "not from still", "fingers not all out",
   * "already scrolled — change hand shape first", "open hand held too
   * briefly" or "left the view".
   *
   * Diagnostics only: nothing decides on it. It exists because a flick that
   * doesn't count is otherwise silent, and each rule fails for a different
   * reason with a different fix.
   */
  #verdict(move, at) {
    this.lastFlick = {
      dir: move.dir,
      verdict: move.verdict ?? move.reason,
      travel: Math.round(move.travel * 100) / 100,
      need: this.options.minTravel,
      speed: Math.round(move.speed * 10) / 10,
      at,
    };
  }

  /**
   * Feed one frame.
   *
   * @param {{x:number,y:number}[]} pts Aspect-corrected points from `toPoints`.
   * @param {number} now Monotonic ms (`performance.now()` in the browser).
   * @returns {{swipe: string|null, velocity: number, armed: boolean, fourFinger: boolean}}
   */
  update(pts, now) {
    const center = palmCenter(pts);
    const scale = handScale(pts);

    // Samples are collected on every frame with a hand present, not just during
    // the swipe pose, because the static poses need a velocity reading too.
    this.samples.push({ t: now, x: center.x, y: center.y, scale });
    const cutoff = now - this.options.windowMs;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    const fourFinger = isFourFingerPose(pts);
    if (fourFinger) {
      if (this.poseHeldSince === null) this.poseHeldSince = now;
    } else {
      this.poseHeldSince = null;
      this.armed = true; // pose broke -> ready for the next swipe
    }

    const velocity = this.#velocity();
    this.#trackStillness(now);

    let swipe = null;
    if (this.pending) {
      // A vertical flick, waiting to see the hand stay in view.
      if (now - this.pending.at >= this.options.confirmMs) {
        swipe = this.pending.swipe;
        this.#verdict({ ...this.pending.move, verdict: 'scrolled' }, now);
        this.pending = null;
        this.candidate = null;
      }
    } else if (fourFinger && this.armed) {
      const found = this.#evaluate(now);
      if ((found === 'swipe_up' || found === 'swipe_down') && this.options.confirmMs > 0) {
        this.pending = { swipe: found, at: now, move: this.#upDownMove() };
      } else {
        swipe = found;
        if (found === 'swipe_up' || found === 'swipe_down') this.#verdict({ ...this.#upDownMove(), verdict: 'scrolled' }, now);
      }
    }
    if (!this.pending && !swipe) this.#watchFlick(now, fourFinger);

    if (swipe) {
      // Clear the window so the next swipe needs fresh evidence, and (by default)
      // require the pose to break first. Both guards, because either one alone
      // leaves the return stroke able to fire the opposite direction and silently
      // undo the swipe that just happened.
      this.samples = [];
      this.poseHeldSince = null;
      this.stillEndedAt = null;
      this.afterFire = true;
      this.candidate = null;
      if (this.options.rearmRequiresPoseBreak) this.armed = false;
    }

    return { swipe, velocity, armed: this.armed, fourFinger };
  }

  /** The hand's up/down movement across the window, in or out of pose. */
  #upDownMove() {
    if (this.samples.length < 2) return null;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    const scale = (a.scale + b.scale) / 2;
    const dy = b.y - a.y;
    const travel = Math.abs(dy) / scale;
    return {
      dir: dy < 0 ? 'up' : 'down',
      travel,
      speed: dt > 0 ? travel / dt : 0,
      upright: Math.abs(b.x - a.x) < this.options.maxVerticalRatio * Math.abs(dy),
      start: a.t,
    };
  }

  /**
   * Follow an up/down movement that hasn't scrolled, and when it ends, say
   * which rule stopped it. Only movements of at least half the needed travel
   * count as an attempt; smaller ones are just a hand moving.
   */
  #watchFlick(now, fourFinger) {
    const o = this.options;
    // The rest of a stroke that just fired is not a new attempt.
    if (this.afterFire) {
      if (this.stillSince === null) return;
      this.afterFire = false;
    }
    const m = this.#upDownMove();
    if (m && m.upright && m.travel >= o.minTravel / 2) {
      if (!this.candidate || m.travel > this.candidate.travel) {
        const fromStill = this.#fromStill(now);
        let reason = 'not from still';
        if (!fourFinger || this.poseHeldSince === null || this.poseHeldSince > m.start + 50) reason = 'fingers not all out';
        else if (!this.armed) reason = 'already scrolled — change hand shape first';
        else if (m.travel < o.minTravel) reason = 'too short';
        else if (m.speed < o.minVelocity) reason = 'too slow';
        else if (fromStill) reason = 'open hand held too briefly';
        this.candidate = { ...m, reason, at: now };
      }
      return;
    }
    // The movement is over: the hand has slowed, or it was never big enough.
    if (this.candidate && (this.stillSince !== null || now - this.candidate.at > o.windowMs)) {
      this.#verdict(this.candidate, now);
      this.candidate = null;
    }
  }

  /** Note when the hand has been still in view, and when that ended. */
  #trackStillness(now) {
    const recent = this.samples.filter((s) => s.t >= now - 150);
    let speed = 0;
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = (b.t - a.t) / 1000;
      speed = dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / ((a.scale + b.scale) / 2) / dt : 0;
    }
    if (speed <= this.options.stillVelocity) {
      this.stillSince ??= now;
    } else {
      if (this.stillSince !== null && now - this.stillSince >= this.options.stillFirstMs) this.stillEndedAt = now;
      this.stillSince = null;
    }
  }

  /** Palm speed in hand-scale units per second, across the current window. */
  #velocity() {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return 0;
    const scale = (a.scale + b.scale) / 2;
    return Math.hypot(b.x - a.x, b.y - a.y) / scale / dt;
  }

  #evaluate(now) {
    const o = this.options;
    if (this.poseHeldSince === null) return null;

    // Only travel accumulated while the pose was actually held may count, so
    // motion from before the fingers came up can't contribute to a swipe.
    //
    // Evaluated on a *slice* of the window rather than by discarding the window
    // whole. Samples are pushed on every hand-present frame, not only four-finger
    // ones, so requiring the oldest sample in the buffer to already be in-pose
    // meant waiting for every pre-pose sample to age out — a full windowMs of
    // holding four fingers still before any movement could register. Raising the
    // hand and swiping in one motion could never fire, which is why the first
    // gesture of a run was always swallowed and the second one worked.
    const win = this.samples.filter((s) => s.t >= this.poseHeldSince);
    if (win.length < 3) return null;

    const a = win[0];
    const b = win[win.length - 1];
    const spanMs = b.t - a.t;
    if (spanMs < o.windowMs * MIN_SPAN_FRACTION) return null;

    const dt = spanMs / 1000;
    const scale = (a.scale + b.scale) / 2;
    const dy = b.y - a.y;

    // The camera faces the user, so in the raw frame a hand moving to the user's
    // own right moves toward image-left: raw x *decreases*. Negate it so positive
    // always means "travelled to the user's right". Because the preview is shown
    // mirrored (selfie view), that also matches rightward on screen, so the user
    // never has to mentally invert anything.
    let userDx = -(b.x - a.x);
    if (o.invertDirection) userDx = -userDx;

    const across = Math.abs(userDx) / scale;
    const upDown = Math.abs(dy) / scale;

    // Sideways: horizontal dominance, so a diagonal wave or a vertical drop
    // isn't a swipe.
    //
    // The velocity check is redundant at default settings (windowMs caps how
    // slowly minTravel can be covered), but it keeps the gesture honest if
    // windowMs is widened in config.
    if (across >= o.minTravel && Math.abs(dy) < o.maxVerticalRatio * Math.abs(userDx)) {
      return across / dt >= o.minVelocity ? (userDx < 0 ? 'swipe_left' : 'swipe_right') : null;
    }

    // Up and down: the same rules turned 90° (plus a still spell just before,
    // if that guard is on). Image y runs down the frame, so a hand moving up
    // has dy < 0.
    if (upDown >= o.minTravel && Math.abs(userDx) < o.maxVerticalRatio * Math.abs(dy) && upDown / dt >= o.minVelocity) {
      if (this.#fromStill(now)) return dy < 0 ? 'swipe_up' : 'swipe_down';
    }
    return null;
  }

  /** The still-first guard: met when it's off, or when a still spell just ended. */
  #fromStill(now) {
    if (this.options.stillFirstMs <= 0) return true;
    return this.stillEndedAt !== null && now - this.stillEndedAt <= this.options.windowMs + 100;
  }
}

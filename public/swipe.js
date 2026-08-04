// Motion gesture: 4-finger horizontal swipe.
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
export const SWIPES = ['swipe_left', 'swipe_right'];

export const DEFAULT_SWIPE_OPTIONS = {
  windowMs: 350,
  minTravel: 1.2, // hand-scale units of horizontal travel
  minVelocity: 3.0, // hand-scale units per second
  maxVerticalRatio: 0.5, // |dy| must stay under this fraction of |dx|
  rearmRequiresPoseBreak: true,
  invertDirection: false,
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
  }

  /**
   * Call on any frame with no hand detected. Losing the hand counts as breaking
   * the pose, which re-arms the tracker.
   */
  handLost() {
    this.samples = [];
    this.poseHeldSince = null;
    this.armed = true;
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

    let swipe = null;
    if (fourFinger && this.armed) {
      swipe = this.#evaluate();
    }

    if (swipe) {
      // Clear the window so the next swipe needs fresh evidence, and (by default)
      // require the pose to break first. Both guards, because either one alone
      // leaves the return stroke able to fire the opposite direction and silently
      // undo the swipe that just happened.
      this.samples = [];
      this.poseHeldSince = null;
      if (this.options.rearmRequiresPoseBreak) this.armed = false;
    }

    return { swipe, velocity, armed: this.armed, fourFinger };
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

  #evaluate() {
    const o = this.options;
    if (this.samples.length < 3) return null;

    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const spanMs = b.t - a.t;
    if (spanMs < o.windowMs * MIN_SPAN_FRACTION) return null;

    // Only count travel accumulated while the pose was actually held, so motion
    // from before the fingers came up can't contribute to a swipe.
    if (this.poseHeldSince === null || this.poseHeldSince > a.t) return null;

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

    const travel = Math.abs(userDx) / scale;
    if (travel < o.minTravel) return null;

    // Horizontal dominance, so a diagonal wave or a vertical drop isn't a swipe.
    if (Math.abs(dy) >= o.maxVerticalRatio * Math.abs(userDx)) return null;

    // Redundant at default settings (windowMs caps how slowly minTravel can be
    // covered), but it keeps the gesture honest if windowMs is widened in config.
    if (travel / dt < o.minVelocity) return null;

    return userDx < 0 ? 'swipe_left' : 'swipe_right';
  }
}

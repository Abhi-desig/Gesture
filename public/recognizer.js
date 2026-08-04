// Combines static poses and swipes into a single stream of gesture names.
//
// This is where the two gesture families have to be reconciled, which is subtler
// than either one alone:
//
//  - A swipe passes through the open-palm test on its way across the frame, so
//    static poses are suppressed while the palm is moving.
//  - Worse, a swipe *ends* with the hand still in the swipe pose. Let it come to
//    rest and it satisfies open_palm — which by default locks the screen. So after
//    a swipe, static poses stay suppressed until the swipe pose is broken.
//
// app.js owns only I/O (camera, canvas, fetch); every decision lives here, which
// keeps the interactions above testable without a camera.

import { classifyPose, isFourFingerPose } from './gestures.js';
import { SwipeTracker } from './swipe.js';

export const DEFAULT_TUNING = {
  confirmFrames: 4,
  cooldownMs: 1200,
  requireReleaseBetweenFires: true,
  stillnessMaxVelocity: 0.8,
  swipeWindowMs: 350,
  swipeMinTravel: 1.2,
  swipeMinVelocity: 3.0,
  swipeMaxVerticalRatio: 0.5,
  swipeRearmRequiresPoseBreak: true,
  invertSwipeDirection: false,
};

export class Recognizer {
  constructor(tuning = {}) {
    this.tracker = new SwipeTracker();
    this.tuning = { ...DEFAULT_TUNING };
    this.setTuning(tuning);
    this.reset();
  }

  setTuning(tuning = {}) {
    this.tuning = { ...this.tuning, ...tuning };
    const t = this.tuning;
    this.tracker.setOptions({
      windowMs: t.swipeWindowMs,
      minTravel: t.swipeMinTravel,
      minVelocity: t.swipeMinVelocity,
      maxVerticalRatio: t.swipeMaxVerticalRatio,
      rearmRequiresPoseBreak: t.swipeRearmRequiresPoseBreak,
      invertDirection: t.invertSwipeDirection,
    });
  }

  reset() {
    this.tracker.reset();
    // The current continuous run of one pose. One fire per run when
    // requireReleaseBetweenFires is on, which is what stops a held fist from
    // re-firing every cooldown window.
    this.run = { pose: null, frames: 0, fired: false };
    this.lastFired = new Map();
    this.poseSuppressed = false;
  }

  /**
   * Feed one frame.
   *
   * @param {{x:number,y:number}[]|null} pts Aspect-corrected points, or null/empty
   *   when no hand is in view.
   * @param {number} now Monotonic ms.
   */
  update(pts, now) {
    if (!pts || pts.length < 21) {
      this.tracker.handLost();
      this.#advanceRun(null);
      this.poseSuppressed = false;
      return this.#view({ handPresent: false });
    }

    const motion = this.tracker.update(pts, now);

    // Breaking the swipe pose clears the post-swipe suppression.
    if (!motion.fourFinger) this.poseSuppressed = false;

    if (motion.swipe) {
      // Hold off static poses until the hand leaves the swipe pose, so the hand
      // settling after a swipe can't read as a held open palm.
      this.poseSuppressed = true;
      this.run = { pose: null, frames: 0, fired: false };
      return this.#view({ handPresent: true, motion, gesture: motion.swipe });
    }

    // Stillness gate: a moving hand is a swipe candidate, not a held pose.
    const still = motion.velocity <= this.tuning.stillnessMaxVelocity;
    const pose = still && !this.poseSuppressed ? classifyPose(pts) : null;

    const gesture = this.#advanceRun(pose, now);
    return this.#view({ handPresent: true, motion, gesture });
  }

  /** Track the pose run and decide whether it should fire. */
  #advanceRun(pose, now = 0) {
    if (pose !== this.run.pose) this.run = { pose, frames: 0, fired: false };
    this.run.frames += 1;

    if (!pose) return null;
    if (this.run.frames < this.tuning.confirmFrames) return null;
    if (this.tuning.requireReleaseBetweenFires && this.run.fired) return null;

    const previous = this.lastFired.get(pose) ?? -Infinity;
    if (now - previous < this.tuning.cooldownMs) return null;

    this.lastFired.set(pose, now);
    this.run.fired = true;
    return pose;
  }

  #view({ handPresent, motion, gesture = null }) {
    return {
      gesture,
      handPresent,
      pose: this.run.pose,
      frames: this.run.frames,
      fired: this.run.fired,
      velocity: motion?.velocity ?? 0,
      fourFinger: motion?.fourFinger ?? false,
      swipeArmed: this.tracker.armed,
      poseSuppressed: this.poseSuppressed,
    };
  }
}

/** Convenience for tests: does this pose gate swipes? */
export { isFourFingerPose };

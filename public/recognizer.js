// Combines static poses and swipes into a single stream of gesture names.
//
// This is where the two gesture families have to be reconciled, which is subtler
// than either one alone:
//
// The swipe pose (four fingers out, thumb ignored) is a *subset* of the open-palm
// pose, so all three phases of a swipe collide with it:
//
//  - Before: you can't get into position without first holding a stationary open
//    palm. Handled by per-gesture hold times — open_palm wants a deliberate hold,
//    longer than the moment it takes to raise your hand and start moving.
//  - During: the moving hand still satisfies open_palm. Handled by the stillness
//    gate, which ignores static poses above a palm-speed threshold.
//  - After: the swipe *ends* in the swipe pose, so letting the hand rest reads as a
//    held open palm. Handled by suppressing static poses until the pose is broken.
//
// Miss any one of them and a swipe fires whatever open_palm is bound to, which
// defaults to locking the screen.
//
// app.js owns only I/O (camera, canvas, fetch); every decision lives here, which
// keeps the interactions above testable without a camera.

import { classifyPose, isFourFingerPose } from './gestures.js';
import { SwipeTracker } from './swipe.js';

/**
 * How long a pose must be held before it fires, in milliseconds, with optional
 * per-gesture overrides.
 *
 * Time rather than frames because frames aren't a unit: 4 frames is 67ms at 60fps
 * but 133ms at 30fps, so a frame count silently means different things on
 * different cameras.
 *
 * Per-gesture because the swipe pose is a *subset* of the open-palm pose — four
 * fingers out, thumb ignored — so you cannot get into position to swipe without
 * first holding a stationary open palm. With one global hold time short enough for
 * a comfortable fist, raising your hand to swipe fires open_palm first, which by
 * default locks the screen. open_palm therefore wants a deliberate hold, long
 * enough that merely getting ready never reaches it.
 */
export const DEFAULT_HOLD_MS = { default: 180, open_palm: 1200 };

// A floor so that on a very slow camera a single frame can't satisfy a hold.
const MIN_FRAMES = 2;

export const DEFAULT_TUNING = {
  holdMs: DEFAULT_HOLD_MS,
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
    this.run = { pose: null, frames: 0, fired: false, startedAt: 0 };
    this.lastFired = new Map();
    this.poseSuppressed = false;
  }

  /** Hold time required for one pose, honouring per-gesture overrides. */
  holdFor(pose) {
    const hold = this.tuning.holdMs;
    if (typeof hold === 'number') return hold;
    return hold?.[pose] ?? hold?.default ?? DEFAULT_HOLD_MS.default;
  }

  /**
   * Feed one frame.
   *
   * @param {{x:number,y:number}[]|null} pts Aspect-corrected points, or null/empty
   *   when no hand is in view.
   * @param {number} now Monotonic ms.
   * @param {boolean|((pose: string) => boolean)} canFire Whether a recognized
   *   pose will actually be acted on. A function is asked per pose.
   *   False while the page is disarmed. Recognition still runs — the readout has
   *   to stay live — but nothing is *recorded* as having fired, because a pose
   *   made between "Start camera" and "Arm" would otherwise consume its own
   *   cooldown and its one-fire-per-run slot for a key press that never happened.
   */
  update(pts, now, canFire = true) {
    if (!pts || pts.length < 21) {
      this.tracker.handLost();
      this.#advanceRun(null, now);
      this.poseSuppressed = false;
      return this.#view({ handPresent: false, now });
    }

    const motion = this.tracker.update(pts, now);

    // Breaking the swipe pose clears the post-swipe suppression.
    if (!motion.fourFinger) this.poseSuppressed = false;

    if (motion.swipe) {
      // Hold off static poses until the hand leaves the swipe pose, so the hand
      // settling after a swipe can't read as a held open palm.
      this.poseSuppressed = true;
      this.run = { pose: null, frames: 0, fired: false, startedAt: now };
      return this.#view({ handPresent: true, motion, gesture: motion.swipe, now });
    }

    // Stillness gate: a moving hand is a swipe candidate, not a held pose.
    const still = motion.velocity <= this.tuning.stillnessMaxVelocity;
    const pose = still && !this.poseSuppressed ? classifyPose(pts) : null;

    const gesture = this.#advanceRun(pose, now, canFire);
    return this.#view({ handPresent: true, motion, gesture, now });
  }

  /** Track the pose run and decide whether it should fire. */
  #advanceRun(pose, now = 0, canFire = true) {
    if (pose !== this.run.pose) this.run = { pose, frames: 0, fired: false, startedAt: now };
    this.run.frames += 1;

    if (!pose) return null;
    if (this.run.frames < MIN_FRAMES) return null;
    if (now - this.run.startedAt < this.holdFor(pose)) return null;
    if (this.tuning.requireReleaseBetweenFires && this.run.fired) return null;

    const previous = this.lastFired.get(pose) ?? -Infinity;
    if (now - previous < this.tuning.cooldownMs) return null;

    // Report it either way — the caller wants it for the readout — but only
    // record the fire when it will actually be sent. Recording while disarmed
    // burns this pose's cooldown, and with requireReleaseBetweenFires on it also
    // demands a full pose break before the pose can fire again, so the first
    // real gesture after arming would be dropped.
    //
    // A predicate rather than a flag, because the answer is per-pose: a gesture
    // bound to a client-side action (arming the page, say) has to act while
    // disarmed, and must therefore take the cooldown that stops it repeating on
    // every frame — while every other pose still goes unrecorded.
    const allowed = typeof canFire === 'function' ? canFire(pose) === true : canFire;
    if (!allowed) return pose;

    this.lastFired.set(pose, now);
    this.run.fired = true;
    return pose;
  }

  #view({ handPresent, motion, gesture = null, now = 0 }) {
    return {
      gesture,
      handPresent,
      pose: this.run.pose,
      frames: this.run.frames,
      heldMs: this.run.pose ? Math.max(0, now - this.run.startedAt) : 0,
      holdMs: this.run.pose ? this.holdFor(this.run.pose) : 0,
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

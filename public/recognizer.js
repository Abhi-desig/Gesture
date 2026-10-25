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

import { isCustomGesture } from './custom-gestures.js';
import { classifyPose, isFourFingerPose, isShh } from './gestures.js';
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
 *
 * `custom` covers every taught gesture. Longer than a built-in pose because a
 * nearest-neighbour match is a looser judgement than a geometric rule, so it is
 * made to prove itself for longer before it presses anything.
 *
 * `ok_sign` arms and disarms, so it is held half a second: long enough that a
 * hand passing through the shape doesn't flip arming, short enough not to feel
 * like waiting.
 */
export const DEFAULT_HOLD_MS = { default: 180, open_palm: 1200, ok_sign: 500, shh: 400, custom: 400 };

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

// A pose that drops out for less than this is still held. One frame of a pinch
// reading as nothing, or a twitch through the stillness gate, is flicker, not
// letting go: counting it as a release made a flickering pinch fire twice, and
// a flickering OK sign arm and then disarm.
export const RELEASE_MS = 150;

export class Recognizer {
  constructor(tuning = {}) {
    this.tracker = new SwipeTracker();
    this.tuning = { ...DEFAULT_TUNING };
    this.customClassifier = null;
    this.mouth = null;
    this.setTuning(tuning);
    this.reset();
  }

  /**
   * Where the mouth is, from the face model, or null without a recent face.
   * Only "shh" uses it: with no mouth, there is no shh.
   */
  setMouth(mouth) {
    this.mouth = mouth ?? null;
  }

  /**
   * Taught gestures, consulted only when no built-in pose matches.
   *
   * @param {((pts: {x:number,y:number}[]) => string|null)|null} classify Returns a
   *   `custom:` gesture name, or null.
   */
  setCustomClassifier(classify) {
    this.customClassifier = typeof classify === 'function' ? classify : null;
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
    this.run = { pose: null, frames: 0, fired: false, startedAt: 0, lastSeenAt: 0, other: null };
    this.lastFired = new Map();
    this.poseSuppressed = false;
  }

  /**
   * The page refused a gesture that fired (a pinch while facing no screen):
   * give back its cooldown, so the next attempt needn't wait. It still has to
   * be let go and made again, or a held pinch would refuse on every frame.
   */
  forgive(pose) {
    this.lastFired.delete(pose);
  }

  /** Hold time required for one pose, honouring per-gesture overrides. */
  holdFor(pose) {
    const hold = this.tuning.holdMs;
    if (typeof hold === 'number') return hold;
    if (hold?.[pose] !== undefined) return hold[pose];
    if (isCustomGesture(pose)) return hold?.custom ?? DEFAULT_HOLD_MS.custom;
    return hold?.default ?? DEFAULT_HOLD_MS.default;
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
    const gated = still && !this.poseSuppressed;
    const pose = gated ? this.#classify(pts, motion) : null;

    // The hand's shape whatever it is doing. Firing still waits for stillness,
    // but anything following the shape over time — closing an open hand, which
    // moves a little as it closes — must not lose it just because the hand
    // drifted. Built-in poses only while
    // moving: a taught gesture is a nearest-neighbour judgement, too loose to
    // trust on a moving hand, so it is never asked there.
    const shape = gated ? pose : this.#builtIn(pts);

    const gesture = this.#advanceRun(pose, now, canFire);
    return this.#view({ handPresent: true, motion, gesture, shape, now });
  }

  /**
   * Built-in poses first, then taught gestures.
   *
   * A taught gesture never runs while four fingers are out: that is how every
   * swipe starts, so a match there would fire while you were getting ready to
   * change desktops — the same collision open_palm has, with no hold time tuned
   * to stop it.
   */
  #classify(pts, motion) {
    const builtIn = this.#builtIn(pts);
    if (builtIn || !this.customClassifier || motion.fourFinger) return builtIn;
    return this.customClassifier(pts) ?? null;
  }

  /** The hand alone, or "shh" when the mouth is known and the finger is on it. */
  #builtIn(pts) {
    return isShh(pts, this.mouth) ? 'shh' : classifyPose(pts);
  }

  /** Track the pose run and decide whether it should fire. */
  #advanceRun(pose, now = 0, canFire = true) {
    const run = this.run;
    if (pose === run.pose) {
      run.frames += 1;
      run.lastSeenAt = now;
      run.other = null;
      run.dropped = false;
    } else if (run.pose && now - run.lastSeenAt < RELEASE_MS) {
      // Maybe flicker: hold the run. Note when something else began, so a real
      // change of pose still times its hold from its own first frame.
      run.other = pose && run.other?.pose !== pose ? { pose, at: now } : pose ? run.other : null;
      run.dropped = true;
      return null;
    } else {
      const startedAt = pose && run.other?.pose === pose ? run.other.at : now;
      this.run = { pose, frames: 1, fired: false, startedAt, lastSeenAt: now, other: null, dropped: false };
    }

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

  #view({ handPresent, motion, gesture = null, shape = null, now = 0 }) {
    return {
      gesture,
      handPresent,
      // This frame's pose: none during a dropout, though the run behind it is kept.
      pose: this.run.dropped ? null : this.run.pose,
      shape,
      frames: this.run.frames,
      heldMs: this.run.pose && !this.run.dropped ? Math.max(0, now - this.run.startedAt) : 0,
      holdMs: this.run.pose && !this.run.dropped ? this.holdFor(this.run.pose) : 0,
      fired: this.run.fired,
      velocity: motion?.velocity ?? 0,
      fourFinger: motion?.fourFinger ?? false,
      swipeArmed: this.tracker.armed,
      poseSuppressed: this.poseSuppressed,
      // Why the last up/down flick did or didn't scroll (diagnostics only).
      flick: this.tracker.lastFlick ?? null,
    };
  }
}

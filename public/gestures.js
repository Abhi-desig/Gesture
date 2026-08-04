// Static pose classification: one frame of landmarks in, one gesture name out.
//
// Pure and stateless, so the whole thing is testable without a camera. Motion
// gestures (swipes) live in swipe.js, which is stateful by necessity.

import {
  extendedFingers,
  handScale,
  indexReach,
  isThumbExtended,
  pinchGap,
} from './landmarks.js';

export const DEFAULT_THRESHOLDS = {
  // Thumb tip and index tip must be this close (hand-scale units) to be a pinch.
  pinchMaxGap: 0.35,

  // ...and the index tip must reach at least this far from the wrist.
  //
  // This second clause is what separates a pinch from a fist. In a closed fist
  // the thumb folds across the index finger, so the thumb-index gap alone reads
  // as a pinch. Measured in hand-scale units, a tight fist puts the index tip
  // around 0.85 from the wrist (curled in past the knuckles) while a pinch keeps
  // it out around 1.45, so the gap between them is wide and this is a safe split.
  pinchMinIndexReach: 1.15,

  // An open palm needs the thumb clearly away from the index tip, which also
  // implies the thumb is out to the side rather than tucked.
  palmMinSpread: 0.6,
};

export const POSES = ['pinch', 'open_palm', 'fist'];

/**
 * Classify a static pose.
 *
 * @param {{x:number,y:number}[]} pts Aspect-corrected points from `toPoints`.
 * @param {object} [thresholds]
 * @returns {'pinch'|'open_palm'|'fist'|null}
 */
export function classifyPose(pts, thresholds = {}) {
  if (!pts || pts.length < 21) return null;
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const scale = handScale(pts);
  const fingers = extendedFingers(pts);
  const gap = pinchGap(pts, scale);
  const reach = indexReach(pts, scale);

  // Order matters: most specific first. A pinch also satisfies the fist test
  // (its index finger reads as curled), so pinch has to be checked before fist
  // or it would never be reachable.
  if (gap < t.pinchMaxGap && reach > t.pinchMinIndexReach) {
    return 'pinch';
  }

  if (fingers.count === 4 && isThumbExtended(pts) && gap > t.palmMinSpread) {
    return 'open_palm';
  }

  if (fingers.count === 0) {
    return 'fist';
  }

  return null;
}

/**
 * The loose pose gate for swipes: four fingers out, thumb ignored entirely.
 *
 * Deliberately does not care about the thumb. A 4-finger swipe pose and an open
 * palm are nearly the same hand shape, and the thumb is MediaPipe's least
 * reliable landmark, so telling them apart by thumb position would misfire
 * constantly. Motion is the discriminator instead: swept sideways it's a swipe,
 * held still it's an open palm (see the stillness gate in swipe.js).
 */
export function isFourFingerPose(pts) {
  if (!pts || pts.length < 21) return false;
  return extendedFingers(pts).count === 4;
}

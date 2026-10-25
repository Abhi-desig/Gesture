// Static pose classification: one frame of landmarks in, one gesture name out.
//
// Pure and stateless, so the whole thing is testable without a camera. Motion
// gestures (swipes) live in swipe.js, which is stateful by necessity.

import {
  LANDMARK,
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

// The OK sign is "yes" in a mid-air TV gesture study (Dim et al., DIS '16),
// and arms Gesture. Point was removed in v2: it fired nothing in its first
// live test, and looking at a screen plus a pinch does its job.
//
// `shh` is the one pose that needs the face as well as the hand, so
// classifyPose never returns it; isShh() below does, given the mouth.
export const POSES = ['ok_sign', 'pinch', 'open_palm', 'fist', 'shh'];

export const SHH_THRESHOLDS = {
  // The lips must be this close to the index finger's top section (middle joint
  // to tip), in palm lengths. Measured to the section rather than the tip
  // because a finger laid across the lips often has its tip at the nose.
  maxDistance: 0.4,
};

/**
 * "Shh": the index finger alone, upright, laid on the lips. Mutes the mic.
 *
 * A common gesture, but no study found tests it for mute, and it is cultural,
 * so it is a candidate that has to earn its place in the check-up.
 *
 * Not rotation-invariant, on purpose: an index finger pointing sideways near
 * the mouth is a hand resting on the chin, not a "shh".
 *
 * @param {{x:number,y:number}[]} pts Aspect-corrected hand points.
 * @param {{x:number,y:number}|null} mouth The lip centre, in the same units
 *   (mouthPoint() in screens.js), or null with no face in view.
 */
export function isShh(pts, mouth, thresholds = {}) {
  if (!pts || pts.length < 21 || !mouth) return false;
  const t = { ...SHH_THRESHOLDS, ...thresholds };
  const f = extendedFingers(pts);
  if (!f.index || f.middle || f.ring || f.pinky) return false;

  // Upright: the finger points up the image, within 45° of vertical.
  const tip = pts[LANDMARK.INDEX_TIP];
  const pip = pts[LANDMARK.INDEX_PIP];
  const dx = tip.x - pip.x;
  const dy = tip.y - pip.y;
  if (dy >= 0 || Math.abs(dx) > Math.abs(dy)) return false;

  return distToSegment(mouth, pip, tip) / handScale(pts) <= t.maxDistance;
}

function distToSegment(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const k = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + k * vx), p.y - (a.y + k * vy));
}

/**
 * Classify a static pose.
 *
 * @param {{x:number,y:number}[]} pts Aspect-corrected points from `toPoints`.
 * @param {object} [thresholds]
 * @returns {'ok_sign'|'pinch'|'open_palm'|'fist'|null}
 */
export function classifyPose(pts, thresholds = {}) {
  if (!pts || pts.length < 21) return null;
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const scale = handScale(pts);
  const fingers = extendedFingers(pts);
  const gap = pinchGap(pts, scale);
  const reach = indexReach(pts, scale);

  // Order matters: most specific first.
  // - The OK sign is a pinch with the other three fingers up, so it would read
  //   as a pinch if pinch came first.
  // - A pinch also satisfies the fist test (its index finger reads as curled),
  //   so pinch has to be checked before fist or it would never be reachable.
  if (gap < t.pinchMaxGap && fingers.middle && fingers.ring && fingers.pinky) {
    return 'ok_sign';
  }

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
 * Which of the four fingers are out, as a fixed-width string: `'I--P'` is
 * index and pinky (horns), `'IM--'` a peace sign, `'----'` a fist.
 *
 * For measuring shapes that are not gestures yet. The check-up uses it to try
 * candidate poses on real hands before either is built in, and to log what the
 * camera actually saw when a pose was missed. Thumb deliberately left out, for
 * the same reason it never decides a pose here.
 */
export function fingerPattern(pts) {
  if (!pts || pts.length < 21) return null;
  const f = extendedFingers(pts);
  return `${f.index ? 'I' : '-'}${f.middle ? 'M' : '-'}${f.ring ? 'R' : '-'}${f.pinky ? 'P' : '-'}`;
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

// Shared geometry over MediaPipe hand landmarks.
//
// Imported by both the browser page and the Node test suite, so this file stays
// dependency-free and side-effect-free.
//
// MediaPipe returns x/y normalized to [0,1] as a *fraction of the frame*, which
// means x and y are not the same physical unit unless the frame is square. On a
// 640x480 feed, dx=0.1 is 64px but dy=0.1 is only 48px. Every distance and
// direction test here would be skewed by that, so callers pass the frame aspect
// (width / height) to `toPoints` once per frame and everything downstream works
// in isotropic units.

export const LANDMARK = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
};

// The four non-thumb fingers. The thumb is deliberately excluded: its landmarks
// are the least reliable of the 21, so it never gates a decision on its own.
export const FINGERS = [
  { name: 'index', tip: LANDMARK.INDEX_TIP, pip: LANDMARK.INDEX_PIP },
  { name: 'middle', tip: LANDMARK.MIDDLE_TIP, pip: LANDMARK.MIDDLE_PIP },
  { name: 'ring', tip: LANDMARK.RING_TIP, pip: LANDMARK.RING_PIP },
  { name: 'pinky', tip: LANDMARK.PINKY_TIP, pip: LANDMARK.PINKY_PIP },
];

const PALM_MCPS = [
  LANDMARK.INDEX_MCP,
  LANDMARK.MIDDLE_MCP,
  LANDMARK.RING_MCP,
  LANDMARK.PINKY_MCP,
];

/** Aspect-correct raw MediaPipe landmarks into isotropic {x, y} points. */
export function toPoints(landmarks, aspect = 1) {
  return landmarks.map((p) => ({ x: p.x * aspect, y: p.y }));
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The unit every threshold is expressed in: wrist to middle-finger knuckle,
 * i.e. palm length. Scaling by this makes detection independent of how far the
 * hand is from the camera.
 */
export function handScale(pts) {
  return Math.max(dist(pts[LANDMARK.WRIST], pts[LANDMARK.MIDDLE_MCP]), 1e-6);
}

/**
 * Centroid of the four knuckles. Much steadier than the wrist (which pivots) or
 * any fingertip (which moves independently of the hand), so it's what we track
 * for motion.
 */
export function palmCenter(pts) {
  let x = 0;
  let y = 0;
  for (const i of PALM_MCPS) {
    x += pts[i].x;
    y += pts[i].y;
  }
  return { x: x / PALM_MCPS.length, y: y / PALM_MCPS.length };
}

/**
 * A finger is extended when its tip sits farther from the wrist than its middle
 * joint does. This is rotation-invariant, unlike the common `tip.y < pip.y`
 * shortcut, which silently inverts as soon as the hand tilts sideways or points
 * downward.
 */
export function isExtended(pts, tip, pip) {
  const wrist = pts[LANDMARK.WRIST];
  return dist(pts[tip], wrist) > dist(pts[pip], wrist);
}

/** Extension state of the four non-thumb fingers, plus a count. */
export function extendedFingers(pts) {
  const state = {};
  let count = 0;
  for (const f of FINGERS) {
    const ext = isExtended(pts, f.tip, f.pip);
    state[f.name] = ext;
    if (ext) count += 1;
  }
  return { ...state, count };
}

/** Lenient thumb-out test, used only to confirm an open palm. */
export function isThumbExtended(pts) {
  return isExtended(pts, LANDMARK.THUMB_TIP, LANDMARK.THUMB_MCP);
}

/** Thumb-tip to index-tip gap, in hand-scale units. */
export function pinchGap(pts, scale = handScale(pts)) {
  return dist(pts[LANDMARK.THUMB_TIP], pts[LANDMARK.INDEX_TIP]) / scale;
}

/** How far the index tip reaches from the wrist, in hand-scale units. */
export function indexReach(pts, scale = handScale(pts)) {
  return dist(pts[LANDMARK.INDEX_TIP], pts[LANDMARK.WRIST]) / scale;
}

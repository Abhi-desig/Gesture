// Which of your screens you are facing, worked out from where your head points.
//
// This is the spatial half of the app. The hand says *what* to do; the head
// says *where*. Look at a screen and point, and that screen's front window comes
// forward. Keep pointing, turn to another screen and lower your hand, and the
// window moves there.
//
// Pure and camera-free, like gestures.js: face landmarks in, a display id out.
// app.js feeds it from the camera, the tests feed it synthetic faces.
//
// Why the head and not the eyes: a laptop webcam cannot resolve where your
// pupils point to better than a few degrees, but monitors sit tens of degrees
// apart, and you turn your head — not just your eyes — to look at one that far
// away. Head direction is the coarse, honest signal that matches the question.

// MediaPipe face mesh indices. Subject's right is image left.
export const FACE = {
  RIGHT_EYE_OUTER: 33,
  LEFT_EYE_OUTER: 263,
  FOREHEAD: 10,
  CHIN: 152,
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

/** Angular distance between two head directions, in the same loose degrees. */
export function angleBetween(a, b) {
  return Math.hypot(a.yaw - b.yaw, a.pitch - b.pitch);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

export const DEFAULT_SCREEN_OPTIONS = {
  // How far your head may point from a screen's calibrated direction and still
  // count as facing it. Past this you are looking at something else — your
  // notebook, the window, the person next to you — and pointing does nothing.
  maxAngle: 20,

  // A screen has to beat the current one by this much before attention moves.
  // Without it, a head held half-way between two screens flips between them on
  // every frame of tracking noise.
  switchMargin: 4,

  // Exponential smoothing on the raw angles, per frame. Head tracking jitters by
  // a degree or two; this keeps the readout readable and the margin meaningful.
  smoothing: 0.35,
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
  }

  /**
   * Feed one head pose.
   *
   * @param {{yaw:number,pitch:number}|null} pose null when no face is in view.
   * @returns {{screen: number|null, pose: {yaw:number,pitch:number}|null,
   *   distance: number|null, nearest: number|null}} `screen` is who has your
   *   attention; `nearest` and `distance` are for the readout, and are reported
   *   even when you are too far from every screen to count as facing one.
   */
  update(pose) {
    if (!pose) {
      // Lost the face: say so rather than holding a stale answer. A turn
      // that happened while the face was out of view must not act on the
      // screen you were facing before it.
      this.reset();
      return { screen: null, pose: null, distance: null, nearest: null };
    }

    const a = this.options.smoothing;
    this.smoothed = this.smoothed
      ? {
          yaw: this.smoothed.yaw + a * (pose.yaw - this.smoothed.yaw),
          pitch: this.smoothed.pitch + a * (pose.pitch - this.smoothed.pitch),
        }
      : { ...pose };

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
 * Carrying a window from one screen to another.
 *
 * Starts when a screen gesture fires — the window on the screen you were facing
 * has just come forward. While the gesture is held, the screen you turn to is
 * the destination. Let go and, if that is a different screen, the window goes
 * there; if it is the same one, nothing more happens, so a plain point-to-focus
 * never moves anything.
 *
 * "Let go" includes the hand leaving the frame, which is what lowering your arm
 * looks like to the camera. A short grace stops one dropped tracking frame from
 * counting as a release.
 */
export class Carry {
  constructor({ releaseMs = 200, timeoutMs = 8000 } = {}) {
    this.releaseMs = releaseMs;
    this.timeoutMs = timeoutMs;
    this.cancel();
  }

  get active() {
    return this.gesture !== null;
  }

  cancel() {
    this.gesture = null;
    this.from = null;
    this.target = null;
    this.startedAt = 0;
    this.releasedAt = null;
  }

  start(gesture, screen, now) {
    this.gesture = gesture;
    this.from = screen;
    this.target = screen;
    this.startedAt = now;
    this.releasedAt = null;
  }

  /**
   * @param {string|null} pose The pose held this frame.
   * @param {number|null} screen The screen faced this frame.
   * @param {number} now
   * @returns {{gesture:string, from:number, to:number}|null} A drop to perform.
   */
  update(pose, screen, now) {
    if (!this.active) return null;

    // Long enough to cross a desk and come back; past it, a forgotten hold
    // should not move a window when the hand finally drops minutes later.
    if (now - this.startedAt > this.timeoutMs) {
      this.cancel();
      return null;
    }

    // Keep the last screen actually faced. The face can drop out for a frame
    // mid-turn; that is not you changing your mind about where it goes.
    if (screen !== null) this.target = screen;

    if (pose === this.gesture) {
      this.releasedAt = null;
      return null;
    }

    this.releasedAt ??= now;
    if (now - this.releasedAt < this.releaseMs) return null;

    const { gesture, from, target } = this;
    this.cancel();
    return target !== null && target !== from ? { gesture, from, to: target } : null;
  }
}

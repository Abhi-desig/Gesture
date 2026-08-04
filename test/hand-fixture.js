// Synthetic 21-landmark hands for testing, built geometrically.
//
// Hand-typing 21 coordinate pairs per pose would be unreadable and impossible to
// adjust, so poses are described anatomically instead: where each MCP knuckle
// sits, how long each finger is, and how far each fingertip reaches past its
// knuckle. Everything is in "scale units" (multiples of wrist -> middle knuckle,
// i.e. palm length), which is the same unit the detector thresholds use.
//
// Output points are already isotropic, matching what `toPoints` produces, so they
// can be handed straight to `classifyPose` / `SwipeTracker`.

// Knuckle positions in the local hand frame: wrist at (0,0), fingers along +y.
const MCP = {
  index: { x: -0.45, y: 0.92 },
  middle: { x: 0.0, y: 1.0 }, // defines the scale unit: 1.0 from the wrist
  ring: { x: 0.42, y: 0.95 },
  pinky: { x: 0.78, y: 0.85 },
};

const FINGER_LEN = { index: 1.0, middle: 1.1, ring: 1.0, pinky: 0.8 };

// Where the joints sit along the finger, as a fraction of its length.
const PIP_AT = 0.42;
const DIP_AT = 0.72;

const JOINT_INDEX = {
  index: { mcp: 5, pip: 6, dip: 7, tip: 8 },
  middle: { mcp: 9, pip: 10, dip: 11, tip: 12 },
  ring: { mcp: 13, pip: 14, dip: 15, tip: 16 },
  pinky: { mcp: 17, pip: 18, dip: 19, tip: 20 },
};

/**
 * How far a fingertip reaches past its knuckle, as a fraction of finger length.
 * `curled` is negative because in a real closed fist the fingertips press into
 * the palm, ending up *closer* to the wrist than the knuckles are.
 */
export const REACH = {
  extended: 1.0,
  curled: -0.15,
  pinching: 0.5,
};

// Thumb tip positions in the local frame, per configuration.
const THUMB_TIP = {
  out: { x: -1.35, y: 0.95 }, // spread wide, as in an open palm
  pinch: { x: -0.3, y: 1.3 }, // meeting the index tip
  tucked: { x: -0.3, y: 0.72 }, // folded across the fingers, as in a fist
};

const THUMB_CMC = { x: -0.55, y: 0.25 };
const THUMB_MCP = { x: -0.75, y: 0.45 };

const PRESETS = {
  open_palm: {
    fingers: { index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended' },
    thumb: 'out',
  },
  fist: {
    fingers: { index: 'curled', middle: 'curled', ring: 'curled', pinky: 'curled' },
    thumb: 'tucked',
  },
  pinch: {
    fingers: { index: 'pinching', middle: 'curled', ring: 'curled', pinky: 'curled' },
    thumb: 'pinch',
  },
  // Four fingers out with the thumb folded in — the swipe pose. Distinct from
  // open_palm only by the thumb, which is exactly why the detector ignores the
  // thumb for swipes and leans on motion instead.
  four_finger: {
    fingers: { index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended' },
    thumb: 'tucked',
  },
  // Two fingers out: matches none of the poses.
  peace: {
    fingers: { index: 'extended', middle: 'extended', ring: 'curled', pinky: 'curled' },
    thumb: 'tucked',
  },
};

/**
 * @param {object} [opts]
 * @param {keyof PRESETS} [opts.pose]
 * @param {object} [opts.fingers] Per-finger override, keys of REACH or a number.
 * @param {keyof THUMB_TIP} [opts.thumb]
 * @param {number} [opts.scale] Palm length in normalized image units.
 * @param {number} [opts.rotation] Radians, to verify rotation invariance.
 * @param {{x:number,y:number}} [opts.origin] Wrist position in the image.
 * @returns {{x:number,y:number}[]} 21 points
 */
export function buildHand({
  pose = 'open_palm',
  fingers,
  thumb,
  scale = 0.12,
  rotation = 0,
  origin = { x: 0.5, y: 0.75 },
} = {}) {
  const preset = PRESETS[pose];
  if (!preset) throw new Error(`unknown pose preset "${pose}"`);

  const fingerSpec = { ...preset.fingers, ...fingers };
  const thumbSpec = thumb ?? preset.thumb;

  const local = new Array(21);
  local[0] = { x: 0, y: 0 };
  local[1] = THUMB_CMC;
  local[2] = THUMB_MCP;

  const tip = THUMB_TIP[thumbSpec] ?? thumbSpec;
  if (!tip || typeof tip.x !== 'number') {
    throw new Error(`unknown thumb spec "${thumbSpec}"`);
  }
  local[4] = tip;
  // Thumb IP sits 60% of the way from the knuckle to the tip.
  local[3] = {
    x: THUMB_MCP.x + (tip.x - THUMB_MCP.x) * 0.6,
    y: THUMB_MCP.y + (tip.y - THUMB_MCP.y) * 0.6,
  };

  for (const [name, idx] of Object.entries(JOINT_INDEX)) {
    const knuckle = MCP[name];
    const len = FINGER_LEN[name];
    const spec = fingerSpec[name];
    const reach = typeof spec === 'number' ? spec : REACH[spec];
    if (reach === undefined) throw new Error(`unknown reach "${spec}" for ${name}`);

    local[idx.mcp] = knuckle;
    local[idx.pip] = { x: knuckle.x, y: knuckle.y + PIP_AT * len };
    local[idx.dip] = { x: knuckle.x, y: knuckle.y + DIP_AT * len };
    local[idx.tip] = { x: knuckle.x, y: knuckle.y + reach * len };
  }

  // Local frame has fingers along +y; image coordinates run y-downward, so flip
  // y to put an upright hand pointing toward the top of the frame.
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return local.map((p) => {
    const lx = p.x;
    const ly = -p.y;
    return {
      x: origin.x + (lx * cos - ly * sin) * scale,
      y: origin.y + (lx * sin + ly * cos) * scale,
    };
  });
}

/**
 * Generate a stream of frames with the palm travelling across the frame.
 *
 * Note the sign convention: the tracker negates raw dx because the camera faces
 * the user, so a *decreasing* raw x means the hand moved to the user's own right.
 *
 * @returns {{pts: {x:number,y:number}[], t: number}[]}
 */
export function motionStream({
  pose = 'four_finger',
  frames = 20,
  durationMs = 300,
  dx = 0,
  dy = 0,
  scale = 0.12,
  // Matches buildHand's default origin, so a stream can be concatenated with a
  // stationary hold without an accidental vertical jump between the two — which
  // would trip the swipe detector's horizontal-dominance check.
  start = { x: 0.5, y: 0.75 },
  startT = 1000,
} = {}) {
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    const f = frames === 1 ? 0 : i / (frames - 1);
    out.push({
      t: startT + f * durationMs,
      pts: buildHand({
        pose,
        scale,
        origin: { x: start.x + dx * f, y: start.y + dy * f },
      }),
    });
  }
  return out;
}

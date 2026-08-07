// config.json loading, validation and hot reload.
//
// Shortcuts are parsed here, at load time, so a typo surfaces immediately with
// the gesture name attached rather than silently doing nothing the first time you
// make that gesture.
//
// Reloads are atomic: if anything in the new file is invalid, the whole reload is
// rejected and the previous good config stays live. A half-applied mapping table
// would be worse than a stale one.

import fs from 'node:fs';
import path from 'node:path';

import { POSES } from '../public/gestures.js';
import { DEFAULT_HOLD_MS } from '../public/recognizer.js';
import { SWIPES } from '../public/swipe.js';
import { BACKEND_NAMES } from './backends/index.js';
import { formatShortcut, parseShortcut } from './shortcut.js';

/** Gesture names the browser page can actually emit. */
export const KNOWN_GESTURES = [...POSES, ...SWIPES];

const NUMBERS = {
  cooldownMs: { default: 1200, min: 0, max: 60000 },
  stillnessMaxVelocity: { default: 0.8, min: 0, max: 100 },
  swipeWindowMs: { default: 350, min: 50, max: 5000 },
  swipeMinTravel: { default: 1.2, min: 0.1, max: 20 },
  swipeMinVelocity: { default: 3.0, min: 0, max: 100 },
  swipeMaxVerticalRatio: { default: 0.5, min: 0.01, max: 10 },
  port: { default: 4321, min: 1, max: 65535 },
  // Dock-swipe tuning, for the space_left/space_right actions. See KEYSEND_SOURCES
  // above for why any of this is configurable rather than compiled in.
  dockSwipeVelocity: { default: 400, min: 1, max: 100000 },
  dockSwipeLingerMs: { default: 300, min: 0, max: 10000 },
};

const BOOLEANS = {
  requireReleaseBetweenFires: true,
  swipeRearmRequiresPoseBreak: true,
  invertSwipeDirection: false,
  dryRun: false,
  // After pressing a Space-switching chord, read com.apple.spaces back and say
  // whether the desktop actually moved. On by default: "the log says it fired
  // and nothing happened" is the single most expensive way to debug this.
  //
  // It costs a short poll of the preferences domain, and only on ctrl+left and
  // ctrl+right. A switch that works is detected on the first or second read; the
  // full ~600ms wait is only paid when nothing moved, which is exactly the case
  // worth spending it on.
  verifySpaceSwitch: true,
  // Hold a session event tap while posting the gesture. Both reference
  // implementations do; whether the WindowServer requires it is measured, not
  // assumed — `npm run probe:keysend -- --swipe-only`.
  dockSwipeWithTap: true,
};

/** Dock-swipe field layouts. See native/keysend.swift for what differs. */
export const DOCK_SWIPE_VARIANTS = ['iss', 'mmf'];

/** How space_left/space_right are performed. See backends/cgevent.js. */
export const SPACE_STRATEGIES = ['osascript', 'direct', 'dockswipe'];

/**
 * Bindings the *page* performs, not the server.
 *
 * These never become key presses and never reach a backend. `toggle_armed` is
 * the reason the category exists: arming is page state, so a gesture that
 * toggles it has to be handled where that state lives — and it has to work
 * while the page is disarmed, which is exactly when nothing is being sent to
 * the server at all.
 */
export const CLIENT_ACTIONS = ['toggle_armed'];

const isClientAction = (combo) => CLIENT_ACTIONS.includes(combo);

/**
 * Which CGEventSource state table the native helper attributes its events to.
 *
 * Only meaningful for the cgevent backend. It is a setting rather than a
 * constant because the whole fix turns on the WindowServer seeing a modifier go
 * down globally, and which state table it honours for symbolic hotkeys is an
 * empirical question — `npm run probe:keysend` sends the same chord through each
 * and reports which one moved the Space.
 */
export const KEYSEND_SOURCES = ['hid', 'combined', 'private', 'null'];

// Setting names, so the flat-shorthand reader can tell a gesture binding from a
// tunable. `backend` matters most here: it's the one string-valued setting, so
// without it in this set it would be mistaken for a gesture mapping.
const RESERVED = new Set([
  'gestures',
  'backend',
  'keysendSource',
  'spaceStrategy',
  'dockSwipeVariant',
  'holdMs',
  ...Object.keys(NUMBERS),
  ...Object.keys(BOOLEANS),
]);

const HOLD_MS_LIMITS = { min: 0, max: 10000 };

/**
 * The page's panic chord: a bare Escape one-way disarms it (see app.js).
 *
 * Binding a gesture to this is self-defeating in a way that is genuinely hard to
 * diagnose. The gesture page is normally the frontmost window — you are watching
 * the readout — so the Escape the server presses lands on the page itself and
 * silently disarms it. Every later gesture is then dropped with no error
 * anywhere, which reads as "it worked for a while and then stopped".
 */
const PANIC_CHORD = { modifiers: [], key: 'escape' };

const isPanicChord = (parsed) =>
  parsed.key === PANIC_CHORD.key && parsed.modifiers.length === 0;

/**
 * `holdMs` is either a single number or a per-gesture map with a `default` key:
 *
 *   "holdMs": 180
 *   "holdMs": { "default": 180, "open_palm": 1200 }
 *
 * The map form exists because the swipe pose is a subset of the open-palm pose, so
 * open_palm needs a longer deliberate hold than the other poses to stay out of the
 * way of swipes.
 */
function validateHoldMs(raw, errors) {
  const value = raw.holdMs ?? { ...DEFAULT_HOLD_MS };

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < HOLD_MS_LIMITS.min || value > HOLD_MS_LIMITS.max) {
      errors.push(`"holdMs" must be between ${HOLD_MS_LIMITS.min} and ${HOLD_MS_LIMITS.max}ms`);
      return null;
    }
    return value;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('"holdMs" must be a number, or an object like { "default": 180, "open_palm": 1200 }');
    return null;
  }

  const out = {};
  for (const [key, ms] of Object.entries(value)) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < HOLD_MS_LIMITS.min || ms > HOLD_MS_LIMITS.max) {
      errors.push(`"holdMs.${key}" must be a number between ${HOLD_MS_LIMITS.min} and ${HOLD_MS_LIMITS.max}`);
      continue;
    }
    if (key !== 'default' && !KNOWN_GESTURES.includes(key)) {
      errors.push(`"holdMs.${key}" is not a gesture — expected "default" or one of ${KNOWN_GESTURES.join(', ')}`);
      continue;
    }
    out[key] = ms;
  }

  if (out.default === undefined) out.default = DEFAULT_HOLD_MS.default;
  return out;
}

/**
 * Pull the gesture map out of a raw config object.
 *
 * Prefers the explicit `gestures` block, but also accepts the flat shorthand
 * from the original spec — `{ "fist": "space", "pinch": "cmd+shift+m" }` — by
 * reading any non-reserved top-level string as a binding.
 */
function extractGestures(raw) {
  if (raw.gestures !== undefined) {
    if (typeof raw.gestures !== 'object' || raw.gestures === null || Array.isArray(raw.gestures)) {
      throw new Error('"gestures" must be an object mapping gesture names to shortcuts');
    }
    return raw.gestures;
  }

  const flat = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && !RESERVED.has(key)) flat[key] = value;
  }
  return flat;
}

/**
 * @param {object} raw Parsed JSON.
 * @returns {{gestures: object, settings: object, warnings: string[]}}
 * @throws {Error} listing every problem found, not just the first.
 */
export function validate(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('config must be a JSON object');
  }

  const errors = [];
  const warnings = [];
  const settings = {};

  for (const [name, spec] of Object.entries(NUMBERS)) {
    const value = raw[name] ?? spec.default;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`"${name}" must be a number (got ${JSON.stringify(raw[name])})`);
    } else if (value < spec.min || value > spec.max) {
      errors.push(`"${name}" must be between ${spec.min} and ${spec.max} (got ${value})`);
    } else {
      settings[name] = value;
    }
  }

  for (const [name, fallback] of Object.entries(BOOLEANS)) {
    const value = raw[name] ?? fallback;
    if (typeof value !== 'boolean') {
      errors.push(`"${name}" must be true or false (got ${JSON.stringify(raw[name])})`);
    } else {
      settings[name] = value;
    }
  }

  const holdMs = validateHoldMs(raw, errors);
  if (holdMs !== null) settings.holdMs = holdMs;

  const backend = raw.backend ?? 'auto';
  if (!BACKEND_NAMES.includes(backend)) {
    errors.push(`"backend" must be one of ${BACKEND_NAMES.join(', ')} (got ${JSON.stringify(backend)})`);
  } else {
    settings.backend = backend;
  }

  const spaceStrategy = raw.spaceStrategy ?? 'osascript';
  if (!SPACE_STRATEGIES.includes(spaceStrategy)) {
    errors.push(
      `"spaceStrategy" must be one of ${SPACE_STRATEGIES.join(', ')} (got ${JSON.stringify(raw.spaceStrategy)})`,
    );
  } else {
    settings.spaceStrategy = spaceStrategy;
  }

  const dockSwipeVariant = raw.dockSwipeVariant ?? 'iss';
  if (!DOCK_SWIPE_VARIANTS.includes(dockSwipeVariant)) {
    errors.push(
      `"dockSwipeVariant" must be one of ${DOCK_SWIPE_VARIANTS.join(', ')} (got ${JSON.stringify(raw.dockSwipeVariant)})`,
    );
  } else {
    settings.dockSwipeVariant = dockSwipeVariant;
  }

  const keysendSource = raw.keysendSource ?? 'hid';
  if (!KEYSEND_SOURCES.includes(keysendSource)) {
    errors.push(
      `"keysendSource" must be one of ${KEYSEND_SOURCES.join(', ')} (got ${JSON.stringify(raw.keysendSource)})`,
    );
  } else {
    settings.keysendSource = keysendSource;
  }

  const gestures = {};
  let rawGestures;
  try {
    rawGestures = extractGestures(raw);
  } catch (err) {
    errors.push(err.message);
    rawGestures = {};
  }

  for (const [name, combo] of Object.entries(rawGestures)) {
    // Checked before parsing: a client action is not a shortcut and must not be
    // run through the key parser, which would reject it as an unknown key.
    if (isClientAction(combo)) {
      gestures[name] = { combo, client: true };
      if (!KNOWN_GESTURES.includes(name)) {
        warnings.push(
          `gesture "${name}" is bound but never emitted — expected one of ${KNOWN_GESTURES.join(', ')}`,
        );
      }
      continue;
    }

    try {
      const parsed = parseShortcut(combo);
      if (isPanicChord(parsed)) {
        errors.push(
          `gesture "${name}" is bound to "escape", which is the gesture page's panic ` +
            'disarm. Firing it would disarm the page — every later gesture would be ' +
            'silently dropped. Use a different shortcut, or add a modifier.',
        );
      } else {
        gestures[name] = { combo: formatShortcut(parsed), parsed };
      }
    } catch (err) {
      errors.push(`gesture "${name}": ${err.message}`);
    }
    if (!KNOWN_GESTURES.includes(name)) {
      warnings.push(
        `gesture "${name}" is bound but never emitted — expected one of ${KNOWN_GESTURES.join(', ')}`,
      );
    }
  }

  if (Object.keys(gestures).length === 0 && errors.length === 0) {
    warnings.push('no gestures are bound; nothing will happen until you add some');
  }

  if (errors.length > 0) {
    throw new Error(`invalid config:\n  - ${errors.join('\n  - ')}`);
  }

  return { gestures, settings, warnings };
}

export class ConfigStore {
  /**
   * @param {string} filePath
   * @param {{log?: (msg: string) => void}} [options]
   */
  constructor(filePath, { log = console.log } = {}) {
    this.filePath = path.resolve(filePath);
    this.log = log;
    this.current = null;
    this.listeners = new Set();
    this.watcher = null;
    this.debounce = null;
  }

  /** Read and validate from disk. Throws without touching `current` on failure. */
  load() {
    const text = fs.readFileSync(this.filePath, 'utf8');

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path.basename(this.filePath)} is not valid JSON: ${err.message}`);
    }

    const next = validate(raw);
    for (const warning of next.warnings) this.log(`config warning: ${warning}`);

    this.current = next;
    return next;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Watch for edits so mappings can be changed without a restart.
   *
   * Watches the containing directory rather than the file itself: editors that
   * save atomically (vim, and VS Code with atomic saves on) replace the file via
   * rename, which permanently detaches a file-level watch after the first save.
   */
  watch() {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);

    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== base) return;

      // A single save emits several events; collapse them.
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        const previous = this.current;
        try {
          this.load();
          this.log(`reloaded ${base}`);
          for (const listener of this.listeners) listener(this.current);
        } catch (err) {
          this.current = previous;
          this.log(`ignoring ${base}: ${err.message}`);
          this.log('previous config is still active');
        }
      }, 150);
    });

    this.watcher.unref?.();
  }

  close() {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }

  /** What GET /config returns: display bindings plus the client-side tunables. */
  clientPayload() {
    const { gestures, settings } = this.current;
    return {
      gestures: Object.fromEntries(
        Object.entries(gestures).map(([name, g]) => [name, g.combo]),
      ),
      knownGestures: KNOWN_GESTURES,
      // So the page can tell a binding it must perform itself from one the
      // server will press, without hardcoding the list in two places.
      clientActions: CLIENT_ACTIONS,
      dryRun: settings.dryRun,
      tuning: {
        holdMs: settings.holdMs,
        cooldownMs: settings.cooldownMs,
        requireReleaseBetweenFires: settings.requireReleaseBetweenFires,
        stillnessMaxVelocity: settings.stillnessMaxVelocity,
        swipeWindowMs: settings.swipeWindowMs,
        swipeMinTravel: settings.swipeMinTravel,
        swipeMinVelocity: settings.swipeMinVelocity,
        swipeMaxVerticalRatio: settings.swipeMaxVerticalRatio,
        swipeRearmRequiresPoseBreak: settings.swipeRearmRequiresPoseBreak,
        invertSwipeDirection: settings.invertSwipeDirection,
      },
    };
  }
}

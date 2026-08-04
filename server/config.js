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
import { SWIPES } from '../public/swipe.js';
import { BACKEND_NAMES } from './backends/index.js';
import { formatShortcut, parseShortcut } from './shortcut.js';

/** Gesture names the browser page can actually emit. */
export const KNOWN_GESTURES = [...POSES, ...SWIPES];

const NUMBERS = {
  cooldownMs: { default: 1200, min: 0, max: 60000 },
  confirmFrames: { default: 4, min: 1, max: 60 },
  stillnessMaxVelocity: { default: 0.8, min: 0, max: 100 },
  swipeWindowMs: { default: 350, min: 50, max: 5000 },
  swipeMinTravel: { default: 1.2, min: 0.1, max: 20 },
  swipeMinVelocity: { default: 3.0, min: 0, max: 100 },
  swipeMaxVerticalRatio: { default: 0.5, min: 0.01, max: 10 },
  port: { default: 4321, min: 1, max: 65535 },
};

const BOOLEANS = {
  requireReleaseBetweenFires: true,
  swipeRearmRequiresPoseBreak: true,
  invertSwipeDirection: false,
  dryRun: false,
};

// Setting names, so the flat-shorthand reader can tell a gesture binding from a
// tunable. `backend` matters most here: it's the one string-valued setting, so
// without it in this set it would be mistaken for a gesture mapping.
const RESERVED = new Set([
  'gestures',
  'backend',
  ...Object.keys(NUMBERS),
  ...Object.keys(BOOLEANS),
]);

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

  const backend = raw.backend ?? 'auto';
  if (!BACKEND_NAMES.includes(backend)) {
    errors.push(`"backend" must be one of ${BACKEND_NAMES.join(', ')} (got ${JSON.stringify(backend)})`);
  } else {
    settings.backend = backend;
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
    try {
      const parsed = parseShortcut(combo);
      gestures[name] = { combo: formatShortcut(parsed), parsed };
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
      dryRun: settings.dryRun,
      tuning: {
        confirmFrames: settings.confirmFrames,
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

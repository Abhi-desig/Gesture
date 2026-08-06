// Read-only queries about the macOS environment, for startup diagnostics.
//
// Everything here answers a question people otherwise guess at: which app owns
// the Accessibility grant, whether the Space-switching hotkeys are even turned
// on, and how many Spaces exist. All three have to be right before a four-finger
// swipe can move the desktop, and when one is wrong the symptom is identical to
// a broken gesture detector.
//
// Nothing here writes. Every failure degrades to `null` rather than throwing:
// a diagnostic that can take the server down is worse than no diagnostic.

import { spawnSync } from 'node:child_process';

import { BINARY } from '../scripts/build-native.mjs';

/**
 * The WindowServer's own view of Spaces, via the native helper.
 *
 * Prefer this to `readSpaces()` for anything that asks "did the desktop move?".
 * com.apple.spaces is the *Dock's* cache: written when the Dock performs a
 * switch and not otherwise, and it lags. It cannot see a Space changed by a
 * route that bypasses the Dock, and it cannot tell "never moved" apart from
 * "moved and snapped back" — two findings with completely different causes.
 *
 * @returns {{active: number, displays: {display: string, spaces: number[],
 *   activeIndex: number|null}[]}|null}
 */
export function windowServerSpaces() {
  const result = spawnSync(BINARY, ['space', 'status'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** Read a preferences domain as a plain object, or null if unreadable. */
function readDefaults(domain) {
  const exported = spawnSync('defaults', ['export', domain, '-'], { encoding: 'utf8' });
  if (exported.status !== 0) return null;

  // Via `defaults export` rather than reading the plist file directly: the file
  // is owned by cfprefsd, which buffers writes, so the copy on disk can lag.
  const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: exported.stdout,
    encoding: 'utf8',
  });
  if (json.status !== 0) return null;

  try {
    return JSON.parse(json.stdout);
  } catch {
    return null;
  }
}

/**
 * Current Space and Space list, per display.
 *
 * @returns {{display: string, current: number|null, spaces: number[]}[]|null}
 */
export function readSpaces() {
  const prefs = readDefaults('com.apple.spaces');
  try {
    const monitors = prefs.SpacesDisplayConfiguration['Management Data'].Monitors;
    return monitors.map((m) => ({
      display: m['Display Identifier'],
      current: m['Current Space']?.ManagedSpaceID ?? null,
      spaces: (m.Spaces ?? []).map((s) => s.ManagedSpaceID),
    }));
  } catch {
    return null;
  }
}

/** A short string identifying which Space each display is on right now. */
export const spaceFingerprint = (spaces) =>
  (spaces ?? []).map((m) => `${m.display}:${m.current}`).join(' ');

// Mission Control's "Move left/right a space", by symbolic hotkey id, with the
// key each one carries by default. When these are off — or on but with no key
// attached — no amount of correctly-sent Ctrl+Arrow will move anything.
const SPACE_HOTKEYS = {
  79: { label: 'Move left a space', fallback: 'ctrl+left' },
  81: { label: 'Move right a space', fallback: 'ctrl+right' },
};

// The modifier bits inside a symbolic hotkey's parameter array. Arrow keys also
// set 0x800000 (function) and 0x200000 (numeric pad), which are descriptive
// rather than chosen, so they are deliberately not decoded here.
const MODIFIER_BITS = [
  [0x20000, 'shift'],
  [0x40000, 'ctrl'],
  [0x80000, 'alt'],
  [0x100000, 'cmd'],
];

const ARROW_NAMES = { 123: 'left', 124: 'right', 125: 'down', 126: 'up' };

/**
 * Decode `value.parameters` — `[ascii, keycode, modifierMask]` — into a chord.
 *
 * @returns {string|null} null when the entry carries no usable key at all.
 */
function describeHotkey(parameters) {
  if (!Array.isArray(parameters) || parameters.length < 3) return null;
  const [, keycode, mask] = parameters;
  if (typeof keycode !== 'number' || keycode === 65535) return null;

  const modifiers = MODIFIER_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
  return [...modifiers, ARROW_NAMES[keycode] ?? `keycode ${keycode}`].join('+');
}

/**
 * The Space-switching hotkeys, and — crucially — which key each is bound to.
 *
 * Reading `enabled` alone is not enough, and the gap is not hypothetical: an
 * entry written as `{"enabled": true}` with no `value` is switched on with **no
 * key assigned**. System Settings draws that as a ticked checkbox, and no
 * keystroke triggers it — synthetic or real. Every send method fails identically,
 * which reads exactly like a broken key-sending backend and is not one.
 *
 * @returns {{id: number, label: string, enabled: boolean, boundTo: string|null,
 *   source: 'default'|'configured'}[]|null}
 */
export function readSpaceHotkeys() {
  const prefs = readDefaults('com.apple.symbolichotkeys');
  const table = prefs?.AppleSymbolicHotKeys;
  if (!table) return null;

  return Object.entries(SPACE_HOTKEYS).map(([id, { label, fallback }]) => {
    const entry = table[id];

    // Absent means the system default is in force, and both of these default to
    // on with their standard chord — so a missing entry is the *healthy* case.
    if (entry === undefined) {
      return { id: Number(id), label, enabled: true, boundTo: fallback, source: 'default' };
    }

    // Enabled, but storing no key of its own. Verified on a machine in exactly
    // this state: the hardware chord still switches Spaces, so macOS is falling
    // back to the built-in binding rather than leaving the shortcut keyless.
    // Do not read a missing `value` as "no key assigned" — that inference looks
    // compelling, matches the symptom, and is wrong.
    const parameters = entry?.value?.parameters;
    if (parameters === undefined) {
      return {
        id: Number(id),
        label,
        enabled: entry?.enabled === true,
        boundTo: fallback,
        source: 'default-implied',
      };
    }

    return {
      id: Number(id),
      label,
      enabled: entry?.enabled === true,
      boundTo: describeHotkey(parameters),
      source: 'configured',
    };
  });
}

/**
 * The app macOS attributes this process's Accessibility grant to.
 *
 * Not node, and not the shell: the grant follows the *responsible* process,
 * which is the first ancestor living in an .app bundle. Starting the server from
 * a different editor or terminal than last time silently moves which app needs
 * the checkbox, and that is a genuinely hard thing to guess from the symptom.
 *
 * @returns {{name: string, path: string}|null}
 */
export function responsibleApp() {
  let pid = process.pid;

  for (let hops = 0; hops < 10; hops += 1) {
    const command = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
    if (command.status !== 0) return null;

    const path = command.stdout.trim();
    const match = path.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
    if (match) return { name: match[1], path };

    const parent = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    if (parent.status !== 0) return null;
    const next = Number(parent.stdout.trim());
    if (!Number.isInteger(next) || next <= 1 || next === pid) return null;
    pid = next;
  }

  return null;
}

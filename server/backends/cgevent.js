// CGEvent keyboard backend, via the Swift helper in native/keysend.swift.
//
// This exists because libnut — the native module under nut.js — cannot switch
// Spaces, and structurally cannot be made to. `nm` on its binary shows
// CGEventCreateKeyboardEvent, CGEventSetFlags and CGEventPost, and no
// CGEventSetType at all, so a modifier is only ever a *flag bit* on the key
// event; a real kCGEventFlagsChanged is never emitted. Applications read flags
// off the event and are satisfied, which is why ctrl+right reliably navigates
// inside Chrome. macOS matches symbolic hotkeys against the WindowServer's
// global modifier state, which only flagsChanged updates — so Mission Control
// never sees Control go down and the desktop never moves.
//
// Shelling out per press rather than binding the API in-process: a spawn is
// ~3ms against a gesture cooldown of 1200ms, and a separate process cannot leave
// a modifier stuck down in the server if it crashes mid-chord.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import { BINARY } from '../../scripts/build-native.mjs';

const execFileAsync = promisify(execFile);

// macOS ANSI virtual keycodes. Layout-independent in the sense that matters
// here: these are physical key positions, which is what CGEvent wants.
const KEYCODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,

  equal: 24,
  minus: 27,
  rightbracket: 30,
  leftbracket: 33,
  enter: 36,
  quote: 39,
  semicolon: 41,
  backslash: 42,
  comma: 43,
  slash: 44,
  period: 47,
  tab: 48,
  space: 49,
  backtick: 50,
  backspace: 51,
  escape: 53,

  // Not in ascending order, and not a mistake: the F-key codes were assigned as
  // keyboards gained rows, so F3 and F4 sit far from F1 and F2.
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,

  home: 115,
  pageup: 116,
  delete: 117, // forward delete; `backspace` is the one above the return key
  end: 119,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

// Play/pause, volume and track keys are NSSystemDefined events carrying an
// NX_KEYTYPE_* code, not virtual keycodes — a different event family entirely,
// which is why the helper takes them through a separate subcommand.
const MEDIA_KEYS = {
  audio_vol_up: 0,
  audio_vol_down: 1,
  audio_mute: 7,
  audio_play: 16,
  audio_next: 17,
  audio_prev: 18,
};

// Space navigation is not a keystroke here. macOS declines to match *any*
// synthesized key against the Move-left/right-a-space hotkeys — measured across
// nut.js, a real flagsChanged at every CGEventSource state table, and osascript
// — so these route to the Dock's own trackpad gesture instead.
const SPACE_ACTIONS = {
  space_left: 'left',
  space_right: 'right',
};

function resolve({ modifiers, key }) {
  if (key in SPACE_ACTIONS) return { kind: 'swipe', direction: SPACE_ACTIONS[key], modifiers };
  if (key in MEDIA_KEYS) return { kind: 'media', code: MEDIA_KEYS[key], modifiers };
  if (key in KEYCODES) return { kind: 'key', code: KEYCODES[key], modifiers };
  throw new Error(`no macOS keycode for "${key}"`);
}

/**
 * @param {{keysendSource?: string}} [options] `keysendSource` picks which
 *   CGEventSource state table the synthesized events are attributed to. It is
 *   configurable because which one the WindowServer actually honours for
 *   symbolic hotkeys is an empirical question — `npm run probe:keysend` answers
 *   it, and the answer gets pinned in config.json rather than recompiled in.
 */
/**
 * How `space_left` / `space_right` are actually performed.
 *
 * Measured on macOS 26.4 against `CGSGetActiveSpace` — not against
 * com.apple.spaces, which is the Dock's cache and never showed any of this:
 *
 *   osascript   moved the Space and it stayed. The OS pressing its own key
 *               through System Events, which is evidently a different path from
 *               a key this process synthesizes: every direct injection
 *               (nut.js, CGEvent with a real flagsChanged at all four source
 *               state tables) failed, and the keystroke leaked to the focused
 *               app instead. Default because it uses no private API at all.
 *   direct      CGSManagedDisplaySetCurrentSpace. Works, but the Space can be
 *               pulled back after ~1.5s when focus stays behind.
 *   dockswipe   The Dock's trackpad gesture. Works sometimes; reverted in two
 *               of four configurations and the `mmf` layout moves the wrong way.
 *
 * Kept selectable because all three are load-bearing on undocumented behaviour
 * and the ranking could invert on the next macOS.
 */
export const SPACE_STRATEGIES = ['osascript', 'direct', 'dockswipe'];

export async function create({
  keysendSource = 'hid',
  spaceStrategy = 'osascript',
  dockSwipeVariant = 'iss',
  dockSwipeVelocity = 400,
  dockSwipeLingerMs = 300,
  dockSwipeWithTap = true,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('the cgevent backend is macOS-only');
  }
  if (!fs.existsSync(BINARY)) {
    // Not an error the user should have to decode: `auto` will fall through to
    // nut.js, and this message is what tells them why Spaces still don't switch.
    throw new Error('native/build/keysend is not built — run "npm run build:native"');
  }

  const sourceArg = `--source=${keysendSource}`;

  // The gesture path needs more than the key path does: both reference
  // implementations post from a long-lived process holding a session event tap,
  // and a one-shot that posts and exits immediately is measurably not the same
  // thing. Held as config so the working combination can be pinned without a
  // rebuild — `npm run probe:keysend -- --swipe-only` reports it.
  const swipeArgs = [
    `--variant=${dockSwipeVariant}`,
    `--velocity=${dockSwipeVelocity}`,
    `--linger-ms=${dockSwipeLingerMs}`,
    ...(dockSwipeWithTap ? ['--with-tap'] : []),
  ];

  // Space navigation, by strategy. Each throws on failure; none of them can
  // report whether the desktop actually moved — server/index.js checks that
  // separately against the WindowServer.
  const switchSpace = {
    async osascript(direction) {
      const keycode = direction === 'left' ? 123 : 124;
      await execFileAsync(
        'osascript',
        ['-e', `tell application "System Events" to key code ${keycode} using control down`],
        { timeout: 3000 },
      );
    },

    async direct(direction) {
      try {
        await execFileAsync(BINARY, ['space', direction], { timeout: 2000 });
      } catch (err) {
        // Exit 3 is "posted, not applied yet" — the WindowServer applies this
        // asynchronously, so it is not an error.
        if (err.code !== 3) throw err;
      }
    },

    async dockswipe(direction) {
      await execFileAsync(BINARY, ['swipe', direction, ...swipeArgs], {
        timeout: 2000 + dockSwipeLingerMs,
      });
    },
  }[spaceStrategy];

  return {
    name: 'cgevent',
    keysendSource,
    spaceStrategy,
    dockSwipe: `${dockSwipeVariant} v${dockSwipeVelocity}` +
      `${dockSwipeWithTap ? ' +tap' : ''} +${dockSwipeLingerMs}ms`,

    supports(combo) {
      try {
        resolve(combo);
        return true;
      } catch {
        return false;
      }
    },

    async press(combo) {
      const resolved = resolve(combo);

      if (resolved.kind === 'swipe') {
        try {
          await switchSpace(resolved.direction);
        } catch (err) {
          throw new Error(
            `space_${resolved.direction} via ${spaceStrategy} failed: ` +
              `${(err.stderr || err.message).trim()}`,
          );
        }
        return;
      }

      try {
        await execFileAsync(
          BINARY,
          [resolved.kind, String(resolved.code), ...resolved.modifiers, sourceArg],
          { timeout: 2000 },
        );
      } catch (err) {
        throw new Error(`keysend failed: ${(err.stderr || err.message).trim()}`);
      }
    },
  };
}

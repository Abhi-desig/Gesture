// macOS osascript / System Events keyboard backend.
//
// The zero-native-dependency fallback for when nut.js can't load. Same
// Accessibility permission requirement as nut.js, since it drives the same
// underlying event system.
//
// Known limitation: System Events cannot synthesize media keys, so the `audio_*`
// keys are unsupported here. `supports()` reports that honestly so the resolver
// can prefer nut.js when a config needs them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const MODIFIERS = {
  cmd: 'command down',
  ctrl: 'control down',
  alt: 'option down',
  shift: 'shift down',
};

// Canonical key name -> macOS virtual key code.
const KEY_CODES = {
  space: 49,
  enter: 36,
  tab: 48,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  delete: 117,
  backspace: 51,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  minus: 27,
  equal: 24,
  comma: 43,
  period: 47,
  slash: 44,
  semicolon: 41,
  quote: 39,
  backslash: 42,
  backtick: 50,
  leftbracket: 33,
  rightbracket: 30,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

function isTypable(key) {
  return /^[a-z0-9]$/.test(key);
}

function buildScript({ modifiers, key }) {
  const using =
    modifiers.length > 0
      ? ` using {${modifiers.map((m) => MODIFIERS[m]).join(', ')}}`
      : '';

  if (isTypable(key)) {
    // Safe to interpolate: `key` is a single [a-z0-9] character, already
    // validated against a whitelist by the shortcut parser.
    return `tell application "System Events" to keystroke "${key}"${using}`;
  }

  const code = KEY_CODES[key];
  if (code === undefined) {
    throw new Error(
      `osascript cannot send "${key}" (System Events has no media-key support; use the nutjs backend)`,
    );
  }
  return `tell application "System Events" to key code ${code}${using}`;
}

export async function create() {
  if (process.platform !== 'darwin') {
    throw new Error('the osascript backend is macOS-only');
  }

  // Confirm osascript is actually callable before claiming availability.
  await run('osascript', ['-e', 'return 1']);

  return {
    name: 'osascript',

    supports(combo) {
      try {
        buildScript(combo);
        return true;
      } catch {
        return false;
      }
    },

    async press(combo) {
      // execFile, not exec: no shell, so nothing here is shell-interpretable.
      await run('osascript', ['-e', buildScript(combo)]);
    },
  };
}

// Shortcut string -> backend-neutral descriptor.
//
// "cmd+shift+m" becomes { modifiers: ['cmd','shift'], key: 'm' }. Backends own
// their own translation from these canonical names to nut.js Key enums or
// osascript key codes, which keeps this file pure and testable.
//
// Parsing happens at config *load* time, not at press time, so a typo in
// config.json surfaces immediately with the gesture name attached instead of
// silently doing nothing the first time you make that gesture.

const MODIFIER_ALIASES = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
};

// Canonical order, so output is deterministic regardless of how it was written.
const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift'];

const KEY_ALIASES = {
  spaceleft: 'space_left',
  spaceright: 'space_right',
  'prev_space': 'space_left',
  'next_space': 'space_right',
  return: 'enter',
  esc: 'escape',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  del: 'delete',
  bksp: 'backspace',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pagedn: 'pagedown',
  spacebar: 'space',
  play: 'audio_play',
  playpause: 'audio_play',
  mute: 'audio_mute',
  volup: 'audio_vol_up',
  voldown: 'audio_vol_down',
  next: 'audio_next',
  prev: 'audio_prev',
  previous: 'audio_prev',
};

const NAMED_KEYS = new Set([
  'space',
  'enter',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'delete',
  'backspace',
  'home',
  'end',
  'pageup',
  'pagedown',
  'minus',
  'equal',
  'comma',
  'period',
  'slash',
  'semicolon',
  'quote',
  'backslash',
  'backtick',
  'leftbracket',
  'rightbracket',
  'audio_play',
  'audio_mute',
  'audio_next',
  'audio_prev',
  'audio_vol_up',
  'audio_vol_down',

  // Not keys at all — actions. macOS refuses Space navigation from synthesized
  // keystrokes, so "move a Space" cannot be expressed as ctrl+arrow and be
  // expected to work; a backend has to post the Dock's trackpad gesture
  // instead. Naming the intent rather than the chord lets it.
  'space_left',
  'space_right',
]);

/** Actions that describe intent rather than a keystroke, so take no modifiers. */
const ACTIONS = new Set(['space_left', 'space_right']);

for (let i = 1; i <= 12; i += 1) NAMED_KEYS.add(`f${i}`);

/** Every key name accepted in config.json, for error messages and docs. */
export function knownKeys() {
  return [
    ...'abcdefghijklmnopqrstuvwxyz'.split(''),
    ...'0123456789'.split(''),
    ...[...NAMED_KEYS].sort(),
  ];
}

function normalizeKey(raw) {
  const k = KEY_ALIASES[raw] ?? raw;
  if (/^[a-z0-9]$/.test(k)) return k;
  if (NAMED_KEYS.has(k)) return k;
  return null;
}

/**
 * @param {string} input e.g. "cmd+shift+m", "space", "ctrl+right"
 * @returns {{modifiers: string[], key: string, raw: string}}
 * @throws {Error} on an unknown modifier or key
 */
export function parseShortcut(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('shortcut must be a non-empty string');
  }

  const raw = input.trim();
  const parts = raw
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '');

  if (parts.length === 0) {
    throw new Error(`"${raw}" has no key`);
  }

  const keyToken = parts[parts.length - 1];
  const modifierTokens = parts.slice(0, -1);

  const modifiers = new Set();
  for (const token of modifierTokens) {
    const mod = MODIFIER_ALIASES[token];
    if (!mod) {
      throw new Error(
        `"${raw}" has unknown modifier "${token}" (expected cmd, ctrl, alt, or shift)`,
      );
    }
    modifiers.add(mod);
  }

  // Checked before key normalization, which would otherwise reject a trailing
  // modifier with a vaguer "unknown key" message. A combo like "cmd+shift" is
  // almost certainly a mistake and would press nothing useful.
  if (MODIFIER_ALIASES[keyToken]) {
    throw new Error(`"${raw}" ends in a modifier — it needs a key too`);
  }

  const key = normalizeKey(keyToken);
  if (!key) {
    throw new Error(`"${raw}" has unknown key "${keyToken}"`);
  }

  if (ACTIONS.has(key) && modifiers.size > 0) {
    throw new Error(
      `"${raw}" combines modifiers with "${key}", which is an action rather than a key. ` +
        `Use "${key}" on its own.`,
    );
  }

  return {
    modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)),
    key,
    raw,
  };
}

/** Canonical display form, e.g. "cmd+shift+m". */
export function formatShortcut(parsed) {
  return [...parsed.modifiers, parsed.key].join('+');
}

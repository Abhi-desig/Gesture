// nut.js keyboard backend.
//
// Note the package name: the original `@nut-tree/nut-js` was pulled from npm and
// its prebuilt binaries moved behind a paid subscription, so this is the
// maintained Apache-2.0 community fork. `libnut` underneath is an N-API module,
// which is why the prebuilt binary keeps working across Node major versions.
//
// KNOWN LIMITATION — this backend cannot switch Spaces, and cannot be fixed to.
// libnut's `toggleKeyCode` calls CGEventCreateKeyboardEvent, CGEventSetFlags and
// CGEventPost; `nm` on libnut.node shows no CGEventSetType at all, which is the
// only way to turn a keyboard event into a kCGEventFlagsChanged. So a modifier
// is only ever a flag bit on the key event and the WindowServer's global
// modifier state is never updated. Applications read flags off the event and are
// satisfied — which is why ctrl+right navigates inside Chrome — but macOS
// matches symbolic hotkeys like Mission Control's "Move left/right a space"
// against that global state, so the desktop never moves.
//
// Sequencing the modifier by hand (pressKey(LeftControl) then pressKey(Right))
// does not help: pressing a modifier alone posts a plain kCGEventKeyDown for
// keycode 59, which is not a modifier state change either. See
// backends/cgevent.js, which posts the flagsChanged pair the WindowServer needs.

const MODIFIERS = {
  cmd: 'LeftCmd',
  ctrl: 'LeftControl',
  alt: 'LeftAlt',
  shift: 'LeftShift',
};

// Canonical key name -> nut.js Key enum member.
const KEYS = {
  space: 'Space',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  delete: 'Delete',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  minus: 'Minus',
  equal: 'Equal',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  backslash: 'Backslash',
  backtick: 'Grave',
  leftbracket: 'LeftBracket',
  rightbracket: 'RightBracket',
  audio_play: 'AudioPlay',
  audio_mute: 'AudioMute',
  audio_next: 'AudioNext',
  audio_prev: 'AudioPrev',
  audio_vol_up: 'AudioVolUp',
  audio_vol_down: 'AudioVolDown',
};

for (const c of 'abcdefghijklmnopqrstuvwxyz') KEYS[c] = c.toUpperCase();
for (let d = 0; d <= 9; d += 1) KEYS[String(d)] = `Num${d}`;
for (let f = 1; f <= 12; f += 1) KEYS[`f${f}`] = `F${f}`;

export async function create() {
  // Dynamic import inside the caller's try/catch: if the native module can't
  // load on this platform or Node build, we degrade to another backend rather
  // than taking the whole server down at startup.
  const { keyboard, Key } = await import('@nut-tree-fork/nut-js');

  // The default inter-key delay is tuned for typing whole strings; for a single
  // chord it just adds latency between gesture and effect.
  keyboard.config.autoDelayMs = 0;

  function resolve({ modifiers, key }) {
    const keyName = KEYS[key];
    if (!keyName || Key[keyName] === undefined) {
      throw new Error(`nut.js has no key for "${key}"`);
    }
    return [...modifiers.map((m) => Key[MODIFIERS[m]]), Key[keyName]];
  }

  return {
    name: 'nutjs',

    supports(combo) {
      try {
        resolve(combo);
        return true;
      } catch {
        return false;
      }
    },

    async press(combo) {
      // `type` rather than the more obvious pressKey/releaseKey pair: this libnut
      // build rejects a modifier combined with a non-character key through
      // pressKey — `pressKey(LeftControl, Right)` throws "Invalid key flag
      // specified", which would break every swipe binding — while `type` taps the
      // same combination correctly. It also presses and releases in one call, so
      // there's no chance of leaving a modifier stuck down if the release throws.
      await keyboard.type(...resolve(combo));
    },
  };
}

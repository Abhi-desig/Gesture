import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_ACTIONS } from '../server/config.js';
import { formatShortcut, knownKeys, parseShortcut } from '../server/shortcut.js';

test('parses a plain key', () => {
  assert.deepEqual(parseShortcut('space'), { modifiers: [], key: 'space', raw: 'space' });
});

test('parses modifiers with a key', () => {
  const parsed = parseShortcut('cmd+shift+m');
  assert.deepEqual(parsed.modifiers, ['cmd', 'shift']);
  assert.equal(parsed.key, 'm');
});

test('normalizes modifiers into a canonical order', () => {
  // However it was written, the same combo parses identically.
  const forms = ['cmd+ctrl+q', 'ctrl+cmd+q', 'control+command+q', 'meta+ctrl+q'];
  for (const form of forms) {
    assert.deepEqual(parseShortcut(form).modifiers, ['cmd', 'ctrl'], form);
  }
});

test('accepts modifier aliases', () => {
  assert.deepEqual(parseShortcut('option+a').modifiers, ['alt']);
  assert.deepEqual(parseShortcut('opt+a').modifiers, ['alt']);
  assert.deepEqual(parseShortcut('super+a').modifiers, ['cmd']);
});

test('accepts key aliases', () => {
  assert.equal(parseShortcut('return').key, 'enter');
  assert.equal(parseShortcut('esc').key, 'escape');
  assert.equal(parseShortcut('arrowright').key, 'right');
  assert.equal(parseShortcut('playpause').key, 'audio_play');
  assert.equal(parseShortcut('mute').key, 'audio_mute');
});

test('is case and whitespace insensitive', () => {
  assert.deepEqual(parseShortcut('  CMD + Shift + M  '), {
    modifiers: ['cmd', 'shift'],
    key: 'm',
    raw: 'CMD + Shift + M',
  });
});

test('deduplicates repeated modifiers', () => {
  assert.deepEqual(parseShortcut('cmd+cmd+a').modifiers, ['cmd']);
});

test('parses the shipped default bindings', () => {
  // Read from config.json rather than a copy. The copy that used to live here
  // had drifted — it still asserted `fist: space` and `pinch: cmd+shift+m`,
  // neither of which had been the default for some time — so the one test whose
  // job was to catch a broken shipped binding could not have caught one.
  const shipped = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const bindings = Object.entries(shipped.gestures);

  assert.ok(bindings.length > 0, 'config.json should ship some bindings');
  for (const [gesture, combo] of bindings) {
    // Client actions are performed by the page and are deliberately not
    // shortcuts, so they must not be run through the key parser.
    if (CLIENT_ACTIONS.includes(combo)) continue;
    assert.doesNotThrow(() => parseShortcut(combo), `${gesture}: ${combo}`);
  }

  assert.deepEqual(parseShortcut('ctrl+right'), {
    modifiers: ['ctrl'],
    key: 'right',
    raw: 'ctrl+right',
  });
});

test('accepts function keys and media keys', () => {
  assert.equal(parseShortcut('f11').key, 'f11');
  assert.equal(parseShortcut('audio_vol_up').key, 'audio_vol_up');
});

test('rejects an unknown key', () => {
  assert.throws(() => parseShortcut('cmd+wat'), /unknown key "wat"/);
});

test('rejects an unknown modifier', () => {
  assert.throws(() => parseShortcut('hyper+a'), /unknown modifier "hyper"/);
});

test('rejects a combo that is only modifiers', () => {
  assert.throws(() => parseShortcut('cmd+shift'), /needs a key/);
});

test('rejects empty input', () => {
  assert.throws(() => parseShortcut(''), /non-empty string/);
  assert.throws(() => parseShortcut('   '), /non-empty string/);
  assert.throws(() => parseShortcut(null), /non-empty string/);
  assert.throws(() => parseShortcut('+'), /no key/);
});

test('formatShortcut round-trips through parse', () => {
  for (const combo of ['space', 'cmd+shift+m', 'ctrl+right', 'f11']) {
    assert.equal(formatShortcut(parseShortcut(combo)), combo);
  }
});

test('knownKeys covers letters, digits and named keys', () => {
  const keys = knownKeys();
  for (const expected of ['a', 'z', '0', '9', 'space', 'right', 'f12', 'audio_play']) {
    assert.ok(keys.includes(expected), `missing ${expected}`);
  }
});

test('space_left / space_right parse as actions, not key chords', () => {
  // macOS refuses Space navigation from synthesized keystrokes, so "move a
  // Space" cannot be spelled ctrl+arrow and be expected to work. These name the
  // intent instead, and a backend posts the Dock's trackpad gesture for them.
  assert.deepEqual(parseShortcut('space_right'), {
    modifiers: [],
    key: 'space_right',
    raw: 'space_right',
  });
  assert.equal(parseShortcut('next_space').key, 'space_right');
  assert.equal(parseShortcut('prev_space').key, 'space_left');
});

test('an action cannot take modifiers', () => {
  // "cmd+space_right" is meaningless — there is no chord to modify — and
  // silently ignoring the modifier would hide the misunderstanding.
  assert.throws(() => parseShortcut('cmd+space_right'), /action rather than a key/);
});

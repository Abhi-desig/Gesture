import test from 'node:test';
import assert from 'node:assert/strict';

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
  const defaults = {
    fist: 'space',
    pinch: 'cmd+shift+m',
    open_palm: 'cmd+ctrl+q',
    swipe_left: 'ctrl+right',
    swipe_right: 'ctrl+left',
  };
  for (const [gesture, combo] of Object.entries(defaults)) {
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

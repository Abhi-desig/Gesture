import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../server/config.js';

const base = {
  gestures: { fist: 'audio_play' },
};

test('the shipped config.json is valid', () => {
  const shipped = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const { gestures, warnings } = validate(shipped);
  assert.ok(Object.keys(gestures).length > 0, 'expected some bindings');
  assert.deepEqual(warnings, [], 'the shipped config should not warn');
});

test('rejects a binding that collides with the page panic chord', () => {
  // A bare Escape disarms the gesture page, which is normally the frontmost
  // window — so this binding quietly turns every *later* gesture off. It reads
  // as "it worked for a while and then stopped", with nothing in any log.
  assert.throws(
    () => validate({ ...base, gestures: { pinch: 'escape' } }),
    /panic disarm/,
  );
});

test('the same key with a modifier is fine', () => {
  // Only the bare chord is the panic key; cmd+escape is a different keystroke
  // and the page ignores it.
  const { gestures } = validate({ ...base, gestures: { pinch: 'cmd+escape' } });
  assert.equal(gestures.pinch.combo, 'cmd+escape');
});

test('an escape binding is reported alongside other errors, not instead of them', () => {
  // The validator's contract is that it lists every problem in one pass, so a
  // config with two mistakes does not take two edit-and-restart cycles.
  let err;
  try {
    validate({ gestures: { pinch: 'escape', fist: 'nonsense_key' } });
  } catch (caught) {
    err = caught;
  }

  assert.ok(err, 'expected validation to fail');
  assert.match(err.message, /panic disarm/);
  assert.match(err.message, /nonsense_key/);
});

test('keysendSource defaults to hid and only accepts known state tables', () => {
  // Which CGEventSource state table the native helper posts from decides whether
  // the WindowServer's *global* modifier state is updated, which is the whole
  // reason Space switching works or doesn't. A typo here would silently fall
  // back to a table Mission Control never reads, so it is validated rather than
  // passed through to the helper.
  assert.equal(validate(base).settings.keysendSource, 'hid');
  assert.equal(validate({ ...base, keysendSource: 'combined' }).settings.keysendSource, 'combined');
  assert.throws(() => validate({ ...base, keysendSource: 'hidsystem' }), /"keysendSource" must be one of/);
});

test('a flat-shorthand config does not mistake the new settings for gestures', () => {
  // The shorthand form reads any non-reserved top-level string as a binding, so
  // a setting missing from RESERVED becomes a phantom gesture that warns on
  // every start and can never fire.
  const { gestures, warnings } = validate({
    fist: 'audio_play',
    keysendSource: 'combined',
    backend: 'auto',
  });
  assert.deepEqual(Object.keys(gestures), ['fist']);
  assert.deepEqual(warnings, []);
});

test('verifySpaceSwitch is on by default and is a boolean', () => {
  assert.equal(validate(base).settings.verifySpaceSwitch, true);
  assert.equal(validate({ ...base, verifySpaceSwitch: false }).settings.verifySpaceSwitch, false);
  assert.throws(() => validate({ ...base, verifySpaceSwitch: 'yes' }), /must be true or false/);
});

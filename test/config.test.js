import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBackend } from '../server/backends/index.js';
import {
  ConfigStore,
  EDITABLE_ACTIONS,
  KNOWN_GESTURES,
  applyBindingEdit,
  configVersion,
  validate,
} from '../server/config.js';

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

test('a client action is a binding, not a shortcut', () => {
  // toggle_armed must not go through the key parser — it is performed by the
  // page, never pressed — so it carries no `parsed` and is flagged instead.
  const { gestures } = validate({ ...base, gestures: { pinch: 'toggle_armed' } });
  assert.equal(gestures.pinch.combo, 'toggle_armed');
  assert.equal(gestures.pinch.client, true);
  assert.equal(gestures.pinch.parsed, undefined);
});

test('the client action list reaches the page', () => {
  // The page decides locally whether a gesture is its own to perform. If this
  // list did not travel with the config, that decision would be a hardcoded
  // copy that could drift from the validator.
  const store = new ConfigStore(new URL('../config.json', import.meta.url).pathname);
  store.load();
  assert.ok(store.clientPayload().clientActions.includes('toggle_armed'));
});

test('a backend is not disqualified by a client action it cannot press', () => {
  // Regression: unsupportedBindings() tested binding.parsed for every gesture.
  // A client action has none, so every backend looked incapable of the config
  // and resolution fell all the way through to dry-run — no keys at all.
  const bindings = validate({
    ...base,
    gestures: { pinch: 'toggle_armed', fist: 'audio_play' },
  }).gestures;

  const backend = {
    name: 'fake',
    supports: (combo) => combo?.key === 'audio_play',
    press: async () => {},
  };
  const messages = [];
  return resolveBackend('auto', bindings, { log: (m) => messages.push(m) }).then(() => {
    assert.ok(
      !messages.some((m) => m.includes('cannot send')),
      `client action should not count against a backend: ${messages.join(' | ')}`,
    );
    assert.equal(backend.supports({ key: 'audio_play' }), true);
  });
});

test('a screen action is a binding, not a shortcut, and reaches the page', () => {
  // Like toggle_armed it is never pressed, so it must not go through the key
  // parser; the page needs the list to know which gestures carry a screen.
  const { gestures, settings } = validate({ ...base, gestures: { pinch: 'focus_screen' } });
  assert.equal(gestures.pinch.combo, 'focus_screen');
  assert.equal(gestures.pinch.screen, true);
  assert.equal(gestures.pinch.parsed, undefined);
  assert.equal(settings.screenMaxAngle, 20);
  assert.equal(settings.screenMovesPointer, true);

  const store = new ConfigStore(new URL('../config.json', import.meta.url).pathname);
  store.load();
  const payload = store.clientPayload();
  assert.ok(payload.screenActions.includes('focus_screen'));
  assert.equal(payload.tuning.screenMaxAngle, 20);
});

test('a backend is not disqualified by a screen action it cannot press', () => {
  // The same regression as the client action above, for the same reason: no
  // `parsed`, so without the skip every backend looks incapable.
  const bindings = validate({
    ...base,
    gestures: { pinch: 'focus_screen', fist: 'audio_play' },
  }).gestures;
  const messages = [];
  return resolveBackend('auto', bindings, { log: (m) => messages.push(m) }).then(() => {
    assert.ok(
      !messages.some((m) => m.includes('cannot send pinch')),
      `screen action should not count against a backend: ${messages.join(' | ')}`,
    );
  });
});

test('a taught gesture can be bound without a warning; a malformed name explains the format', () => {
  const ok = validate({ gestures: { 'custom:peace': 'audio_next' } });
  assert.equal(ok.gestures['custom:peace'].combo, 'audio_next');
  assert.deepEqual(ok.warnings, []);

  const bad = validate({ gestures: { 'custom:Peace Sign': 'audio_next' } });
  assert.match(bad.warnings.join('\n'), /not a valid taught-gesture name/);
});

test('holdMs accepts "custom" and taught gesture names, and still rejects typos', () => {
  const { settings } = validate({ ...base, holdMs: { default: 180, custom: 500, 'custom:peace': 700 } });
  assert.equal(settings.holdMs.custom, 500);
  assert.equal(settings.holdMs['custom:peace'], 700);
  assert.throws(() => validate({ ...base, holdMs: { default: 180, opne_palm: 1200 } }), /not a gesture/);
});

test('customMaxDistance and feedbackSound have defaults and reach the page', () => {
  const { settings } = validate(base);
  assert.equal(settings.customMaxDistance, 0.18);
  assert.equal(settings.feedbackSound, true);
  assert.throws(() => validate({ ...base, customMaxDistance: 5 }), /customMaxDistance/);
  assert.throws(() => validate({ ...base, feedbackSound: 'loud' }), /must be true or false/);

  const store = new ConfigStore(new URL('../config.json', import.meta.url).pathname);
  store.load();
  const payload = store.clientPayload();
  assert.equal(typeof payload.feedbackSound, 'boolean');
  assert.equal(typeof payload.tuning.customMaxDistance, 'number');
});

// ------------------------------------------------------- the locked set (v2)

test('the shipped gesture set is the locked set', () => {
  // Locked on 24 Oct 2026 from the research in docs/ROADMAP.md, then changed
  // by choice on 25 Oct after trying it live (see the last two lines). Changing
  // a default means changing this test, on purpose, with the reason for it.
  const shippedConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(shippedConfig.gestures, {
    ok_sign: 'toggle_armed', // "yes" in a mid-air TV study (Dim et al. 2016)
    pinch: 'focus_screen', // look, then pinch (Vision Pro's select)
    swipe_left: 'space_right', // as on a Mac trackpad
    swipe_right: 'space_left',
    // Office additions, 24 Oct 2026, from the 8 most annoying daily tasks.
    // shh is a candidate: no study tests it for mute, so it stays only if the
    // check-up shows ≥ 90% success with no misfires.
    shh: 'cmd+shift+a', // Zoom mute, with its global shortcut on
    swipe_up: 'pagedown', // up/down for up/down controls (Dim et al. 2016);
    swipe_down: 'pageup', //   the page moves with the hand, as on a trackpad
    // Chosen live on 25 Oct over close-your-hand (play) and cover (lock),
    // knowing the camera reads a thumbs-up or a resting fist as a fist.
    fist: 'cmd+ctrl+q',
    open_palm: 'audio_play', // after a 1.2 s hold
  });
  assert.equal(shippedConfig.holdMs.ok_sign, 500);
  assert.equal(shippedConfig.holdMs.shh, 400);
  assert.equal(shippedConfig.holdMs.open_palm, 1200);
});

test('the office actions are on the list the page offers', () => {
  for (const action of ['pagedown', 'pageup', 'cmd+shift+a', 'cmd+shift+v', 'right', 'left']) {
    assert.ok(EDITABLE_ACTIONS.includes(action), action);
  }
  for (const name of ['shh', 'swipe_up', 'swipe_down']) assert.ok(KNOWN_GESTURES.includes(name), name);
});

test('the new gestures are known, and point says what replaced it', () => {
  for (const name of ['ok_sign', 'grab', 'cover']) assert.ok(KNOWN_GESTURES.includes(name), name);
  assert.ok(!KNOWN_GESTURES.includes('point'));
  const { warnings } = validate({ gestures: { point: 'focus_screen' } });
  assert.match(warnings.join(' '), /point was removed.*pinch/);
  assert.throws(() => validate({ ...base, holdMs: { default: 180, point: 350 } }), /point was removed/);
});

// ------------------------------------------------------- editing in the app

const shipped = () => JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('every action the page can offer is one the validator accepts', () => {
  for (const action of EDITABLE_ACTIONS) {
    assert.doesNotThrow(() => validate({ gestures: { fist: action } }), action);
  }
  assert.ok(!EDITABLE_ACTIONS.includes('escape'), 'the panic key is never on offer');
});

test('an edit changes only the gestures it names, and keeps every other setting', () => {
  const raw = shipped();
  const { raw: next } = applyBindingEdit(raw, { open_palm: 'audio_next' });
  assert.equal(next.gestures.open_palm, 'audio_next');
  assert.equal(next.gestures.pinch, raw.gestures.pinch);
  assert.deepEqual({ ...next, gestures: null }, { ...raw, gestures: null });
  assert.equal(raw.gestures.open_palm, 'audio_play', 'the input is not mutated');
  assert.doesNotThrow(() => validate(next));
});

test('null unbinds; taught gestures can be given a job', () => {
  const { raw: next } = applyBindingEdit(shipped(), { fist: null, 'custom:wave': 'audio_next' });
  assert.equal('fist' in next.gestures, false);
  assert.equal(next.gestures['custom:wave'], 'audio_next');
});

test('the page cannot choose a shortcut that is not on the list', () => {
  // The safety boundary: a compromised page may pick between listed actions,
  // never make a gesture press an arbitrary key.
  const { errors } = applyBindingEdit(shipped(), { fist: 'cmd+q' });
  assert.match(errors.join(' '), /can't be chosen here/);
});

test('a hand-written shortcut survives as long as the edit leaves it alone', () => {
  const raw = { ...shipped(), gestures: { ...shipped().gestures, fist: 'cmd+shift+m' } };
  const { raw: next } = applyBindingEdit(raw, { fist: 'cmd+shift+m', pinch: 'toggle_armed' });
  assert.equal(next.gestures.fist, 'cmd+shift+m');
});

test('edits to unknown gestures, empty edits and short-form configs are refused', () => {
  assert.match(applyBindingEdit(shipped(), { wiggle: 'audio_play' }).errors.join(' '), /never emitted/);
  assert.match(applyBindingEdit(shipped(), {}).errors.join(' '), /nothing to change/);
  assert.match(applyBindingEdit({ fist: 'audio_play' }, { fist: 'audio_next' }).errors.join(' '), /short form/);
  assert.match(applyBindingEdit(shipped(), { fist: 42 }).errors.join(' '), /must be set to an action/);
});

test('the file version changes whenever the text does', () => {
  assert.equal(configVersion('{"a":1}'), configVersion('{"a":1}'));
  assert.notEqual(configVersion('{"a":1}'), configVersion('{"a":2}'));
  const store = new ConfigStore(new URL('../config.json', import.meta.url).pathname);
  store.load();
  assert.equal(store.clientPayload().version, configVersion(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
  assert.deepEqual(store.clientPayload().editableActions, EDITABLE_ACTIONS);
});

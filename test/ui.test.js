import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VIEWS, parseRoute } from '../public/ui/router.js';
import { setupSteps } from '../public/ui/setup.js';
import { cameraState, statusChips } from '../public/ui/status.js';
import { describeAction, describeGesture, liveSummary } from '../public/ui/words.js';

// ------------------------------------------------------------------ words

test('every shipped binding has a plain-language name', () => {
  const shipped = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  for (const combo of Object.values(shipped.gestures)) {
    assert.notEqual(describeAction(combo), combo, `${combo} is shown as raw config`);
  }
});

test('an unfamiliar shortcut is shown as itself, and nothing bound says so', () => {
  assert.equal(describeAction('cmd+shift+m'), 'cmd+shift+m');
  assert.equal(describeAction(undefined), 'not bound');
  assert.equal(describeGesture('open_palm'), 'open hand');
  assert.equal(describeGesture('custom:wave'), '“wave” (taught)');
  assert.equal(describeGesture('some_new_pose'), 'some new pose');
});

const summaryBase = {
  cameraOn: true,
  view: { handPresent: true, pose: 'pinch', heldMs: 90, holdMs: 180 },
  headWanted: true,
  headAvailable: true,
  facing: { screen: 2, pose: { yaw: 30, pitch: 0 } },
  calibrated: true,
  screenName: (id) => ({ 1: 'Built-in', 2: 'BenQ GW2480' })[id],
  last: { gesture: 'fist' },
  bindings: { fist: 'audio_play' },
};

test('the Home card says what is seen, how far the hold is, and where you face', () => {
  const s = liveSummary(summaryBase);
  assert.equal(s.seeing, 'pinch');
  assert.equal(s.holdPct, 0.5);
  assert.equal(s.facing, 'BenQ GW2480');
  assert.equal(s.last, 'fist → play / pause');
});

test('the Home card explains each way of not knowing', () => {
  assert.equal(liveSummary({ ...summaryBase, cameraOn: false }).seeing, 'Camera is off');
  assert.equal(liveSummary({ ...summaryBase, view: { handPresent: false } }).seeing, 'No hand in view');
  assert.equal(liveSummary({ ...summaryBase, facing: { screen: null, pose: { yaw: 0, pitch: 40 } } }).facing, 'No screen — looking away');
  assert.equal(liveSummary({ ...summaryBase, facing: { screen: null, pose: null } }).facing, 'No face in view');
  assert.equal(liveSummary({ ...summaryBase, calibrated: false }).facing, 'Screens not calibrated');
  assert.equal(liveSummary({ ...summaryBase, headWanted: false }).facing, null, 'no Facing line without screen bindings');
  assert.equal(liveSummary({ ...summaryBase, last: null }).last, 'Nothing yet');
});

// ----------------------------------------------------------------- status

const camera = { on: true, mode: 'worker', hidden: false, muted: false, recovering: false, msSinceFrame: 30, fps: 39.6 };
const statusBase = {
  camera,
  armed: false,
  dryRun: false,
  health: { backend: 'cgevent', accessibility: { granted: true }, accessibilityHelp: 'System Settings…' },
  head: { wanted: true, available: true, faceSeen: true, calibrated: true, facingName: 'BenQ' },
  sound: 'on',
};
const chip = (s, id) => statusChips(s).find((c) => c.id === id);

test('the camera chip and the Detection row share one rule', () => {
  assert.equal(cameraState({ ...camera, on: false }), 'off');
  assert.equal(cameraState({ ...camera, mode: 'page', hidden: true }), 'paused');
  assert.equal(cameraState({ ...camera, hidden: true }), 'running', 'the worker keeps going while hidden');
  assert.equal(cameraState({ ...camera, msSinceFrame: 4000 }), 'stalled');
  assert.deepEqual(
    [chip(statusBase, 'camera').label, chip(statusBase, 'camera').tone],
    ['Camera 40 fps', 'on'],
  );
  assert.equal(chip({ ...statusBase, camera: { ...camera, msSinceFrame: 4000 } }, 'camera').tone, 'bad');
});

test('every chip is a word, and the problems that stop Gesture are red', () => {
  for (const c of statusChips(statusBase)) assert.ok(c.label.length > 0);
  assert.equal(chip(statusBase, 'keys').label, 'Keys ready');
  assert.equal(chip({ ...statusBase, health: { ...statusBase.health, accessibility: { granted: false } } }, 'keys').tone, 'bad');
  assert.equal(chip({ ...statusBase, dryRun: true }, 'keys').label, 'Dry-run');
  assert.equal(chip({ ...statusBase, health: null }, 'keys').label, 'Server unreachable');
  // Before the first answer it's not known yet, which is not the same as down.
  assert.equal(chip({ ...statusBase, health: undefined }, 'keys').tone, 'off');
  assert.equal(chip({ ...statusBase, armed: true }, 'armed').label, 'Armed');
  assert.equal(chip({ ...statusBase, sound: 'locked' }, 'sound').tone, 'warn');
});

test('the head chip appears only when a screen action is bound', () => {
  assert.equal(chip(statusBase, 'head').label, 'Facing BenQ');
  assert.equal(chip({ ...statusBase, head: { ...statusBase.head, faceSeen: false } }, 'head').label, 'No face');
  assert.equal(chip({ ...statusBase, head: { ...statusBase.head, facingName: null } }, 'head').label, 'Facing no screen');
  assert.equal(chip({ ...statusBase, head: { wanted: false } }, 'head'), undefined);
});

// ------------------------------------------------------------------ setup

const setupBase = {
  health: { backend: 'cgevent', accessibility: { granted: true } },
  cameraOn: false,
  headWanted: true,
  headAvailable: false,
  displays: 2,
  calibrated: 0,
  armedOnce: false,
  armGesture: 'pinch',
};

test('setup steps tick themselves off from what is true', () => {
  const before = setupSteps(setupBase);
  assert.deepEqual(before.steps.map((s) => s.id), ['keys', 'camera', 'head', 'screens', 'arm']);
  assert.equal(before.done, 1);

  const after = setupSteps({ ...setupBase, cameraOn: true, headAvailable: true, calibrated: 2, armedOnce: true });
  assert.equal(after.done, after.total);
});

test('a step the page can do has a button; one it cannot has a hint', () => {
  const { steps } = setupSteps({ ...setupBase, health: { backend: 'cgevent', accessibility: { granted: false }, accessibilityHelp: 'System Settings → Accessibility' } });
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  assert.equal(byId.keys.done, false);
  assert.equal(byId.keys.action, null);
  assert.match(byId.keys.hint, /Accessibility/);
  assert.equal(byId.camera.action, 'start-camera');
  assert.equal(byId.screens.action, 'calibrate');
});

test('no answer from the server is not "allowed"', () => {
  assert.equal(setupSteps({ ...setupBase, health: null }).steps[0].done, false);
});

test('head and screen steps only appear with a screen binding; arming names its gesture', () => {
  const { steps } = setupSteps({ ...setupBase, headWanted: false });
  assert.deepEqual(steps.map((s) => s.id), ['keys', 'camera', 'arm']);
  assert.match(steps.at(-1).hint, /^Pinch, or press Arm/);
  assert.match(setupSteps({ ...setupBase, armGesture: 'ok_sign' }).steps.at(-1).hint, /^Make an OK sign, or press Arm/);
  assert.match(setupSteps({ ...setupBase, armGesture: 'custom:wave' }).steps.at(-1).hint, /^Make a “wave” \(taught\)/);
  assert.match(setupSteps({ ...setupBase, armGesture: null }).steps.at(-1).hint, /Press Arm/);
});

// ----------------------------------------------------------------- router

test('a hash names a view, and anything else is home', () => {
  assert.deepEqual(VIEWS, ['home', 'gestures', 'screens', 'measure', 'lab', 'settings']);
  assert.equal(parseRoute('#/screens'), 'screens');
  assert.equal(parseRoute('#/lab'), 'lab');
  assert.equal(parseRoute('#/measure/'), 'measure');
  assert.equal(parseRoute('#/nope'), 'home');
  assert.equal(parseRoute(''), 'home');
  assert.equal(parseRoute(undefined), 'home');
});

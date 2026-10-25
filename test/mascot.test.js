import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOD_MS,
  SHRUG_MS,
  mascotMood,
  screenGazeX,
} from '../public/ui/mascot.js';

const DESK = [
  { id: 1, x: 0, width: 1440 },
  { id: 2, x: 1440, width: 1920 },
];

const base = {
  cameraOn: true,
  checkup: false,
  event: null,
  armed: true,
  learning: false,
  view: { handPresent: false, pose: null, heldMs: 0, holdMs: 0 },
  poseName: '',
  headWanted: true,
  faceSeen: true,
  facingScreen: 2,
  gazeX: screenGazeX(DESK, 2),
};
const mood = (overrides, now = 10000) => mascotMood({ ...base, ...overrides }, now);

test('a camera that is off beats everything, and the face closes', () => {
  const m = mood({ cameraOn: false, event: { type: 'fired', at: 9900, text: 'x' }, armed: false });
  assert.equal(m.mood, 'off');
  assert.deepEqual(m.gaze, { x: 0, y: 0 });
  assert.equal(m.label, 'Camera off');
});

test('during the check-up it holds still, even when something fires', () => {
  const m = mood({ checkup: true, event: { type: 'fired', at: 9990, text: 'pinch → x' } });
  assert.equal(m.mood, 'still');
  assert.deepEqual(m.gaze, { x: 0, y: 0 }, 'no eye movement that could cue a trial');
});

test('a fired gesture nods, then the face settles back', () => {
  const event = { type: 'fired', at: 10000, text: 'fist → play / pause' };
  assert.equal(mood({ event }, 10000 + NOD_MS - 1).mood, 'nod');
  assert.equal(mood({ event }, 10000 + NOD_MS - 1).label, 'Did it: fist → play / pause');
  assert.equal(mood({ event }, 10000 + NOD_MS).mood, 'awake');
});

test('a refusal shrugs, with the reason as its label', () => {
  const event = { type: 'refused', at: 10000, text: 'No face in view' };
  assert.equal(mood({ event }, 10000 + SHRUG_MS - 1).label, 'No face in view');
  assert.equal(mood({ event }, 10000 + SHRUG_MS).mood, 'awake');
});

test('disarmed sleeps, but a gesture fired while disarmed still nods', () => {
  // Arming is itself a gesture that fires while disarmed — the nod should show.
  assert.equal(mood({ armed: false }).mood, 'asleep');
  assert.equal(mood({ armed: false, event: { type: 'fired', at: 9900, text: 'pinch → arm / disarm' } }).mood, 'nod');
});

test('a hand in view is watched, and a held pose fills the ring', () => {
  assert.equal(mood({ view: { handPresent: true, pose: null, heldMs: 0, holdMs: 0 } }).mood, 'watching');
  const holding = mood({ view: { handPresent: true, pose: 'pinch', heldMs: 90, holdMs: 180 }, poseName: 'pinch' });
  assert.equal(holding.mood, 'watching');
  assert.equal(holding.ring, 0.5);
  assert.equal(holding.label, 'Holding pinch');
});

test('calibrating or teaching shows it is learning', () => {
  assert.equal(mood({ learning: true }).mood, 'learning');
});

test('the eyes look toward the screen you face, and down when you face none', () => {
  assert.ok(mood({}).gaze.x > 0.3, 'BenQ is to the right');
  assert.ok(mood({ facingScreen: 1, gazeX: screenGazeX(DESK, 1) }).gaze.x < -0.3);
  const away = mood({ facingScreen: null });
  assert.equal(away.mood, 'away');
  assert.deepEqual(away.gaze, { x: 0, y: 1 });
  assert.deepEqual(mood({ faceSeen: false }).gaze, { x: 0, y: 0 }, 'no face: eyes straight ahead');
});

test('one screen, or an unknown one, means looking straight ahead', () => {
  assert.equal(screenGazeX([{ id: 1, x: 0, width: 1440 }], 1), 0);
  assert.equal(screenGazeX(DESK, 99), 0);
});

test('a camera that is on but sees nothing shows as paused, not awake', () => {
  const m = mood({ paused: true });
  assert.equal(m.mood, 'off');
  assert.equal(m.label, 'Camera paused');
});

test('labels are short enough for a tooltip', () => {
  const long = mood({ event: { type: 'refused', at: 9990, text: 'x'.repeat(200) } });
  assert.ok(long.label.length <= 80);
});

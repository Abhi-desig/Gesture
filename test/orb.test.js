import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_MS,
  DOWN_AFTER_MS,
  ENGINE_START_MS,
  GREETING_MS,
  PROBLEM_MS,
  REPEAT_QUIET_MS,
  cameraNote,
  explainProblem,
  saidFor,
  greetingFor,
  nextChangeIn,
  orbView,
  saidRecently,
  sleptBetween,
  steadyLabel,
  takeEvent,
} from '../public/orb/orb-state.js';
import { OrbHub, readCameraState, readMascot } from '../server/orb-hub.js';

const at = (hour) => new Date(2026, 9, 25, hour, 30);

const base = {
  downSince: null,
  engines: 1,
  camera: { want: false, state: 'off', error: null },
  cameraAt: null,
  wantSince: null,
  mascot: { mood: 'off', gaze: { x: 0, y: 0 }, label: 'Camera off' },
  steady: 'Ready',
  event: null,
  greeting: null,
};
const view = (over, now = 10_000) => orbView({ ...base, ...over }, now);
const cameraOn = { camera: { want: true, state: 'on', error: null } };

// ------------------------------------------------------------------ greeting

test('the greeting follows the clock', () => {
  assert.equal(greetingFor(at(7)), 'Good morning');
  assert.equal(greetingFor(at(13)), 'Good afternoon');
  assert.equal(greetingFor(at(19)), 'Good evening');
  assert.equal(greetingFor(at(23)), 'Hello');
  assert.equal(greetingFor(at(3)), 'Hello');
});

test('a long gap between ticks means the Mac slept', () => {
  assert.equal(sleptBetween(0, 61_000), true);
  assert.equal(sleptBetween(0, 1_000), false);
  assert.equal(sleptBetween(NaN, 61_000), false, 'no tick yet is not a sleep');
});

test('a greeting opens the pill, then it shrinks back', () => {
  const greeting = { text: 'Good morning', at: 9_000 };
  const v = view({ greeting }, 9_000 + 1_000);
  assert.equal(v.size, 'pill');
  assert.equal(v.line1, 'Good morning');
  assert.equal(v.line2, 'Click me to turn on the camera', 'camera off: says how to start');
  assert.equal(v.mood, 'hello', 'Jelly waves');
  assert.equal(view({ greeting }, 9_000 + GREETING_MS).size, 'tab');
});

test('with the camera on, the greeting carries the steady state', () => {
  const v = view({ ...cameraOn, mascot: { mood: 'awake', gaze: { x: 0, y: 0 }, label: 'Ready' }, greeting: { text: 'Good morning', at: 9_500 } });
  assert.equal(v.line2, 'Ready');
  assert.equal(v.tone, 'live');
});

// ------------------------------------------------------------------ camera

test('camera off is a dim tab with closed eyes', () => {
  const v = view({});
  assert.deepEqual([v.size, v.tone, v.mood], ['tab', 'off', 'off']);
});

test('while the camera starts, the mascot is the loading animation', () => {
  const v = view({ camera: { want: true, state: 'starting', error: null }, wantSince: 9_000 });
  assert.deepEqual([v.size, v.tone, v.mood], ['pill', 'loading', 'learning']);
  assert.equal(v.line1, 'Waking up…');
  assert.equal(v.line2, 'Loading hand tracking');
  assert.equal(view({ camera: { want: true, state: 'off', error: null }, engines: 0, wantSince: 9_000 }).line2, 'Opening the camera page');
});

test('a camera page that never opens is said in words', () => {
  const s = { camera: { want: true, state: 'off', error: null }, engines: 0, wantSince: 0 };
  assert.equal(view(s, ENGINE_START_MS - 1).tone, 'loading');
  const v = view(s, ENGINE_START_MS);
  assert.equal(v.tone, 'bad');
  assert.match(v.line2, /Quit Gesture/);
});

test('camera on: the ball shows armed or not, and the eyes follow the screen', () => {
  const armed = view({ ...cameraOn, mascot: { mood: 'watching', gaze: { x: 0.8, y: 0 }, label: 'Watching your hand' }, steady: 'Watching your hand' });
  assert.deepEqual([armed.size, armed.tone, armed.mood], ['tab', 'live', 'watching']);
  assert.equal(armed.gaze.x, 0.8);
  const disarmed = view({ ...cameraOn, mascot: { mood: 'asleep', gaze: { x: 0, y: 0 }, label: 'Disarmed' } });
  assert.equal(disarmed.tone, 'rest');
});

test('the camera prompt waits until it is answered', () => {
  const v = view({ camera: { want: true, state: 'needs-permission', error: null } }, 1e9);
  assert.equal(v.size, 'pill');
  assert.equal(v.line1, 'Let me see you');
});

test('a blocked camera says so, then leaves an amber ball', () => {
  const s = { camera: { want: false, state: 'blocked', error: 'Permission denied' }, cameraAt: 9_000 };
  const v = view(s, 9_500);
  assert.deepEqual([v.size, v.tone, v.mood, v.line1], ['pill', 'bad', 'problem', 'My camera is blocked']);
  const later = view(s, 9_000 + PROBLEM_MS);
  assert.deepEqual([later.size, later.tone], ['tab', 'warn']);
});

test('a camera that failed shows its error', () => {
  const v = view({ camera: { want: false, state: 'failed', error: 'Could not load hand tracking' }, cameraAt: 9_900 });
  assert.equal(v.line1, "My camera didn't start");
  assert.equal(v.line2, 'Could not load hand tracking');
});

// ------------------------------------------------------------------ gestures

test('a gesture that worked opens the pill briefly in a few words, with the detail kept for VoiceOver', () => {
  const event = { type: 'fired', text: 'Swipe up → page down', at: 9_000 };
  const v = view({ ...cameraOn, event }, 9_500);
  assert.deepEqual([v.size, v.tone, v.mood, v.line1, v.line2], ['pill', 'nod', 'nod', 'Down we go', 'Swipe up → page down']);
  assert.equal(view({ ...cameraOn, event }, 9_000 + ACTION_MS).size, 'tab');
});

test('Jelly says what an action means to it, with the face to match', () => {
  assert.deepEqual(saidFor('OK sign → armed'), { words: "I'm awake", mood: 'armed' });
  assert.deepEqual(saidFor('OK sign → disarmed'), { words: 'Going to sleep', mood: 'asleep' });
  assert.deepEqual(saidFor('Swipe left → next desktop'), { words: "Hey, I'm looking", mood: 'nod' });
  assert.equal(saidFor('Swipe right → previous desktop').words, "Hey, I'm looking");
  assert.equal(saidFor('Shh → mute mic (Zoom)').words, 'Shh');
  assert.deepEqual(saidFor('Fist → cmd+shift+m'), { words: 'Got it', mood: 'nod' }, 'anything else');
  const armed = view({ ...cameraOn, event: { type: 'fired', text: 'OK sign → armed', at: 9_000 } }, 9_500);
  assert.deepEqual([armed.mood, armed.line1], ['armed', "I'm awake"]);
});

test('a refusal shrugs; something broken is a problem', () => {
  const refused = view({ ...cameraOn, event: { type: 'refused', text: 'No face in view', at: 9_000 } }, 9_500);
  assert.equal(refused.mood, 'shrug');
  const down = view({ downSince: 0 }, DOWN_AFTER_MS);
  assert.equal(down.mood, 'problem');
});

test('a refusal stays longer than an action, and beats a greeting', () => {
  const event = { type: 'refused', text: 'No face in view', at: 9_000 };
  const greeting = { text: 'Good morning', at: 9_000 };
  const v = view({ ...cameraOn, event, greeting }, 9_000 + ACTION_MS + 100);
  assert.deepEqual([v.tone, v.line1, v.line2], ['warn', "I can't see you", 'No face in view. Face the camera, then try again']);
});

test('the server going away is only said after a few seconds', () => {
  assert.equal(view({ downSince: 9_000 }, 9_000 + DOWN_AFTER_MS - 1).size, 'tab');
  const v = view({ downSince: 9_000 }, 9_000 + DOWN_AFTER_MS);
  assert.deepEqual([v.tone, v.line1], ['bad', 'Something broke']);
  assert.match(v.line2, /Quit Gesture/);
});

test('known problems get a few words, with what the page said and the fix as the detail', () => {
  assert.deepEqual(explainProblem('macOS is discarding key presses: Accessibility access is not granted'), {
    words: 'Mac blocked me',
    detail: 'macOS is discarding key presses: Accessibility access is not granted. Allow Gesture in System Settings → Privacy → Accessibility',
  });
  assert.match(explainProblem('The Gesture server is not answering').detail, /Quit Gesture and open it again$/);
  assert.equal(explainProblem('Still turning — look at one screen, then pinch').words, 'Hold still');
  assert.equal(explainProblem('Calibrate your screens first').words, 'Show me your screens');
  assert.deepEqual(explainProblem('Something new'), { words: "That didn't work", detail: 'Something new' });
});

test('the second line never repeats the reaction on the first', () => {
  assert.equal(steadyLabel('Ready', { mood: 'nod', label: 'Did it: fist' }), 'Ready');
  assert.equal(steadyLabel('Ready', { mood: 'offline', label: 'Gesture page is not open' }), 'Ready');
  assert.equal(steadyLabel('Ready', { mood: 'off', label: 'Camera off' }), 'Ready', 'just turned on: not "Camera off"');
  assert.equal(steadyLabel('Ready', { mood: 'asleep', label: 'Disarmed' }), 'Disarmed');
});

test('a reaction is taken once, and one from before the orb loaded is not news', () => {
  const fired = { seq: 7, type: 'fired', text: 'Fist → lock screen' };
  const first = takeEvent(null, fired, 100);
  assert.deepEqual(first.event, { type: 'fired', text: 'Fist → lock screen', at: 100 });
  assert.equal(takeEvent(first.lastSeq, fired, 200).event, null, 'the same one sent again');
  assert.equal(takeEvent(7, null, 200).lastSeq, 7);
  assert.notEqual(takeEvent(7, { ...fired, seq: 8 }, 300).event, null);
});

test('a problem is said once, not on every repeat', () => {
  const said = new Map([['Calibrate your screens first', 1_000]]);
  const again = { type: 'refused', text: 'Calibrate your screens first', at: 0 };
  assert.equal(saidRecently(said, again, 2_000), true);
  assert.equal(saidRecently(said, again, 1_000 + REPEAT_QUIET_MS), false, 'it may be said again later');
  assert.equal(saidRecently(said, { ...again, text: 'No face in view' }, 2_000), false, 'a different problem');
  assert.equal(saidRecently(said, { ...again, type: 'fired' }, 2_000), false, 'gestures that work always show');
});

test('turning the camera off says so once', () => {
  const on = { want: true, state: 'on', error: null };
  const off = { want: false, state: 'off', error: null };
  const note = cameraNote(on, off, 5_000);
  assert.deepEqual(note, { line1: "I'm not looking", line2: 'Camera off. Click me to turn it back on', at: 5_000 });
  assert.equal(cameraNote(off, off, 6_000), null, 'already off: nothing new to say');
  assert.equal(cameraNote(on, { ...off, want: true }, 6_000), null, 'the camera page went away: that is not you turning it off');
  const v = view({ camera: off, note }, 5_500);
  assert.deepEqual([v.size, v.tone, v.line1], ['pill', 'off', "I'm not looking"]);
  assert.equal(view({ camera: off, note }, 5_000 + ACTION_MS).size, 'tab');
});

test('a pinch while the face model loads says to wait, not to restart', () => {
  const { words, detail } = explainProblem('Head tracking is still starting — try again in a moment');
  assert.equal(words, 'Still waking up');
  assert.match(detail, /Try again in a moment$/);
});

test('the orb sleeps until its picture can change by itself', () => {
  assert.equal(nextChangeIn(base, 10_000), Infinity, 'nothing pending');
  assert.equal(nextChangeIn({ ...base, greeting: { text: 'Hi', at: 9_000 } }, 10_000), GREETING_MS - 1_000);
  const both = { ...base, greeting: { text: 'Hi', at: 9_000 }, event: { type: 'fired', text: 'x', at: 9_900 } };
  assert.equal(nextChangeIn(both, 10_000), ACTION_MS - 100, 'the soonest one');
  assert.equal(nextChangeIn({ ...base, downSince: 9_000 }, 10_000), DOWN_AFTER_MS - 1_000, 'a drop turning into a warning');
  assert.equal(nextChangeIn({ ...base, greeting: { text: 'Hi', at: 0 } }, 10_000), Infinity, 'long over');
});

// ------------------------------------------------------------------ server hub

function fakeClient() {
  const sent = [];
  return {
    sent,
    ended: false,
    write(text) {
      sent.push(text);
    },
    end() {
      this.ended = true;
    },
    events(type) {
      return sent
        .filter((t) => t.startsWith(`event: ${type}\n`))
        .map((t) => JSON.parse(t.split('\ndata: ')[1]));
    },
  };
}

const mood = (over = {}) => ({ mood: 'awake', gaze: { x: 0, y: 0 }, label: 'Ready', event: null, ...over });

test('a client gets the whole state first', () => {
  const hub = new OrbHub({ now: () => 0 });
  const orb = fakeClient();
  hub.attach(orb, 'orb');
  const [hello] = orb.events('hello');
  assert.equal(hello.engines, 0);
  assert.equal(hello.mascot.mood, 'offline');
  assert.deepEqual(hello.camera, { want: false, state: 'off', error: null });
});

test("the orb's click reaches the engine, and the engine's answer reaches the orb", () => {
  const hub = new OrbHub({ now: () => 0 });
  const orb = fakeClient();
  const engine = fakeClient();
  hub.attach(orb, 'orb');
  hub.attach(engine, 'engine');
  assert.deepEqual(orb.events('engines').at(-1), { engines: 1 });

  hub.wantCamera(true);
  assert.equal(engine.events('camera').at(-1).want, true);

  hub.reportCamera({ state: 'blocked', error: 'Permission denied' });
  assert.deepEqual(orb.events('camera').at(-1), { want: false, state: 'blocked', error: 'Permission denied' });
});

test("Settings' own camera button keeps the orb in step", () => {
  const hub = new OrbHub({ now: () => 0 });
  hub.reportCamera({ state: 'on', error: null });
  assert.equal(hub.snapshot().camera.want, true);
  hub.reportCamera({ state: 'off', error: null });
  assert.equal(hub.snapshot().camera.want, false);
});

test('an engine that disconnects takes its camera with it, but not the wish for one', () => {
  const hub = new OrbHub({ now: () => 0 });
  const orb = fakeClient();
  hub.attach(orb, 'orb');
  const detach = hub.attach(fakeClient(), 'engine');
  hub.reportCamera({ state: 'on', error: null });
  detach();
  assert.deepEqual(hub.snapshot().camera, { want: true, state: 'off', error: null });
  assert.equal(hub.engines, 0);
  detach();
  assert.equal(orb.events('engines').length, 2, 'detaching twice changes nothing');
});

test('moods are passed on only when they look different', () => {
  const hub = new OrbHub({ now: () => 0 });
  const orb = fakeClient();
  hub.attach(orb, 'orb');
  hub.setMascot(mood());
  hub.setMascot(mood({ gaze: { x: 0.01, y: 0 } }));
  assert.equal(orb.events('mascot').length, 1, 'a gaze change too small to see');
  hub.setMascot(mood({ event: { seq: 1, type: 'fired', text: 'Fist → lock screen' } }));
  assert.equal(orb.events('mascot').length, 2, 'a new reaction');
});

test('a page gone quiet turns the mood offline, keeping its last reaction', () => {
  let now = 0;
  const hub = new OrbHub({ now: () => now });
  const orb = fakeClient();
  hub.attach(orb, 'orb');
  hub.setMascot(mood({ event: { seq: 4, type: 'fired', text: 'x' } }));
  now = 5_001;
  hub.tick();
  const last = orb.events('mascot').at(-1);
  assert.equal(last.mood, 'offline');
  assert.equal(last.event.seq, 4);
});

test('a changed config and a late problem reach every page', () => {
  const hub = new OrbHub({ now: () => 0 });
  const page = fakeClient();
  hub.attach(page, 'engine');
  hub.configChanged();
  assert.equal(page.events('config').length, 1);
  hub.problem("The desktop didn't move");
  hub.problem("The desktop didn't move");
  const problems = page.events('problem');
  assert.deepEqual(problems.map((p) => p.seq), [1, 2], 'numbered, so each is new');
  assert.equal(problems[0].text, "The desktop didn't move");
});

test('idle streams are pinged, and closing ends them all', () => {
  let now = 0;
  const hub = new OrbHub({ now: () => now });
  const orb = fakeClient();
  hub.attach(orb, 'orb');
  now = 15_000;
  hub.tick();
  assert.ok(orb.sent.includes(': ping\n\n'));
  hub.close();
  assert.equal(orb.ended, true);
});

test('what the page sends is checked', () => {
  assert.ok(readMascot(mood()).mascot);
  assert.ok(readMascot({ ...mood(), mood: 'dancing' }).error);
  assert.ok(readMascot({ ...mood(), gaze: { x: 2, y: 0 } }).error);
  assert.ok(readMascot({ ...mood(), event: { seq: 'one', type: 'fired', text: 'x' } }).error);
  assert.ok(readMascot({ ...mood(), event: { seq: 1, type: 'exploded', text: 'x' } }).error);
  assert.equal(readMascot({ ...mood(), label: 'x'.repeat(300) }).mascot.label.length, 80);

  assert.deepEqual(readCameraState({ state: 'on' }).camera, { state: 'on', error: null });
  assert.ok(readCameraState({ state: 'exploded' }).error);
  assert.equal(readCameraState({ state: 'failed', error: 'e'.repeat(500) }).camera.error.length, 160);
});

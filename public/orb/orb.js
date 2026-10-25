// The orb page: I/O only. It listens to the server's live feed, asks
// orb-state.js what to show, draws Jelly, and turns clicks into requests.
//
// In the desktop app the island itself (a Liquid Glass notch, the words, the
// light) is SwiftUI (src-tauri/island), which keeps this page in a fixed box
// at its top centre. The page tells it what to show with the orb_view
// command, and clicks on the island come back as orbClick(). In a plain
// browser the words show under Jelly, which is how the page is previewed and
// tested.

import { mountMascotArt } from '../ui/mascot-art.js';
import { renderMascot } from '../ui/mascot-view.js';
import {
  cameraNote,
  greetingFor,
  nextChangeIn,
  orbView,
  saidRecently,
  sleptBetween,
  steadyLabel,
  takeEvent,
} from './orb-state.js';

const tauri = window.__TAURI__?.core;
const invoke = (command, args) => (tauri ? tauri.invoke(command, args).catch(() => {}) : Promise.resolve());

const el = {
  jelly: document.getElementById('jelly'),
  ball: document.getElementById('ball'),
  preview: document.getElementById('preview'),
  line1: document.getElementById('line1'),
  line2: document.getElementById('line2'),
};
if (!tauri) {
  document.body.classList.add('preview');
  el.preview.hidden = false;
}

const s = {
  downSince: null,
  engines: 0,
  camera: { want: false, state: 'off', error: null },
  cameraAt: null,
  wantSince: null,
  mascot: { mood: 'offline', gaze: { x: 0, y: 0 }, label: '' },
  steady: 'Ready',
  event: null,
  note: null,
  greeting: null,
};
let lastSeq = null;
// When each problem was last shown: see saidRecently().
const said = new Map();
let greeted = false;
// Set when the orb brought the hidden Gesture window forward for the camera
// prompt, so it can put it away again once the camera is allowed.
let openedForPermission = false;

function greet() {
  s.greeting = { text: greetingFor(new Date()), at: performance.now() };
  render();
}

function onCamera(camera) {
  const now = performance.now();
  if (camera.state !== s.camera.state) s.cameraAt = now;
  if (camera.want && camera.state !== 'on') s.wantSince ??= now;
  else s.wantSince = null;

  if (camera.state === 'needs-permission' && !openedForPermission) {
    openedForPermission = true;
    invoke('open_settings');
  } else if (camera.state === 'on' && openedForPermission) {
    openedForPermission = false;
    invoke('hide_settings');
  } else if (camera.state === 'blocked' || camera.state === 'failed') {
    openedForPermission = false;
  }
  s.note = cameraNote(s.camera, camera, now) ?? s.note;
  s.camera = camera;
}

function onMascot(mascot) {
  s.mascot = mascot;
  s.steady = steadyLabel(s.steady, mascot);
  const now = performance.now();
  const taken = takeEvent(lastSeq, mascot.event, now);
  lastSeq = taken.lastSeq;
  if (taken.event && !saidRecently(said, taken.event, now)) {
    s.event = taken.event;
    if (taken.event.type === 'refused') said.set(taken.event.text, now);
  }
}

function connect() {
  const events = new EventSource('./events');
  const on = (type, handle) =>
    events.addEventListener(type, (event) => {
      handle(JSON.parse(event.data));
      render();
    });

  on('hello', (snapshot) => {
    s.engines = snapshot.engines;
    onCamera(snapshot.camera);
    // Noted, not shown: see takeEvent().
    lastSeq = snapshot.mascot.event?.seq ?? lastSeq;
    onMascot(snapshot.mascot);
    // Gesture starts with the Mac, so its first contact is the login greeting.
    if (!greeted) {
      greeted = true;
      greet();
    }
  });
  on('engines', ({ engines }) => {
    s.engines = engines;
  });
  on('camera', onCamera);
  on('mascot', onMascot);

  events.addEventListener('open', () => {
    s.downSince = null;
    render();
  });
  events.addEventListener('error', () => {
    s.downSince ??= performance.now();
    render();
  });
}

// ------------------------------------------------------------------ drawing

// What the island was last told, so it is told only of changes.
let shown = '';
let wakeTimer = null;

function render() {
  const now = performance.now();
  const view = orbView(s, now);
  // Nothing redraws on a timer: the next render is the next event, or the
  // moment this picture runs out by itself.
  clearTimeout(wakeTimer);
  const wait = nextChangeIn(s, now);
  if (wait !== Infinity) wakeTimer = setTimeout(render, wait + 16);

  renderMascot(el.ball, { mood: view.mood, gaze: view.gaze, ring: 0, label: view.line1 });

  const said = JSON.stringify([view.size, view.tone, view.line1, view.line2]);
  if (said === shown) return;
  shown = said;
  // The island shows Jelly's few words; VoiceOver reads the detail as well.
  const label = view.line2 ? `${view.line1}. ${view.line2}` : view.line1;
  invoke('orb_view', { pill: view.size === 'pill', tone: view.tone, words: view.line1, label });
  if (!tauri) {
    el.line1.textContent = view.line1;
    el.line2.textContent = view.line2;
  }
}

// ------------------------------------------------------------------ input

/** A click on the island, sent by the app; in a browser, a click on Jelly. */
window.orbClick = () => {
  // While Chrome's prompt waits in the Gesture window, a click brings it back.
  if (s.camera.state === 'needs-permission') {
    invoke('open_settings');
    return;
  }
  fetch('./camera', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: !s.camera.want }),
  }).catch(() => {});
};

// Jelly sits on the island above it, so its clicks land here rather than in
// the island.
el.jelly.addEventListener('click', window.orbClick);
el.jelly.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  invoke('orb_menu');
});

// ------------------------------------------------------------------ clock

// Notices the Mac waking: timers stop while it sleeps, so a long gap between
// ticks means the lid was just opened. A tick every few seconds is plenty.
let lastWall = Date.now();
setInterval(() => {
  const wall = Date.now();
  if (sleptBetween(lastWall, wall)) greet();
  lastWall = wall;
}, 5000);

mountMascotArt(el.ball);
connect();
render();

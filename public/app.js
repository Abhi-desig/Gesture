// Camera -> hand landmarks -> gesture -> POST /gesture.
//
// I/O only. Every gesture decision lives in recognizer.js, which is unit tested;
// this file drives the camera, paints the overlay, and talks to the server.

import {
  CustomGestures,
  SAMPLES_PER_GESTURE,
  SampleRecorder,
  customName,
} from './custom-gestures.js';
import { Chime, cueFor } from './feedback.js';
import { toPoints } from './landmarks.js';
import { Recognizer } from './recognizer.js';
import { Carry, ScreenTracker, crowdedScreens, headPose, summarizeHead } from './screens.js';

// Must match the version scripts/fetch-model.js vendors: a locally vendored
// bundle paired with a different CDN wasm build fails in ways that look like a
// broken camera rather than a version skew.
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const VENDOR_BASE = './vendor';

const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOCAL_MODEL_URL = './models/hand_landmarker.task';

const CDN_FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const LOCAL_FACE_MODEL_URL = './models/face_landmarker.task';

// How long a fired gesture stays shown in the Pose row. Swipes are instantaneous,
// so without this they'd flash for a single frame and be unreadable.
const RECENT_MS = 900;

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const el = {
  video: document.getElementById('video'),
  canvas: document.getElementById('overlay'),
  stageMsg: document.getElementById('stage-msg'),
  cameraBtn: document.getElementById('camera-btn'),
  armBtn: document.getElementById('arm-btn'),
  armLabel: document.getElementById('arm-label'),
  banner: document.getElementById('banner'),
  bindingsBody: document.getElementById('bindings-body'),
  log: document.getElementById('log'),
  detection: document.getElementById('r-detection'),
  pose: document.getElementById('r-pose'),
  held: document.getElementById('r-held'),
  velocity: document.getElementById('r-velocity'),
  fourFinger: document.getElementById('r-fourfinger'),
  rearm: document.getElementById('r-rearm'),
  backend: document.getElementById('r-backend'),
  custom: document.getElementById('r-custom'),
  sound: document.getElementById('r-sound'),
  teachName: document.getElementById('teach-name'),
  teachBtn: document.getElementById('teach-btn'),
  teachStatus: document.getElementById('teach-status'),
  customList: document.getElementById('custom-list'),
  head: document.getElementById('r-head'),
  facing: document.getElementById('r-facing'),
  deskMap: document.getElementById('desk-map'),
  calibrateBtn: document.getElementById('calibrate-btn'),
  screensStatus: document.getElementById('screens-status'),
};

const ctx = el.canvas.getContext('2d');
const recognizer = new Recognizer();
const chime = new Chime();
const screenTracker = new ScreenTracker();
const carry = new Carry();

// Calibration lives in this browser, like taught gestures: it is a record of
// where your head points, and it only means anything at this desk.
const SCREENS_STORAGE_KEY = 'gesture.screens.v1';

// Taught gestures live in this browser only: they are samples of your hand, and
// nothing about them needs to leave the machine. Bindings stay in config.json,
// like every other gesture, so the server still decides what each one presses.
const CUSTOM_STORAGE_KEY = 'gesture.customGestures.v1';
const custom = loadCustomGestures();
recognizer.setCustomClassifier((pts) => custom.match(pts));

const state = {
  armed: false,
  cameraOn: false,
  landmarker: null,
  worker: null,
  // 'worker' keeps detecting while the page is hidden; 'page' is the fallback for
  // browsers without MediaStreamTrackProcessor and stops the moment you look away.
  mode: null,
  detectorTracks: [],
  // The camera track is muted — by a screen lock, most often. Detection cannot
  // work until it comes back, and restarting while muted would not help.
  cameraMuted: false,
  recovering: false,
  config: null,
  configRaw: '',
  view: null,
  recent: null,
  recentAt: 0,
  fps: 0,
  // Set while teaching a gesture: { name, phase: 'countdown'|'recording', recorder }.
  // Nothing fires while it is set, so the shape you're teaching can't press keys.
  recording: null,
  // Closest taught gesture to the current hand, for the readout.
  customNear: null,
  // Head tracking: whether the worker could start it, the latest pose, and
  // which calibrated screen that pose is facing.
  headAvailable: false,
  head: null,
  facing: null,
  // Connected displays as the server reports them, and where your head pointed
  // when you looked at each. `screensError` explains an empty list.
  displays: [],
  screensError: null,
  calibration: loadCalibration(),
  // Set while calibrating: { queue, index, phase: 'countdown'|'recording',
  // samples, results, timer }. Screen gestures do nothing meanwhile.
  calibrating: null,
};

// ---------------------------------------------------------------- config

function tuning() {
  return state.config?.tuning ?? recognizer.tuning;
}

function applyConfig(config) {
  state.config = config;
  recognizer.setTuning(config.tuning);
  chime.enabled = config.feedbackSound !== false;
  if (typeof config.tuning?.customMaxDistance === 'number') {
    custom.maxDistance = config.tuning.customMaxDistance;
  }
  if (typeof config.tuning?.screenMaxAngle === 'number') {
    screenTracker.setOptions({ maxAngle: config.tuning.screenMaxAngle });
  }
  renderBindings();
  renderCustomGestures();
}

function renderBindings() {
  const { gestures, knownGestures } = state.config;
  const names = [...new Set([...knownGestures, ...Object.keys(gestures)])];

  el.bindingsBody.replaceChildren(
    ...names.map((name) => {
      const combo = gestures[name];
      const row = document.createElement('tr');
      if (!combo) row.className = 'unbound';

      const nameCell = document.createElement('td');
      nameCell.textContent = name;

      const comboCell = document.createElement('td');
      comboCell.className = 'combo';
      comboCell.textContent = combo ?? 'unbound';

      const simCell = document.createElement('td');
      simCell.className = 'sim';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'test';
      button.disabled = !combo;
      button.title = combo
        ? `Send ${name} to the server without using the camera`
        : `${name} has no binding in config.json`;
      button.addEventListener('click', () => simulate(name));
      simCell.append(button);

      row.append(nameCell, comboCell, simCell);
      return row;
    }),
  );
}

async function pollConfig() {
  try {
    const res = await fetch('./config');
    if (!res.ok) return;
    const text = await res.text();
    if (text === state.configRaw) return;
    applyConfig(JSON.parse(text));
    state.configRaw = text;
    if (state.config.dryRun) {
      showBanner(
        'Dry-run is on.',
        'Gestures are recognized and logged, but no keys are pressed. Set "dryRun": false in config.json to arm for real.',
      );
    }
  } catch {
    // Server not up yet or momentarily unreachable; the next poll retries.
  }
}

async function loadHealth() {
  try {
    const res = await fetch('./health');
    const health = await res.json();
    el.backend.textContent = health.backend;
    el.backend.className = health.backend === 'dryrun' ? 'off' : 'on';

    if (health.backend === 'dryrun') {
      showBanner(
        'No keyboard backend loaded.',
        'Gestures will be recognized but no keys pressed. See the server console for why.',
        true,
      );
    } else if (health.accessibility?.granted === false && !health.dryRun) {
      // Shown before anything is attempted: without this permission macOS drops
      // synthetic key events silently, so gestures would appear to work while
      // doing nothing at all.
      showBanner(
        'macOS is blocking key presses.',
        `Accessibility access is not granted, so gestures will fire but no keys will be pressed. Grant it in ${health.accessibilityHelp} then restart the server.`,
        true,
      );
    }
  } catch {
    el.backend.textContent = 'unreachable';
    el.backend.className = 'off';
  }
}

// ---------------------------------------------------------------- firing

function logEntry(what, kind = 'note') {
  const li = document.createElement('li');
  li.className = kind;

  const left = document.createElement('span');
  left.className = 'what';
  left.textContent = what;

  const right = document.createElement('span');
  right.className = 'when';
  right.textContent = new Date().toLocaleTimeString();

  li.append(left, right);
  el.log.querySelector(':scope > .empty')?.remove();
  el.log.prepend(li);
  while (el.log.children.length > 40) el.log.lastElementChild.remove();
}

// When this page last asked the server to press Escape. Escape is the panic
// disarm, so an Escape arriving right after we asked for one is our own
// keystroke coming back rather than a user pressing the panic key.
//
// Belt and braces: config.js now rejects a bare `escape` binding outright, which
// is the real fix, and with that in place this should never trigger. It stays
// because the failure it prevents is invisible — the page disarms, every later
// gesture is dropped, and nothing is logged anywhere — and because the server
// and the page are separately deployable, so the two checks can drift apart.
let lastSelfEscapeAt = -Infinity;
// Generous enough to cover the request round trip on either side of the actual
// key press, short enough that a real panic Escape a moment later still works.
const SELF_ESCAPE_GRACE_MS = 400;

/** " on BenQ: Figma — Home", for a screen action's log line. */
function screenDetail(data) {
  if (!data.screen) return '';
  if (!data.app) return ` on ${data.screen}${data.reason ? ` (${data.reason})` : ''}`;
  return ` on ${data.screen}: ${data.app}${data.window ? ` — ${data.window}` : ''}`;
}

/**
 * @param {string} name
 * @param {object} [extra] More body fields. Only screen actions send any — the
 *   display you were facing — and the server checks it against what is
 *   actually connected.
 * @returns {Promise<object|null>} The server's answer, or null if unreachable.
 */
async function send(name, extra = {}) {
  // Stamped before the request, not after: the server presses the key and then
  // responds, so the keystroke can reach this page before the response does.
  if (state.config?.gestures?.[name] === 'escape') lastSelfEscapeAt = performance.now();

  try {
    const res = await fetch('./gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gesture: name, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    chime.play(cueFor(res.status, data));

    if (data.fired) {
      if (data.shortcut === 'escape') lastSelfEscapeAt = performance.now();
      logEntry(`${name} -> ${data.shortcut}${screenDetail(data)}`, 'fired');
    } else if (data.reason === 'cooldown') {
      logEntry(`${name} skipped (cooldown ${data.retryInMs}ms)`, 'skipped');
    } else if (data.reason === 'dryRun') {
      logEntry(`${name} -> ${data.shortcut}${data.screen ? ` on ${data.screen}` : ''} (dry-run)`, 'skipped');
    } else {
      logEntry(`${name} failed: ${data.error ?? res.status}`, 'failed');
      if (res.status === 503) {
        showBanner('macOS is discarding key presses.', `${data.help} Then reload this page.`, true);
      } else if (res.status === 500) {
        showBanner('The key press failed.', data.error ?? 'see the server console', true);
      }
    }
    return data;
  } catch (err) {
    chime.play('failed');
    logEntry(`${name} failed: ${err.message}`, 'failed');
    return null;
  }
}

/**
 * Bindings this page performs rather than sending to the server.
 *
 * The list comes from the server so it cannot drift from the validator, but it
 * falls back to the one action that exists — an older server that does not send
 * the field should still let a pinch arm the page.
 */
function clientActions() {
  return state.config?.clientActions ?? ['toggle_armed'];
}

/** What a gesture is bound to, or null when it is unbound. */
const bindingFor = (name) => state.config?.gestures?.[name] ?? null;

/** Is this gesture handled locally? Answered per gesture, from config. */
function isClientGesture(name) {
  const combo = bindingFor(name);
  return combo !== null && clientActions().includes(combo);
}

/**
 * Run a client-side binding. Returns false when it isn't one.
 *
 * Deliberately works while disarmed: `toggle_armed` is the way back from
 * disarmed, so gating it on being armed would make it a one-way switch.
 */
function runClientAction(name) {
  const combo = bindingFor(name);
  if (combo !== 'toggle_armed') return false;

  setArmed(!state.armed, name);
  return true;
}

/** Bindings that act on the screen you are facing. From the server, like clientActions. */
function screenActions() {
  return state.config?.screenActions ?? [];
}

function isScreenGesture(name) {
  const combo = bindingFor(name);
  return combo !== null && screenActions().includes(combo);
}

/** Head tracking is only started when something will use it. */
function wantsHead() {
  return Object.values(state.config?.gestures ?? {}).some((combo) => screenActions().includes(combo));
}

/**
 * A screen gesture fired: bring forward the front window on the screen you are
 * facing, and start carrying it in case you turn to another screen before
 * letting go.
 *
 * Refuses out loud rather than guessing. Pointing while looking at your
 * notebook, or before calibrating, should do nothing — and say why — rather
 * than pick whichever screen is nearest.
 */
async function aimAtScreen(name) {
  const refuse = (why) => {
    chime.play('failed');
    logEntry(`${name}: ${why}`, 'failed');
  };
  if (state.calibrating) return refuse('finish calibrating first');
  if (!state.headAvailable) return refuse('head tracking is not running — restart the camera');
  if (!screenTracker.calibrated) return refuse('calibrate your screens first');
  const screen = state.facing?.screen ?? null;
  if (screen === null) {
    return refuse(state.head ? 'not facing any calibrated screen' : 'no face in view');
  }

  carry.start(name, screen, performance.now());
  const data = await send(name, { screen });
  // Nothing was picked up — the screen was empty, or the request failed — so
  // there is nothing to carry. Dry-run keeps it, so the whole move can be
  // rehearsed without touching a window.
  if (data?.reason !== 'dryRun' && (!data?.fired || data.changed === false)) carry.cancel();
}

/** You let go while facing another screen: the window goes there. */
function dropOnScreen({ gesture, to }) {
  if (!state.armed) return;
  send(gesture, { screen: to, drop: true });
}

/** Detected gestures are silently dropped while disarmed — no log spam. */
function onGestureDetected(name) {
  state.recent = name;
  state.recentAt = performance.now();
  if (runClientAction(name)) return;
  if (!state.armed) return;
  if (isScreenGesture(name)) {
    aimAtScreen(name);
    return;
  }
  send(name);
}

function simulate(name) {
  // A client action is testable in either state, because it does not depend on
  // being armed — and for toggle_armed, requiring it would be contradictory.
  if (runClientAction(name)) return;
  if (!state.armed) {
    logEntry('arm first, then test', 'note');
    return;
  }
  // Uses where you are looking, like the real gesture. To aim at a screen
  // without the camera, click it on the map under Screens instead.
  if (isScreenGesture(name)) {
    aimAtScreen(name);
    return;
  }
  send(name);
}

// ---------------------------------------------------------------- taught gestures

function loadCustomGestures() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return new CustomGestures();
    const { set: loaded, skipped } = CustomGestures.fromJSON(JSON.parse(raw));
    if (skipped.length > 0) {
      queueMicrotask(() => logEntry(`skipped unreadable taught gestures: ${skipped.join(', ')}`, 'failed'));
    }
    return loaded;
  } catch {
    // Storage blocked or corrupt: start empty rather than not at all.
    return new CustomGestures();
  }
}

function saveCustomGestures() {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(custom.toJSON()));
    return true;
  } catch (err) {
    logEntry(`could not save taught gestures: ${err.message}`, 'failed');
    return false;
  }
}

function teachStatus(text, kind = '') {
  el.teachStatus.textContent = text;
  el.teachStatus.className = `hint ${kind}`.trim();
}

function renderCustomGestures() {
  if (custom.size === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None yet.';
    el.customList.replaceChildren(li);
    return;
  }

  el.customList.replaceChildren(
    ...custom.names.map((name) => {
      const li = document.createElement('li');

      const label = document.createElement('code');
      label.textContent = name;

      const detail = document.createElement('span');
      detail.className = 'detail';
      const combo = bindingFor(name);
      const count = custom.samplesFor(name).length;
      detail.textContent = `${count} sample${count === 1 ? '' : 's'} · ${combo ?? 'unbound'}`;
      if (!combo) detail.classList.add('unbound');

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'delete';
      remove.title = `Forget ${name}`;
      remove.addEventListener('click', () => {
        custom.remove(name);
        saveCustomGestures();
        renderCustomGestures();
        logEntry(`forgot ${name}`, 'note');
      });

      li.append(label, detail, remove);
      return li;
    }),
  );
}

const COUNTDOWN_STEPS = 3;
const COUNTDOWN_STEP_MS = 700;

function startRecording() {
  if (!state.cameraOn) {
    teachStatus('Start the camera first.', 'failed');
    return;
  }
  const name = customName(el.teachName.value);
  if (!name) {
    teachStatus('Use a short name in lowercase letters, digits or _, starting with a letter — like "peace".', 'failed');
    return;
  }
  if (custom.names.includes(name)) {
    teachStatus(`${name} already exists — delete it first.`, 'failed');
    return;
  }

  state.recording = { name, phase: 'countdown', recorder: null, timer: null };
  el.teachBtn.textContent = 'Cancel';
  el.teachName.disabled = true;

  let remaining = COUNTDOWN_STEPS;
  const tick = () => {
    if (state.recording?.name !== name) return;
    if (remaining > 0) {
      teachStatus(`Get ready to hold the new shape in view… ${remaining}`);
      remaining -= 1;
      state.recording.timer = setTimeout(tick, COUNTDOWN_STEP_MS);
      return;
    }
    state.recording.phase = 'recording';
    state.recording.recorder = new SampleRecorder();
    teachStatus(`Recording ${name}: 0/${SAMPLES_PER_GESTURE} — hold it steady.`);
  };
  tick();
}

function endRecording() {
  clearTimeout(state.recording?.timer);
  state.recording = null;
  el.teachBtn.textContent = 'Record';
  el.teachName.disabled = false;
  // A gesture held through the recording shouldn't fire the moment it ends.
  recognizer.reset();
}

function cancelRecording(reason) {
  const name = state.recording?.name;
  endRecording();
  teachStatus(`${name} not saved: ${reason}.`, 'failed');
}

/** Fed every frame while teaching. Nothing fires until it finishes. */
function recordFrame(pts, now) {
  const rec = state.recording;
  if (rec.phase !== 'recording') return;

  const result = rec.recorder.offer(pts, now);
  if (result.status === 'timeout') {
    chime.play('failed');
    cancelRecording(`only ${result.captured} of ${SAMPLES_PER_GESTURE} samples were usable`);
    return;
  }
  if (result.status === 'recording') {
    teachStatus(
      `Recording ${rec.name}: ${result.captured}/${SAMPLES_PER_GESTURE} — ${result.problem ?? 'hold it steady'}.`,
      result.problem ? 'failed' : '',
    );
    return;
  }

  const { name, recorder } = rec;
  const problem = custom.recordingProblem(name, recorder.samples);
  if (problem) {
    chime.play('failed');
    cancelRecording(problem);
    return;
  }

  custom.add(name, recorder.samples);
  endRecording();
  const saved = saveCustomGestures();
  renderCustomGestures();
  chime.play('done');
  logEntry(`taught ${name}`, 'note');
  teachStatus(
    bindingFor(name)
      ? `Saved ${name}. It's bound to ${bindingFor(name)}.`
      : `Saved ${name}${saved ? '' : ' for this session only'}. Bind it in config.json, e.g. "${name}": "audio_next".`,
    'on',
  );
}

// ---------------------------------------------------------------- screens

function loadCalibration() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCREENS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((s) => Number.isInteger(s?.id) && Number.isFinite(s?.yaw) && Number.isFinite(s?.pitch))
      : [];
  } catch {
    return [];
  }
}

function saveCalibration() {
  try {
    localStorage.setItem(SCREENS_STORAGE_KEY, JSON.stringify(state.calibration));
  } catch (err) {
    logEntry(`could not save the screen calibration: ${err.message}`, 'failed');
  }
}

/**
 * Hand the tracker only screens that are connected right now. A calibration
 * for a monitor that has since been unplugged is kept — plug it back in and it
 * works again — but must not be faceable while it is gone.
 */
function applyCalibration() {
  const connected = new Set(state.displays.map((d) => d.id));
  screenTracker.setCalibration(state.calibration.filter((s) => connected.has(s.id)));
}

const displayName = (id) =>
  state.displays.find((d) => d.id === id)?.name ?? state.calibration.find((s) => s.id === id)?.name ?? `display ${id}`;

/**
 * Where a display sits relative to the main one, in words, so "look at the
 * BenQ" is unambiguous when two monitors share a name.
 */
function whereIs(display) {
  if (display.main) return 'main';
  const main = state.displays.find((d) => d.main) ?? state.displays[0];
  const dx = display.x + display.width / 2 - (main.x + main.width / 2);
  const dy = display.y + display.height / 2 - (main.y + main.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'below' : 'above';
}

async function loadScreens() {
  try {
    const res = await fetch('./screens');
    const data = await res.json();
    const ids = (list) => list.map((d) => `${d.id}:${d.x},${d.y},${d.width}x${d.height}`).join(' ');
    const changed = ids(data.displays ?? []) !== ids(state.displays);
    state.displays = data.displays ?? [];
    state.screensError = data.ok ? null : data.error;
    if (changed) {
      applyCalibration();
      renderDeskMap();
    }
  } catch {
    state.screensError = 'the server is not answering';
  }
  updateScreensStatus();
}

/**
 * Your screens as macOS arranges them, scaled into the panel. Built once per
 * change in the display list; updateDeskMap() then only moves classes around,
 * because it runs on every frame.
 */
function renderDeskMap() {
  const displays = state.displays;
  if (displays.length === 0) {
    el.deskMap.replaceChildren();
    el.deskMap.hidden = true;
    return;
  }
  el.deskMap.hidden = false;

  const minX = Math.min(...displays.map((d) => d.x));
  const minY = Math.min(...displays.map((d) => d.y));
  const maxX = Math.max(...displays.map((d) => d.x + d.width));
  const maxY = Math.max(...displays.map((d) => d.y + d.height));
  const width = maxX - minX;
  const height = maxY - minY;
  // Fixed aspect box, so the map keeps the real proportions of the desk.
  el.deskMap.style.aspectRatio = `${width} / ${height}`;

  el.deskMap.replaceChildren(
    ...displays.map((d) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'screen';
      tile.dataset.id = String(d.id);
      tile.style.left = `${((d.x - minX) / width) * 100}%`;
      tile.style.top = `${((d.y - minY) / height) * 100}%`;
      tile.style.width = `${(d.width / width) * 100}%`;
      tile.style.height = `${(d.height / height) * 100}%`;
      tile.title = `Bring forward the front window on ${d.name} — the same as looking at it and pointing`;
      tile.addEventListener('click', () => clickScreen(d.id));

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = d.name;
      const status = document.createElement('span');
      status.className = 'status';
      tile.append(name, status);
      return tile;
    }),
  );
  updateDeskMap();
}

/** Per frame: which screen you face, which one a carried window is headed for. */
function updateDeskMap() {
  const facing = state.facing?.screen ?? null;
  const calibrated = new Set(state.calibration.map((s) => s.id));
  const step = state.calibrating;
  const calibratingId = step ? step.queue[step.index]?.id : null;

  for (const tile of el.deskMap.children) {
    const id = Number(tile.dataset.id);
    tile.classList.toggle('facing', id === facing);
    tile.classList.toggle('calibrated', calibrated.has(id));
    tile.classList.toggle('calibrating', id === calibratingId);
    tile.classList.toggle('source', carry.active && id === carry.from);
    tile.classList.toggle('target', carry.active && id === carry.target && carry.target !== carry.from);

    let status = calibrated.has(id) ? '' : 'not calibrated';
    if (id === calibratingId) status = step.phase === 'recording' ? 'hold still…' : 'look here';
    else if (carry.active && id === carry.target && carry.target !== carry.from) status = 'drop here';
    else if (id === facing) status = 'facing';
    tile.lastElementChild.textContent = status;
  }
}

/**
 * Aim at a screen by clicking its tile — the screen action without the camera,
 * for trying the window side of it on its own.
 */
function clickScreen(id) {
  const name = Object.keys(state.config?.gestures ?? {}).find(isScreenGesture);
  if (!name) {
    logEntry('no gesture is bound to focus_screen in config.json', 'note');
    return;
  }
  if (!state.armed) {
    logEntry('arm first, then click a screen', 'note');
    return;
  }
  send(name, { screen: id });
}

function updateScreensStatus(text, kind = '') {
  if (text === undefined) {
    if (state.calibrating) return;
    if (state.screensError) [text, kind] = [`Screens unavailable: ${state.screensError}.`, 'failed'];
    else if (!wantsHead()) [text, kind] = ['Bind a gesture to "focus_screen" in config.json to use your screens.', ''];
    else if (!screenTracker.calibrated) {
      text = 'Not calibrated yet. Start the camera, then press Calibrate and look at each screen when asked.';
    } else {
      text = 'Look at a screen and point to bring its window forward. Keep pointing, turn to another screen and lower your hand to move the window there.';
    }
  }
  el.screensStatus.textContent = text;
  el.screensStatus.className = `hint ${kind}`.trim();
}

const CALIBRATE_COUNTDOWN_STEPS = 3;
const CALIBRATE_STEP_MS = 800;
const CALIBRATE_RECORD_MS = 1200;
// Fewer head readings than this in the recording window means the face was
// mostly out of view, and the median of a handful is not worth keeping.
const CALIBRATE_MIN_SAMPLES = 6;
// Median wander, in degrees, past which you were still turning while it
// recorded and the reading would be a point somewhere along the way.
const CALIBRATE_MAX_SPREAD = 5;

/**
 * Look at each screen in turn while the camera records where your head points.
 *
 * Paced by sound as much as by text, because the screen you are asked to look
 * at is, by definition, not the one this page is on. Left to right, so the
 * order is the order you would naturally turn in.
 */
async function startCalibration() {
  await loadScreens();
  if (!state.cameraOn) return updateScreensStatus('Start the camera first.', 'failed');
  if (!state.headAvailable) {
    return updateScreensStatus('Head tracking is not running. Restart the camera after binding focus_screen.', 'failed');
  }
  if (state.displays.length === 0) return updateScreensStatus('No screens were reported.', 'failed');

  const queue = [...state.displays].sort((a, b) => a.x - b.x || a.y - b.y);
  state.calibrating = { queue, index: 0, phase: 'countdown', samples: [], results: [], timer: null };
  carry.cancel();
  el.calibrateBtn.textContent = 'Cancel';
  nextCalibrationStep();
}

function nextCalibrationStep() {
  const cal = state.calibrating;
  if (!cal) return;
  const display = cal.queue[cal.index];
  const label = `${display.name} (${whereIs(display)})`;

  let remaining = CALIBRATE_COUNTDOWN_STEPS;
  cal.phase = 'countdown';
  const tick = () => {
    if (state.calibrating !== cal) return;
    if (remaining > 0) {
      updateScreensStatus(`${cal.index + 1}/${cal.queue.length}: look at the middle of ${label}… ${remaining}`);
      chime.play('tick');
      remaining -= 1;
      cal.timer = setTimeout(tick, CALIBRATE_STEP_MS);
      return;
    }
    cal.phase = 'recording';
    cal.samples = [];
    updateScreensStatus(`${cal.index + 1}/${cal.queue.length}: hold still on ${label}…`);
    cal.timer = setTimeout(finishCalibrationStep, CALIBRATE_RECORD_MS);
  };
  tick();
}

function finishCalibrationStep() {
  const cal = state.calibrating;
  if (!cal) return;
  const display = cal.queue[cal.index];
  const reading = summarizeHead(cal.samples);

  if (!reading || cal.samples.length < CALIBRATE_MIN_SAMPLES) {
    return endCalibration(`could not see your face while you looked at ${display.name}`);
  }
  if (reading.spread > CALIBRATE_MAX_SPREAD) {
    return endCalibration(`your head was still moving while recording ${display.name} — hold still once you are facing it`);
  }

  cal.results.push({ id: display.id, name: display.name, yaw: reading.yaw, pitch: reading.pitch });
  chime.play('done');
  cal.index += 1;
  if (cal.index < cal.queue.length) {
    nextCalibrationStep();
    return;
  }

  // Keep calibrations for screens that are not connected right now; replace
  // the rest with what was just measured.
  const measured = new Set(cal.results.map((r) => r.id));
  state.calibration = [...state.calibration.filter((s) => !measured.has(s.id)), ...cal.results];
  saveCalibration();
  applyCalibration();

  // Two screens closer together than twice the switching margin flip on noise.
  const crowded = crowdedScreens(cal.results, screenTracker.options.switchMargin * 2);
  endCalibration(null);
  logEntry(`calibrated ${cal.results.length} screen${cal.results.length === 1 ? '' : 's'}`, 'note');
  if (crowded.length > 0) {
    const pairs = crowded.map(([a, b]) => `${a} and ${b}`).join(', ');
    updateScreensStatus(
      `Calibrated, but ${pairs} are too close together to tell apart reliably. Turn your whole head, not just your eyes, and calibrate again.`,
      'failed',
    );
  } else {
    updateScreensStatus();
    updateScreensStatus(`Calibrated. ${el.screensStatus.textContent}`, 'on');
  }
}

function endCalibration(problem) {
  clearTimeout(state.calibrating?.timer);
  state.calibrating = null;
  el.calibrateBtn.textContent = 'Calibrate';
  if (problem) {
    chime.play('failed');
    updateScreensStatus(`Calibration stopped: ${problem}. Nothing was changed.`, 'failed');
  }
  updateDeskMap();
}

// ---------------------------------------------------------------- detection

/**
 * The one place landmarks turn into gestures, fed by either the worker or the
 * in-page fallback loop.
 *
 * The timestamp is taken here, on the main thread, rather than accepted from the
 * caller. A Worker has its own `performance.timeOrigin`, so its `performance.now()`
 * is on a different clock than the page's — mixing the two silently broke staleness
 * detection, which read "stalled" forever because the constant offset between the
 * clocks exceeded the threshold. Transport delay is sub-millisecond, so one clock
 * for everything is both simpler and accurate enough.
 */
function handleLandmarks(landmarks, width, height, face) {
  const now = performance.now();
  const pts = landmarks && width && height ? toPoints(landmarks, width / height) : null;

  // Head first, so a gesture fired on this frame aims at where you are looking
  // now. `undefined` means the face model did not run on this frame — keep the
  // last reading — while `null` means it ran and found no face.
  if (face !== undefined && width && height) {
    state.head = headPose(face, width / height);
    state.facing = screenTracker.update(state.head);
    if (state.calibrating?.phase === 'recording' && state.head) state.calibrating.samples.push(state.head);
  }

  // Per pose, not a flat "am I armed": a gesture bound to a client action has
  // to fire while disarmed, and must take the cooldown that keeps it from
  // repeating on every frame. Everything else stays unrecorded while disarmed
  // so the first real gesture after arming is not swallowed.
  const view = recognizer.update(pts, now, (pose) => state.armed || isClientGesture(pose));
  state.view = view;
  state.customNear = custom.size > 0 ? custom.nearest(pts) : null;

  if (state.recording) recordFrame(pts, now);
  else if (view.gesture) onGestureDetected(view.gesture);

  // The shape, not the gated pose: turning your head moves your hand too, and
  // that must not count as letting go of the window you are carrying.
  const drop = carry.update(view.shape ?? null, state.facing?.screen ?? null, now);
  if (drop) dropOnScreen(drop);

  markFrame(now);
  draw(landmarks, drawMode(view), width, height);
  updateReadout();
}

function drawMode(view) {
  if (view.gesture) return 'swipe';
  if (view.velocity > tuning().stillnessMaxVelocity) return 'moving';
  return 'still';
}

// ---------------------------------------------------------------- rendering

const STROKE = {
  still: '#6ea8fe',
  moving: '#f0b45f',
  swipe: '#46d17f',
};

function draw(landmarks, mode = 'still', frameWidth, frameHeight) {
  if (frameWidth && el.canvas.width !== frameWidth) {
    el.canvas.width = frameWidth;
    el.canvas.height = frameHeight;
  }

  const { width, height } = el.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!landmarks) return;

  const color = STROKE[mode];
  ctx.lineWidth = Math.max(2, width / 320);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height);
    ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height);
  }
  ctx.stroke();

  const r = Math.max(2.5, width / 240);
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * width, p.y * height, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function set(node, text, cls = '') {
  node.textContent = text;
  node.className = cls;
}

/**
 * Detection status, reported with a live frame rate so "is this still working now
 * that I've switched apps?" is answerable at a glance.
 *
 * In `worker` mode the answer is yes: the detection loop lives in a Web Worker,
 * which browsers don't throttle, so hiding the page changes nothing. In `page` mode
 * — the fallback where MediaStreamTrackProcessor is missing — the loop is suspended
 * whenever the page isn't rendered, and that has to be said out loud rather than
 * looking like a broken detector.
 */
function detectionStatus() {
  if (!state.cameraOn) return ['off', 'off'];

  if (state.mode === 'page' && document.hidden) return ['paused (tab hidden)', 'moving'];
  if (state.cameraMuted) return ['camera muted', 'moving'];
  if (state.recovering) return ['restarting…', 'moving'];
  if (msSinceFrame() > 1500) return ['stalled', 'moving'];

  const fps = state.fps ? ` ${Math.round(state.fps)}fps` : '';
  return [`running${fps}`, 'on'];
}

let lastFaultAt = 0;

/** Surface a recurring detector fault at most once every few seconds. */
function noteDetectorFault(message) {
  const now = performance.now();
  if (now - lastFaultAt < 4000) return;
  lastFaultAt = now;
  logEntry(`detector: ${message}`, 'failed');
}

/** Smoothed frame rate, so the readout doesn't jitter. */
function markFrame(now) {
  if (lastFrameAt > 0) {
    const delta = now - lastFrameAt;
    if (delta > 0) {
      const instant = 1000 / delta;
      state.fps = state.fps ? state.fps * 0.9 + instant * 0.1 : instant;
    }
  }
  lastFrameAt = now;

  if (recoveryAttempted) {
    // Frames are flowing again, so the next stall is a new episode and gets its
    // own single restart attempt. This is what keeps the watchdog from being a
    // one-shot: lock the screen twice and it recovers twice.
    recoveryAttempted = false;
    logEntry('detection recovered', 'note');
  }
}

function updateReadout() {
  const t = tuning();
  const view = state.view;
  set(el.detection, ...detectionStatus());

  const recentActive = state.recent && performance.now() - state.recentAt < RECENT_MS;
  if (recentActive) {
    set(el.pose, state.recent, 'on');
  } else if (!view?.handPresent) {
    set(el.pose, state.cameraOn ? 'no hand' : '—', 'off');
  } else {
    set(el.pose, view.pose ?? '—', view.pose ? 'on' : 'off');
  }

  // Shown as elapsed/required so a pose that needs a long deliberate hold (open_palm
  // defaults to 1200ms) visibly fills up rather than seeming not to work.
  set(
    el.held,
    view?.pose ? `${Math.round(view.heldMs)}/${view.holdMs}ms` : '—',
    view?.fired ? 'on' : '',
  );

  if (!view?.handPresent) {
    set(el.velocity, '—', 'off');
  } else {
    const moving = view.velocity > t.stillnessMaxVelocity;
    set(
      el.velocity,
      `${view.velocity.toFixed(2)} / ${t.stillnessMaxVelocity}`,
      moving ? 'moving' : '',
    );
  }

  set(
    el.fourFinger,
    view?.handPresent ? (view.fourFinger ? 'yes' : 'no') : '—',
    view?.fourFinger ? 'on' : 'off',
  );

  // Both guards are cleared by the same user action — curl your fingers — so they
  // share one row rather than confusing the reader with two.
  const blocked = view ? !view.swipeArmed || view.poseSuppressed : false;
  set(el.rearm, blocked ? 'curl fingers' : 'ready', blocked ? 'off' : 'on');

  // Shown as distance/threshold, like palm speed: the number that decides whether
  // a taught gesture fires, so you can see how far off a near-miss was.
  const near = state.customNear;
  if (custom.size === 0) {
    set(el.custom, 'none taught', 'off');
  } else if (!view?.handPresent || !near) {
    set(el.custom, '—', 'off');
  } else {
    const label = near.name.slice('custom:'.length);
    set(
      el.custom,
      `${label} ${near.distance.toFixed(2)} / ${custom.maxDistance}`,
      near.distance <= custom.maxDistance ? 'on' : '',
    );
  }

  const sound = chime.status;
  if (sound === 'on') set(el.sound, 'on', 'on');
  else if (sound === 'off') set(el.sound, 'off', 'off');
  else set(el.sound, 'click page to enable', 'moving');

  updateHeadReadout();
  updateDeskMap();
}

/**
 * Head and Facing rows. Facing is shown as distance/threshold, like palm speed
 * and taught matches, so a near-miss says how near it was.
 */
function updateHeadReadout() {
  if (!wantsHead()) {
    set(el.head, 'off (nothing bound)', 'off');
    set(el.facing, '—', 'off');
    return;
  }
  if (!state.cameraOn) {
    set(el.head, '—', 'off');
    set(el.facing, '—', 'off');
    return;
  }
  if (!state.headAvailable) {
    set(el.head, state.mode === 'page' ? 'needs Chrome' : 'starting…', 'moving');
    set(el.facing, '—', 'off');
    return;
  }

  const pose = state.facing?.pose;
  if (!pose) {
    set(el.head, 'no face', 'off');
    set(el.facing, '—', 'off');
    return;
  }
  set(el.head, `yaw ${Math.round(pose.yaw)}° pitch ${Math.round(pose.pitch)}°`, '');

  if (carry.active) {
    const to = carry.target !== carry.from ? displayName(carry.target) : 'turn to a screen';
    set(el.facing, `${displayName(carry.from)} → ${to}`, 'moving');
    return;
  }
  if (!screenTracker.calibrated) {
    set(el.facing, 'not calibrated', 'off');
    return;
  }

  const { screen, nearest, distance } = state.facing;
  const max = screenTracker.options.maxAngle;
  if (screen !== null) set(el.facing, `${displayName(screen)} ${Math.round(distance)}° / ${max}`, 'on');
  else set(el.facing, `nothing (${displayName(nearest)} ${Math.round(distance)}° / ${max})`, '');
}

// ---------------------------------------------------------------- camera

function showBanner(title, detail, bad = false) {
  el.banner.className = bad ? 'banner bad' : 'banner';
  el.banner.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = title;
  el.banner.append(strong, document.createTextNode(detail));
  el.banner.hidden = false;
}

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Where to load MediaPipe from: `public/vendor/` if it has been vendored, the
 * CDN otherwise.
 *
 * Worth preferring the local copy for more than offline support. The worker runs
 * `importScripts()` on the tasks-vision bundle while holding raw camera
 * VideoFrames, and importScripts cannot carry an integrity hash — so from the
 * CDN, a third party executes code in the one context with direct camera access.
 *
 * The bundle and the wasm are chosen together, never mixed: they are two halves
 * of one build, and a local bundle against CDN wasm fails obscurely.
 */
async function resolveAssets() {
  const vendored =
    (await exists(`${VENDOR_BASE}/vision_bundle.js`)) &&
    (await exists(`${VENDOR_BASE}/wasm/vision_wasm_internal.wasm`));
  const base = vendored ? VENDOR_BASE : CDN_BASE;

  return {
    vendored,
    // ESM for the page, UMD for the classic worker: the ESM build fails inside a
    // worker with "ModuleFactory not set."
    esm: `${base}/vision_bundle.mjs`,
    umd: `${base}/vision_bundle.js`,
    wasm: `${base}/wasm`,
    model: (await exists(LOCAL_MODEL_URL)) ? LOCAL_MODEL_URL : CDN_MODEL_URL,
    faceModel: (await exists(LOCAL_FACE_MODEL_URL)) ? LOCAL_FACE_MODEL_URL : CDN_FACE_MODEL_URL,
  };
}

async function createLandmarker(assets) {
  // Imported lazily so the page still works offline: bindings, arming and the
  // test buttons don't need MediaPipe at all.
  const { FilesetResolver, HandLandmarker } = await import(assets.esm);
  const vision = await FilesetResolver.forVisionTasks(assets.wasm);
  const modelAssetPath = assets.model;

  let lastError;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

let lastTimestamp = 0;
let lastVideoTime = -1;
let lastFrameAt = 0;
// When the current detection session began. Staleness is measured from the later
// of this and the last frame, so a freshly started camera gets a grace period
// instead of reading "stalled" until its first frame lands — which would also
// make the watchdog below restart a camera that is merely still warming up.
let detectionStartedAt = 0;
// One restart per stall episode. Cleared by markFrame() the moment frames come
// back, so this bounds a *loop* without making recovery a one-shot: lock the
// screen twice and the watchdog recovers twice.
let recoveryAttempted = false;

/** How long since a frame arrived, allowing for a just-started camera. */
function msSinceFrame() {
  return performance.now() - Math.max(lastFrameAt, detectionStartedAt);
}

function scheduleFrame() {
  if (!state.cameraOn) return;
  if (typeof el.video.requestVideoFrameCallback === 'function') {
    el.video.requestVideoFrameCallback(onFrame);
  } else {
    requestAnimationFrame(onFrame);
  }
}

function onFrame() {
  if (!state.cameraOn) return;

  // videoWidth is 0 until the first frame arrives, and MediaPipe rejects a
  // zero-area region of interest outright.
  if (el.video.readyState >= 2 && el.video.videoWidth > 0) {
    if (el.video.currentTime !== lastVideoTime) {
      lastVideoTime = el.video.currentTime;

      // detectForVideo throws INVALID_ARGUMENT on a timestamp that doesn't
      // strictly increase, which is the usual reason a page like this dies a
      // second after starting.
      const ts = Math.max(performance.now(), lastTimestamp + 1);
      lastTimestamp = ts;

      try {
        const result = state.landmarker.detectForVideo(el.video, ts);
        handleLandmarks(result.landmarks?.[0] ?? null, el.video.videoWidth, el.video.videoHeight);
      } catch (err) {
        stopCamera();
        showBanner('Hand tracking stopped.', err.message, true);
        return;
      }
    }
  }

  scheduleFrame();
}

/**
 * Tear down everything the detector owns.
 *
 * Extracted because the failure path used to stop only the tracks in the stream
 * it had just opened, leaving the *clone* in state.detectorTracks and the Worker
 * alive. Each retry then accumulated another Worker holding its own MediaPipe
 * instance and a 7.8 MB model — invisible until the tab ran out of memory.
 */
function teardownDetection() {
  if (state.worker) {
    state.worker.postMessage({ type: 'stop' });
    state.worker.terminate();
    state.worker = null;
  }
  for (const track of state.detectorTracks) track.stop();
  state.detectorTracks = [];
}

/**
 * Watch a camera track for the transitions that silently kill detection.
 *
 * `mute` is the one that matters: locking the screen mutes the camera, and the
 * worker's `await reader.read()` then blocks forever with no error anywhere. The
 * default open_palm binding locks the screen, so this is a self-inflicted wound
 * the app has to be able to survive.
 */
function watchTrack(track, label) {
  track.addEventListener('ended', () => {
    logEntry(`camera track (${label}) ended`, 'failed');
  });
  track.addEventListener('mute', () => {
    state.cameraMuted = true;
    logEntry(`camera muted (${label}) — detection is paused`, 'note');
    updateReadout();
  });
  track.addEventListener('unmute', () => {
    state.cameraMuted = false;
    // Give it a fresh grace period: frames often resume on their own, and
    // restarting a camera that was about to recover is pure disruption.
    detectionStartedAt = performance.now();
    logEntry(`camera unmuted (${label})`, 'note');
    updateReadout();
  });
}

/**
 * Start detection in a worker, reading frames straight off the camera track.
 *
 * The track is cloned: MediaStreamTrackProcessor consumes the track it's given, so
 * handing over the original would blank the preview.
 */
async function startWorkerDetection(stream, assets) {
  const source = stream.getVideoTracks()[0];
  if (!source) throw new Error('the camera stream has no video track');

  const track = source.clone();
  state.detectorTracks.push(track);

  // Both: the clone is what the worker reads, but a screen lock mutes the source
  // and the clone independently, and either one going quiet stops detection.
  watchTrack(source, 'preview');
  watchTrack(track, 'detector');

  const processor = new MediaStreamTrackProcessor({ track });
  const worker = new Worker('./detector-worker.js');
  state.worker = worker;

  const ready = new Promise((resolve, reject) => {
    const settle = (event) => {
      const { type, message, fatal } = event.data;
      if (type === 'ready') resolve();
      else if (type === 'error' && fatal) reject(new Error(message));
      else return;
      worker.removeEventListener('message', settle);
    };
    worker.addEventListener('message', settle);
  });

  worker.addEventListener('message', (event) => {
    const { type } = event.data;
    if (type === 'landmarks') {
      if (!state.cameraOn) return;
      const { landmarks, width, height } = event.data;
      handleLandmarks(landmarks, width, height, 'face' in event.data ? event.data.face : undefined);
    } else if (type === 'head') {
      state.headAvailable = event.data.available;
      if (!event.data.available) logEntry(`head tracking unavailable: ${event.data.message}`, 'failed');
      updateScreensStatus();
    } else if (type === 'error') {
      if (event.data.fatal) {
        stopCamera();
        showBanner('Hand tracking stopped.', event.data.message, true);
      } else {
        // Non-fatal per-frame errors were previously swallowed entirely, which
        // made a detector that threw on every frame look identical to one seeing
        // no hands. Rate-limited so a persistent fault can't flood the log.
        noteDetectorFault(event.data.message);
      }
    }
  });

  worker.addEventListener('error', (event) => {
    stopCamera();
    showBanner('Hand tracking worker failed.', event.message || 'unknown error', true);
  });

  worker.postMessage(
    {
      type: 'start',
      readable: processor.readable,
      bundleUrl: assets.umd,
      wasmUrl: assets.wasm,
      modelUrl: assets.model,
      // Decided at camera start: binding focus_screen later needs a restart.
      faceModelUrl: wantsHead() ? assets.faceModel : null,
    },
    [processor.readable],
  );

  await ready;
}

async function startCamera() {
  el.cameraBtn.disabled = true;
  el.stageMsg.hidden = false;
  el.stageMsg.textContent = 'Waiting for camera permission…';

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play();
  } catch (err) {
    el.stageMsg.textContent = 'Camera unavailable.';
    el.cameraBtn.disabled = false;
    showBanner('Could not start the camera.', err.message, true);
    return;
  }

  el.stageMsg.textContent = 'Loading hand tracking model…';

  // Prefer the worker: it's the only arrangement that survives the page being
  // hidden, which is the normal case for an app that drives other applications.
  const canUseWorker = typeof MediaStreamTrackProcessor === 'function';
  const assets = await resolveAssets();

  try {
    if (canUseWorker) {
      await startWorkerDetection(stream, assets);
      state.mode = 'worker';
    } else {
      if (!state.landmarker) state.landmarker = await createLandmarker(assets);
      state.mode = 'page';
      showBanner(
        'Detection will pause when this window is hidden.',
        "This browser lacks MediaStreamTrackProcessor, so detection can't run in a background worker. Keep the window visible, or use Chrome for always-on detection.",
      );
    }
  } catch (err) {
    // teardownDetection() first: startWorkerDetection may have got as far as
    // cloning the track and spawning the Worker before throwing, and neither is
    // reachable through `stream`.
    teardownDetection();
    for (const track of stream.getTracks()) track.stop();
    el.video.srcObject = null;
    el.stageMsg.textContent = 'Could not start hand tracking.';
    el.cameraBtn.disabled = false;
    showBanner(
      'Could not load MediaPipe.',
      `${err.message}. The model is fetched from a CDN — check your connection, or vendor it locally with "npm run fetch-model".`,
      true,
    );
    return;
  }

  if (!assets.vendored) {
    // Said once per start rather than as a banner: it is a real exposure — third
    // party code running in the worker that holds camera frames — but not one
    // that stops the app working, and a banner here would cry wolf.
    logEntry('MediaPipe loaded from a CDN — run "npm run fetch-model" to vendor it', 'note');
  }

  recognizer.reset();
  lastFrameAt = 0;
  detectionStartedAt = performance.now();
  state.fps = 0;
  state.cameraOn = true;
  state.cameraMuted = false;
  el.stageMsg.hidden = true;
  el.cameraBtn.disabled = false;
  el.cameraBtn.textContent = 'Stop camera';

  if (state.mode === 'page') scheduleFrame();
}

function stopCamera() {
  state.cameraOn = false;

  teardownDetection();

  for (const track of el.video.srcObject?.getTracks() ?? []) track.stop();
  el.video.srcObject = null;

  recognizer.reset();
  state.mode = null;
  state.view = null;
  state.recent = null;
  state.fps = 0;
  state.cameraMuted = false;
  state.headAvailable = false;
  state.head = null;
  state.facing = null;
  screenTracker.reset();
  carry.cancel();
  if (state.calibrating) endCalibration('the camera stopped');
  draw(null);
  updateReadout();

  el.cameraBtn.textContent = 'Start camera';
  el.stageMsg.hidden = false;
  el.stageMsg.textContent = 'Camera is off.';
}

// ---------------------------------------------------------------- watchdog

// How long without a frame counts as stalled. Comfortably longer than a slow
// camera's worst frame interval, short enough that a lock/unlock cycle recovers
// before you have finished typing your password.
const STALL_MS = 3000;
const WATCHDOG_INTERVAL_MS = 1000;

/**
 * Restart the camera when detection has gone quiet and stayed quiet.
 *
 * The case this exists for: open_palm is bound to cmd+ctrl+q, which locks the
 * screen, which mutes the camera. The worker blocks on `await reader.read()`
 * forever, the readout says "stalled", and nothing short of clicking Stop and
 * Start again brings it back — so a single misfired gesture permanently kills
 * detection until you notice and intervene.
 */
async function superviseDetection() {
  if (!state.cameraOn || state.mode !== 'worker') return;
  // Muted means the OS has taken the camera away — usually the lock screen.
  // Restarting now would just re-acquire a muted track; wait for unmute, which
  // resets the stall clock and gives it a chance to resume on its own.
  if (state.cameraMuted || state.recovering || recoveryAttempted) return;
  if (msSinceFrame() < STALL_MS) return;

  recoveryAttempted = true;
  state.recovering = true;
  logEntry(`no frames for ${Math.round(msSinceFrame())}ms — restarting the camera`, 'note');
  updateReadout();

  try {
    const wasArmed = state.armed;
    stopCamera();
    await startCamera();
    // stopCamera() leaves arming alone, but say so in the log either way: a
    // recovery that silently changed the arm state would be worse than the stall.
    logEntry(
      state.cameraOn
        ? `camera restarted — ${wasArmed ? 'still armed' : 'still disarmed'}`
        : 'camera restart failed — press Start camera to retry',
      state.cameraOn ? 'note' : 'failed',
    );
  } catch (err) {
    logEntry(`camera restart failed: ${err.message}`, 'failed');
  } finally {
    state.recovering = false;
    updateReadout();
  }
}

/**
 * @param {boolean} armed
 * @param {string|null} source The gesture that caused it, when one did. Logged
 *   as a single attributed line: without this a gesture-driven toggle wrote two
 *   entries — its own and this one — for one action.
 */
function setArmed(armed, source = null) {
  state.armed = armed;
  // A window being carried when you disarm stays where it is.
  if (!armed) carry.cancel();
  el.armBtn.setAttribute('aria-pressed', String(armed));
  el.armLabel.textContent = armed ? 'Armed' : 'Disarmed';

  const what = armed ? 'armed — gestures will press keys' : 'disarmed';
  logEntry(source ? `${source} -> ${what}` : what, source ? 'fired' : 'note');
  chime.play(armed ? 'armed' : 'disarmed');
}

// ---------------------------------------------------------------- boot

el.cameraBtn.addEventListener('click', () => {
  if (state.cameraOn) stopCamera();
  else startCamera();
});

el.armBtn.addEventListener('click', () => setArmed(!state.armed));

// Browsers only start audio inside a real click or key press on the page, so the
// first one of either unlocks the sound cues. Hand gestures don't count.
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    chime.unlock();
    updateReadout();
  });
}

el.teachBtn.addEventListener('click', () => {
  if (state.recording) cancelRecording('cancelled');
  else startRecording();
});
el.teachName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !state.recording) startRecording();
});

el.calibrateBtn.addEventListener('click', () => {
  if (state.calibrating) endCalibration('cancelled');
  else startCalibration();
});

// Opt-in autostart, used by scripts/gesture-launch.sh so one keypress reaches a
// live camera. The camera only — arming stays manual, because a page that armed
// itself on load would press a real shortcut for any hand that happened to be in
// frame before you'd even looked at the window.
//
// Calling getUserMedia without a user gesture is allowed once Chrome has
// persisted the grant for this origin, so this is silent from the second launch
// on; the first one still shows the permission prompt and startCamera() already
// reports a refusal in the banner.
if (new URLSearchParams(location.search).has('camera')) startCamera();

// Escape is a one-way panic disarm. Deliberately not a toggle: this page is
// normally the frontmost window, so a gesture that presses the panic key would
// otherwise be able to toggle the page's own arm state.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.armed) return;

  if (performance.now() - lastSelfEscapeAt < SELF_ESCAPE_GRACE_MS) {
    // Said out loud rather than swallowed: an ignored panic key is exactly the
    // kind of thing that must never be silent.
    logEntry('ignored an Escape this page just fired — still armed', 'note');
    return;
  }

  setArmed(false);
});

document.addEventListener('visibilitychange', () => {
  // In worker mode nothing pauses, so say nothing and — importantly — don't reset,
  // which would throw away a gesture in progress just because you looked away.
  if (state.cameraOn && state.mode === 'page') {
    logEntry(
      document.hidden ? 'detection paused — this tab is hidden' : 'detection resumed',
      'note',
    );
    // Start fresh: a pose held across the gap shouldn't count the hidden time
    // toward its hold duration.
    recognizer.reset();
  }
  updateReadout();
});

renderCustomGestures();
await pollConfig();
await loadHealth();
await loadScreens();
setInterval(pollConfig, 3000);
// Monitors get plugged in and unplugged; the map and the calibration in use
// follow within a few seconds.
setInterval(loadScreens, 5000);
// Keeps the detection status honest even when no frames are arriving to drive it.
setInterval(updateReadout, 1000);

// Report what this client can do, once, at load — independent of whether the
// camera is running. Background detection hinges entirely on
// MediaStreamTrackProcessor: with it the detector lives in a Worker and survives
// being hidden, without it detection is pumped by requestVideoFrameCallback on
// the main thread, which the engine freezes for a non-visible page. That is a
// property of the engine, so it should be answerable without asking anyone to
// start a camera first.
fetch('/client', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    engine: window.__TAURI__ ? 'tauri-webview' : 'browser',
    hasMSTP: typeof MediaStreamTrackProcessor === 'function',
    hasWorker: typeof Worker === 'function',
    hasGUM: !!navigator.mediaDevices?.getUserMedia,
    secureContext: window.isSecureContext,
  }),
}).catch(() => {});

// Heartbeat: while the camera is on, tell the server every 2s that this page's
// main thread is alive, what the frame rate is, and whether the page thinks it
// is visible. This exists to make "gestures die when the window is hidden"
// diagnosable from GET /recent alone: heartbeats that stop mean the main thread
// was suspended; heartbeats that continue with a collapsing fps mean the worker
// stopped receiving camera frames; heartbeats and fps both healthy mean the
// pipeline is fine and the problem is at or past the gesture POST.
setInterval(() => {
  if (!state.cameraOn) return;
  fetch('/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fps: Math.round(state.fps * 10) / 10,
      mode: state.mode,
      armed: state.armed,
      visibility: document.visibilityState,
      msSinceFrame: Math.round(msSinceFrame()),
      // Which engine this client is, and whether it *can* detect while hidden.
      // Reported rather than assumed: 'worker' mode requires
      // MediaStreamTrackProcessor, and whether the Tauri webview has it decides
      // whether background detection is possible at all or has to be faked by
      // keeping a window on screen.
      hasMSTP: typeof MediaStreamTrackProcessor === 'function',
      engine: window.__TAURI__ ? 'tauri-webview' : 'browser',
    }),
    // A diagnostics channel must never become the thing that breaks.
  }).catch(() => {});
}, 2000);
setInterval(superviseDetection, WATCHDOG_INTERVAL_MS);
updateReadout();

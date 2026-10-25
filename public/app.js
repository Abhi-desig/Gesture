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
import { CoverDetector } from './cover.js';
import { Chime, Voice, cueFor } from './feedback.js';
import { fingerPattern } from './gestures.js';
import { toPoints } from './landmarks.js';
import { Recognizer } from './recognizer.js';
import {
  FACE,
  ScreenTracker,
  crowdedScreens,
  headPose,
  mouthPoint,
  screenDuring,
  spokenLabels,
  summarizeHead,
} from './screens.js';
import { seededRandom } from './stats.js';
import { GrabDetector } from './transitions.js';
import { mascotMood, screenGazeX } from './ui/mascot.js';
import { mountMascotArt } from './ui/mascot-art.js';
import { renderMascot } from './ui/mascot-view.js';
import { VIEWS, parseRoute, showView } from './ui/router.js';
import { setupSteps } from './ui/setup.js';
import { cameraState, statusChips } from './ui/status.js';
import { describeAction, describeGesture, liveSummary } from './ui/words.js';

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
  flick: document.getElementById('r-flick'),
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
  participant: document.getElementById('participant'),
  checkupBtn: document.getElementById('checkup-btn'),
  measureStatus: document.getElementById('measure-status'),
  measureResults: document.getElementById('measure-results'),
  chips: document.getElementById('status-chips'),
  diagnostics: document.getElementById('diagnostics'),
  diagnosticsBtn: document.getElementById('diagnostics-btn'),
  diagnosticsClose: document.getElementById('diagnostics-close'),
  sumSeeing: document.getElementById('sum-seeing'),
  sumHold: document.getElementById('sum-hold'),
  sumFacing: document.getElementById('sum-facing'),
  sumFacingLabel: document.getElementById('sum-facing-label'),
  sumLast: document.getElementById('sum-last'),
  setup: document.getElementById('setup'),
  setupSteps: document.getElementById('setup-steps'),
  setupProgress: document.getElementById('setup-progress'),
  setupToggle: document.getElementById('setup-toggle'),
  settingsSummary: document.getElementById('settings-summary'),
  mascot: document.getElementById('mascot'),
  mascotToggle: document.getElementById('mascot-toggle'),
  bindingsStatus: document.getElementById('bindings-status'),
};

const ctx = el.canvas.getContext('2d');
const recognizer = new Recognizer();
const chime = new Chime();
const voice = new Voice();
const screenTracker = new ScreenTracker();
// Movements rather than poses, so they sit beside the recogniser: closing an
// open hand and covering the camera. Both are built and unbound by default.
const grab = new GrabDetector();
const cover = new CoverDetector();
// Recent facing readings, so a pinch aims at where you looked while pinching.
const FACING_HISTORY_MS = 2000;
const MOUTH_FRESH_MS = 300;
const facingHistory = [];

// Calibration lives in this browser, like taught gestures: it is a record of
// where your head points, and it only means anything at this desk. One per
// participant code, because friends take turns at the same desk and every head
// sits differently; no code keeps the original key, so an existing calibration
// is not lost.
const SCREENS_STORAGE_KEY = 'gesture.screens.v1';
const PARTICIPANT_STORAGE_KEY = 'gesture.participant';
const PARTICIPANT = /^[a-z0-9_-]{1,16}$/;
const calibrationKey = (code) => (code ? `${SCREENS_STORAGE_KEY}:${code}` : SCREENS_STORAGE_KEY);
const initialParticipant = loadParticipant();

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
  // Asked for at camera start and not answered yet: the face model is loading.
  headStarting: false,
  head: null,
  // When the face model last reported (with or without a face) — the check-up
  // keeps one trace entry per reading, not per frame.
  headAt: null,
  facing: null,
  // Where the mouth was at the last face reading, for "shh".
  mouth: null,
  // Connected displays as the server reports them, and where your head pointed
  // when you looked at each. `screensError` explains an empty list.
  displays: [],
  screensError: null,
  participant: initialParticipant,
  calibration: loadCalibration(initialParticipant),
  // Set while calibrating: { queue, index, phase: 'countdown'|'recording',
  // samples, results, timer }. Screen gestures do nothing meanwhile.
  calibrating: null,
  // Set while the check-up runs: { runner, session, records, labels }. Nothing
  // fires meanwhile — every gesture is a measurement, not a command.
  checkup: null,
  // The last GET /health answer, null when the server didn't respond, or
  // undefined before the first answer, so a page load doesn't flash red.
  health: undefined,
  // The last gesture that acted (or would have, in dry-run), for the Home card.
  lastActed: null,
  // Setup checklist memory: armed at least once, and whether it was folded away.
  armedOnce: readFlag('gesture.armedOnce') === 'yes',
  setupPref: readFlag('gesture.setup'),
  // The last thing the mascot should react to: { type: 'fired'|'refused', at, text }.
  mascotEvent: null,
  mascotOn: readFlag('gesture.mascot') !== 'off',
};

/** localStorage, but never fatal: storage can be blocked or full. */
function readFlag(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembered for this page only.
  }
}

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
  renderSettings();
}

function setBindingsStatus(text, kind = '') {
  el.bindingsStatus.textContent = text;
  el.bindingsStatus.className = `hint ${kind}`.trim();
}

/** The one gap worth pointing out: no gesture left to arm or disarm with. */
function armingGap() {
  const armed = Object.values(state.config?.gestures ?? {}).includes('toggle_armed');
  return armed ? '' : ' Nothing is set to arm / disarm, so use the Arm button.';
}

/** The default line under the table. */
function bindingsHint() {
  return `Choose what each gesture does — it's saved to config.json straight away. Any other shortcut can still be written into config.json by hand.${armingGap()}`;
}

/**
 * A choice of action for one gesture: the listed actions, "not bound", and —
 * if config.json holds a shortcut that isn't on the list — that shortcut too,
 * so a hand-written binding is shown as it is rather than misreported.
 */
function actionPicker(name, combo) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', `What ${describeGesture(name)} does`);
  const option = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  };
  const listed = state.config.editableActions ?? [];
  select.append(option('', 'not bound'), ...listed.map((a) => option(a, describeAction(a))));
  if (combo && !listed.includes(combo)) select.append(option(combo, `${combo} (from config.json)`));
  select.value = combo ?? '';
  select.addEventListener('change', () => saveBinding(name, select.value || null, select));
  return select;
}

async function saveBinding(name, combo, select) {
  select.disabled = true;
  setBindingsStatus('Saving…');
  try {
    const res = await fetch('./config/gestures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: state.config.version, edits: { [name]: combo } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Someone edited the file by hand meanwhile: show theirs, then let the
      // choice be made again on top of it.
      if (data.config) applyConfig(data.config);
      await pollConfig();
      setBindingsStatus('config.json changed on disk, so the list was reloaded. Choose again.', 'failed');
      return;
    }
    if (!res.ok) {
      renderBindings();
      setBindingsStatus((data.errors ?? [data.error ?? `HTTP ${res.status}`]).join(' '), 'failed');
      return;
    }
    // Same text GET /config would return, so the next poll sees no change.
    state.configRaw = JSON.stringify(data.config);
    applyConfig(data.config);
    const saved = `Saved: ${describeGesture(name)} → ${describeAction(combo)}.${armingGap()}`;
    if (data.warnings?.length) setBindingsStatus(`${saved} But ${data.warnings.join('; ')}.`, 'failed');
    else setBindingsStatus(saved, 'on');
    logEntry(`${name} -> ${combo ?? '(unbound)'} (changed here)`, 'note');
  } catch (err) {
    renderBindings();
    setBindingsStatus(`Could not save: ${err.message}`, 'failed');
  }
}

function renderBindings() {
  const { gestures, knownGestures } = state.config;
  // Taught gestures too, so a new shape can be given a job right here.
  const names = [...new Set([...knownGestures, ...custom.names, ...Object.keys(gestures)])];
  const editable = Array.isArray(state.config.editableActions);

  el.bindingsBody.replaceChildren(
    ...names.map((name) => {
      const combo = gestures[name];
      const row = document.createElement('tr');
      if (!combo) row.className = 'unbound';

      const nameCell = document.createElement('td');
      nameCell.textContent = describeGesture(name);
      nameCell.title = name;

      // A picker when the server allows editing; otherwise what it does in
      // words, with the exact shortcut underneath when the two differ.
      const comboCell = document.createElement('td');
      comboCell.className = 'combo';
      if (editable) {
        comboCell.append(actionPicker(name, combo));
      } else {
        comboCell.textContent = describeAction(combo);
        if (combo && describeAction(combo) !== combo) {
          const shortcut = document.createElement('span');
          shortcut.className = 'shortcut';
          shortcut.textContent = combo;
          comboCell.append(shortcut);
        }
      }

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
  setBindingsStatus(bindingsHint());
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

/**
 * Re-read /health for the status bar and the setup checklist. Accessibility can
 * be granted or revoked while the page is open, and both should notice.
 */
async function refreshHealth() {
  try {
    const res = await fetch('./health');
    state.health = await res.json();
  } catch {
    state.health = null;
  }
  renderSettings();
  updateReadout();
}

async function loadHealth() {
  try {
    const res = await fetch('./health');
    const health = await res.json();
    state.health = health;
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
    state.health = null;
    el.backend.textContent = 'unreachable';
    el.backend.className = 'off';
  }
  renderSettings();
}

// ---------------------------------------------------------------- app shell

/** The Settings view: what config.json says, read-only until editing lands. */
function renderSettings() {
  const config = state.config;
  if (!config) return;
  const t = config.tuning ?? {};
  const hold = t.holdMs ?? {};
  const holdText = typeof hold === 'number'
    ? `${hold} ms`
    : Object.entries(hold).map(([k, v]) => `${k === 'default' ? 'poses' : describeGesture(k)} ${v} ms`).join(' · ');
  const rows = [
    ['Sound cues', config.feedbackSound === false ? 'off' : 'on'],
    ['Keys pressed through', state.health?.backend ?? '—'],
    ['Dry-run', config.dryRun ? 'on — nothing is pressed' : 'off'],
    ['Hold before acting', holdText || '—'],
    ['Pause between repeats', t.cooldownMs !== undefined ? `${t.cooldownMs} ms` : '—'],
    ['Facing a screen within', t.screenMaxAngle !== undefined ? `${t.screenMaxAngle}°` : '—'],
    ['Server', location.host],
  ];
  el.settingsSummary.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

function setDiagnostics(open) {
  el.diagnostics.hidden = !open;
  el.diagnosticsBtn.setAttribute('aria-expanded', String(open));
  if (open) el.diagnosticsClose.focus();
}

/** Show the view the hash names, and remember it for the next visit. */
function route() {
  const view = parseRoute(location.hash);
  showView(view);
  // Gestures don't fire in the Lab, and a pose held across the switch either
  // way must not fire the moment you arrive or leave.
  if ((view === 'lab') !== Boolean(lab?.isOpen)) {
    if (view === 'lab') cancelCheckup('the Lab was opened');
    recognizer.reset();
    grab.reset();
    // Still the Lab once it has loaded? You may have left while it did.
    if (view === 'lab') loadLab().then((loaded) => parseRoute(location.hash) === 'lab' && loaded.open());
    else lab?.close();
  }
  // On a narrow window the tabs scroll sideways; keep the current one in view.
  document.querySelector(`[data-nav="${view}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  writeFlag('gesture.view', view);
}

// Re-rendered only when something visible changed: updateReadout() runs on every
// camera frame, and rebuilding these lists forty times a second would be waste.
let chipsKey = '';
let setupKey = '';

function screensCalibratedCount() {
  return state.displays.filter((d) => state.calibration.some((c) => c.id === d.id)).length;
}

function renderStatusChips() {
  const chips = statusChips({
    camera: {
      on: state.cameraOn,
      mode: state.mode,
      hidden: document.hidden,
      muted: state.cameraMuted,
      recovering: state.recovering,
      msSinceFrame: msSinceFrame(),
      fps: state.fps,
    },
    armed: state.armed,
    dryRun: state.config?.dryRun === true,
    health: state.health,
    head: {
      wanted: wantsHead(),
      available: state.headAvailable,
      faceSeen: Boolean(state.facing?.pose),
      calibrated: screenTracker.calibrated,
      facingName: state.facing?.screen != null ? displayName(state.facing.screen) : null,
    },
    sound: chime.status,
  });

  const key = chips.map((c) => `${c.id}:${c.label}:${c.tone}`).join('|');
  if (key === chipsKey) return;
  chipsKey = key;
  el.chips.replaceChildren(
    ...chips.map((c) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip ${c.tone}`;
      chip.dataset.chip = c.id;
      chip.textContent = c.label;
      chip.title = c.id === 'armed' ? `${c.detail} Click to ${state.armed ? 'disarm' : 'arm'}.` : c.detail || 'Open Diagnostics';
      return chip;
    }),
  );
}

function renderHome() {
  const summary = liveSummary({
    cameraOn: state.cameraOn,
    view: state.view,
    headWanted: wantsHead(),
    headAvailable: state.headAvailable,
    facing: state.facing,
    calibrated: screenTracker.calibrated,
    screenName: displayName,
    last: state.lastActed,
    bindings: state.config?.gestures ?? {},
  });
  if (el.sumSeeing.textContent !== summary.seeing) el.sumSeeing.textContent = summary.seeing;
  el.sumHold.style.width = `${Math.round(summary.holdPct * 100)}%`;
  el.sumHold.classList.toggle('full', summary.holdPct >= 1);
  const facing = summary.facing ?? '—';
  if (el.sumFacing.textContent !== facing) el.sumFacing.textContent = facing;
  el.sumFacing.hidden = summary.facing === null;
  el.sumFacingLabel.hidden = summary.facing === null;
  if (el.sumLast.textContent !== summary.last) el.sumLast.textContent = summary.last;
}

function renderSetup() {
  const armGesture = Object.entries(state.config?.gestures ?? {}).find(([, combo]) => combo === 'toggle_armed')?.[0] ?? null;
  const { steps, done, total } = setupSteps({
    health: state.health,
    cameraOn: state.cameraOn,
    headWanted: wantsHead(),
    headAvailable: state.headAvailable,
    displays: state.displays.length,
    calibrated: screensCalibratedCount(),
    armedOnce: state.armedOnce,
    armGesture,
  });

  // Folded away once everything is done, unless you asked to keep it open.
  const collapsed = state.setupPref === 'hidden' || (state.setupPref !== 'shown' && done === total);
  const key = `${collapsed}|${steps.map((s) => `${s.id}:${s.done}:${s.hint}`).join('|')}`;
  if (key === setupKey) return;
  setupKey = key;

  el.setup.classList.toggle('collapsed', collapsed);
  el.setupToggle.textContent = collapsed ? 'Show' : 'Hide';
  el.setupToggle.setAttribute('aria-expanded', String(!collapsed));
  el.setupProgress.textContent = done === total ? 'All set' : `${done} of ${total} done`;
  el.setupSteps.replaceChildren(
    ...steps.map((s) => {
      const li = document.createElement('li');
      li.className = s.done ? 'done' : '';
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = '✓';
      tick.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = s.done ? `${s.label} — done` : s.label;
      const hint = document.createElement('span');
      hint.className = 'step-hint';
      hint.textContent = s.hint;
      li.append(tick, label, hint);
      if (s.action && !s.done) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset.action = s.action;
        button.textContent = s.actionLabel;
        li.append(button);
      }
      return li;
    }),
  );
}

// ---------------------------------------------------------------- engine
//
// `?engine=1` is this page running in the hidden Chrome window the desktop app
// keeps for it. Nobody clicks Start camera there: the orb under the camera is
// the switch. The server relays the orb's clicks over /events, and this page
// reports back what its camera actually did, so the orb can say "starting",
// "allow the camera" or "blocked" instead of guessing.

const ENGINE = new URLSearchParams(location.search).has('engine');

// What the orb last asked for. followCamera() moves the camera toward it.
let engineWant = false;
let engineBusy = false;

function reportCamera(cameraState, error = null) {
  fetch('./camera/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: cameraState, error }),
  }).catch(() => {});
}

/** Will Chrome ask before giving us the camera? It would ask in a hidden window. */
async function cameraNeedsPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state === 'prompt';
  } catch {
    return false;
  }
}

/**
 * Start or stop the camera until it matches engineWant.
 *
 * A loop rather than one step, because the orb can be clicked again while the
 * camera and model are still loading: the second click is honoured once the
 * first finishes, never dropped.
 */
async function followCamera() {
  if (engineBusy) return;
  engineBusy = true;
  try {
    while (engineWant !== state.cameraOn) {
      if (engineWant) {
        reportCamera((await cameraNeedsPermission()) ? 'needs-permission' : 'starting');
        const result = await startCamera();
        if (!result.ok) {
          engineWant = false;
          reportCamera(result.blocked ? 'blocked' : 'failed', result.message);
          break;
        }
        if (engineWant) reportCamera('on');
      } else {
        stopCamera();
        reportCamera('off');
      }
    }
  } finally {
    engineBusy = false;
  }
}

function connectEngine(events) {
  // The hidden page never gets a click, which Chrome otherwise requires before
  // sound; the desktop app starts it with autoplay allowed.
  chime.unlock();
  events.addEventListener('hello', (event) => {
    const { camera } = JSON.parse(event.data);
    if (state.cameraOn) {
      // The server restarted and forgot; this page's camera is the truth.
      engineWant = true;
      reportCamera('on');
    } else {
      engineWant = camera.want;
      followCamera();
    }
  });
  events.addEventListener('camera', (event) => {
    engineWant = JSON.parse(event.data).want;
    followCamera();
  });
}

// ---------------------------------------------------------------- mascot

// Counting from the clock rather than from 0, so a reloaded page can't reuse a
// number the orb has already seen and have its first reaction ignored.
let mascotSeq = Date.now();

/**
 * Something the face should react to: a nod for 'fired', a shrug for 'refused'.
 * Numbered so the orb can tell a new reaction from the same one sent again.
 */
function reactMascot(type, text) {
  mascotSeq += 1;
  state.mascotEvent = { type, at: performance.now(), text, seq: mascotSeq };
  updateReadout();
}

let mascotSent = { key: '', at: -Infinity, seq: null };

// Faster than this and a hand flickering at the edge of a pose would flood the
// server; a steady mood is still re-sent every couple of seconds, which is how
// the server knows the page is alive and the orb should keep showing it.
const MASCOT_SEND_MIN_MS = 150;
const MASCOT_KEEPALIVE_MS = 2000;

/**
 * Tell the server the current mood and the last reaction, for the orb to show.
 *
 * Called from updateReadout(), which camera frames drive — so this keeps
 * working while the page is hidden, which is exactly when the orb matters.
 */
function syncMascot(mood) {
  const now = performance.now();
  const event = state.mascotEvent;
  const key = `${mood.mood}|${mood.gaze.x.toFixed(1)}|${mood.label}|${event?.seq ?? ''}`;
  const changed = key !== mascotSent.key;
  // A new reaction goes at once: it is what the orb shows in words.
  const newEvent = (event?.seq ?? null) !== mascotSent.seq;
  const wait = newEvent ? 0 : changed ? MASCOT_SEND_MIN_MS : MASCOT_KEEPALIVE_MS;
  if (now - mascotSent.at < wait) return;
  mascotSent = { key, at: now, seq: event?.seq ?? null };
  fetch('./mascot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mood: mood.mood,
      gaze: mood.gaze,
      label: mood.label,
      event: event ? { seq: event.seq, type: event.type, text: event.text } : null,
    }),
  }).catch(() => {});
}

// The orb is fed whether or not the header face is shown: the switch in
// Settings hides this page's face, not Gesture's.
// Longer than the slowest idle frame gap (125 ms) by far, shorter than the
// watchdog's restart (3 s).
const PAUSED_AFTER_MS = 1500;

function renderMascotNow() {
  const screen = state.facing?.screen ?? null;
  const mood = mascotMood(
    {
      cameraOn: state.cameraOn,
      // On, but no frames: the camera muted (a screen lock) or detection stalled.
      paused: state.cameraOn && (state.cameraMuted || msSinceFrame() > PAUSED_AFTER_MS),
      checkup: state.checkup !== null,
      event: state.mascotEvent,
      armed: state.armed,
      learning: Boolean(state.calibrating || state.recording),
      view: state.view,
      poseName: describeGesture(state.view?.pose),
      headWanted: wantsHead(),
      faceSeen: Boolean(state.facing?.pose),
      facingScreen: screen,
      gazeX: screenGazeX(state.displays, screen),
    },
    performance.now(),
  );
  if (state.mascotOn && !document.hidden) renderMascot(el.mascot, mood);
  syncMascot(mood);
}

function setMascotOn(on) {
  state.mascotOn = on;
  writeFlag('gesture.mascot', on ? 'on' : 'off');
  el.mascot.hidden = !on;
  el.mascotToggle.checked = on;
  if (on) renderMascotNow();
}

function runSetupAction(action) {
  if (action === 'start-camera') startCamera();
  else if (action === 'arm') setArmed(true);
  else if (action === 'calibrate') {
    location.hash = '#/screens';
    startCalibration();
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
  try {
    const res = await fetch('./gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gesture: name, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    chime.play(cueFor(res.status, data));

    if (data.fired || data.reason === 'dryRun') {
      state.lastActed = { gesture: name };
      reactMascot('fired', `${describeGesture(name)} → ${describeAction(data.shortcut ?? bindingFor(name))}`);
    } else if (data.reason !== 'cooldown') {
      reactMascot('refused', data.error ?? `${describeGesture(name)} didn't work`);
    }
    if (data.fired) {
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
    reactMascot('refused', 'The Gesture server is not answering');
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

/** Close-your-hand and covering the lens cost work every frame: only when used. */
const watchesMovements = () => state.checkup !== null || bindingFor('grab') !== null || bindingFor('cover') !== null;

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
  state.lastActed = { gesture: name };
  reactMascot('fired', `${describeGesture(name)} → ${state.armed ? 'armed' : 'disarmed'}`);
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
  const gestures = state.config?.gestures ?? {};
  // Shh needs the face too: it is a finger on the lips.
  return Object.values(gestures).some((combo) => screenActions().includes(combo)) || Boolean(gestures.shh);
}

/**
 * A screen gesture fired: bring forward the front window on the screen you
 * faced *while making it*, not wherever your head is the moment the hold ends.
 *
 * Refuses out loud rather than guessing. Pinching while looking at your
 * notebook, mid-turn, or before calibrating should do nothing — and say why —
 * rather than pick whichever screen is nearest. A refusal gives the gesture
 * its cooldown back, so trying again doesn't mean waiting.
 */
async function aimAtScreen(name) {
  const refuse = (why) => {
    recognizer.forgive(name);
    // Said once. A pinch flickers in and out, and each flicker is a new pinch,
    // so the same refusal would otherwise sound and show again and again.
    const now = performance.now();
    if (why === lastRefusal.why && now - lastRefusal.at < REFUSAL_QUIET_MS) return;
    lastRefusal = { why, at: now };
    chime.play('failed');
    logEntry(`${name}: ${why}`, 'failed');
    reactMascot('refused', why.charAt(0).toUpperCase() + why.slice(1));
  };
  if (state.calibrating) return refuse('finish calibrating first');
  if (state.headStarting) return refuse('head tracking is still starting — try again in a moment');
  if (!state.headAvailable) return refuse('head tracking is not running — restart the camera');
  if (!screenTracker.calibrated) return refuse('calibrate your screens first');

  // The hold, plus a frame's slack.
  const now = performance.now();
  const span = recognizer.holdFor(name) + 50;
  const during = screenDuring(facingHistory, now - span, now);
  if (!during) return refuse(state.head ? 'still turning — look at one screen, then pinch' : 'no face in view');
  if (during.screen === null) return refuse(state.head ? 'not facing any calibrated screen' : 'no face in view');
  await send(name, { screen: during.screen });
}

// The last refusal said, so a repeat within this long goes unsaid.
const REFUSAL_QUIET_MS = 4000;
let lastRefusal = { why: '', at: -Infinity };

/** Detected gestures are silently dropped while disarmed — no log spam. */
function onGestureDetected(name) {
  // Shapes the camera still recognises but that do nothing by default (an
  // open palm, a fist) stay out of the log and the server.
  if (bindingFor(name) === null) return;
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

function loadParticipant() {
  try {
    const code = localStorage.getItem(PARTICIPANT_STORAGE_KEY) ?? '';
    return PARTICIPANT.test(code) ? code : '';
  } catch {
    return '';
  }
}

function loadCalibration(participant) {
  try {
    const parsed = JSON.parse(localStorage.getItem(calibrationKey(participant)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((s) => Number.isInteger(s?.id) && Number.isFinite(s?.yaw) && Number.isFinite(s?.pitch))
      : [];
  } catch {
    return [];
  }
}

function saveCalibration() {
  try {
    localStorage.setItem(calibrationKey(state.participant), JSON.stringify(state.calibration));
  } catch (err) {
    logEntry(`could not save the screen calibration: ${err.message}`, 'failed');
  }
}

/** Switch to another person's code: their calibration, their results file. */
function setParticipant(raw) {
  if (state.checkup) return;
  const code = raw.trim().toLowerCase();
  if (code !== '' && !PARTICIPANT.test(code)) {
    setMeasureStatus('Use 1–16 lowercase letters, digits, _ or -, like "p1".', 'failed');
    el.participant.value = state.participant;
    return;
  }
  if (code === state.participant) return;
  state.participant = code;
  try {
    localStorage.setItem(PARTICIPANT_STORAGE_KEY, code);
  } catch {
    // Remembered for this page only.
  }
  state.calibration = loadCalibration(code);
  applyCalibration();
  updateDeskMap();
  updateScreensStatus();
  const count = `${state.calibration.length} screen${state.calibration.length === 1 ? '' : 's'} calibrated`;
  setMeasureStatus(
    state.calibration.length ? `${code || 'No code'}: ${count}.` : `${code || 'No code'}: not calibrated yet — calibrate under Screens first.`,
  );
  logEntry(`participant ${code || '(none)'} — ${count}`, 'note');
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
  // The real proportions of the desk; sizeDeskMap() fits them to the card.
  el.deskMap.dataset.aspect = String(width / height);
  sizeDeskMap();

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
      tile.title = `Bring forward the front window on ${d.name} — the same as looking at it and pinching`;
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

const DESK_MAP_MAX_HEIGHT = 180;

/**
 * As wide as the card allows and never taller than 180 px, at the desk's real
 * proportions. CSS alone cannot do both, so it is measured — and re-measured
 * whenever the card changes size, including when the Screens view first shows.
 */
function sizeDeskMap() {
  const aspect = Number(el.deskMap.dataset.aspect);
  const available = el.deskMap.parentElement.clientWidth - 36;
  if (!(aspect > 0) || available <= 0) return;
  const height = Math.min(DESK_MAP_MAX_HEIGHT, available / aspect);
  el.deskMap.style.width = `${Math.round(height * aspect)}px`;
  el.deskMap.style.height = `${Math.round(height)}px`;
}

new ResizeObserver(sizeDeskMap).observe(el.deskMap.parentElement);

/** Per frame: which screen you face, and which are calibrated. */
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

    let status = calibrated.has(id) ? '' : 'not calibrated';
    if (id === calibratingId) status = step.phase === 'recording' ? 'hold still…' : 'look here';
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
      text = 'Look at a screen and pinch to bring its window forward. It goes by where you looked while pinching.';
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
  if (state.checkup) return updateScreensStatus('Finish or cancel the check-up first.', 'failed');
  await loadScreens();
  if (!state.cameraOn) return updateScreensStatus('Start the camera first.', 'failed');
  if (!state.headAvailable) {
    return updateScreensStatus('Head tracking is not running. Restart the camera after binding focus_screen.', 'failed');
  }
  if (state.displays.length === 0) return updateScreensStatus('No screens were reported.', 'failed');

  const queue = [...state.displays].sort((a, b) => a.x - b.x || a.y - b.y);
  state.calibrating = { queue, index: 0, phase: 'countdown', samples: [], results: [], timer: null };
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

  // Spread and sample count travel with the reading: the check-up reports them,
  // and a wobbly calibration explains a bad facing score before anything else.
  cal.results.push({
    id: display.id,
    name: display.name,
    yaw: reading.yaw,
    pitch: reading.pitch,
    spread: reading.spread,
    samples: cal.samples.length,
    at: new Date().toISOString(),
  });
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

// ---------------------------------------------------------------- check-up

function setMeasureStatus(text, kind = '') {
  el.measureStatus.textContent = text;
  el.measureStatus.className = `hint ${kind}`.trim();
}

/** "ck-20261023-142501-x7k2": sortable, and unique enough per machine. */
function sessionId(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

let postFailed = false;

/**
 * Save one record to experiments/<date>.jsonl through the server. Said once in
 * the log if it fails rather than per trial: the check-up should finish either
 * way, and the summary on the page still holds the numbers.
 *
 * @returns {Promise<string|null>} The file it was written to.
 */
async function postRecord(session, record) {
  try {
    const res = await fetch('./experiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, participant: state.participant || 'me', ...record }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data.file ?? null;
  } catch (err) {
    if (!postFailed) logEntry(`could not save a check-up result: ${err.message}`, 'failed');
    postFailed = true;
    return null;
  }
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Screens that are both calibrated and connected — the only ones a trial can use. */
function usableCalibration() {
  return state.calibration.filter((c) => state.displays.some((d) => d.id === c.id));
}

// The check-up's code, loaded when the first one starts.
let checkupLib = null;

async function startCheckup() {
  if (state.calibrating) return setMeasureStatus('Finish calibrating first.', 'failed');
  if (!state.cameraOn) return setMeasureStatus('Start the camera first.', 'failed');
  if (!state.headAvailable) {
    return setMeasureStatus('Head tracking is not running. Bind a gesture to focus_screen and restart the camera.', 'failed');
  }
  await loadScreens();
  const calibration = usableCalibration();
  if (calibration.length === 0) return setMeasureStatus('Calibrate your screens first, under Screens.', 'failed');

  const screens = state.displays.filter((d) => calibration.some((c) => c.id === d.id));
  const labels = spokenLabels(screens);
  const seed = Date.now() >>> 0;
  checkupLib ??= await import('./checkup.js');
  const plan = checkupLib.checkupPlan({ screens: screens.map((d) => d.id), labels, rng: seededRandom(seed) });
  const session = sessionId('ck');

  recognizer.reset();
  grab.reset();
  chime.unlock();
  postFailed = false;
  state.checkup = { runner: new checkupLib.CheckupRunner(plan), session, records: [], calibration, file: null };
  el.checkupBtn.textContent = 'Cancel';
  el.participant.disabled = true;
  el.measureResults.hidden = true;
  setMeasureStatus(`Starting — ${plan.length} spoken prompts. Wait for the chime after each one, then do it.`);
  logEntry(`check-up started (${state.participant || 'me'}, ${plan.length} prompts)`, 'note');

  // Everything needed to read the results later without this page: what was
  // bound, how the tracker was tuned, and what the calibration looked like.
  postRecord(session, {
    kind: 'session',
    mode: 'checkup',
    seed,
    prompts: plan.length,
    tuning: { ...tuning(), screen: screenTracker.options },
    bindings: state.config?.gestures ?? {},
    displays: state.displays.map((d) => ({ ...d, label: labels[d.id] ?? null })),
    calibration: calibration.map((c) => ({
      id: c.id,
      name: c.name,
      yaw: round1(c.yaw),
      pitch: round1(c.pitch),
      spread: round1(c.spread),
      samples: c.samples ?? null,
      ageMin: c.at ? Math.round((Date.now() - Date.parse(c.at)) / 60000) : null,
    })),
    camera: { fps: round1(state.fps), mode: state.mode },
  }).then((file) => {
    if (file && state.checkup?.session === session) state.checkup.file = file;
  });
}

/** Fed every camera frame while the check-up runs. */
function checkupFrame(now, view, pts, movement) {
  const commands = state.checkup.runner.tick(now, {
    head: state.head,
    headAt: state.headAt,
    facing: state.facing,
    view,
    pattern: fingerPattern(pts),
    movement,
    covered: cover.covered,
  });
  runCheckupCommands(commands);
}

function runCheckupCommands(commands) {
  const cu = state.checkup;
  if (!cu) return;
  for (const command of commands) {
    switch (command.type) {
      case 'say':
        voice.say(command.text).then(({ fallback }) => {
          // A tick at least marks that a prompt happened when speech failed.
          if (fallback) chime.play('tick');
          if (state.checkup === cu) cu.runner.speechEnded(performance.now());
        });
        break;
      case 'chime':
        chime.play(command.cue);
        break;
      case 'status':
        setMeasureStatus(command.text);
        break;
      case 'save':
        cu.records.push(command.record);
        postRecord(cu.session, command.record).then((file) => {
          if (file) cu.file = file;
        });
        break;
      case 'done':
        finishCheckup(cu, command.aborted === true);
        break;
      default:
        break;
    }
  }
}

function cancelCheckup(reason) {
  if (!state.checkup) return;
  runCheckupCommands(state.checkup.runner.abort(performance.now(), reason));
}

function finishCheckup(cu, aborted) {
  if (state.checkup !== cu) return;
  state.checkup = null;
  voice.cancel();
  // A pose made during the last trial must not fire the moment it ends.
  recognizer.reset();
  el.checkupBtn.textContent = 'Run check-up';
  el.participant.disabled = false;

  if (aborted) {
    setMeasureStatus('Check-up stopped. The trials so far are saved.', 'failed');
    logEntry('check-up stopped', 'note');
    return;
  }

  const summary = checkupLib.summarizeCheckup(cu.records, { calibration: cu.calibration });
  const gate = checkupLib.gateA(summary);
  postRecord(cu.session, {
    kind: 'checkup_summary',
    summary,
    gate: gate.map(({ name, value, pass }) => ({ name, value, pass })),
  });
  renderCheckupResults(summary, gate);

  const judged = gate.filter((g) => g.pass !== null);
  const passed = judged.filter((g) => g.pass);
  chime.play(passed.length === judged.length ? 'done' : 'failed');
  setMeasureStatus(
    `Done — ${passed.length} of ${judged.length} checks passed. Saved to ${cu.file ?? 'experiments/'}.`,
    passed.length === judged.length ? 'on' : 'failed',
  );
  logEntry(`check-up done: ${passed.length}/${judged.length} checks passed`, 'note');
}

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const deg = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}°`);

/** The summary as a table: the measurement, then the pass mark beside it. */
function renderCheckupResults(summary, gate) {
  const rows = [];
  const heading = (text) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.colSpan = 3;
    th.textContent = text;
    tr.append(th);
    rows.push(tr);
  };
  const row = (label, value, note = '', noteClass = '') => {
    const tr = document.createElement('tr');
    const cells = [label, value, note].map((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    });
    if (noteClass) cells[2].className = noteClass;
    tr.append(...cells);
    rows.push(tr);
  };

  heading('Calibration');
  for (const c of summary.calibration) row(c.name, deg(c.spread), c.samples ? `${c.samples} readings` : '');
  for (const s of summary.separation) row(`${s.a} ↔ ${s.b}`, deg(s.deg), 'apart');

  heading('Facing');
  const f = summary.facing;
  row('Right screen', pct(f.accuracy), `${f.trials} trials`);
  row('Away → no screen', pct(f.awayNullRate), `${f.awayTrials} trials`);
  row('Settles in', ms(f.settleMedian), 'median');
  row('Head jitter', deg(f.restJitter), `smoothed ${deg(f.smoothJitter)}`);

  heading('Hand shapes');
  for (const [name, p] of Object.entries(summary.poses)) {
    row(name, pct(p.successRate), p.topConfusion ? `else seen as ${p.topConfusion}` : `${p.n} trials`);
    row(`${name} done in`, ms(p.firedMedian), `shape at ${ms(p.shapeMedian)}`);
  }

  heading('Gate A (proposed pass marks)');
  for (const g of gate) {
    const value = g.format === 'ms' ? ms(g.value) : pct(g.value);
    const mark = g.min !== undefined ? `≥ ${g.format === 'ms' ? ms(g.min) : pct(g.min)}` : `≤ ${g.format === 'ms' ? ms(g.max) : pct(g.max)}`;
    const verdict = g.pass === null ? 'not measured' : g.pass ? `pass (${mark})` : `fail (${mark})`;
    row(g.name, value, verdict, g.pass === null ? 'na' : g.pass ? 'pass' : 'fail');
  }

  el.measureResults.tBodies[0].replaceChildren(...rows);
  el.measureResults.hidden = false;
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
function handleLandmarks(landmarks, width, height, face, luma) {
  const now = performance.now();
  const pts = landmarks && width && height ? toPoints(landmarks, width / height) : null;

  // Head first, so a gesture fired on this frame aims at where you are looking
  // now. `undefined` means the face model did not run on this frame — keep the
  // last reading — while `null` means it ran and found no face.
  if (face !== undefined && width && height) {
    state.head = headPose(face, width / height);
    state.mouth = mouthPoint(face, width / height);
    state.headAt = now;
    state.facing = screenTracker.update(state.head, now);
    facingHistory.push({ t: now, screen: state.facing?.screen ?? null });
    while (facingHistory.length > 0 && facingHistory[0].t < now - FACING_HISTORY_MS) facingHistory.shift();
    if (state.calibrating?.phase === 'recording' && state.head) state.calibrating.samples.push(state.head);
  }

  // Per pose, not a flat "am I armed": a gesture bound to a client action has
  // to fire while disarmed, and must take the cooldown that keeps it from
  // repeating on every frame. Everything else stays unrecorded while disarmed
  // so the first real gesture after arming is not swallowed.
  //
  // During the check-up every pose may fire, so a pinch is measured with the
  // same hold and cooldown it has in real use — and then goes nowhere.
  // The face model runs on every other frame; a mouth older than that is gone.
  recognizer.setMouth(state.headAt !== null && now - state.headAt < MOUTH_FRESH_MS ? state.mouth : null);
  const view = recognizer.update(
    pts,
    now,
    (pose) => state.checkup !== null || state.armed || isClientGesture(pose),
  );
  // Why the last up / down swipe did or didn't scroll, for the Diagnostics
  // row and the heartbeat.
  if (view.flick) state.flick = view.flick;
  state.view = view;
  state.customNear = custom.size > 0 ? custom.nearest(pts) : null;

  // Movements: an open hand closing, and the lens covered. Watched only while
  // one is bound or a check-up measures them; fed every frame then, whatever
  // happens below, so their state stays right.
  const movement = watchesMovements()
    ? (grab.update(view.shape ?? null, now) ?? cover.update(luma ?? null, now))
    : null;

  // The Lab gets the hand for its snap detector, and nothing fires: closing
  // the recognizer's gate is not enough, because a client action like arming
  // acts on any gesture the recognizer reports.
  if (state.recording) recordFrame(pts, now);
  else if (state.checkup) checkupFrame(now, view, pts, movement);
  else if (lab?.isOpen) lab.frame(now, pts, landmarks);
  else {
    if (view.gesture) onGestureDetected(view.gesture);
    if (movement) onGestureDetected(movement);
  }

  markFrame(now);
  syncWorkerOptions();
  // Nobody sees the overlay or the readout while the page is hidden.
  if (!document.hidden) draw(landmarks, drawMode(view), width, height);
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
  // The same rule as the Camera chip (ui/status.js), so the two never disagree.
  const camera = cameraState({
    on: state.cameraOn,
    mode: state.mode,
    hidden: document.hidden,
    muted: state.cameraMuted,
    recovering: state.recovering,
    msSinceFrame: msSinceFrame(),
  });
  if (camera === 'running') return [`running${state.fps ? ` ${Math.round(state.fps)}fps` : ''}`, 'on'];
  return {
    off: ['off', 'off'],
    paused: ['paused (tab hidden)', 'moving'],
    muted: ['camera muted', 'moving'],
    restarting: ['restarting…', 'moving'],
    stalled: ['stalled', 'moving'],
  }[camera];
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
  // Hidden: only the mood, which feeds the orb. The rest is redrawn on return.
  if (document.hidden) {
    renderMascotNow();
    return;
  }
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
  if (state.flick) {
    const f = state.flick;
    set(el.flick, `${f.dir}: ${f.verdict} (${f.travel} of ${f.need} palms)`, f.verdict === 'scrolled' ? 'on' : 'off');
  }

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
  renderStatusChips();
  renderHome();
  renderSetup();
  renderMascotNow();
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

// MediaPipe's loader clears a shared global after creating each task, so two
// created at once on this page can fail with "ModuleFactory not set": the
// fallback hand model and the Lab's cutout are created one at a time.
let mediapipeQueue = Promise.resolve();
function oneAtATime(create) {
  const run = mediapipeQueue.then(create, create);
  mediapipeQueue = run.catch(() => {});
  return run;
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
 * default fist binding locks the screen, so this is a self-inflicted wound
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

// The camera, at what detection needs. MediaPipe shrinks every frame to
// 192-256 px before its models see it, and everything after works in palm
// lengths, so 720p bought nothing but pixels to capture, convert and copy.
// The Lab asks for more while it is open, for sharp recordings.
const CAMERA_DETECT = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } };
const CAMERA_DETAILED = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

/** The preview track (Home's, and the Lab's) at detection size, or detailed. */
function setCameraDetail(detailed) {
  const track = el.video.srcObject?.getVideoTracks()[0];
  track?.applyConstraints(detailed ? CAMERA_DETAILED : CAMERA_DETECT).catch(() => {});
}

/**
 * What the worker does beyond tracking a hand. `full`: every frame, not slower
 * when no hand is in view, for whatever needs an unbroken stream. `luma`: the
 * lens brightness, which only covering the lens uses.
 */
function workerOptions() {
  return {
    full: Boolean(state.calibrating || state.checkup || state.recording || lab?.isOpen),
    luma: state.checkup !== null || bindingFor('cover') !== null,
  };
}

let sentOptions = '';
const optionsKey = (o) => `${o.full}|${o.luma}`;

/** Tell the worker when its options change. Cheap enough for every frame. */
function syncWorkerOptions() {
  if (!state.worker) return;
  const options = workerOptions();
  if (optionsKey(options) === sentOptions) return;
  sentOptions = optionsKey(options);
  state.worker.postMessage({ type: 'options', options });
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
      const { landmarks, width, height, luma } = event.data;
      handleLandmarks(landmarks, width, height, 'face' in event.data ? event.data.face : undefined, luma);
    } else if (type === 'head') {
      state.headStarting = false;
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
      faceIndices: Object.values(FACE),
      options: workerOptions(),
    },
    [processor.readable],
  );
  sentOptions = optionsKey(workerOptions());
  state.headStarting = wantsHead();

  await ready;
}

/**
 * @returns {Promise<{ok: true} | {ok: false, blocked: boolean, message: string}>}
 *   `blocked`: the camera was refused, by Chrome's prompt or by macOS.
 */
async function startCamera() {
  if (state.cameraOn) return { ok: true };
  el.cameraBtn.disabled = true;
  el.stageMsg.hidden = false;
  el.stageMsg.textContent = 'Waiting for camera permission…';

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...CAMERA_DETECT, facingMode: 'user' },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play();
  } catch (err) {
    el.stageMsg.textContent = 'Camera unavailable.';
    el.cameraBtn.disabled = false;
    showBanner('Could not start the camera.', err.message, true);
    return { ok: false, blocked: err.name === 'NotAllowedError', message: err.message };
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
      if (!state.landmarker) state.landmarker = await oneAtATime(() => createLandmarker(assets));
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
    return { ok: false, blocked: false, message: `Could not load hand tracking: ${err.message}` };
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
  lab?.cameraChanged();

  if (state.mode === 'page') scheduleFrame();
  return { ok: true };
}

function stopCamera() {
  state.cameraOn = false;

  teardownDetection();

  for (const track of el.video.srcObject?.getTracks() ?? []) track.stop();
  el.video.srcObject = null;
  lab?.cameraChanged();

  recognizer.reset();
  state.mode = null;
  state.view = null;
  state.recent = null;
  state.fps = 0;
  state.cameraMuted = false;
  state.headAvailable = false;
  state.headStarting = false;
  state.head = null;
  state.mouth = null;
  state.facing = null;
  screenTracker.reset();
  facingHistory.length = 0;
  grab.reset();
  cover.reset();
  if (state.calibrating) endCalibration('the camera stopped');
  cancelCheckup('the camera stopped');
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
 * The case this exists for: fist is bound to cmd+ctrl+q, which locks the
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
  if (armed && !state.armedOnce) {
    state.armedOnce = true;
    writeFlag('gesture.armedOnce', 'yes');
  }
  el.armBtn.setAttribute('aria-pressed', String(armed));
  el.armLabel.textContent = armed ? 'Armed' : 'Disarmed';

  const what = armed ? 'armed — gestures will press keys' : 'disarmed';
  logEntry(source ? `${source} -> ${what}` : what, source ? 'fired' : 'note');
  chime.play(armed ? 'armed' : 'disarmed');
  updateReadout();
}

// ---------------------------------------------------------------- boot

el.cameraBtn.addEventListener('click', () => {
  if (ENGINE) {
    // Through the same path as the orb's click, so the two never disagree.
    engineWant = !state.cameraOn;
    followCamera();
  } else if (state.cameraOn) stopCamera();
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

el.participant.value = state.participant;
el.participant.addEventListener('change', () => setParticipant(el.participant.value));
el.participant.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.participant.blur();
});

el.checkupBtn.addEventListener('click', () => {
  if (state.checkup) cancelCheckup('cancelled');
  else startCheckup();
});

// The status bar: Armed toggles, every other chip opens Diagnostics, which is
// where the detail behind it lives.
el.chips.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-chip]');
  if (!chip) return;
  if (chip.dataset.chip === 'armed') setArmed(!state.armed);
  else setDiagnostics(true);
});

el.diagnosticsBtn.addEventListener('click', () => setDiagnostics(el.diagnostics.hidden));
el.diagnosticsClose.addEventListener('click', () => {
  setDiagnostics(false);
  el.diagnosticsBtn.focus();
});

el.setupToggle.addEventListener('click', () => {
  const collapsed = el.setup.classList.contains('collapsed');
  state.setupPref = collapsed ? 'shown' : 'hidden';
  writeFlag('gesture.setup', state.setupPref);
  renderSetup();
});

el.setupSteps.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) runSetupAction(button.dataset.action);
});

el.mascotToggle.addEventListener('change', () => setMascotOn(el.mascotToggle.checked));
el.mascot.hidden = !state.mascotOn;
el.mascotToggle.checked = state.mascotOn;
mountMascotArt(el.mascot);

// The Lab borrows the camera, sounds and results file; it decides nothing here.
// Its code loads on the first visit, so nobody who never opens it pays for it.
let lab = null;
let labLoading = null;

function loadLab() {
  labLoading ??= import('./lab/lab.js').then(({ createLab }) => {
    lab = createLab({
      resolveAssets,
      exists,
      oneAtATime,
      stream: () => el.video.srcObject,
      cameraDetail: setCameraDetail,
      startCamera,
      voice,
      chime,
      postRecord,
      sessionId,
      log: logEntry,
      react: reactMascot,
    });
    return lab;
  });
  return labLoading;
}

window.addEventListener('hashchange', route);
// No hash: go back to the view you were last on.
if (!location.hash) {
  const last = readFlag('gesture.view');
  // Never the Lab in the hidden engine: gestures don't fire there, and its
  // person cutout would run for nobody.
  if (VIEWS.includes(last) && !(ENGINE && last === 'lab')) history.replaceState(null, '', `#/${last}`);
}
route();

// The server's live feed. Every page reads the config again when config.json
// changes, or the server restarted (a new hello), instead of polling for it;
// the engine also takes its camera switch from here.
const serverEvents = new EventSource(ENGINE ? './events?role=engine' : './events');
serverEvents.addEventListener('hello', () => pollConfig());
serverEvents.addEventListener('config', () => pollConfig());
// A gesture that went out but didn't work, found after the fact (a desktop
// switch macOS undid).
serverEvents.addEventListener('problem', (event) => {
  const { text } = JSON.parse(event.data);
  chime.play('failed');
  logEntry(text, 'failed');
  reactMascot('refused', text);
});
if (ENGINE) connectEngine(serverEvents);

// Escape is a one-way panic disarm. Deliberately not a toggle: this page is
// normally the frontmost window, so a gesture that presses the panic key would
// otherwise be able to toggle the page's own arm state.
document.addEventListener('keydown', (event) => {
  // Escape also closes the drawer — on top of, never instead of, disarming.
  if (event.key === 'Escape' && !el.diagnostics.hidden) setDiagnostics(false);
  if (event.key !== 'Escape' || !state.armed) return;
  // config.js refuses a bare `escape` binding, so this is always you.
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
  // The preview plays only while someone can see it; detection reads its own
  // copy of the camera track either way.
  if (state.mode === 'worker') {
    if (document.hidden) el.video.pause();
    else el.video.play().catch(() => {});
  }
  updateReadout();
});

renderCustomGestures();
await pollConfig();
await loadHealth();
await loadScreens();
// Monitors get plugged in and unplugged; the map and the calibration in use
// follow within half a minute. Each read spawns the native helper, so not more
// often: a pinch reads the displays fresh on the server anyway.
setInterval(loadScreens, 30000);
// An Accessibility grant made while the page is open ticks off its setup step.
setInterval(refreshHealth, 10000);
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
      // Whether this browser *can* detect while hidden: 'worker' mode needs
      // MediaStreamTrackProcessor.
      hasMSTP: typeof MediaStreamTrackProcessor === 'function',
      flick: state.flick,
    }),
    // A diagnostics channel must never become the thing that breaks.
  }).catch(() => {});
}, 2000);
setInterval(superviseDetection, WATCHDOG_INTERVAL_MS);
updateReadout();

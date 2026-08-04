// Camera -> hand landmarks -> gesture -> POST /gesture.
//
// I/O only. Every gesture decision lives in recognizer.js, which is unit tested;
// this file drives the camera, paints the overlay, and talks to the server.

import { toPoints } from './landmarks.js';
import { Recognizer } from './recognizer.js';

const TASKS_VISION_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
// UMD build, for the classic worker: the ESM build fails inside a worker with
// "ModuleFactory not set."
const TASKS_VISION_UMD_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.js';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOCAL_MODEL_URL = './models/hand_landmarker.task';

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
};

const ctx = el.canvas.getContext('2d');
const recognizer = new Recognizer();

const state = {
  armed: false,
  cameraOn: false,
  landmarker: null,
  worker: null,
  // 'worker' keeps detecting while the page is hidden; 'page' is the fallback for
  // browsers without MediaStreamTrackProcessor and stops the moment you look away.
  mode: null,
  detectorTracks: [],
  config: null,
  configRaw: '',
  view: null,
  recent: null,
  recentAt: 0,
  fps: 0,
};

// ---------------------------------------------------------------- config

function tuning() {
  return state.config?.tuning ?? recognizer.tuning;
}

function applyConfig(config) {
  state.config = config;
  recognizer.setTuning(config.tuning);
  renderBindings();
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
  el.log.prepend(li);
  while (el.log.children.length > 40) el.log.lastElementChild.remove();
}

async function send(name) {
  try {
    const res = await fetch('./gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gesture: name }),
    });
    const data = await res.json().catch(() => ({}));

    if (data.fired) {
      logEntry(`${name} -> ${data.shortcut}`, 'fired');
    } else if (data.reason === 'cooldown') {
      logEntry(`${name} skipped (cooldown ${data.retryInMs}ms)`, 'skipped');
    } else if (data.reason === 'dryRun') {
      logEntry(`${name} -> ${data.shortcut} (dry-run)`, 'skipped');
    } else {
      logEntry(`${name} failed: ${data.error ?? res.status}`, 'failed');
      if (res.status === 503) {
        showBanner('macOS is discarding key presses.', `${data.help} Then reload this page.`, true);
      } else if (res.status === 500) {
        showBanner('The key press failed.', data.error ?? 'see the server console', true);
      }
    }
  } catch (err) {
    logEntry(`${name} failed: ${err.message}`, 'failed');
  }
}

/** Detected gestures are silently dropped while disarmed — no log spam. */
function onGestureDetected(name) {
  state.recent = name;
  state.recentAt = performance.now();
  if (!state.armed) return;
  send(name);
}

function simulate(name) {
  if (!state.armed) {
    logEntry('arm first, then test', 'note');
    return;
  }
  send(name);
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
function handleLandmarks(landmarks, width, height) {
  const now = performance.now();
  const pts = landmarks && width && height ? toPoints(landmarks, width / height) : null;

  const view = recognizer.update(pts, now);
  state.view = view;

  if (view.gesture) onGestureDetected(view.gesture);

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

  const stale = performance.now() - lastFrameAt > 1500;

  if (state.mode === 'page' && document.hidden) return ['paused (tab hidden)', 'moving'];
  if (stale) return ['stalled', 'moving'];

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

async function resolveModelUrl() {
  try {
    const res = await fetch(LOCAL_MODEL_URL, { method: 'HEAD' });
    if (res.ok) return LOCAL_MODEL_URL;
  } catch {
    // Not vendored; fall through to the CDN.
  }
  return CDN_MODEL_URL;
}

async function createLandmarker() {
  // Imported lazily so the page still works offline: bindings, arming and the
  // test buttons don't need MediaPipe at all.
  const { FilesetResolver, HandLandmarker } = await import(TASKS_VISION_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const modelAssetPath = await resolveModelUrl();

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
 * Start detection in a worker, reading frames straight off the camera track.
 *
 * The track is cloned: MediaStreamTrackProcessor consumes the track it's given, so
 * handing over the original would blank the preview.
 */
async function startWorkerDetection(stream, modelUrl) {
  const source = stream.getVideoTracks()[0];
  if (!source) throw new Error('the camera stream has no video track');

  const track = source.clone();
  state.detectorTracks.push(track);

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
      handleLandmarks(landmarks, width, height);
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
      bundleUrl: TASKS_VISION_UMD_URL,
      wasmUrl: WASM_URL,
      modelUrl,
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

  try {
    if (canUseWorker) {
      await startWorkerDetection(stream, await resolveModelUrl());
      state.mode = 'worker';
    } else {
      if (!state.landmarker) state.landmarker = await createLandmarker();
      state.mode = 'page';
      showBanner(
        'Detection will pause when this window is hidden.',
        "This browser lacks MediaStreamTrackProcessor, so detection can't run in a background worker. Keep the window visible, or use Chrome for always-on detection.",
      );
    }
  } catch (err) {
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

  recognizer.reset();
  lastFrameAt = 0;
  state.fps = 0;
  state.cameraOn = true;
  el.stageMsg.hidden = true;
  el.cameraBtn.disabled = false;
  el.cameraBtn.textContent = 'Stop camera';

  if (state.mode === 'page') scheduleFrame();
}

function stopCamera() {
  state.cameraOn = false;

  if (state.worker) {
    state.worker.postMessage({ type: 'stop' });
    state.worker.terminate();
    state.worker = null;
  }
  for (const track of state.detectorTracks) track.stop();
  state.detectorTracks = [];

  for (const track of el.video.srcObject?.getTracks() ?? []) track.stop();
  el.video.srcObject = null;

  recognizer.reset();
  state.mode = null;
  state.view = null;
  state.recent = null;
  state.fps = 0;
  draw(null);
  updateReadout();

  el.cameraBtn.textContent = 'Start camera';
  el.stageMsg.hidden = false;
  el.stageMsg.textContent = 'Camera is off.';
}

function setArmed(armed) {
  state.armed = armed;
  el.armBtn.setAttribute('aria-pressed', String(armed));
  el.armLabel.textContent = armed ? 'Armed' : 'Disarmed';
  logEntry(armed ? 'armed — gestures will press keys' : 'disarmed', 'note');
}

// ---------------------------------------------------------------- boot

el.cameraBtn.addEventListener('click', () => {
  if (state.cameraOn) stopCamera();
  else startCamera();
});

el.armBtn.addEventListener('click', () => setArmed(!state.armed));

// Escape is a one-way panic disarm. Deliberately not a toggle, and deliberately
// not Space: `fist` is bound to space by default, so if this page happened to be
// the focused window when a gesture fired, a Space toggle would arm itself.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.armed) setArmed(false);
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

await pollConfig();
await loadHealth();
setInterval(pollConfig, 3000);
// Keeps the detection status honest even when no frames are arriving to drive it.
setInterval(updateReadout, 1000);
updateReadout();

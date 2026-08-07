// Camera -> hand landmarks -> gesture -> POST /gesture.
//
// I/O only. Every gesture decision lives in recognizer.js, which is unit tested;
// this file drives the camera, paints the overlay, and talks to the server.

import { toPoints } from './landmarks.js';
import { Recognizer } from './recognizer.js';

// Must match the version scripts/fetch-model.js vendors: a locally vendored
// bundle paired with a different CDN wasm build fails in ways that look like a
// broken camera rather than a version skew.
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const VENDOR_BASE = './vendor';

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

async function send(name) {
  // Stamped before the request, not after: the server presses the key and then
  // responds, so the keystroke can reach this page before the response does.
  if (state.config?.gestures?.[name] === 'escape') lastSelfEscapeAt = performance.now();

  try {
    const res = await fetch('./gesture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gesture: name }),
    });
    const data = await res.json().catch(() => ({}));

    if (data.fired) {
      if (data.shortcut === 'escape') lastSelfEscapeAt = performance.now();
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

  const view = recognizer.update(pts, now, state.armed);
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
      bundleUrl: assets.umd,
      wasmUrl: assets.wasm,
      modelUrl: assets.model,
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

await pollConfig();
await loadHealth();
setInterval(pollConfig, 3000);
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

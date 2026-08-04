// Camera -> hand landmarks -> gesture -> POST /gesture.

import { classifyPose } from './gestures.js';
import { toPoints } from './landmarks.js';
import { SwipeTracker } from './swipe.js';

const TASKS_VISION_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOCAL_MODEL_URL = './models/hand_landmarker.task';

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
  pose: document.getElementById('r-pose'),
  held: document.getElementById('r-held'),
  velocity: document.getElementById('r-velocity'),
  fourFinger: document.getElementById('r-fourfinger'),
  rearm: document.getElementById('r-rearm'),
  backend: document.getElementById('r-backend'),
  detection: document.getElementById('r-detection'),
};

const ctx = el.canvas.getContext('2d');
const tracker = new SwipeTracker();

const state = {
  armed: false,
  cameraOn: false,
  landmarker: null,
  config: null,
  configRaw: '',
  // The current continuous run of one static pose. One fire per run when
  // requireReleaseBetweenFires is on, which is what stops a held fist from
  // machine-gunning its shortcut every cooldown window.
  run: { pose: null, frames: 0, fired: false },
  lastFired: new Map(),
  velocity: 0,
  fourFinger: false,
  swipeArmed: true,
  handPresent: false,
};

// ---------------------------------------------------------------- config

// Used until /config arrives. Without a fallback, an undefined confirmFrames
// would make `frames < confirmFrames` false and fire a pose on its first frame.
const FALLBACK_TUNING = {
  confirmFrames: 4,
  cooldownMs: 1200,
  requireReleaseBetweenFires: true,
  stillnessMaxVelocity: 0.8,
};

function tuning() {
  return state.config?.tuning ?? FALLBACK_TUNING;
}

function applyConfig(config) {
  state.config = config;
  const t = config.tuning;
  tracker.setOptions({
    windowMs: t.swipeWindowMs,
    minTravel: t.swipeMinTravel,
    minVelocity: t.swipeMinVelocity,
    maxVerticalRatio: t.swipeMaxVerticalRatio,
    rearmRequiresPoseBreak: t.swipeRearmRequiresPoseBreak,
    invertDirection: t.invertSwipeDirection,
  });
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
      if (res.status === 500) {
        showBanner(
          'The key press failed.',
          'On macOS, grant this terminal Accessibility access: System Settings > Privacy & Security > Accessibility. Key presses fail silently without it.',
          true,
        );
      }
    }
  } catch (err) {
    logEntry(`${name} failed: ${err.message}`, 'failed');
  }
}

/** Detected gestures are silently dropped while disarmed — no log spam. */
function onGestureDetected(name) {
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

function considerPose(pose, now) {
  const t = tuning();
  if (pose !== state.run.pose) state.run = { pose, frames: 0, fired: false };
  state.run.frames += 1;

  if (!pose) return;
  if (state.run.frames < t.confirmFrames) return;
  if (t.requireReleaseBetweenFires && state.run.fired) return;

  const previous = state.lastFired.get(pose) ?? -Infinity;
  if (now - previous < t.cooldownMs) return;

  state.lastFired.set(pose, now);
  state.run.fired = true;
  onGestureDetected(pose);
}

function handleResult(result, now) {
  const landmarks = result.landmarks?.[0];

  if (!landmarks) {
    tracker.handLost();
    considerPose(null, now);
    state.handPresent = false;
    state.velocity = 0;
    state.fourFinger = false;
    state.swipeArmed = tracker.armed;
    draw(null);
    updateReadout();
    return;
  }

  state.handPresent = true;
  const aspect = el.video.videoWidth / el.video.videoHeight;
  const pts = toPoints(landmarks, aspect);

  const motion = tracker.update(pts, now);
  state.velocity = motion.velocity;
  state.fourFinger = motion.fourFinger;
  state.swipeArmed = motion.armed;

  if (motion.swipe) {
    // A swipe supersedes any pose reading for this frame, and resets the pose run
    // so the hand settling afterwards doesn't immediately count as a held pose.
    state.run = { pose: null, frames: 0, fired: false };
    onGestureDetected(motion.swipe);
    draw(landmarks, 'swipe');
    updateReadout(motion.swipe);
    return;
  }

  // Stillness gate. Without this a swipe would trip the open-palm binding on its
  // way across the frame, since the two hand shapes are near-identical.
  const pose = classifyPose(pts);
  const still = state.velocity <= tuning().stillnessMaxVelocity;
  considerPose(still ? pose : null, now);

  draw(landmarks, still ? 'still' : 'moving');
  updateReadout();
}

// ---------------------------------------------------------------- rendering

const STROKE = {
  still: '#6ea8fe',
  moving: '#f0b45f',
  swipe: '#46d17f',
};

function draw(landmarks, mode = 'still') {
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
 * Detection only runs while the page is being rendered: browsers suspend both
 * requestVideoFrameCallback and requestAnimationFrame in hidden tabs. Since this
 * app exists to drive *other* applications, that state is easy to hit by
 * accident, and silently detecting nothing is the worst way to express it. A
 * visible-but-unfocused window is fine — only genuinely hidden stops the loop.
 */
function detectionStatus() {
  if (!state.cameraOn) return ['off', 'off'];
  if (document.hidden) return ['paused (tab hidden)', 'moving'];
  if (performance.now() - lastFrameAt > 1500) return ['stalled', 'moving'];
  return ['running', 'on'];
}

function updateReadout(swipe) {
  const t = tuning();
  set(el.detection, ...detectionStatus());

  if (swipe) {
    set(el.pose, swipe, 'on');
  } else if (!state.handPresent) {
    set(el.pose, 'no hand', 'off');
  } else {
    set(el.pose, state.run.pose ?? '—', state.run.pose ? 'on' : 'off');
  }

  const frames = state.run.pose ? `${state.run.frames}/${t.confirmFrames}` : '—';
  set(el.held, frames, state.run.fired ? 'on' : '');

  if (!state.handPresent) {
    set(el.velocity, '—', 'off');
  } else {
    const moving = state.velocity > (t.stillnessMaxVelocity ?? 0.8);
    set(
      el.velocity,
      `${state.velocity.toFixed(2)} / ${t.stillnessMaxVelocity}`,
      moving ? 'moving' : '',
    );
  }

  set(
    el.fourFinger,
    state.handPresent ? (state.fourFinger ? 'yes' : 'no') : '—',
    state.fourFinger ? 'on' : 'off',
  );
  set(
    el.rearm,
    state.swipeArmed ? 'ready' : 'curl fingers',
    state.swipeArmed ? 'on' : 'off',
  );
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

  if (el.video.readyState >= 2 && el.video.videoWidth > 0) {
    if (el.canvas.width !== el.video.videoWidth) {
      el.canvas.width = el.video.videoWidth;
      el.canvas.height = el.video.videoHeight;
    }

    if (el.video.currentTime !== lastVideoTime) {
      lastVideoTime = el.video.currentTime;

      // detectForVideo throws on a timestamp that doesn't strictly increase,
      // which is the usual reason one of these pages dies a second after start.
      const ts = Math.max(performance.now(), lastTimestamp + 1);
      lastTimestamp = ts;

      try {
        handleResult(state.landmarker.detectForVideo(el.video, ts), ts);
        lastFrameAt = ts;
      } catch (err) {
        stopCamera();
        showBanner('Hand tracking stopped.', err.message, true);
        return;
      }
    }
  }

  scheduleFrame();
}

async function startCamera() {
  el.cameraBtn.disabled = true;
  el.stageMsg.hidden = false;
  el.stageMsg.textContent = 'Loading hand tracking model…';

  try {
    if (!state.landmarker) state.landmarker = await createLandmarker();
  } catch (err) {
    el.stageMsg.textContent = 'Could not load the hand tracking model.';
    el.cameraBtn.disabled = false;
    showBanner(
      'Could not load MediaPipe.',
      `${err.message}. The model is fetched from a CDN — check your connection, or vendor it locally with "npm run fetch-model".`,
      true,
    );
    return;
  }

  el.stageMsg.textContent = 'Waiting for camera permission…';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
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

  state.cameraOn = true;
  el.stageMsg.hidden = true;
  el.cameraBtn.disabled = false;
  el.cameraBtn.textContent = 'Stop camera';
  scheduleFrame();
}

function stopCamera() {
  state.cameraOn = false;
  for (const track of el.video.srcObject?.getTracks() ?? []) track.stop();
  el.video.srcObject = null;
  tracker.reset();
  state.run = { pose: null, frames: 0, fired: false };
  state.handPresent = false;
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
  if (state.cameraOn) {
    logEntry(
      document.hidden ? 'detection paused — this tab is hidden' : 'detection resumed',
      'note',
    );
    // Start the next run from scratch: a pose held across the gap shouldn't count
    // its pre-hide frames toward confirmFrames. The swipe buffer self-heals, since
    // stale samples fall outside the window on the first frame back.
    state.run = { pose: null, frames: 0, fired: false };
  }
  updateReadout();
});

await pollConfig();
await loadHealth();
setInterval(pollConfig, 3000);
// Keeps the detection status honest even when no frames are arriving to drive it.
setInterval(() => updateReadout(), 1000);
updateReadout();

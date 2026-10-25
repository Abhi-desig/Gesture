// Local HTTP server: serves the page, turns gesture names into key presses.
//
// This process can press any key on the machine, so the exposed surface is kept
// deliberately narrow. See SECURITY below.

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { resolveBackend } from './backends/index.js';
import { ConfigStore, applyBindingEdit, configVersion, validate, writeConfig } from './config.js';
import { readSpaceHotkeys, readSpaces, responsibleApp, windowServerSpaces, windowServerSpacesAsync } from './macos.js';
import { appendRecord, experimentsDir, MAX_RECORD_BYTES, validateRecord } from './experiments.js';
import { OrbHub, readCameraState, readMascot } from './orb-hub.js';
import { accessibilityHelpFor, checkAccessibility } from './permissions.js';
import { focusScreen, listDisplays } from './screens.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.GESTURE_CONFIG ?? path.join(ROOT, 'config.json');
const EXPERIMENTS_DIR = experimentsDir({ root: ROOT });

// Loopback only. Binding 0.0.0.0 would let anything on the local network press
// keys on this machine.
const HOST = '127.0.0.1';

const config = new ConfigStore(CONFIG_PATH);

try {
  config.load();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

const backend = await resolveBackend(
  config.current.settings.backend,
  config.current.gestures,
  {
    keysendSource: config.current.settings.keysendSource,
    spaceStrategy: config.current.settings.spaceStrategy,
    dockSwipeVariant: config.current.settings.dockSwipeVariant,
    dockSwipeVelocity: config.current.settings.dockSwipeVelocity,
    dockSwipeLingerMs: config.current.settings.dockSwipeLingerMs,
    dockSwipeWithTap: config.current.settings.dockSwipeWithTap,
  },
);
const accessibility = await checkAccessibility();
// Resolved once: this cannot change while the process lives, and it is the
// answer to "which app do I tick in System Settings?".
const owner = responsibleApp();

// Authoritative per-gesture cooldown. The browser debounces too, but that's for
// responsiveness — this is the guard that actually holds if a page is duplicated,
// reloaded mid-gesture, or otherwise misbehaves.
const lastFired = new Map();

config.onChange(() => {
  lastFired.clear();
  orb.configChanged();
  const bindings = Object.entries(config.current.gestures)
    .map(([name, g]) => `${name} -> ${g.combo}`)
    .join(', ');
  console.log(`  bindings: ${bindings || '(none)'}`);
});

const app = express();
app.disable('x-powered-by');

// 4 kB is plenty for every route that acts. Only result records are bigger —
// a facing trial carries its head trace — so only that route gets more, and
// it is chosen here rather than by route order, where a later route's own
// limit would never be reached past this one.
const smallJson = express.json({ limit: '4kb' });
const recordJson = express.json({ limit: MAX_RECORD_BYTES });
app.use((req, res, next) => (req.path === '/experiment' ? recordJson : smallJson)(req, res, next));

/**
 * SECURITY: reject cross-origin requests.
 *
 * Without this, any website open in the browser could POST to this port while
 * the server runs and fire whatever is bound — locking the screen, muting the
 * mic — as a drive-by. Two layers:
 *
 *  - Origin must be loopback when present. Browsers always attach Origin to
 *    POST, so a malicious page cannot pass this. A missing Origin is allowed
 *    because that means a non-browser caller (curl, tests), and anything running
 *    locally already has more direct ways to press keys than this endpoint.
 *  - Content-Type must be application/json, which HTML forms cannot send
 *    cross-origin without a CORS preflight that we never answer.
 */
function sameOriginOnly(req, res, next) {
  const refused = originProblem(req);
  if (refused) return res.status(403).json({ ok: false, error: refused });

  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'expected Content-Type: application/json' });
  }

  return next();
}

/** Why a request's Origin is refused, or null when it is loopback or absent. */
function originProblem(req) {
  const origin = req.get('origin');
  if (!origin) return null;
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return 'bad origin';
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    return 'cross-origin requests are not allowed';
  }
  return null;
}

// Long enough to catch a revert, which is the whole point of watching. A Space
// switched by any route can be pulled back by macOS when focus stays behind, and
// that has been measured at up to ~1.7s — a shorter window reports the revert as
// a success and hides the one failure mode worth naming.
//
// It delays only the HTTP response, never the switch itself, and only for
// Space-switching bindings.
const SPACE_SETTLE_TIMEOUT_MS = 2000;
// Each sample spawns the helper; four a second still catches a snap-back.
const SPACE_POLL_MS = 250;

/** e.g. "2/4" — position, not just identity, so a jump is distinguishable. */
function spacePosition(state) {
  if (!state) return '(unreadable)';
  const monitor = state.displays?.find((d) => d.activeIndex !== null);
  return monitor ? `${monitor.activeIndex + 1}/${monitor.spaces.length}` : `space ${state.active}`;
}

/**
 * Did the desktop actually move?
 *
 * The gap this closes: `backend.press()` resolving means the events were posted,
 * not that anything happened. For every other binding that distinction is
 * academic, but Space switching is exactly where it bites — the chord lands
 * inside the focused app, the log says the gesture fired, and the desktop sits
 * still. Without this the next debugging step is a guess between the detector,
 * the cooldown, the backend and the OS settings; with it, three of those four are
 * eliminated by the log line itself.
 *
 * @returns {{moved: boolean, from: string, to: string}|null} null when Spaces
 *   could not be read at all, which is not a failure worth failing the press for.
 */
async function verifySpaceMoved(before) {
  if (!before) return null;

  // Sampled rather than read once, and it keeps sampling after the first change,
  // because a Space can move and then be pulled back ~1.5s later when focus
  // stays with an app on the Space you left. "Moved" and "stayed moved" are
  // different answers and only one of them means the gesture worked.
  const deadline = performance.now() + SPACE_SETTLE_TIMEOUT_MS;
  let sawChange = false;
  let latest = before;

  while (performance.now() < deadline) {
    await sleep(SPACE_POLL_MS);
    const now = await windowServerSpacesAsync();
    if (!now) continue;
    latest = now;
    if (now.active !== before.active) sawChange = true;
  }

  return {
    moved: sawChange,
    held: latest.active !== before.active,
    from: spacePosition(before),
    to: spacePosition(latest),
  };
}

/**
 * A ring of recent page activity, for diagnosing "works in view, dead in the
 * background" without anyone having to watch two windows at once.
 *
 * The page heartbeats every couple of seconds with its frame rate and
 * visibility, and every gesture POST lands here with its outcome. Reading
 * GET /recent after a background test then answers, from one place: was the
 * page's main thread still running? were camera frames still flowing? did the
 * gesture reach the server at all, and what did the server do with it?
 */
const RECENT_LIMIT = 200;
const recent = [];

function remember(event) {
  recent.push({ t: new Date().toISOString(), ...event });
  if (recent.length > RECENT_LIMIT) recent.shift();
}

app.post('/heartbeat', sameOriginOnly, (req, res) => {
  const b = req.body ?? {};
  remember({
    type: 'heartbeat',
    // Whitelisted rather than spread: this is a loopback diagnostics channel,
    // not a place to let a page store arbitrary payloads.
    fps: typeof b.fps === 'number' ? b.fps : null,
    mode: typeof b.mode === 'string' ? b.mode : null,
    armed: b.armed === true,
    visibility: typeof b.visibility === 'string' ? b.visibility : null,
    msSinceFrame: typeof b.msSinceFrame === 'number' ? Math.round(b.msSinceFrame) : null,
    hasMSTP: b.hasMSTP === true,
    engine: typeof b.engine === 'string' ? b.engine : null,
    // The last palm up / down and why it did or didn't scroll.
    flick:
      b.flick && typeof b.flick === 'object'
        ? {
            dir: String(b.flick.dir ?? '').slice(0, 8),
            verdict: String(b.flick.verdict ?? '').slice(0, 60),
            travel: Number.isFinite(b.flick.travel) ? b.flick.travel : null,
            speed: Number.isFinite(b.flick.speed) ? b.flick.speed : null,
          }
        : null,
  });
  res.json({ ok: true });
});

/**
 * Record that a client actually fetched the page and then ran its JavaScript.
 *
 * Added because "the window is blank" is otherwise unfalsifiable from outside
 * the webview: there is no console to read and no devtools in a release build.
 * A `page` event means the HTML was served; the `config` event that follows
 * means the page's script ran far enough to ask for its bindings. Blank with
 * neither is a navigation that never happened; blank with both is a rendering
 * problem, and those are very different things to chase.
 */
function rememberFetch(kind, req) {
  remember({
    type: 'fetch',
    what: kind,
    // The tail of the UA, because Tauri's WKWebView presents itself as Safari
    // and cannot be told apart by a keyword — but Chrome's UA ends in
    // "Chrome/… Safari/…" while the webview's ends at "Safari/…", which is
    // enough to tell the app's own loads from a browser tab pointed at the
    // same port.
    agent: (req.get('user-agent') ?? '').slice(-45),
  });
}

app.post('/client', sameOriginOnly, (req, res) => {
  const b = req.body ?? {};
  remember({
    type: 'client',
    engine: typeof b.engine === 'string' ? b.engine : null,
    hasMSTP: b.hasMSTP === true,
    hasWorker: b.hasWorker === true,
    hasGUM: b.hasGUM === true,
    secureContext: b.secureContext === true,
  });
  res.json({ ok: true });
});

app.get('/recent', (_req, res) => {
  res.json({ now: new Date().toISOString(), events: recent });
});

/**
 * Append one check-up or experiment record to experiments/<date>.jsonl.
 *
 * Same-origin only, like every route that writes: these files are people's
 * measurements, and nothing outside this page should be able to add to them.
 */
app.post('/experiment', sameOriginOnly, async (req, res) => {
  const { record, error } = validateRecord(req.body);
  if (error) return res.status(400).json({ ok: false, error });
  try {
    const { file } = await appendRecord(EXPERIMENTS_DIR, record);
    // Short when it is in the project, whole when GESTURE_EXPERIMENTS_DIR put it elsewhere.
    return res.json({ ok: true, file: file.startsWith(ROOT + path.sep) ? path.relative(ROOT, file) : file });
  } catch (err) {
    console.error(`could not save a ${record.kind} record: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * The orb: its live feed, the mascot's mood, and the camera switch.
 *
 * The page knows the mood and runs the camera; the orb under the camera shows
 * the mood and asks for the camera. server/orb-hub.js keeps the state between
 * them and streams each change to both.
 */
const orb = new OrbHub();
const orbTicker = setInterval(() => orb.tick(), 1000);
orbTicker.unref();

// Read-only, but a page on another site still has no business holding a
// stream open to it, so a foreign Origin is refused like on every POST.
app.get('/events', (req, res) => {
  const refused = originProblem(req);
  if (refused) return res.status(403).json({ ok: false, error: refused });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  // How long the browser waits before reconnecting, e.g. after a server restart.
  res.write('retry: 2000\n\n');
  const detach = orb.attach(res, req.query.role);
  req.on('close', detach);
});

app.get('/orb', (_req, res) => {
  res.json(orb.snapshot());
});

app.post('/mascot', sameOriginOnly, (req, res) => {
  const { mascot, error } = readMascot(req.body);
  if (error) return res.status(400).json({ ok: false, error });
  orb.setMascot(mascot);
  return res.json({ ok: true });
});

app.post('/camera', sameOriginOnly, (req, res) => {
  if (typeof req.body?.on !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'body must be {"on": true | false}' });
  }
  orb.wantCamera(req.body.on);
  return res.json({ ok: true, engines: orb.engines });
});

app.post('/camera/state', sameOriginOnly, (req, res) => {
  const { camera, error } = readCameraState(req.body);
  if (error) return res.status(400).json({ ok: false, error });
  orb.reportCamera(camera);
  if (camera.error) remember({ type: 'camera', state: camera.state, error: camera.error });
  return res.json({ ok: true });
});

/**
 * The displays, for the page's calibration and desk map.
 *
 * Read fresh every time: plugging in or unplugging a monitor while the server
 * runs is ordinary, and a stale list would let a gesture aim at a screen that
 * is no longer there.
 */
app.get('/screens', async (_req, res) => {
  try {
    res.json({ ok: true, displays: await listDisplays() });
  } catch (err) {
    res.json({ ok: false, displays: [], error: err.message });
  }
});

/**
 * A gesture bound to a screen action: focus the screen you were facing.
 *
 * This is the one place the wire carries more than a gesture name. It carries
 * a display id too, because only the page can see your head. That widens what a
 * compromised page could ask for by exactly one thing — which of your own
 * screens — and the id is checked against the displays actually connected, so
 * the worst it can do is bring a window you already have open forward.
 */
async function screenAction(req, res, name, binding) {
  const { settings } = config.current;
  const screen = req.body?.screen;
  const action = binding.combo;

  if (!Number.isInteger(screen) || screen <= 0) {
    return res.status(400).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: action,
      error: `"${binding.combo}" needs the screen you were facing: {"gesture": "${name}", "screen": <display id>}`,
    });
  }

  const slot = name;
  const now = performance.now();
  const waited = now - (lastFired.get(slot) ?? -Infinity);
  if (waited < settings.cooldownMs) {
    remember({ type: 'gesture', gesture: name, action, outcome: 'cooldown' });
    return res.status(429).json({
      ok: true,
      fired: false,
      gesture: name,
      shortcut: action,
      reason: 'cooldown',
      retryInMs: Math.ceil(settings.cooldownMs - waited),
    });
  }
  lastFired.set(slot, now);

  let display;
  try {
    display = (await listDisplays()).find((d) => d.id === screen);
  } catch (err) {
    lastFired.delete(slot);
    return res.status(500).json({ ok: false, fired: false, gesture: name, shortcut: action, error: err.message });
  }
  if (!display) {
    lastFired.delete(slot);
    return res.status(404).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: action,
      error: `display ${screen} is not connected — calibrate your screens again`,
    });
  }

  if (settings.dryRun) {
    remember({ type: 'gesture', gesture: name, action, screen: display.name, outcome: 'dryRun' });
    console.log(`[dry-run] ${name} -> ${action} (${display.name})`);
    return res.json({
      ok: true,
      fired: false,
      gesture: name,
      shortcut: action,
      screen: display.name,
      reason: 'dryRun',
    });
  }

  const access = await checkAccessibility();
  if (access.granted === false) {
    lastFired.delete(slot);
    remember({ type: 'gesture', gesture: name, action, outcome: 'accessibility-denied' });
    return res.status(503).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: action,
      error: 'macOS is refusing window control: Accessibility access is not granted',
      help: accessibilityHelpFor(owner),
    });
  }

  try {
    const options = { movePointer: settings.screenMovesPointer };
    const result = await focusScreen(screen, options);
    const what = result.app ? `${result.app}${result.window ? ` — ${result.window}` : ''}` : 'no window';
    const effect = result.reason ? ` (${result.reason})` : '';
    remember({ type: 'gesture', gesture: name, action, screen: display.name, outcome: 'done', app: result.app ?? null });
    console.log(`${name} -> ${action}  ${display.name}: ${what}${effect}`);
    return res.json({
      ok: true,
      fired: true,
      gesture: name,
      shortcut: action,
      screen: display.name,
      app: result.app ?? null,
      window: result.window ?? null,
      // Did anything actually change? A pinch at an empty desktop succeeds and
      // does nothing, and the page says which.
      changed: result.focused === true,
      reason: result.reason ?? null,
    });
  } catch (err) {
    lastFired.delete(slot);
    remember({ type: 'gesture', gesture: name, action, outcome: 'error', error: err.message });
    console.error(`${name} -> ${action} failed: ${err.message}`);
    return res.status(err.notTrusted ? 503 : 500).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: action,
      error: err.message,
      ...(err.notTrusted ? { help: accessibilityHelpFor(owner) } : {}),
    });
  }
}

app.post('/gesture', sameOriginOnly, async (req, res) => {
  const { gestures, settings } = config.current;
  const name = req.body?.gesture;

  if (typeof name !== 'string' || name === '') {
    return res.status(400).json({ ok: false, error: 'body must be {"gesture": "<name>"}' });
  }

  // The wire protocol carries gesture *names* only, never key combos. The
  // shortcut is resolved here from config, so the worst a compromised page can
  // do is trigger something the user already bound — not inject arbitrary keys.
  const binding = gestures[name];
  if (!binding) {
    return res.status(404).json({
      ok: false,
      fired: false,
      gesture: name,
      error: `"${name}" is not bound in config.json`,
    });
  }

  // A binding the page performs itself. Reaching here means the page POSTed
  // something it should have handled locally — an older page against a newer
  // config, most likely — so say so plainly rather than failing in the backend
  // with an unparseable-shortcut error.
  if (binding.client) {
    return res.status(400).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: binding.combo,
      error: `"${binding.combo}" is a client-side action; the page performs it, the server does not`,
    });
  }

  if (binding.screen) return screenAction(req, res, name, binding);

  // performance.now(), not Date.now(): this clock only ever moves forward. Wall
  // clock can step backwards on an NTP correction or a sleep/wake, which makes
  // `waited` negative and wedges the gesture into a permanent 429 — the machine
  // has to be restarted to clear it, and nothing anywhere says why.
  const now = performance.now();
  const previous = lastFired.get(name) ?? -Infinity;
  const waited = now - previous;
  if (waited < settings.cooldownMs) {
    remember({ type: 'gesture', gesture: name, outcome: 'cooldown' });
    return res.status(429).json({
      ok: true,
      fired: false,
      gesture: name,
      shortcut: binding.combo,
      reason: 'cooldown',
      retryInMs: Math.ceil(settings.cooldownMs - waited),
    });
  }

  // Claim the cooldown slot before awaiting the press, so two requests arriving
  // in the same tick can't both get through.
  lastFired.set(name, now);

  if (settings.dryRun) {
    remember({ type: 'gesture', gesture: name, outcome: 'dryRun' });
    console.log(`[dry-run] ${name} -> ${binding.combo}`);
    return res.json({
      ok: true,
      fired: false,
      gesture: name,
      shortcut: binding.combo,
      reason: 'dryRun',
    });
  }

  // nut.js does NOT throw when macOS discards the event for lack of Accessibility
  // access — it logs a warning and resolves. Reporting `fired: true` in that case
  // is a lie that sends people hunting through Keyboard Shortcuts and gesture
  // thresholds while the actual cause is one toggle in System Settings. Checked
  // per press because the permission can be revoked while the server runs.
  const access = await checkAccessibility();
  if (access.granted === false) {
    remember({ type: 'gesture', gesture: name, outcome: 'accessibility-denied' });
    lastFired.delete(name);
    console.error(`${name} -> ${binding.combo} NOT pressed: Accessibility access denied`);
    return res.status(503).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: binding.combo,
      error: 'macOS is discarding key presses: Accessibility access is not granted',
      help: accessibilityHelpFor(owner),
    });
  }

  // Sampled before the press, so the comparison afterwards is against the
  // desktop we were actually on when the key went out.
  const watchSpaces =
    settings.verifySpaceSwitch && SPACE_SWITCH_COMBOS.has(binding.combo)
      ? windowServerSpaces()
      : null;

  try {
    await backend.press(binding.parsed);

    // Answered now, checked after. The desktop is watched for two seconds, to
    // catch macOS pulling it back; holding the answer that long made the
    // feedback for a swipe arrive two seconds after the desktop had moved.
    // Only a switch that failed is said, through the orb's feed.
    if (watchSpaces) {
      verifySpaceMoved(watchSpaces).then((space) => reportSpace(name, binding.combo, space));
    } else {
      remember({ type: 'gesture', gesture: name, outcome: 'pressed' });
      console.log(`${name} -> ${binding.combo}`);
    }

    return res.json({
      ok: true,
      fired: true,
      gesture: name,
      shortcut: binding.combo,
      backend: backend.name,
    });
  } catch (err) {
    remember({ type: 'gesture', gesture: name, outcome: 'error', error: err.message });
    lastFired.delete(name); // a failed press shouldn't burn the cooldown
    console.error(`failed to press ${binding.combo} for ${name}: ${err.message}`);
    return res.status(500).json({
      ok: false,
      fired: false,
      gesture: name,
      shortcut: binding.combo,
      error: err.message,
    });
  }
});

/** How a desktop switch went, in the log, the diagnostics and, if it failed, the orb. */
function reportSpace(name, combo, space) {
  remember({
    type: 'gesture',
    gesture: name,
    outcome: 'pressed',
    ...(space ? { space: space.moved && space.held ? 'moved' : space.moved ? 'reverted' : 'no-move' } : {}),
  });
  if (space && !(space.moved && space.held)) {
    orb.problem(space.moved ? 'The desktop moved, then macOS moved it back' : "The desktop didn't move");
  }
  if (space?.moved && space.held) {
    console.log(`${name} -> ${combo}  (space ${space.from} -> ${space.to})`);
  } else if (space?.moved) {
    // Distinct from both success and failure: the switch happened and macOS
    // undid it. Nothing about the gesture, the binding or the send is wrong.
    console.log(`${name} -> ${combo}`);
    console.log(`  !! the desktop moved and then snapped back to ${space.to}.`);
    console.log('  !! macOS pulls the Space back when keyboard focus stays with an app');
    console.log(`  !! on the Space you left. Try a different "spaceStrategy" than`);
    console.log(`  !! "${backend.spaceStrategy}" in config.json.`);
  } else if (space) {
    // The whole point of this branch: separate "the key was never sent" from
    // "the key was sent and macOS ignored it". Only the second one is true
    // here, and it rules out the detector, the cooldown and the binding.
    console.log(`${name} -> ${combo}`);
    console.log(`  !! sent, but the desktop did not move — still on ${space.to}.`);
    console.log(`  !! The press itself succeeded, so this is not the gesture detector,`);
    console.log(`  !! not the cooldown and not the binding. backend=${backend.name}` +
      `${backend.keysendSource ? ` source=${backend.keysendSource}` : ''}`);
    console.log('  !! Next: stop the server and run "npm run probe:keysend" from this');
    console.log('  !! same app, which reports which send method moves a Space.');
  } else {
    console.log(`${name} -> ${combo}`);
  }
}

app.get('/config', (req, res) => {
  rememberFetch('config', req);
  res.json(config.clientPayload());
});

/**
 * Change what gestures do, from the Gestures view.
 *
 * Same-origin, and limited to EDITABLE_ACTIONS — see config.js for why that
 * list is the safety boundary. The edit names the file version it was based
 * on: if config.json changed on disk since (a hand edit, say), the edit is
 * refused rather than quietly overwriting it.
 */
app.post('/config/gestures', sameOriginOnly, async (req, res) => {
  const { version, edits } = req.body ?? {};

  let text;
  try {
    text = await fs.promises.readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    return res.status(500).json({ ok: false, error: `could not read config.json: ${err.message}` });
  }
  if (version !== configVersion(text)) {
    return res.status(409).json({
      ok: false,
      error: 'config.json changed on disk since this page loaded it',
      config: config.clientPayload(),
    });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return res.status(400).json({ ok: false, errors: ['config.json is not valid JSON — fix it by hand first'] });
  }

  const edited = applyBindingEdit(raw, edits);
  if (edited.errors) return res.status(400).json({ ok: false, errors: edited.errors });
  try {
    validate(edited.raw);
  } catch (err) {
    return res.status(400).json({ ok: false, errors: [err.message] });
  }

  try {
    await writeConfig(CONFIG_PATH, edited.raw);
    config.load();
  } catch (err) {
    return res.status(500).json({ ok: false, error: `could not save config.json: ${err.message}` });
  }

  // Valid is not the same as pressable: the backend chosen at startup may not
  // be able to send a newly chosen key (osascript has no media keys).
  const warnings = Object.keys(edits)
    .map((name) => [name, config.current.gestures[name]])
    .filter(([, binding]) => binding?.parsed && typeof backend.supports === 'function' && !backend.supports(binding.parsed))
    .map(([name, binding]) => `the ${backend.name} backend cannot press ${binding.combo}, so ${name} won't work until it's changed`);

  for (const [name, combo] of Object.entries(edits)) {
    console.log(`config: ${name} -> ${combo ?? '(unbound)'}  (changed on the Gestures page)`);
  }
  remember({ type: 'config', edits });
  return res.json({ ok: true, config: config.clientPayload(), warnings });
});

app.get('/health', async (_req, res) => {
  // Re-checked per request, never cached. Accessibility can be revoked while the
  // server runs, and a stale "authorized" is actively misleading: it points the
  // user away from the one setting that is actually stopping their key presses.
  res.json({
    ok: true,
    backend: backend.name,
    backendReason: backend.reason,
    keysendSource: backend.keysendSource ?? null,
    spaceStrategy: backend.spaceStrategy ?? null,
    verifySpaceSwitch: config.current.settings.verifySpaceSwitch,
    dryRun: config.current.settings.dryRun,
    accessibility: await checkAccessibility(),
    accessibilityAtStartup: accessibility,
    accessibilityHelp: accessibilityHelpFor(owner),
    boundGestures: Object.keys(config.current.gestures),
  });
});

app.use((req, _res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    rememberFetch('page', req);
  }
  next();
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// The chords macOS reserves for moving between Spaces. Bindings that use one of
// these depend on OS settings no amount of correct key-sending can substitute
// for, so they get their own preflight.
const SPACE_SWITCH_COMBOS = new Set([
  'space_left',
  'space_right',
  // Still listed, though they cannot work on macOS 26: someone upgrading from an
  // older config has them bound, and the "sent, but the desktop did not move"
  // line is precisely what tells them to switch to the actions above.
  'ctrl+left',
  'ctrl+right',
]);

/** At startup: which screens a screen binding can reach, or why it can't. */
async function screenPreflight() {
  const bound = Object.entries(config.current.gestures).filter(([, g]) => g.screen);
  if (bound.length === 0) return;

  const names = bound.map(([name, g]) => `${name} -> ${g.combo}`).join(', ');
  try {
    const displays = await listDisplays();
    console.log(`  Screens (${names}): ${displays.map((d) => d.name).join(', ')}`);
    if (displays.length < 2) {
      console.log('  Only one screen is connected, so a pinch always lands on it.');
    }
  } catch (err) {
    console.log(`  !! ${names} cannot act on screens: ${err.message}`);
  }
  console.log('');
}

/**
 * Say out loud, at startup, the things that otherwise get guessed at.
 *
 * All three checks here describe failures that look exactly like a broken
 * gesture detector from the user's side: the hand is tracked, the gesture fires,
 * the log says it fired, and the desktop does not move.
 */
function preflight() {
  if (owner) {
    console.log(`  Accessibility is granted to (or needed by): ${owner.name}`);
    console.log('  Start the server from a different app and that app needs the grant instead.');
    console.log('');
  }

  const usesSpaceSwitch = Object.values(config.current.gestures).some((g) =>
    SPACE_SWITCH_COMBOS.has(g.combo),
  );
  if (!usesSpaceSwitch) return;

  // The symbolic hotkeys only matter to a binding that actually presses a key.
  // space_left / space_right post the Dock's gesture and never consult them, so
  // warning about them there would send people to an irrelevant setting.
  const spaceKeyBindings = Object.entries(config.current.gestures).filter(([, g]) =>
    ['ctrl+left', 'ctrl+right'].includes(g.combo),
  );

  if (spaceKeyBindings.length > 0) {
    console.log('  !! These gestures press a Space-switching KEY:');
    for (const [name, g] of spaceKeyBindings) console.log(`  !!   ${name} -> ${g.combo}`);
    console.log('  !! macOS refuses Space navigation from synthesized keystrokes, so these');
    console.log('  !! will land in the focused app and leave the desktop where it is.');
    console.log('  !! Bind them to "space_right" / "space_left" instead, which post the');
    console.log('  !! trackpad gesture the Dock actually listens for.');
    console.log('');
  }

  const hotkeys = spaceKeyBindings.length > 0 ? readSpaceHotkeys() : null;
  const disabled = hotkeys?.filter((h) => !h.enabled) ?? [];
  if (disabled.length > 0) {
    console.log('  !! A gesture is bound to a Space-switching shortcut, but these are');
    console.log('  !! turned off in System Settings > Keyboard > Keyboard Shortcuts >');
    console.log('  !! Mission Control:');
    for (const h of disabled) console.log(`  !!   ${h.label}`);
    console.log('  !! Nothing will move until they are enabled.');
    console.log('');
  }

  // Bound, but to something other than what a gesture sends.
  const expected = { 79: 'ctrl+left', 81: 'ctrl+right' };
  const mismatched =
    hotkeys?.filter((h) => h.boundTo && h.boundTo !== expected[h.id]) ?? [];
  for (const h of mismatched) {
    console.log(`  !! "${h.label}" is bound to ${h.boundTo}, not ${expected[h.id]}.`);
    console.log(`  !! Bind a gesture to ${h.boundTo} instead, or change it in System Settings.`);
    console.log('');
  }

  const spaces = readSpaces();
  if (spaces) {
    const total = spaces.reduce((n, m) => n + m.spaces.length, 0);
    if (total < 2) {
      console.log('  !! A gesture is bound to a Space-switching shortcut, but there is only');
      console.log('  !! one Space. Add a desktop in Mission Control, or nothing can move.');
      console.log('');
    } else {
      const summary = spaces
        .map((m) => `${m.display === 'Main' ? 'main' : m.display.slice(0, 8)}: ${m.spaces.length}`)
        .join(', ');
      console.log(`  Spaces available — ${summary}`);
      console.log('');
    }
  }

  if (backend.name === 'cgevent') {
    console.log(`  Keys go through the native helper (source: ${backend.keysendSource}).`);
    console.log(`  Space switching uses the "${backend.spaceStrategy}" strategy.`);
    if (config.current.settings.verifySpaceSwitch) {
      console.log('  Each swipe reports whether the desktop actually moved.');
    }
    console.log('');
  }

  if (backend.name === 'nutjs') {
    // Worth being blunt about: this is the exact configuration that produces
    // "the tab goes back but the desktop doesn't change".
    console.log('  !! The nut.js backend cannot switch Spaces. Its native module never');
    console.log('  !! emits a modifier flagsChanged event, so macOS sees Ctrl+Arrow inside');
    console.log('  !! the focused app but never as a Mission Control hotkey.');
    console.log('  !! Run "npm run build:native" and restart to use the cgevent backend.');
    console.log('');
  }
}

const { port } = config.current.settings;
const server = app.listen(port, HOST, () => {
  const bindings = Object.entries(config.current.gestures)
    .map(([name, g]) => `    ${name.padEnd(12)} ${g.combo}`)
    .join('\n');

  console.log('');
  console.log(`  gesture  ->  http://${HOST}:${port}`);
  console.log('');
  console.log(bindings || '    (no gestures bound)');
  console.log('');
  if (config.current.settings.dryRun) {
    console.log('  dry-run is on: gestures are logged, no keys are pressed.');
  } else if (backend.name === 'dryrun') {
    console.log('  no backend loaded: gestures are logged, no keys are pressed.');
  } else if (accessibility.granted === false) {
    console.log('  !! Accessibility access is NOT granted, so key presses will be');
    console.log('  !! silently ignored by macOS. Gestures will look like they work');
    console.log('  !! and nothing will happen. Grant it here, then restart:');
    console.log(`  !! ${accessibilityHelpFor(owner)}`);
    // Named rather than described, because "the terminal app running this
    // server" is exactly the part people get wrong — the grant follows whichever
    // editor or terminal launched it, not node.
    if (owner) console.log(`  !! The app to enable is: ${owner.name}`);
  } else if (accessibility.granted === null && accessibility.relevant) {
    console.log('  Could not determine Accessibility access. If gestures fire but');
    console.log(`  nothing happens: ${accessibilityHelpFor(owner)}`);
  }
  console.log('');

  preflight();
  screenPreflight();

  config.watch();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    config.close();
    // Open event streams would otherwise hold the close up indefinitely.
    orb.close();
    server.close(() => process.exit(0));
  });
}

// When the desktop app spawns this server it passes its own pid. If that
// process dies without managing to kill us — force-quit, crash, SIGKILL — we
// must not linger: an orphaned server holds the port with its TCC permissions
// attributed to a dead app, so every osascript press fails with error 1002 and
// the next app launch silently attaches to the broken instance.
const parentPid = Number(process.env.GESTURE_PARENT_PID);
if (Number.isInteger(parentPid) && parentPid > 1) {
  const watchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0: existence check only
    } catch {
      console.log(`parent process ${parentPid} is gone; shutting down`);
      clearInterval(watchdog);
      config.close();
      orb.close();
      server.close(() => process.exit(0));
      // A lingering request must not keep the zombie alive.
      setTimeout(() => process.exit(0), 2000).unref();
    }
  }, 3000);
  watchdog.unref();
}

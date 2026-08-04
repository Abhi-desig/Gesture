// Local HTTP server: serves the page, turns gesture names into key presses.
//
// This process can press any key on the machine, so the exposed surface is kept
// deliberately narrow. See SECURITY below.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { resolveBackend } from './backends/index.js';
import { ConfigStore } from './config.js';
import { ACCESSIBILITY_HELP, checkAccessibility } from './permissions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.GESTURE_CONFIG ?? path.join(ROOT, 'config.json');

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

const backend = await resolveBackend(config.current.settings.backend);
const accessibility = await checkAccessibility();

// Authoritative per-gesture cooldown. The browser debounces too, but that's for
// responsiveness — this is the guard that actually holds if a page is duplicated,
// reloaded mid-gesture, or otherwise misbehaves.
const lastFired = new Map();

config.onChange(() => {
  lastFired.clear();
  const bindings = Object.entries(config.current.gestures)
    .map(([name, g]) => `${name} -> ${g.combo}`)
    .join(', ');
  console.log(`  bindings: ${bindings || '(none)'}`);
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));

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
  const origin = req.get('origin');
  if (origin) {
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return res.status(403).json({ ok: false, error: 'bad origin' });
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      return res.status(403).json({ ok: false, error: 'cross-origin requests are not allowed' });
    }
  }

  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'expected Content-Type: application/json' });
  }

  return next();
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

  const now = Date.now();
  const previous = lastFired.get(name) ?? -Infinity;
  const waited = now - previous;
  if (waited < settings.cooldownMs) {
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
    console.log(`[dry-run] ${name} -> ${binding.combo}`);
    return res.json({
      ok: true,
      fired: false,
      gesture: name,
      shortcut: binding.combo,
      reason: 'dryRun',
    });
  }

  try {
    await backend.press(binding.parsed);
    console.log(`${name} -> ${binding.combo}`);
    return res.json({
      ok: true,
      fired: true,
      gesture: name,
      shortcut: binding.combo,
      backend: backend.name,
    });
  } catch (err) {
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

app.get('/config', (_req, res) => res.json(config.clientPayload()));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    backend: backend.name,
    backendReason: backend.reason,
    dryRun: config.current.settings.dryRun,
    accessibility,
    accessibilityHelp: ACCESSIBILITY_HELP,
    boundGestures: Object.keys(config.current.gestures),
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

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
    console.log(`  !! ${ACCESSIBILITY_HELP}`);
  } else if (accessibility.granted === null && accessibility.relevant) {
    console.log('  Could not determine Accessibility access. If gestures fire but');
    console.log(`  nothing happens: ${ACCESSIBILITY_HELP}`);
  }
  console.log('');

  config.watch();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    config.close();
    server.close(() => process.exit(0));
  });
}

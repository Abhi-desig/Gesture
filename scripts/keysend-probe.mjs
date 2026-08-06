// Bake-off: which way of sending Ctrl+Right actually moves the Space?
//
// Four-finger swipes are bound to ctrl+left / ctrl+right, and the reported
// symptom is that the keystroke lands inside the focused app ("the tab goes
// back") while the desktop never changes. That is the signature of a modifier
// that was set as a *flag* on the key event but never announced as a real
// flagsChanged event: applications read flags off the event and are satisfied,
// while macOS matches symbolic hotkeys against the WindowServer's global
// modifier state, which only flagsChanged updates.
//
// Rather than assume that, this probe sends the same chord four ways and reads
// the current Space out of com.apple.spaces before and after each one. Whichever
// method moves the desktop is the one the backend should use.
//
//   node scripts/keysend-probe.mjs
//
// Stop the server first — not because it interferes with the probe, but because
// a live camera page can fire its own gestures into the middle of a measurement.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

import { KEYSEND_SOURCES } from '../server/config.js';
import { readSpaceHotkeys } from '../server/macos.js';
import { BINARY as NATIVE_BINARY, build as buildNative } from './build-native.mjs';

const COUNTDOWN_SECONDS = 3;
// The Dock writes the new current Space to preferences asynchronously, so a
// single read right after the keystroke can miss a switch that did happen.
const SETTLE_TIMEOUT_MS = 2500;
const SETTLE_POLL_MS = 100;
// Long enough for Mission Control's switch animation to finish, so the next
// method starts from a settled desktop.
const BETWEEN_METHODS_MS = 1200;

const RIGHT_KEYCODE = 124;
const LEFT_KEYCODE = 123;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ spaces

/**
 * Current Space per display, read from the Dock's own preferences.
 *
 * `defaults export` rather than reading the plist directly: the file on disk is
 * owned by cfprefsd and can lag behind, or be a binary the process is still
 * buffering writes to.
 */
function readSpaces() {
  const exported = spawnSync('defaults', ['export', 'com.apple.spaces', '-'], { encoding: 'utf8' });
  if (exported.status !== 0) return null;

  const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: exported.stdout,
    encoding: 'utf8',
  });
  if (json.status !== 0) return null;

  try {
    const monitors = JSON.parse(json.stdout).SpacesDisplayConfiguration['Management Data'].Monitors;
    return monitors.map((m) => ({
      display: m['Display Identifier'],
      current: m['Current Space']?.ManagedSpaceID ?? null,
      spaces: (m.Spaces ?? []).map((s) => s.ManagedSpaceID),
    }));
  } catch {
    return null;
  }
}

const fingerprint = (spaces) => (spaces ?? []).map((m) => `${m.display}:${m.current}`).join(' ');

// --------------------------------------------------------- the real instrument
//
// com.apple.spaces is the *Dock's* cache. It is written when the Dock performs a
// switch and not otherwise, and it lags. Both properties make it the wrong thing
// to measure with, and measuring with it hid two distinct outcomes:
//
//   - a Space changed by any route that bypasses the Dock never shows up at all;
//   - a Space that changes and then reverts within the polling window reads as
//     "did not move", which is a very different finding from "moved and snapped
//     back" and points at a completely different cause.
//
// CGSGetActiveSpace is the WindowServer's own answer, and needs no permission.

/** @returns {{active: number, displays: object[]}|null} */
function windowServerState() {
  const result = spawnSync(NATIVE_BINARY, ['space', 'status'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const activeSpace = () => windowServerState()?.active ?? null;

/**
 * Sample the active Space densely for a while after a send.
 *
 * Returns whether it ever moved and whether it was still moved at the end,
 * because those are different results: "never moved" indicts the send, while
 * "moved then reverted" means the send worked and something pulled it back.
 */
/**
 * Wait until the Space stops changing on its own.
 *
 * Necessary because a switch can be undone up to ~1.7s later, and a fixed pause
 * shorter than that lets one method's revert land inside the next method's
 * measurement window. That produced a run where a method's "before" was a Space
 * no method had put it on.
 */
async function settle({ stableMs = 1200, timeoutMs = 6000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = activeSpace();
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await sleep(stepMs);
    const now = activeSpace();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return last;
    }
  }
  return activeSpace();
}

async function watchSpace(before, { forMs = 3000, stepMs = 100 } = {}) {
  const samples = [];
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    await sleep(stepMs);
    samples.push(activeSpace());
  }
  const moved = samples.some((s) => s !== null && s !== before);
  const held = samples.length > 0 && samples[samples.length - 1] !== before;
  return { moved, held, samples };
}

/** Poll until the current-Space fingerprint changes, or we run out of patience. */
async function waitForSpaceChange(before) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  const start = fingerprint(before);
  while (Date.now() < deadline) {
    const now = readSpaces();
    if (fingerprint(now) !== start) return now;
    await sleep(SETTLE_POLL_MS);
  }
  return readSpaces();
}

// ------------------------------------------------------------------ direction

/**
 * Which way there is actually room to move.
 *
 * Every method below is measured by whether the desktop moved, so a method that
 * works but is asked to move past the last Space reports as a failure. Ctrl+Right
 * on the rightmost Space is a no-op, and with several methods to try in sequence
 * you drift into that wall and everything after it reads as broken. So pick the
 * direction per attempt, from where we are at that moment.
 */
function chooseDirection(spaces) {
  const monitor = (spaces ?? []).find((m) => m.spaces.length > 1);
  if (!monitor) return 'right';
  const index = monitor.spaces.indexOf(monitor.current);
  if (index < 0) return 'right';
  return index >= monitor.spaces.length - 1 ? 'left' : 'right';
}

const keycodeFor = (direction) => (direction === 'left' ? LEFT_KEYCODE : RIGHT_KEYCODE);

/** Index of the current Space on the first display that has more than one. */
function positionOf(spaces) {
  const monitor = (spaces ?? []).find((m) => m.spaces.length > 1);
  if (!monitor) return null;
  const index = monitor.spaces.indexOf(monitor.current);
  return index < 0 ? null : index;
}

// ------------------------------------------------------------------ methods

/** A: what ships today. */
async function methodA(direction) {
  const { keyboard, Key } = await import('@nut-tree-fork/nut-js');
  keyboard.config.autoDelayMs = 0;
  await keyboard.type(Key.LeftControl, direction === 'left' ? Key.Left : Key.Right);
}

/** B: nut.js, but sequencing the modifier explicitly instead of as a flag. */
async function methodB(direction) {
  const { keyboard, Key } = await import('@nut-tree-fork/nut-js');
  const arrow = direction === 'left' ? Key.Left : Key.Right;
  keyboard.config.autoDelayMs = 0;
  try {
    await keyboard.pressKey(Key.LeftControl);
    await sleep(30);
    await keyboard.pressKey(arrow);
    await sleep(30);
    await keyboard.releaseKey(arrow);
    await sleep(30);
  } finally {
    // Always, even if the middle threw: a Control left stuck down turns every
    // subsequent keystroke on the machine into a control chord.
    await keyboard.releaseKey(Key.LeftControl).catch(() => {});
  }
}

/**
 * C: the Swift helper — a real flagsChanged pair around the key, at the HID tap.
 *
 * Run once per CGEventSource state table rather than once overall. The helper
 * emits the same event sequence either way; what changes is whose modifier state
 * the WindowServer is told about, and symbolic hotkeys match against the global
 * one. A private state table could satisfy the focused application and still be
 * invisible to Mission Control — the same shape of bug as libnut's flag bit, one
 * level up — so this is measured rather than reasoned about.
 */
function methodC(source, direction) {
  const result = spawnSync(
    NATIVE_BINARY,
    ['key', String(keycodeFor(direction)), 'ctrl', `--source=${source}`],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exited ${result.status}`);
}

/**
 * E: not a key press at all — the trackpad's dock-swipe gesture.
 *
 * Here because macOS appears to refuse Space navigation from *any* synthesized
 * key, which would make every row above unwinnable no matter how the chord is
 * built. This is the path Mac Mouse Fix and BetterTouchTool use: post the
 * gesture the Dock actually listens for. Velocity is swept because the Dock
 * completes the switch on a flick and rubber-bands back on a slow drag, and
 * where that threshold sits is not documented.
 */
function methodE(config, direction) {
  const args = [
    'swipe',
    direction,
    `--variant=${config.variant}`,
    `--velocity=${config.velocity}`,
    `--linger-ms=${config.linger}`,
  ];
  if (config.tap) args.push('--with-tap');

  const result = spawnSync(NATIVE_BINARY, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exited ${result.status}`);
}

/**
 * The gesture configurations worth measuring, most-likely first.
 *
 * `tap` and `linger` are here because the payload may never have been the
 * problem. Neither reference implementation posts a dock swipe from a
 * short-lived process: both hold a session event tap and run a run loop. A
 * one-shot that posts three phases and exits microseconds later is a different
 * thing from what either of them does, and that difference is untested.
 */
const SWIPE_CONFIGS = [
  { variant: 'iss', velocity: 400, tap: true, linger: 300 },
  { variant: 'iss', velocity: 400, tap: false, linger: 300 },
  { variant: 'mmf', velocity: 400, tap: true, linger: 300 },
  { variant: 'iss', velocity: 9999, tap: true, linger: 300 },
];

const describeConfig = (c) =>
  `--variant=${c.variant} --velocity=${c.velocity}` +
  `${c.tap ? ' --with-tap' : ''} --linger-ms=${c.linger}`;

/**
 * F: not an event at all — ask the WindowServer to change Space directly.
 *
 * Private CGS/SkyLight call, no injection involved, so it sidesteps the block on
 * synthesized Space navigation entirely. Its own problem is that macOS pulls the
 * Space back if focus stays behind, which is what the held/reverted distinction
 * above exists to show.
 */
function methodF(direction) {
  const result = spawnSync(NATIVE_BINARY, ['space', direction], { encoding: 'utf8' });
  if (result.error) throw result.error;
  // Exit 3 means the call was made and the WindowServer had not applied it yet,
  // which is expected — it applies asynchronously. Not a failure to report here.
  if (result.status !== 0 && result.status !== 3) {
    throw new Error(result.stderr.trim() || `exited ${result.status}`);
  }
}

/** D: the osascript fallback. Expected to fail; it establishes the baseline. */
function methodD(direction) {
  const result = spawnSync(
    'osascript',
    ['-e', `tell application "System Events" to key code ${keycodeFor(direction)} using control down`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exited ${result.status}`);
}

// ------------------------------------------------------------------ driver

function describe(spaces) {
  if (!spaces) return '(could not read com.apple.spaces)';
  return spaces
    .map((m) => {
      const index = m.spaces.indexOf(m.current);
      const position = index >= 0 ? ` [${index + 1} of ${m.spaces.length}]` : '';
      const name = m.display === 'Main' ? 'main display' : `display ${m.display.slice(0, 8)}`;
      return `${name}: space ${m.current}${position}`;
    })
    .join(', ');
}

async function attempt({ id, label, run }) {
  console.log(`\n─── ${id}. ${label}`);

  const state = windowServerState();
  const before = state?.active ?? null;
  const monitor = state?.displays?.find((d) => d.activeIndex !== null);
  const direction =
    monitor && monitor.activeIndex >= monitor.spaces.length - 1 ? 'left' : 'right';

  const position = monitor ? ` [${monitor.activeIndex + 1} of ${monitor.spaces.length}]` : '';
  console.log(`    before: space ${before}${position}`);
  console.log(`    sending ${direction}`);

  let error = null;
  try {
    await run(direction);
  } catch (err) {
    error = err.message;
  }

  if (error) {
    console.log(`    !!      the send itself failed: ${error}`);
    return { id, label, moved: false, held: false, error };
  }

  const { moved, held, samples } = await watchSpace(before);
  console.log(`    after:  space ${samples[samples.length - 1]}`);

  if (moved && held) {
    console.log('    ✓ the desktop MOVED and stayed');
  } else if (moved) {
    // The distinction the old instrument could not see. Worth calling out
    // loudly: it means the mechanism works and something is undoing it.
    const at = samples.findIndex((s) => s !== before);
    const back = samples.findIndex((s, i) => i > at && s === before);
    console.log(`    ~ the desktop MOVED, then reverted after ~${(back - at) * 100}ms`);
  } else {
    console.log('    ✗ the desktop did not move');
  }

  return { id, label, moved, held, error: null };
}

/**
 * Refuse to run without Accessibility.
 *
 * Without it macOS discards every synthetic key event *silently* — nothing
 * throws, nothing moves — so all four methods would report "did not move" and
 * the probe would confidently blame the code for a permission problem. The
 * grant belongs to the app responsible for this process, which is whichever
 * terminal, editor or agent launched it, not to node. So print that app's name:
 * running the probe from a different shell than the server is exactly how you
 * end up staring at four false negatives.
 */
async function requireAccessibility() {
  let status;
  try {
    const mod = await import('@nut-tree-fork/node-mac-permissions');
    status = (mod.default ?? mod).getAuthStatus('accessibility');
  } catch {
    console.log('(could not check Accessibility; continuing, but read the results sceptically)\n');
    return;
  }

  if (status === 'authorized') return;

  const responsible = spawnSync('sh', [
    '-c',
    // Walk up the process tree to the first thing living in an .app bundle:
    // that is the binary macOS attributes the Accessibility grant to.
    'p=$PPID; for i in 1 2 3 4 5 6 7 8; do ' +
      'c=$(ps -o comm= -p $p 2>/dev/null) || break; ' +
      'case "$c" in *.app/Contents/MacOS/*) echo "$c"; exit 0;; esac; ' +
      'p=$(ps -o ppid= -p $p 2>/dev/null | tr -d " ") || break; [ -z "$p" ] && break; done',
  ], { encoding: 'utf8' });

  const appPath = responsible.stdout.trim();
  const appName = appPath ? appPath.replace(/^.*\/([^/]+)\.app\/.*$/, '$1') : null;

  console.error(`Accessibility is "${status}" for this process, so macOS will discard every`);
  console.error('key this probe sends — silently. Every method would report "did not move"');
  console.error('and that would say nothing about how the key was sent.\n');
  if (appName) {
    console.error(`The grant belongs to the app running this probe: ${appName}`);
    console.error(`  ${appPath}\n`);
  }
  console.error('Either grant it in System Settings > Privacy & Security > Accessibility,');
  console.error('or re-run this probe from the same app you start the server from.\n');
  process.exit(1);
}

/**
 * Refuse to run only when the hotkeys are actually switched off.
 *
 * Deliberately does NOT treat a preferences entry with no stored key as broken.
 * That inference was made here once, from an entry reading exactly
 * `{"enabled": true}`, and it was wrong: macOS falls back to the built-in chord,
 * and the hardware keystroke switches Spaces perfectly well in that state.
 */
function requireSpaceHotkeys() {
  const hotkeys = readSpaceHotkeys();
  if (!hotkeys) return;

  const off = hotkeys.filter((h) => !h.enabled);
  if (off.length === 0) {
    console.log(`hotkeys: ${hotkeys.map((h) => `${h.label} = ${h.boundTo}`).join(', ')}\n`);
    return;
  }

  console.error('These Mission Control shortcuts are turned off, so nothing this probe');
  console.error('sends could move a Space and every row would read "did not move":\n');
  for (const h of off) console.error(`  ${h.label} (symbolic hotkey ${h.id})`);
  console.error('\nEnable them in System Settings > Keyboard > Keyboard Shortcuts >');
  console.error('Mission Control, then re-run this.\n');
  process.exit(1);
}

async function main() {
  console.log('\nkeysend probe — which way of pressing Ctrl+Right moves the Space?\n');

  await requireAccessibility();
  requireSpaceHotkeys();

  const initialState = windowServerState();
  if (!initialState) {
    console.error('Could not read the active Space from the WindowServer, so a Space');
    console.error('change cannot be detected. Run "npm run build:native" first.\n');
    process.exit(1);
  }

  const initial = initialState.active;
  const totalSpaces = initialState.displays.reduce((n, d) => n + d.spaces.length, 0);
  const startMonitor = initialState.displays.find((d) => d.activeIndex !== null);
  console.log(
    `starting position: space ${initial}` +
      (startMonitor ? ` [${startMonitor.activeIndex + 1} of ${startMonitor.spaces.length}]` : ''),
  );
  if (totalSpaces < 2) {
    console.error('\nThere is only one Space, so nothing can move between Spaces.');
    console.error('Add a desktop in Mission Control and run this again.\n');
    process.exit(1);
  }

  // The key-based rows are known to fail on macOS 26 and each costs several
  // seconds. Once that is established, --swipe-only skips straight to the
  // gesture variants so iterating on them is quick.
  const swipeOnly = process.argv.includes('--swipe-only');

  const methods = swipeOnly
    ? []
    : [
        { id: 'A', label: 'nut.js keyboard.type(LeftControl, Arrow) — the original', run: methodA },
        { id: 'B', label: 'nut.js pressKey/releaseKey, modifier sequenced explicitly', run: methodB },
      ];

  // C only exists if the helper builds. A missing Swift toolchain is a reason to
  // skip the row, not to abandon the probe.
  let nativeReady = false;
  try {
    if (!fs.existsSync(NATIVE_BINARY)) buildNative({ log: (m) => console.log(`(${m})`) });
    nativeReady = true;
  } catch (err) {
    console.log(`\n(skipping C: could not build the Swift helper — ${err.message})`);
  }
  if (nativeReady && !swipeOnly) {
    for (const source of KEYSEND_SOURCES) {
      methods.push({
        id: `C-${source}`,
        source,
        label: `Swift helper, flagsChanged at the HID tap, --source=${source}`,
        run: (direction) => methodC(source, direction),
      });
    }
  }
  if (!swipeOnly) {
    methods.push({ id: 'D', label: 'osascript "key code … using control down" — baseline', run: methodD });
  }

  // Last, and deliberately so: if one of these is the only thing that moves the
  // desktop, the conclusion is that this is not a key-sending problem at all.
  if (nativeReady) {
    methods.push({
      id: 'F',
      direct: true,
      label: 'direct WindowServer call (CGSManagedDisplaySetCurrentSpace)',
      run: methodF,
    });
  }

  if (nativeReady) {
    for (const [i, config] of SWIPE_CONFIGS.entries()) {
      methods.push({
        id: `E${i + 1}`,
        dockSwipe: config,
        label: `dock-swipe gesture (not a key), ${describeConfig(config)}`,
        run: (direction) => methodE(config, direction),
      });
    }
  }

  console.log(`\nSending in ${COUNTDOWN_SECONDS}s. Do not touch the keyboard until this finishes.`);
  for (let n = COUNTDOWN_SECONDS; n > 0; n -= 1) {
    process.stdout.write(`  ${n}… `);
    await sleep(1000);
  }
  console.log('');

  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const selected = only
    ? methods.filter((m) => only.split(',').some((id) => m.id === id.trim()))
    : methods;

  if (only && selected.length === 0) {
    console.error(`\n--only=${only} matched nothing. Available: ${methods.map((m) => m.id).join(', ')}\n`);
    process.exit(1);
  }

  const results = [];
  for (const method of selected) {
    results.push(await attempt(method));
    // Settle rather than sleep a fixed amount: a revert from this method must
    // not land inside the next one's measurement.
    await settle();
  }

  // ---------------------------------------------------------------- verdict

  console.log('\n─── verdict\n');
  for (const r of results) {
    const mark = r.error ? 'ERROR' : r.moved && r.held ? 'WORKS' : r.moved ? 'REVERT' : 'no';
    console.log(`  ${r.id}  ${mark.padEnd(6)} ${r.label}`);
  }

  // "Moved and held" is the only real win. Anything that moved and snapped back
  // is a separate finding, and conflating the two is what the old instrument did.
  const winners = results.filter((r) => r.moved && r.held);
  const reverted = results.filter((r) => r.moved && !r.held);
  const winningSources = winners.filter((r) => r.source).map((r) => r.source);
  const winningSwipes = winners.filter((r) => r.dockSwipe).map((r) => r.dockSwipe);
  const bestSwipe = winningSwipes[0];
  console.log('');

  if (reverted.length > 0) {
    console.log('  These moved the desktop and then it snapped back:');
    for (const r of reverted) console.log(`    ${r.id}  ${r.label}`);
    console.log('');
    console.log('  That is a working switch being undone, not a failed send. macOS pulls');
    console.log('  the Space back when keyboard focus stays with an app on the Space you');
    console.log('  left, so the fix is about focus, not about how the switch is made.');
    console.log('');
  }

  // Checked before the key-based verdicts: a gesture winning where every key
  // lost is a different finding, not a better variant of the same one.
  if (winningSwipes.length > 0 && winningSources.length === 0) {
    console.log('  Only the dock-swipe gesture moved the desktop. Every way of sending the');
    console.log('  KEY failed — including osascript, which is the OS pressing its own key.');
    console.log('');
    console.log('  So macOS is refusing Space navigation from synthesized keystrokes, and no');
    console.log('  amount of reshaping the chord will change that. Switching Spaces has to');
    console.log('  stop going through the keyboard and post the trackpad gesture instead,');
    console.log('  which is what Mac Mouse Fix and BetterTouchTool do.');
    console.log('');
    console.log(`  Use: ${describeConfig(bestSwipe)}`);
    if (bestSwipe.tap || bestSwipe.linger > 0) {
      console.log('');
      console.log('  Note what that includes. If --with-tap or --linger-ms was needed, a');
      console.log('  fire-and-exit helper cannot do this: the server has to keep a long-lived');
      console.log('  process holding the tap, not spawn one per gesture.');
    }
    console.log('');
    console.log('  Caveat worth keeping in view: the gesture path uses undocumented CGEvent');
    console.log('  fields. They are stable in practice but they are not API, and Apple moved');
    console.log('  the payload layout in the macOS 27 betas.');
  } else if (winners.length === 0) {
    // The two usual explanations were already ruled out above: this only runs
    // with Accessibility granted and with a key actually bound to the hotkeys.
    console.log('  Nothing moved the Space — including osascript, which is the OS pressing');
    console.log('  its own key. Seven different ways of sending it failed identically, so');
    console.log('  this is not about how the key is synthesized.');
    console.log('');
    console.log('  Accessibility and the hotkey bindings were both checked before sending,');
    console.log('  so look further out: press ctrl+left on your own keyboard and see whether');
    console.log('  that moves the desktop. If it does not, nothing in this repo can help and');
    console.log('  the problem is in System Settings. If it does, re-run this with the');
    console.log('  frontmost window changed — a full-screen app can swallow the chord.');
  } else if (winningSources.length > 0) {
    // Preference order, not just "the first that worked": hid emulates real
    // hardware most closely, and private is last because it is the one whose
    // isolation could stop being harmless on a future macOS.
    const pick =
      ['hid', 'combined', 'null', 'private'].find((s) => winningSources.includes(s)) ??
      winningSources[0];
    console.log(`  The Swift helper moves the Space with --source=${winningSources.join(', ')}.`);
    console.log('  The flagsChanged theory holds: libnut cannot emit one, so the cgevent');
    console.log('  backend is the fix.');
    console.log('');
    console.log(`  Pin it in config.json:   "keysendSource": "${pick}"`);
    if (!winningSources.includes('private')) {
      console.log('');
      console.log('  Note that --source=private did NOT work. That was the shipped default');
      console.log('  before this run, and it is the same class of bug as libnut\'s: a modifier');
      console.log('  announced only where the WindowServer is not listening.');
    }
    if (winners.some((r) => r.id === 'B')) {
      console.log('');
      console.log('  B also worked, which contradicts the static analysis of libnut. Read the');
      console.log('  rows above before dropping the native helper — B is the cheaper fix if real.');
    }
  } else if (winners.some((r) => r.id === 'B')) {
    console.log('  B works, so the fix is pure JavaScript: sequence the modifier explicitly in');
    console.log('  server/backends/nutjs.js. No Swift, no new toolchain dependency.');
  } else {
    console.log(`  Unexpected: ${winners.map((r) => r.id).join(', ')} moved the Space, but none`);
    console.log('  of the Swift helper variants did. Read the rows above before changing code.');
  }

  // Walk back to where we started, so the probe leaves the desktop as it found it.
  const winningSource = winningSources[0];
  const send = winningSource
    ? (direction) => methodC(winningSource, direction)
    : bestSwipe
      ? (direction) => methodE(bestSwipe, direction)
      : winners.some((r) => r.id === 'B')
        ? (direction) => methodB(direction)
        : null;

  if (send && activeSpace() !== initial) {
    console.log('\n  (returning to the Space you started on)');
    const target = startMonitor?.spaces.indexOf(initial) ?? null;

    // Step toward the original index rather than walking blindly in one
    // direction: the methods above may have moved either way, and a blind walk
    // can leave you further from where you started than when it began.
    for (let i = 0; i < 8; i += 1) {
      const here = windowServerState();
      if (!here || here.active === initial) break;
      const at = here.displays.find((d) => d.activeIndex !== null)?.activeIndex ?? null;
      if (at === null || target === null || at === target) break;
      await send(at > target ? 'left' : 'right');
      await sleep(700);
    }

    if (activeSpace() !== initial) {
      console.log(`  (could not get back — you are on space ${activeSpace()})`);
    }
  }

  // Write the outcome to disk as well as printing it. Reading a verdict off a
  // terminal and retyping it is a step that can go wrong, and this file is
  // something the config can be set from directly.
  const resultPath = new URL('../probe-result.json', import.meta.url);
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        macos: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(),
        winner: bestSwipe ?? null,
        configJson: bestSwipe
          ? {
              dockSwipeVariant: bestSwipe.variant,
              dockSwipeVelocity: bestSwipe.velocity,
              dockSwipeWithTap: bestSwipe.tap,
              dockSwipeLingerMs: bestSwipe.linger,
            }
          : null,
        directWindowServer: results.find((r) => r.id === 'F')
          ? { moved: results.find((r) => r.id === 'F').moved, held: results.find((r) => r.id === 'F').held }
          : null,
        results: results.map((r) => ({
          id: r.id,
          moved: r.moved,
          held: r.held ?? false,
          error: r.error,
          label: r.label,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log('  (written to probe-result.json)');

  console.log('');
}

await main();

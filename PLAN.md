# Fix desktop switching, first-gesture misses, and drift-over-time

## Context

Four-finger swipes are meant to move between macOS Spaces (`swipe_left → ctrl+right`,
`swipe_right → ctrl+left`). Instead the keystroke lands *inside Chrome* — "sometimes it does
not work, sometimes the tab goes back" — and the desktop never changes. On top of that the
first gesture of a run is usually swallowed, and after a while gestures stop having any
effect at all.

I ran live diagnostics against the running server before planning. **The environment is not
the problem** — every setting people normally blame is already correct:

| Checked | Result |
| --- | --- |
| Live backend (`GET /health`) | `nutjs` — the native CGEvent backend, not the osascript fallback |
| Accessibility | `granted: true`, `status: "authorized"` |
| Owning app (process ancestry of pid 19570) | `node` ← `npm start` ← `zsh` ← **Visual Studio Code.app** |
| Mission Control "Move left/right a space" (symbolic hotkeys 79/81) | both `enabled = true` |
| Spaces available | 5 on the main display, 3 on the second |
| `dryRun` | `false` |
| libnut event tap | posts at `kCGHIDEventTap` (`CGEventPost` first arg `= 0` at every call site — verified by disassembly) |

So the shortcut, the permission, the OS settings and the tap location are all fine. The
defects are in the code.

---

## Root causes

### 1. The Ctrl+Arrow never reaches Mission Control — it reaches Chrome

[nutjs.js:91](server/backends/nutjs.js:91) calls `keyboard.type(Key.LeftControl, Key.Right)`,
which resolves through `node_modules/@nut-tree-fork/libnut/dist/lib/libnut-keyboard.class.js`
to `libnut.keyTap("right", ["control"])`. libnut sets the Control bit with `CGEventSetFlags`
on the arrow-key event, but never emits a `kCGEventFlagsChanged` event for Control itself.

That split is exactly what the symptom describes:

- **Applications** read flags straight off the event, so Chrome sees a genuine `Ctrl+→` and
  acts on it — hence "the tab goes back".
- **Mission Control** does not. macOS matches symbolic hotkeys against the WindowServer's
  *global* modifier state, which is only updated by `flagsChanged`. It never sees Control go
  down, so the Space-switch hotkey never matches.

Fix: emit the modifier as a real `flagsChanged` pair around the key event, posted at the HID
tap. **Per your choice, prove it with a bake-off before building anything** (Phase 0).

### 2. The first swipe of every run is systematically rejected

[swipe.js:128](public/swipe.js:128):

```js
if (this.poseHeldSince === null || this.poseHeldSince > a.t) return null;
```

Samples are pushed on **every** hand-present frame ([swipe.js:72](public/swipe.js:72)), not
only four-finger frames. `a` is the oldest sample in the 350 ms window, so until every
pre-pose sample has aged out, `a.t < poseHeldSince` and the swipe cannot be evaluated at all.

In practice you must hold four fingers still for a full ~350 ms *before* moving. Raise-and-swipe
in one motion always fails; you then naturally settle and retry, and the second attempt works.
That is the "first action not working" report, and it is also part of "sometimes it does not
work".

### 3. Pinch disarms the app

[config.json:4](config.json:4) binds `pinch → escape`. [app.js:654](public/app.js:654) makes
Escape a one-way panic disarm:

```js
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.armed) setArmed(false);
});
```

When the gesture page is frontmost — the normal case, you're watching the readout — a pinch
sends a system-wide Escape that lands on the page and silently sets `armed = false`. Every
gesture is dropped from then on until you click **Arm** again. This is the single best match
for "after some time the actions are not working effectively". The comment above that handler
is reasoning about precisely this hazard for `space`, and the current binding walks into it.

### 4. Secondary degradation contributors

- **Non-monotonic cooldown clock.** [index.js:108](server/index.js:108) uses `Date.now()` for
  `lastFired`. An NTP step or sleep/wake can move wall clock backwards, making `waited`
  negative and wedging every gesture into a permanent HTTP 429 `cooldown`.
- **No recovery from a stalled camera.** There is no `track.onended`/`onmute` handler anywhere
  in `public/`. If the track mutes, the worker blocks forever on `await reader.read()`
  ([detector-worker.js:56](public/detector-worker.js:56)) and the UI reads "stalled" with
  nothing to restore it. Note `open_palm → cmd+ctrl+q` **locks the screen**, which mutes the
  camera — the default binding can permanently kill detection.
- **Worker/track leak on a failed start.** [app.js:585](public/app.js:585) stops only
  `stream.getTracks()`; the clone in `state.detectorTracks` and `state.worker` survive. Each
  retry accumulates another live Worker holding a MediaPipe instance and the 7.8 MB model.
- **Disarmed gestures burn the fire slot.** [recognizer.js:146-147](public/recognizer.js:146)
  records `lastFired` and `run.fired` before [app.js:218](public/app.js:218) checks `armed`.
  Any pose made between "Start camera" and "Arm" eats that pose's 1200 ms cooldown *and*
  requires a full pose break before it can fire again.
- **`backend.supports()` is dead code.** `resolveBackend`
  ([backends/index.js:28](server/backends/index.js:28)) never calls it, despite
  [osascript.js:8](server/backends/osascript.js:8) claiming it exists so the resolver can
  prefer nut.js. If nut.js ever fails to load, `auto` silently picks osascript — which cannot
  send `audio_play` (your `fist` binding) and cannot switch Spaces at all.

---

## Your two direct questions

**Which app gets Accessibility?** **Visual Studio Code** — verified from the running server's
process ancestry, and it is already `authorized`. Chrome does **not** need Accessibility; it
only needs Camera. If you ever start the server from a different terminal, that app needs the
grant instead — Claude.app, for example, currently reads `denied`. Phase 1 adds a startup line
that prints the responsible app by name so this is never a guess again.

**Data protection.** Audited clean: no telemetry, no analytics, no API keys, no `.env`, no
secrets. Camera frames never leave the browser; the only thing crossing to the server is
`{"gesture":"<name>"}` on `127.0.0.1`. The server binds loopback only, `sameOriginOnly`
blocks drive-by cross-origin POSTs, and the wire protocol carries gesture *names* rather than
key combos, so a hostile page can at worst trigger something you already bound.

One real exposure, worth closing: `public/models/` does not exist on this machine, so every
cold start pulls the MediaPipe WASM runtime and the 7.8 MB model from jsdelivr and
`storage.googleapis.com` — and [detector-worker.js:105](public/detector-worker.js:105) runs
`importScripts()` on that CDN bundle *inside the worker that holds raw camera `VideoFrame`s*.
`importScripts` cannot carry SRI. `npm run fetch-model` only vendors the model, not the
runtime, so the README's offline claim ([README.md:308](README.md:308)) is not currently true.
Phase 4 fixes this.

---

## Phase 0 — Prove the key-send mechanism (do this first)

New `scripts/keysend-probe.mjs`, run with the server stopped. Counts down, then sends
`ctrl+right` four ways with a pause between each, reporting the current Space
(`ManagedSpaceID` from `com.apple.spaces`) before and after each attempt:

| # | Method |
| --- | --- |
| A | `keyboard.type(Key.LeftControl, Key.Right)` — what ships today (control) |
| B | `pressKey(LeftControl)` → `pressKey(Right)` → `releaseKey(Right)` → `releaseKey(LeftControl)`, ~30 ms apart |
| C | Swift helper: `flagsChanged` down → keyDown → keyUp → `flagsChanged` up, all at `.cghidEventTap` |
| D | `osascript` `key code 124 using control down` — expected to fail; establishes the baseline |

The probe also prints a plain-language verdict so we don't have to interpret raw IDs.

**Decision rule:** if **B** switches Spaces, Phase 1 is a pure-JS change and no toolchain
dependency is added. If only **C** works, we ship the Swift helper. `swiftc` 6.3.3 is already
present at `/usr/bin/swiftc`, so building is free — but a spawned helper's Accessibility grant
is attributed to the responsible parent (VS Code), which is an assumption the probe verifies
rather than one we design around.

## Phase 1 — Make Space switching work

Depending on Phase 0:

- **If B wins** — rewrite `press()` in [nutjs.js](server/backends/nutjs.js) to sequence the
  modifiers explicitly with a small inter-event delay, in a `try/finally` that always releases
  held modifiers. The existing comment about `pressKey(LeftControl, Right)` throwing "Invalid
  key flag specified" refers to passing both keys in one call; pressing them individually is a
  different path.
- **If C wins** — add `native/keysend.swift` (~60 lines) plus `scripts/build-native.mjs`
  wrapping `/usr/bin/swiftc -O`, and a new `server/backends/cgevent.js` that shells out to it.
  Register it ahead of `nutjs` in `CANDIDATES` ([backends/index.js:6](server/backends/index.js:6)),
  and have its `create()` throw when the binary is missing so `auto` degrades to nut.js
  cleanly. Build is opt-in via `npm run build:native`, never a `postinstall`.

Also in this phase, independent of the outcome:

- Make `resolveBackend` actually consult `supports()` against the configured bindings, so a
  backend that cannot send `audio_play` is skipped rather than 500-ing per press.
- Add a startup preflight that reads symbolic hotkeys 79/81 and the Space count and warns when
  Space switching cannot possibly work, alongside a line naming the responsible app for the
  Accessibility grant.

## Phase 2 — Fix the first-swipe rejection

In `#evaluate()` ([swipe.js:117](public/swipe.js:117)), stop discarding the whole window and
instead evaluate the in-pose slice:

```js
if (this.poseHeldSince === null) return null;
const win = this.samples.filter((s) => s.t >= this.poseHeldSince);
if (win.length < 3) return null;
const a = win[0];
const b = win[win.length - 1];
```

…then apply the existing span, travel, vertical-ratio and velocity checks to `win`. This
preserves the stated invariant — travel from before the fingers came up still cannot count —
while letting a swipe register as soon as ~175 ms of in-pose motion exists. Leave `#velocity()`
reading the full sample window; it gates the static poses and needs the wider view.

## Phase 3 — Stop the drift

- **Rebind `pinch`** off `escape` in [config.json](config.json). Proposal: `ctrl+up`
  (Mission Control) — useful, harmless, and it exercises the same symbolic-hotkey path we just
  fixed. Easy to change.
- **Harden the panic key** so this cannot recur: reject a binding at config-load time when it
  collides with the page's panic chord, and ignore an Escape that arrives within ~250 ms of a
  fire the page itself initiated.
- **Monotonic cooldowns** — swap `Date.now()` for `performance.now()` at
  [index.js:108](server/index.js:108) (and the `lastFired` values it feeds).
- **Camera watchdog** — listen for `ended`/`mute`/`unmute` on the source and cloned tracks, and
  add a supervisor that attempts one restart when `cameraOn && mode === 'worker'` and no frame
  has arrived for ~3 s. Log every transition; never loop. This is what makes an `open_palm`
  screen-lock survivable.
- **Plug the start-failure leak** — extract a `teardownDetection()` (stop `state.detectorTracks`,
  terminate and null `state.worker`) and call it from the `catch` at
  [app.js:584](public/app.js:584) as well as from `stopCamera()`.
- **Don't burn the fire slot while disarmed** — thread a `canFire` flag into
  `Recognizer.update()` so `#advanceRun` skips the `lastFired.set` / `run.fired = true`
  bookkeeping when the page is disarmed, while still driving the live readout.

## Phase 4 — Close the CDN exposure

Extend [scripts/fetch-model.js](scripts/fetch-model.js) into a vendoring script that also
fetches `vision_bundle.js`, `vision_bundle.mjs` and the wasm assets into `public/vendor/`, and
have [app.js:9-18](public/app.js:9) prefer local paths with the CDN as an explicit fallback.
Update `.gitignore` and correct the offline claim at [README.md:308](README.md:308). This stops
third-party code from executing in the worker that holds raw camera frames.

Also refresh the stale docs found along the way: [README.md:64](README.md:64) and
[README.md:145](README.md:145) still document `pinch → cmd+shift+a`; the comment at
[app.js:652](public/app.js:652) still says `fist` is bound to space.

## Phase 5 — Tests

Extend the existing `node:test` suites, which already run without a camera via
[test/hand-fixture.js](test/hand-fixture.js):

- `test/swipe.test.js` — a swipe that begins immediately after the pose starts, with older
  out-of-pose samples still buffered, now fires; pre-pose travel still does not count. The
  existing 16 tests must stay green.
- `test/recognizer.test.js` — a pose recognized while `canFire` is false leaves no cooldown
  residue, and the next armed attempt fires.
- `test/shortcut.test.js` — fix the case at
  [shortcut.test.js:50](test/shortcut.test.js:50) that claims to cover "the shipped default
  bindings" but asserts against bindings that no longer exist; point it at `config.json`.
- New: config validation rejects a binding that collides with the panic chord.

---

## Verification

1. `npm test` — all suites green.
2. `node scripts/keysend-probe.mjs` with the server stopped — records which method moves the
   Space. This is the gate for Phase 1.
3. Restart the server and check `curl -s http://127.0.0.1:4321/health | python3 -m json.tool`
   — expect the chosen backend, `accessibility.granted: true`, and the new preflight lines in
   the console.
4. End-to-end in Chrome at `http://127.0.0.1:4321`: Start camera → Arm → raise four fingers and
   swipe **in one motion**. The desktop should change on the *first* attempt, and nothing
   should happen inside the tab.
5. Pinch, then confirm the page's arm state is still **Armed** and the log shows no `disarmed`
   entry.
6. Soak: leave it armed and idle for ~10 minutes, then gesture again — should still fire.
7. Recovery: trigger `open_palm` (or lock the screen manually), unlock, and confirm detection
   resumes on its own, with the recovery logged.
8. Offline check: after vendoring, load the page with DevTools → Network filtered to
   third-party origins — expect zero requests off `127.0.0.1`.

## Files touched

- `server/backends/nutjs.js`, `server/backends/index.js`, and (only if Phase 0 says so)
  new `server/backends/cgevent.js` + `native/keysend.swift` + `scripts/build-native.mjs`
- `server/index.js` — monotonic cooldowns, startup preflight, responsible-app line
- `server/config.js` — panic-chord collision validation
- `public/swipe.js` — in-pose window slice
- `public/recognizer.js` — `canFire` threading
- `public/app.js` — teardown helper, camera watchdog, panic-key guard, local vendor paths
- `config.json` — `pinch` rebind
- `scripts/keysend-probe.mjs` (new), `scripts/fetch-model.js` (extended)
- `test/swipe.test.js`, `test/recognizer.test.js`, `test/shortcut.test.js`
- `README.md`

## Deliberately not doing

`open_palm` stays on `cmd+ctrl+q` (screen lock), per your "keep all gestures" choice. It is a
sharp default — a misfire locks your Mac, and the resulting camera mute is what the Phase 3
watchdog exists to survive. Say the word and I'll move it.

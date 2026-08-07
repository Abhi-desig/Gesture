# Architecture

How the whole thing fits together, for someone who has just cloned it.

[`README.md`](README.md) is the user-facing guide — what the gestures are, how to
tune them, how to fix a permission. This document is the developer-facing one:
what each piece is, why it exists, and what happens between raising your hand and
a key being pressed.

Every claim here about macOS behaviour was measured on macOS 26.4. Where
something is unverified it says so.

---

## 1. The shape of it

Three processes, and it matters that they are three:

```
┌──────────────────────┐   spawns    ┌────────────────────────┐
│  Gesture.app (Rust)  │────────────►│  Node server (Express) │
│  menu bar, no window │             │  127.0.0.1:4321        │
└──────────┬───────────┘             └───────────┬────────────┘
           │ opens                    serves page │ ▲ POST /gesture
           ▼                                      ▼ │
┌────────────────────────────────────────────────────┴───────┐
│  Chrome — the page: camera, MediaPipe, gesture recognition │
└────────────────────────────────────────────────────────────┘
```

- **The page** decides *what gesture you made*. It never knows what key that means.
- **The server** decides *what that gesture does* and presses the key.
- **The app** owns none of that. It starts the server, sits in the menu bar,
  starts at login, and opens the page in Chrome.

The wire between page and server carries **gesture names only** — `{"gesture":
"fist"}` — never key combos. The mapping is resolved server-side from
`config.json`. That is a security boundary, not a style choice: the server can
press any key on the machine, so the worst a compromised page can do is trigger
something you already bound.

### Why the UI is in Chrome and not in the app

This is the least obvious decision in the project, and it was forced by a
measurement rather than a preference. The page reports its own capabilities at
load (`POST /client`, visible in `GET /recent`):

| Engine | `MediaStreamTrackProcessor` | Detection path | Works while hidden |
| --- | --- | --- | --- |
| Chrome | yes | Worker fed by `MediaStreamTrackProcessor` | **yes** |
| Tauri's WKWebView | **no** | `requestVideoFrameCallback`, main thread | no |

WebKit freezes `requestVideoFrameCallback` for any non-visible page. So inside a
webview the app can only detect while a window is on screen; Chrome keeps
detecting with the window minimised. `backgroundThrottling: "disabled"` does not
close the gap — it keeps the main thread scheduled (heartbeats keep arriving) but
does not restore frame delivery (`msSinceFrame` grows without bound).

Rendering the UI natively would mean reimplementing camera capture and hand
inference in Rust to reach a place Chrome already occupies. The menu bar,
start-at-login and process supervision are worth having natively. The webview was
not.

---

## 2. Technology stack

| Layer | Choice | Why this one |
| --- | --- | --- |
| Hand tracking | MediaPipe Tasks Vision (`HandLandmarker`) | 21 landmarks per hand, WASM + GPU, runs in a Worker |
| Page | Vanilla ES modules, no framework | The whole UI is one readout and five rows; a framework would be more code than the app |
| Server | Node 22+, Express 5 | Already the ecosystem the page lives in |
| Key injection | Swift helper (`native/keysend.swift`) via CGEvent | See §8 — nothing in npm can do what this needs |
| Fallbacks | nut.js, osascript | Degradation when the helper is not built |
| Desktop shell | Tauri 2 (Rust) | Menu bar + LaunchAgent + process supervision, ~300 lines |
| Tests | `node:test` | No dependency, and the logic worth testing is pure |

---

## 3. Project structure

```
public/                 the page — runs in Chrome
  index.html            markup: video stage, readout, bindings table, log
  app.js                I/O only: camera, worker, canvas, fetch. No decisions.
  recognizer.js         pose runs, hold times, cooldowns  ← the decisions
  gestures.js           landmarks -> pose name (pinch / open_palm / fist)
  swipe.js              landmarks over time -> swipe_left / swipe_right
  landmarks.js          geometry helpers: distances, palm centre, extension
  detector-worker.js    MediaPipe in a Worker, so hiding the page cannot stall it
  vendor/, models/      vendored MediaPipe runtime and the 7.8 MB model

server/                 the local server
  index.js              routes, cooldown, Space verification, preflight
  config.js             load, validate, hot-reload config.json
  shortcut.js           "cmd+shift+m" -> { modifiers, key }
  permissions.js        Accessibility status, and who owes the grant
  macos.js              read-only OS queries: Spaces, hotkeys, responsible app
  backends/
    index.js            picks a backend that can express your bindings
    cgevent.js          the Swift helper — the one that works
    nutjs.js            prebuilt fallback; cannot switch Spaces
    osascript.js        last resort; no media keys

native/keysend.swift    key chords, media keys, dock swipes, direct Space calls
src-tauri/              the menu-bar host (Rust)
scripts/                build the helper, vendor the model, probe key-sending
test/                   82 tests, no camera required
```

---

## 4. The page

### Module boundaries

`app.js` is deliberately dumb. It drives the camera, paints the overlay, and
talks to the server — every *decision* lives in `recognizer.js`, which is pure
and unit-tested. If you find yourself adding an `if` about gestures to `app.js`,
it probably belongs in the recogniser.

```
landmarks.js   geometry primitives
gestures.js    classifyPose(pts)      -> 'pinch' | 'open_palm' | 'fist' | null
swipe.js       SwipeTracker.update()  -> 'swipe_left' | 'swipe_right' | null
recognizer.js  Recognizer.update()    -> a view: gesture, pose, held, velocity…
app.js         wires the above to the camera, canvas and server
```

### Two detection modes

`app.js` picks one at camera start:

- **worker** (Chrome): the camera track is cloned into a
  `MediaStreamTrackProcessor`, whose `readable` is transferred into the Worker.
  MediaPipe runs there. Browsers do not throttle workers, so **detection survives
  the window being hidden or minimised** — the whole point.
- **page** (no `MediaStreamTrackProcessor`): a `requestVideoFrameCallback` loop
  on the main thread. Works, but stops the moment the page is not visible.

The mode is on the readout, and in every heartbeat, because "it stopped working
when I switched apps" is otherwise indistinguishable from a broken detector.

### Worker protocol

Main thread → worker:

| Message | Payload |
| --- | --- |
| `start` | `readable` (transferred), `bundleUrl`, `wasmUrl`, `modelUrl` |
| `stop` | — |

Worker → main thread:

| Message | Meaning |
| --- | --- |
| `ready` | MediaPipe loaded and the landmarker exists |
| `landmarks` | `landmarks`, `width`, `height` — one frame |
| `error` | `message`, `fatal`. Fatal stops the camera; non-fatal is rate-limited into the log |
| `stopped` | the loop exited |

A deliberate subtlety: **timestamps are taken on the main thread**, not accepted
from the worker. A Worker has its own `performance.timeOrigin`, so its
`performance.now()` is a different clock; mixing the two made staleness detection
read "stalled" forever.

### Recognition

`Recognizer.update(pts, now, canFire)` runs per frame and returns a view object
driving both the readout and the firing.

Order matters:

1. **No hand** → clear the run, report `handPresent: false`.
2. **Swipe?** — checked *before* poses. A swipe suppresses static poses until the
   hand leaves the four-finger shape.
3. **Stillness gate** — above `stillnessMaxVelocity` the hand is a swipe
   candidate, not a held pose.
4. **Pose run** — a pose must persist `MIN_FRAMES` *and* its `holdMs`, must not
   be a repeat within `cooldownMs`, and (with `requireReleaseBetweenFires`) must
   have been released since it last fired.

Why the open palm and the swipe fight: **the swipe pose is a subset of the
open-palm pose.** There is no hand shape that is one and not the other, so all
three phases of a swipe collide with `open_palm`. Three guards keep them apart —
a long deliberate `holdMs` for `open_palm`, the stillness gate during the sweep,
and pose suppression after it. Remove any one and a swipe locks your screen.

`canFire` is asked **per pose**:

```js
recognizer.update(pts, now, (pose) => state.armed || isClientGesture(pose));
```

While disarmed the gesture is still *reported* (the readout must show what it
sees) but not *recorded* — recording would burn its cooldown and, with
`requireReleaseBetweenFires`, demand a full pose break, so the first real gesture
after arming would be silently dropped. The exception is a pose bound to a client
action, which must act while disarmed and therefore must take the cooldown.

---

## 5. Bindings, and the two kinds

`config.json` maps a gesture name to one of three things:

```json
{
  "fist":        "audio_play",    // a key the server presses
  "swipe_left":  "space_right",   // a server-side action
  "pinch":       "toggle_armed"   // a client-side action
}
```

**Key chords** (`cmd+ctrl+q`, `f11`, `audio_play`) are parsed by
`server/shortcut.js` into `{ modifiers, key }` and pressed by a backend.

**Server actions** (`space_left`, `space_right`) name an *intent* rather than a
keystroke, because on macOS 26 no synthesized `ctrl+arrow` can switch Spaces
(§8). The backend chooses the mechanism.

**Client actions** (`toggle_armed`) are performed by the page and never reach a
backend. Arming is page state, so a gesture that toggles it has to be handled
where that state lives — and it has to work while disarmed, which is exactly when
the page sends the server nothing at all. The list travels to the page in
`GET /config` as `clientActions`, so it cannot drift from the validator.

Two consequences worth knowing, both of which were bugs first:

- `unsupportedBindings()` must skip client bindings. They have no parsed
  shortcut, so testing them made every backend look incapable and dropped the
  whole app to dry-run.
- `POST /gesture` with a client action answers **400** explaining the page owns
  it, rather than failing deeper down on an unparseable shortcut.

Parsing happens at config **load** time, so a typo surfaces immediately with the
gesture name attached rather than doing nothing the first time you make that
gesture. Reloads are atomic: if anything in the new file is invalid the whole
reload is rejected and the previous good config stays live.

One binding is rejected outright: a bare `escape`. It is the page's panic disarm,
and the page is normally frontmost, so binding it would make the first firing
disarm everything after it — with nothing logged anywhere.

---

## 6. The server

| Route | Purpose |
| --- | --- |
| `POST /gesture` | The only route that presses keys |
| `GET /config` | Bindings, tunables, `clientActions`, `knownGestures` |
| `GET /health` | Backend, permission status, strategies |
| `POST /heartbeat` | Page liveness: fps, mode, visibility, `msSinceFrame` |
| `POST /client` | Engine capabilities, once at load |
| `GET /recent` | The last 200 diagnostic events |
| `GET /*` | Static files from `public/` |

### Security

The server binds **loopback only** — `0.0.0.0` would let anything on the network
press keys on this machine. Beyond that, `sameOriginOnly` applies two checks to
every mutating route:

- **Origin** must be loopback when present. Browsers always attach `Origin` to
  POST, so a malicious page cannot pass this. A *missing* Origin is allowed:
  that means a non-browser caller, and anything running locally already has more
  direct ways to press keys than this endpoint.
- **Content-Type** must be `application/json`, which HTML forms cannot send
  cross-origin without a preflight that is never answered.

Verified: cross-origin → 403, wrong content type → 415, body over 4 kB → 413,
unbound gesture → 404, malformed body → 400.

### Cooldown

Server-side and authoritative — the page debounces too, but that is for
responsiveness. This is the guard that holds if a page is duplicated or reloaded
mid-gesture. It uses `performance.now()`, never `Date.now()`: wall clock can step
backwards on an NTP correction or a sleep/wake, which makes the elapsed time
negative and wedges the gesture into a permanent 429.

The slot is claimed *before* awaiting the press, so two requests in the same tick
cannot both get through, and released again if the press throws.

### The diagnostic ring

`GET /recent` exists because "works in view, dead in the background" is otherwise
impossible to diagnose without watching two windows at once. It answers, from one
place: was the page's main thread alive? were frames flowing? did the gesture
reach the server, and what did the server do with it? Several conclusions in this
document came from it, and at least two earlier theories died there.

---

## 7. Backends

`resolveBackend()` tries candidates in order and picks the first that can express
**your actual bindings** — a backend that cannot send `audio_play` is skipped
rather than 500-ing once per press.

| Backend | Needs | Spaces | Media keys |
| --- | --- | --- | --- |
| `cgevent` | `npm run build:native` | yes | yes |
| `nutjs` | nothing (prebuilt) | **no** | yes |
| `osascript` | nothing | via System Events | no |

If none can express everything, the best partial backend is used with a loud
warning — pressing four gestures out of five beats pressing none. If none load at
all it degrades to dry-run, loudly, because a silently key-pressing-nothing
server looks exactly like a missing permission.

---

## 8. Key injection, and why it is this complicated

### Modifiers

libnut (under nut.js) sets a modifier as a **flag bit** on the key event and never
emits `kCGEventFlagsChanged`. It structurally cannot: `nm` on `libnut.node` shows
`CGEventCreateKeyboardEvent`, `CGEventSetFlags` and `CGEventPost`, and no
`CGEventSetType` — which is the only way to turn a keyboard event into a
flagsChanged one. Applications read flags off the event and are satisfied; the
WindowServer's *global* modifier state, which symbolic hotkeys match against, is
never updated.

`native/keysend.swift` posts the `flagsChanged` pair around the key at
`kCGHIDEventTap`, exactly as a keyboard does.

### Spaces — the exception

**On macOS 26.4 no key this process synthesizes will switch Spaces.** Measured
against `CGSGetActiveSpace` across nut.js (two ways), a real `flagsChanged` at all
four `CGEventSource` state tables, and `osascript`:

| Method | Result |
| --- | --- |
| nut.js, both ways | never moves |
| Swift helper, all four source tables | never moves |
| **`osascript` via System Events** | **moves, and stays** |
| `CGSManagedDisplaySetCurrentSpace` | moves; can snap back |
| Dock-swipe gesture | moves; reverted in 2 of 4 configs |

The giveaway on the failing rows is `^[[1;5C` echoed into the terminal: the
keystroke *is* delivered to the focused app, the WindowServer simply declines to
match it against the Space hotkey. Synthetic `ctrl+up` still opens Mission
Control, so this is specific to Space navigation.

So `space_left` / `space_right` route through **System Events** — the OS pressing
its own key, evidently a different path — and that is `spaceStrategy:
"osascript"`, the default, which uses no private API. Two private fallbacks
(`direct`, `dockswipe`) remain selectable; both can be undone by macOS ~1.5s later
when focus stays behind, which is what "moved and then snapped back" means in the
log.

**A warning for anyone measuring this:** `com.apple.spaces` is the *Dock's* cache.
It is written only when the Dock performs a switch, and it lags. It cannot see a
Space changed by any other route, and cannot tell "never moved" from "moved and
snapped back". Everything here reads `CGSGetActiveSpace` instead —
`native/build/keysend space status` prints it as JSON and needs no permission.

### `native/keysend.swift`

```
keysend key   <keycode> [cmd] [ctrl] [alt] [shift] [--source=…]
keysend media <nx-type>                    # NSSystemDefined, not virtual keycodes
keysend swipe <left|right> [--variant=…]   # the Dock's trackpad gesture
keysend space <left|right|status>          # direct WindowServer call
```

Shelled out to per press rather than bound in-process: a spawn is ~3 ms against a
1200 ms cooldown, and a separate process cannot leave a modifier stuck down in the
server if it crashes mid-chord.

---

## 9. The Tauri host

`src-tauri/src/lib.rs`, ~300 lines, **owns no window**.

- **Server lifecycle.** Spawns `node server/index.js`, or attaches to a server
  already on the port — so `npm start` in a terminal and the app stay
  interchangeable. Kills it on quit.
- **Node discovery.** A GUI app inherits launchd's PATH, which contains none of
  the places Node is installed, so `Command::new("node")` works from a terminal
  and silently fails from a double-click. It checks the usual install locations,
  then PATH; `GESTURE_NODE` overrides.
- **Orphan protection.** The child is told the parent's pid and exits on its own
  if the app is force-killed — `RunEvent::Exit` cannot cover a SIGKILL, and an
  orphan holding port 4321 has its permissions attributed to a dead app.
- **Tray:** Open Gesture (Chrome, `--app=` window), Start at Login (reads the
  LaunchAgent's real state), Quit.
- **Exit handling.** With no windows, Tauri asks to exit as soon as it launches,
  so `ExitRequested` is refused unless Quit set the flag. And `app.exit()` raises
  the same `CloseRequested` a red button does — a handler that prevents it
  unconditionally cancels the quit too, which is exactly the bug that made Quit do
  nothing.

There is **no IPC**. The page talks HTTP to the Node server; the capability file
grants nothing because the host renders nothing.

---

## 10. Permissions

| Permission | Needed for | Declared in |
| --- | --- | --- |
| Camera | `getUserMedia` | `NSCameraUsageDescription` |
| Accessibility | any synthetic key event | granted by the user |
| Automation | `osascript` → System Events (Spaces) | `NSAppleEventsUsageDescription` |

macOS discards synthetic key events from unauthorized processes **silently** —
nothing throws, nothing moves. That is indistinguishable from a broken detector,
so the server checks before every press and reports `fired: false` with a reason
rather than claiming success.

**The grant follows the *responsible* app**, which is the first ancestor living in
an `.app` bundle — not `node`. Start the server from your editor and the editor
needs it; start it from Gesture.app and Gesture does. `responsibleApp()` resolves
this and the banner names it.

**An unsigned build loses the grant on every rebuild.** Its designated
requirement is the hash of that exact binary:

```
$ codesign -d -r- Gesture.app
designated => cdhash H"345fb776bbf1a998f3e9c28d2fec2642d5a58b9a"
```

So macOS treats each rebuild as a different application. Remove the entry and
re-add it, or sign with a certificate so the requirement names the identifier
instead.

---

## 11. Build and run

```bash
npm install
npm run build:native      # Swift helper — without it Spaces cannot work
npm run fetch-model       # vendor MediaPipe + model for offline use
npm start                 # server only, open http://127.0.0.1:4321
```

Desktop app (needs a Rust toolchain):

```bash
npm run app:dev
npm run app:build         # -> src-tauri/target/release/bundle/macos/Gesture.app
```

```bash
npm test                  # 82 tests, no camera needed
npm run probe:keysend     # measure which key-sending method moves a Space
```

**Not solved:** bundling the Node runtime into the `.app`. A built app still
expects `node` on `PATH` and the project directory present (`GESTURE_ROOT`
overrides). Nor is code signing — see §10.

---

## 12. End to end: what happens when you make a fist

1. **Launch.** `Gesture.app` starts, finds `node`, spawns the server, waits for
   port 4321 to accept a connection, opens Chrome at `--app=http://127.0.0.1:4321`.
2. **Page load.** Fetches `/config` (bindings, tuning, `clientActions`) and
   `/health` (backend, permissions). Posts `/client` with its engine
   capabilities. Renders the bindings table.
3. **Start camera.** `getUserMedia` → if `MediaStreamTrackProcessor` exists, clone
   the track, transfer `readable` into the Worker, `postMessage('start')`. The
   worker loads MediaPipe and answers `ready`.
4. **Per frame.** Worker reads a `VideoFrame`, runs `HandLandmarker`, posts 21
   landmarks. The main thread stamps `performance.now()`, converts to
   aspect-corrected points, and calls `recognizer.update()`.
5. **Recognition.** Not a swipe; velocity under the stillness threshold;
   `classifyPose` returns `fist`; the run persists past `MIN_FRAMES` and 180 ms;
   no cooldown outstanding → the recogniser returns `gesture: 'fist'`.
6. **Dispatch.** `onGestureDetected('fist')` — not a client action, and the page
   is armed → `POST /gesture {"gesture":"fist"}`.
7. **Server.** Origin and content-type pass. `fist` resolves to `audio_play`.
   Cooldown is clear, so the slot is claimed. Not dry-run. Accessibility is
   checked *now*, because it can be revoked while running.
8. **Press.** The `cgevent` backend resolves `audio_play` to NX type 16 and runs
   `keysend media 16`, which posts an `NSSystemDefined` event at the HID tap.
9. **Answer.** `{ ok: true, fired: true, shortcut: "audio_play" }`. The page logs
   `fist -> audio_play`. Music pauses.

And when you **pinch** instead: step 5 fires while disarmed too (the `canFire`
predicate allows it, and records the cooldown so a held pinch does not toggle on
every frame); step 6 finds `toggle_armed` in `clientActions`, calls
`setArmed(!armed, 'pinch')`, and **returns without contacting the server at all**.

And when you **swipe left**: step 8 becomes `spaceStrategy: "osascript"` →
`osascript -e 'tell application "System Events" to key code 124 using control
down'`, and the server then samples `CGSGetActiveSpace` for 2 s to report whether
the desktop actually moved, stayed moved, or snapped back.

---

## 13. Where the bodies are buried

Things that will bite you, all of which bit someone already:

- **Do not measure Spaces with `com.apple.spaces`.** §8.
- **Do not assume a "no" result without validating the instrument.** Six rounds
  of this project chased key-synthesis theories because the detector was blind.
- **`canFire` is a predicate, not a flag** — a boolean still works, but a new
  client action needs the per-pose form.
- **The swipe pose is a subset of the open-palm pose.** Any change to hold times
  or the stillness gate risks making swipes lock the screen. `test/swipe.test.js`
  covers this; keep it green.
- **Worker and page clocks differ.** Never pass a worker's `performance.now()` to
  the main thread.
- **Rebuilding the app invalidates its permissions.** §10.
- **`app.exit()` fires `CloseRequested`.** A close handler that always prevents
  will cancel your quit.

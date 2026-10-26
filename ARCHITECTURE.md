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
│  the orb (a panel)   │             │  127.0.0.1:4321        │
└──────────┬───────────┘             └───────────┬────────────┘
           │ launches, hidden         serves page │ ▲ POST /gesture
           ▼                                      ▼ │
┌────────────────────────────────────────────────────┴───────┐
│  Chrome — the page: camera, MediaPipe, gesture recognition │
└────────────────────────────────────────────────────────────┘
```

- **The page** decides *what gesture you made*. It never knows what key that means.
- **The server** decides *what that gesture does* and presses the key.
- **The app** owns none of that. It starts the server, shows the orb under the
  camera, starts at login, and keeps the page running in a hidden Chrome window
  of its own (§9). The orb is a page too, served by the same server, and learns
  everything from it over one event stream.

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
inference in Rust to reach a place Chrome already occupies. The orb,
start-at-login and process supervision are worth having natively. Detection in
the webview was not: the orb's webview only draws, and has no camera.

---

## 2. Technology stack

| Layer | Choice | Why this one |
| --- | --- | --- |
| Hand tracking | MediaPipe Tasks Vision (`HandLandmarker`) | 21 landmarks per hand, WASM + GPU, runs in a Worker |
| Page | Vanilla ES modules, no framework | The whole UI is one readout and five rows; a framework would be more code than the app |
| Server | Node 22+, Express 5 | Already the ecosystem the page lives in |
| Key injection | Swift helper (`native/keysend.swift`) via CGEvent | See §8 — nothing in npm can do what this needs |
| Fallbacks | nut.js, osascript | Degradation when the helper is not built |
| Desktop shell | Tauri 2 (Rust), tauri-nspanel | The orb panel + LaunchAgent + process supervision, ~1,000 lines |
| Tests | `node:test` | No dependency, and the logic worth testing is pure |

---

## 3. Project structure

```
public/                 the page — runs in Chrome
  index.html            markup: video stage, readout, bindings table, log
  orb.html, orb/        the orb under the camera: orb-state.js decides what it
                        shows, orb.js draws it and sends its clicks
  app.js                I/O only: camera, worker, canvas, fetch. No decisions.
  recognizer.js         pose runs, hold times, cooldowns  ← the decisions
  custom-gestures.js    taught gestures: samples, nearest-neighbour match
  feedback.js           sound cues: which response gets which sound
  gestures.js           landmarks -> pose name (ok_sign / pinch / open_palm / fist),
                        and shh: a finger on the lips, given the mouth
  transitions.js        open palm, then a fist -> grab (unbound by default)
  cover.js              frame brightness -> cover (the lens covered for 1 s)
  swipe.js              landmarks over time -> swipe_left / swipe_right, and a
                        flick from still -> swipe_up / swipe_down
  landmarks.js          geometry helpers: distances, palm centre, extension
  screens.js            face -> head direction -> the screen you face, and during a hold
  checkup.js            the check-up: trial plan, frame-driven runner, scoring
  stats.js              medians, quartiles, seeded randomness, bootstrap
  ui/                   status chips, setup checklist, plain words, hash routes;
                        the mascot: mascot.svg (the art), mascot.css (its
                        motion), mascot-art.js (mounts it), mascot.js (its mood)
  snap.js               the finger snap: a set, then folded on the next frame;
                        snap practice and its replay
  lab/                  the Lab's vanish effect: lab.js (I/O), segmenter.js
                        (person cutout), renderer.js (WebGL2), vanish.js
                        (timeline, dust settings), plate.js (room coverage)
  detector-worker.js    MediaPipe in a Worker, so hiding the page cannot stall it
  worker-lib.js         the worker's pure helpers: idle pacing, brightness, face
                        points. Loaded by the worker and by the tests
  vendor/, models/      vendored MediaPipe runtime; hand, face and selfie models

server/                 the local server
  index.js              routes, cooldown, Space verification, preflight
  config.js             load, validate, hot-reload config.json
  shortcut.js           "cmd+shift+m" -> { modifiers, key }
  permissions.js        Accessibility status, and who owes the grant
  macos.js              read-only OS queries: Spaces, hotkeys, responsible app
  screens.js            displays and focusing a screen, via the helper
  orb-hub.js            the orb's live feed: mood, camera, engines, streamed
  experiments.js        check-up records: validate, append to experiments/*.jsonl
  backends/
    index.js            picks a backend that can express your bindings
    cgevent.js          the Swift helper — the one that works
    nutjs.js            prebuilt fallback; cannot switch Spaces
    osascript.js        last resort; no media keys

native/keysend.swift    key chords, media keys, dock swipes, Space calls, windows
src-tauri/              the orb and process host (Rust)
scripts/                build the helper, vendor the models, probe key-sending,
                        replay recorded head traces and snaps through other
                        settings, measure the load (measure-load.mjs)
test/                   285 tests, no camera required (plus 5 Rust tests in
                        src-tauri)
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
gestures.js    classifyPose(pts)      -> 'ok_sign' | 'pinch' | 'open_palm' | 'fist' | null
               isShh(pts, mouth)      -> the index upright on the lips (needs the face)
transitions.js GrabDetector.update()  -> 'grab' | null   (fed view.shape)
cover.js       CoverDetector.update() -> 'cover' | null  (fed the frame's brightness)
swipe.js       SwipeTracker.update()  -> 'swipe_left' | 'swipe_right' | 'swipe_up' | 'swipe_down' | null
recognizer.js  Recognizer.update()    -> a view: gesture, pose, shape, held, velocity…
screens.js     ScreenTracker.update() -> the display you face; screenDuring() -> the one faced through a hold
ui/            statusChips(), setupSteps(), liveSummary(), parseRoute() -> what to show
ui/mascot.js   mascotMood(snapshot, now) -> { mood, gaze, ring, label }
app.js         wires the above to the camera, canvas and server
```

The same rule holds for the interface. `ui/` decides what the status bar, the
Home card and the setup checklist say. These are pure functions over a snapshot
of state, tested in `test/ui.test.js`. `app.js` only puts their answers on the
page. It rebuilds the chips and checklist only when their text changes, because
`updateReadout()` runs on every camera frame.

`cameraState()` is shared by the Camera chip and the Diagnostics "Detection"
row, so the two cannot disagree.

### The mascot

`mascotMood()` turns the same snapshot into one of nine moods. The first rule
that matches wins: camera off, check-up running, just fired (500 ms), just
refused (700 ms), disarmed, learning, watching a hand, facing no screen, ready.
Moods follow *events* (fired, refused, armed), never particular gestures, so
changing which gesture does what never changes the mascot.

- **On the page:** `renderMascot()` sets `data-mood` and three CSS variables
  (`--gaze-x`, `--gaze-y`, `--ring`) on the header SVG. All motion is CSS, keyed
  to named parts, so new art only has to keep the ids. `docs/MASCOT.md` is the
  contract.
- **One art file:** `ui/mascot.svg` (Jelly), mounted by `ui/mascot-art.js`
  into both the header and the orb. It holds every mood's parts, and
  `ui/mascot.css` shows and moves the ones a mood needs; each page sets only
  the size. Long-running motion (breathing) is a transform on the element that
  holds the SVG, which the compositor animates without repainting the drawing;
  blinks are a timer in `ui/mascot-view.js`, not a looping animation.
- **In the orb:** the page posts each change to `POST /mascot`, with its last
  reaction numbered. It sends at most one every 150 ms (a new reaction goes at
  once), plus one every 2 s so the server knows the page is alive. `server/orb-hub.js` streams each change
  to the orb over `GET /events`, and the number is what lets the orb show
  "Swipe up → page down" for 1.5 s, once, though the face's nod lasts 0.5 s.

Two rules are enforced in code, not left to the art:
- It goes still for the whole check-up. Motion near a timed trial could cue the
  person being measured.
- The eyes follow the *faced screen's* position on the desk, never the camera,
  so it doesn't stare back at you.

Views are hash routes (`#/screens`), so the server keeps serving one static
page. Home is moved off-screen rather than set to `display:none` when another
view shows: the camera preview lives there, and the non-Chrome detection
fallback stops when its `<video>` is not rendered.

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

### Doing less

Detection is nearly all of what Gesture costs, and most of the time nobody is
gesturing. So the engine does only the work someone needs. Measured before and
after in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

- **Slow when idle.** With no hand for 1 s, the worker runs the models on one
  frame every 125 ms (about 8 a second) and closes the rest unread. The first
  frame with a hand puts it back to every frame (`shouldDetect()` in
  `worker-lib.js`). Calibration, the check-up, teaching and the Lab force full
  rate: they need an unbroken stream.
- **640×360 at 30 fps.** MediaPipe shrinks every frame to 192–256 px before its
  models see it, and everything after works in palm lengths, so 720p only added
  pixels to capture, convert and copy. The Lab asks for 1280×720 while it is
  open, so recordings stay sharp.
- **Only what is read crosses threads.** The worker posts the 8 face points the
  page uses (the `FACE` indices), not all 478. It measures the lens brightness
  only while `cover` is bound or a check-up runs.
- **Nothing drawn while hidden.** With the page hidden, the overlay and the
  readout aren't touched and the preview `<video>` is paused. Only the mood,
  which feeds the orb, is still worked out.
- **No polling for config.** The server sends a `config` event over
  `/events` when `config.json` changes. `/screens` is read every 30 s rather
  than every 5 s, because each read spawns the helper; a pinch reads the
  displays fresh anyway.
- **The Lab and the check-up load when opened** (`import()`), and the hidden
  engine never reopens the Lab at launch: gestures don't fire there.
- **Sound sleeps.** The AudioContext is suspended 30 s after the last cue, and
  woken for the next.

### Worker protocol

Main thread → worker:

| Message | Payload |
| --- | --- |
| `start` | `readable` (transferred), `bundleUrl`, `wasmUrl`, `modelUrl`, `faceModelUrl` (null unless a gesture is bound to a screen action), `faceIndices` (the face points to send), `options` |
| `options` | `full` (every frame, not slower when idle), `luma` (measure the lens brightness) |
| `stop` | — |

Worker → main thread:

| Message | Meaning |
| --- | --- |
| `ready` | MediaPipe loaded and the landmarker exists |
| `head` | `available`, `message` — whether the face landmarker started. Never fatal |
| `landmarks` | `landmarks`, `width`, `height`, `luma` (null unless asked) — one frame. `face` too on every other frame: absent means "not run this frame", `null` means "ran, no face"; only the asked-for points are filled in |
| `error` | `message`, `fatal`. Fatal stops the camera; non-fatal is rate-limited into the log |
| `stopped` | the loop exited |

**After sleep.** Closing the lid locks the screen, and about 15 s later Chrome
suspends the camera, firing `mute`, then `unmute` on unlock
([Chromium, 2021](https://groups.google.com/g/discuss-webrtc/c/X46ua1nCR3Y/m/nQbxX0JmCAAJ)).
A closed lid can also end the track, or stop frames with no event at all. In
the desktop app, an ended track or the stall watchdog calls `recoverCamera()`,
which restarts the camera through `followCamera()`: the orb is told
"starting", and a failed start is tried again after 1, 2, 4, then every 10 s
while the orb still wants the camera, since it may not be back yet, or the
screen may still be locked. Before this, an ended track was only logged, and
the watchdog's single restart could fail straight after a wake and never try
again, while the orb still thought the camera was on.

A deliberate subtlety: **timestamps are taken on the main thread**, not accepted
from the worker. A Worker has its own `performance.timeOrigin`, so its
`performance.now()` is a different clock; mixing the two made staleness detection
read "stalled" forever.

### Recognition

`Recognizer.update(pts, now, canFire)` runs per frame and returns a view object
driving both the readout and the firing.

A pose that drops out for less than `RELEASE_MS` (150 ms) is still held. One
frame of a pinch reading as nothing is flicker, not letting go: counting it as a
release made a flickering pinch fire twice, and a flickering OK sign arm and
then disarm. A real change of pose still times its hold from its own first
frame.

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

### Taught gestures

`Recognizer.setCustomClassifier()` takes a function that names a taught gesture
(`custom:<name>`) or returns null. It is consulted only after `classifyPose`
finds nothing, and never while four fingers are out: that shape starts every
swipe, so a taught match there would collide with swipes exactly the way
open_palm does, without a hold time tuned to prevent it.

The classifier is `CustomGestures.match()` in `custom-gestures.js`:

- Each sample is the 21 landmarks relative to the wrist, divided by palm length.
- Distance is root-mean-square over landmarks after rotating to best fit, with the
  rotation clamped to ±30°. That forgives a tilted hand but keeps "thumb up" and
  "thumb down" apart.
- A match needs the nearest sample within `customMaxDistance` (0.18) **and**
  clearly nearer than the next gesture's (at most 0.8×). A hand halfway between
  two taught shapes matches neither.

Recording refuses built-in shapes, the four-finger shape, samples that disagree
with each other, and anything within the threshold of a gesture already taught,
so a saved gesture is always one that can still fire. Samples live in the page's
`localStorage`. The server only ever sees the name.

### Sound cues

`feedback.js` maps each `POST /gesture` response to a sound with `cueFor()`:
rising for a press, falling for a refusal, a tick for dry-run, silence for
cooldown. The page plays it on the response. A Space switch that didn't move is
found afterwards and sounded then (the server's `problem` event, §6). Web Audio
needs a real click or key press before it can start; hand gestures don't count.
The hidden engine never gets one, so the desktop app starts its Chrome with
`--autoplay-policy=no-user-gesture-required` and the page unlocks sound at
start in engine mode.

### Head tracking and screens

Every other binding means the same thing wherever you look. `focus_screen`
doesn't: the hand says *what*, the head says *where*.

1. **Head direction.** The worker runs MediaPipe's face landmarker on every
   other frame. `headPose()` reads yaw from the line between the outer eye
   corners in the x–z plane and pitch from the forehead–chin line. Those are
   depth angles from the face mesh, so where you sit in the frame and how far
   away you are don't change them. They're loose degrees, because MediaPipe's z
   is only "roughly the scale of x". That doesn't matter, because nothing is
   compared against an absolute angle.
2. **Calibration** records the median head direction while you look at each
   connected display, left to right, paced by sound because the screen you're
   asked to look at is never the one the page is on. A reading is refused if
   too few frames saw a face or the head was still moving (median spread over
   5°). Readings are stored in localStorage by display id.
3. **`ScreenTracker`** smooths the angles (EMA 0.35) and picks the nearest
   calibrated screen, with two guards. Past `screenMaxAngle` it reports *no*
   screen, so looking at your notebook is not looking at the laptop. And a
   challenger has to beat the current screen by `switchMargin` (4°), so a head
   held at the midpoint doesn't flip on noise.
4. **Firing.** `pinch` fires through the recogniser like any pose.
   - **Which screen:** `app.js` keeps the last 2 s of facing readings, and
     `screenDuring()` picks the screen faced for at least 60% of the pinch's
     own hold. That's where you looked *while* pinching, not where your head is
     when the hold completes.
   - **Mid-turn:** with no screen holding most of the hold, it refuses with
     "still turning".
   - **Sending:** `{"gesture": "pinch", "screen": <id>}`.
5. **Refusals give the cooldown back.** `recognizer.forgive()` clears the
   cooldown of a gesture the page refused, so you needn't wait 1.2 s to try
   again. It doesn't clear "already fired", or a held pinch would refuse, and
   chime, on every frame.

Moving windows between screens (`Carry`, `drop`, `keysend move`) was removed in
v2. Nothing showed it was needed, and git history has it.

### Measurement: the check-up

`checkup.js` is pure, like the recogniser. `CheckupRunner.tick(now, obs)` gets
the head, the tracker's answer, the recogniser's view and the hand's
`fingerPattern` on every camera frame. It returns commands (`say`, `chime`,
`save`, `status`, `done`) for `app.js` to carry out.

- **Frames, not timers.** The page is usually hidden while you look at other
  screens, and Chrome throttles a hidden page's timers to as little as once a
  minute. Worker messages keep arriving, so every phase is timed against frame
  timestamps.
- **Cue, random wait, chime.** Speech takes a variable few hundred ms to start
  and finish, so it never falls inside a timed interval. Time zero is the go
  chime (`Chime` `go`), and the random 0.8–1.5 s wait stops anyone timing it.
- **Pose trials wait for a release** (300 ms out of the shape) before the cue,
  so a carried-over shape can't count.
  - Built-in poses (pinch) succeed on `view.gesture`, with `canFire` forced
    true, so hold and cooldown are the real ones.
  - Candidate poses that aren't gestures yet (`POSE_PATTERNS`, such as horns
    `I--P` or peace `IM--`) succeed once their finger pattern is held 500 ms.
    The default plan measures the bound gestures; a candidate is added to try
    it out.
  - Every pose trial logs a histogram of what was seen, which is the evidence
    for *why* a shape fails.
- **Facing trials keep their head trace**, from 500 ms before the chime to
  1.5 s after: `[ms, raw yaw, raw pitch, tracker screen, smoothed yaw, smoothed
  pitch]`. `replayFacing()` and `scripts/replay-facing.mjs` re-run those raw
  angles through any tracker setting. That's how the EMA-vs-1€ choice is made
  from data.

Records go to `POST /experiment`, which is same-origin, takes a 32 kB body
(every other route stays at 4 kB) and accepts only allow-listed `kind`s.
`server/experiments.js` appends them to `experiments/<local date>.jsonl`. The
server stamps `v` and `t`, so the page can't backdate a result. It never writes
inside an `.app` bundle; there it uses Application Support instead, and
`GESTURE_EXPERIMENTS_DIR` overrides both.

### The Lab: the snap and the vanish

An experiment with its own page, `#/lab`. It changes the camera picture instead
of acting on the Mac, so it is kept apart:
- **No gesture fires while the Lab is open.** `handleLandmarks()` sends frames
  to the Lab instead of `onGestureDetected()`.
  - Closing the recogniser's gate would not be enough: `canFire` only decides
    whether a fire is *recorded*. The pose still comes back, and a client
    action like arming acts on it, on every frame.
  - Entering or leaving resets the recogniser; entering stops a running check-up, which would otherwise take every frame.
- **I/O and decisions are split, as everywhere.** `lab/lab.js` wires the
  camera, cutout, renderer, recorder and controls. The decisions are pure and
  tested: `snap.js`, `lab/vanish.js` and `lab/plate.js`.

**The snap.** A snap lasts about 7 ms (Acharya et al., 2021), and a frame
arrives every 25–33 ms, so the camera only ever sees the before and the after.
`SnapDetector` looks for exactly that pair.
- **Set:** thumb within 0.35 palm lengths of the middle fingertip, closer to it
  than to the index, and the middle tip more than 1.3 from the wrist, held for
  60 ms. The last rule is what keeps a fist out: its thumb is also near the
  middle tip.
- **Snap:** on the *next frame with a hand*, the middle tip is at least 0.4
  closer to the wrist. Up to two handless frames may sit in between, for motion
  blur.
  - **Not a time window:** a slow opening reaches the palm too, but in small
    steps over several frames.
  - **The wrist, not the palm centre:** the tip lands on the thumb's base,
    which is nowhere near the knuckles.
- **Measured, not assumed:** these thresholds are starting points. Snap
  practice (`SnapPractice`, the same command protocol as the check-up) saves
  `snap` records with each trial's landmarks, in thousandths to stay under
  32 kB. `scripts/replay-snaps.mjs` re-runs them through a grid of thresholds.

**The cutout.** `lab/segmenter.js` runs MediaPipe's landscape selfie segmenter
on the page, not in the worker, only while the Lab is showing. What was measured
on an M1:
- **Input size:** the mask comes back at the size of the input. A 1280×720
  frame took the Lab to 2 fps, from copying, uploading and counting 921,600
  values a frame. Each frame is shrunk to 256×144 first.
- **Speed:** about 7 ms a frame at that size, on the CPU and the GPU alike. The
  CPU goes first: it warms up in 25 ms rather than about 170, and leaves the
  GPU to the renderer.

MediaPipe tasks on the page are created through `oneAtATime()`, because its
loader clears a shared global after each one.

**The renderer** (`lab/renderer.js`, WebGL2) runs five passes a frame:
1. **Person:** the mask, widened, with discs over the hand landmarks drawn in.
   The segmenter was trained on head-and-shoulders footage.
   - From it, **recent**: a running maximum of where you've been, fading with
     a 250 ms half-life. Two blend passes (`ZERO, SRC_ALPHA` to fade, then
     `MAX`) do it in place.
   - The room is learned, and you are hidden, wherever recent says so, not
     just this frame's mask.
2. **Room:** the camera blended in at 10% a frame wherever nobody has been.
   - Colour and alpha grow together from zero, so the texture is premultiplied
     and its mipmaps average only what was seen.
   - **The part never seen**, usually right behind you, is guessed by a fill
     pass at 160 px wide. Each row continues from the nearest seen room on the
     left and right, weighted by distance; rows with nothing either side fall
     back to "pull-push". Measured on a drawn room (yellow wall over a grey
     sofa), against its true background where the figure sat:
     - the earlier pull-push-only fill was 14.5 out of 255 off on average, a
       visible grey ghost, because it mixed wall and sofa;
     - the row fill is 0.8 off, losing only vertical detail behind you;
     - seeing the room by leaning during Capture is 0.2.
   - It is half-float, because 8-bit 10% steps stall short of the target.
3. **Stats:** live against room brightness over the visible background,
   mipmapped to one pixel. This lets the hidden patch follow auto-exposure
   without reading anything back to the CPU.
4. **Screen:** the live picture, the room wherever the live mask sees you, and
   the frozen snapshot of you, cut away by a noise delay.
5. **Specks:** `gl_VertexID` points, one per 4×4 pixels of you, each placed by
   a formula of time. There are no buffers and no simulation, so playing the
   formula backwards brings you back.

Three choices here were bugs first:
- **The room never learns you, not even during "Capture the room".**
  - **The first live run** left a smeared copy of the user behind. Capture
    counted the whole frame as room, which baked in anyone who stayed seated,
    and every frame the cutout was unsure let a little more in.
  - **Reproduced on a drawn scene:** a cutout unsure 15% of the time left the
    figure on 12.7% of the screen while "gone", and capture while seated left
    15.6%.
  - **After the fix:** with *recent* and capture only learning faster, both
    are 0%. That holds up to a cutout unsure 40% of the time.
  - **What remains:** a part you always cover is guessed from the colours
    around it. The Lab says so below 85% seen.
- **The return retakes the snapshot every frame**, so the dust lands where you
  are. A snapshot from when the return began left a second you behind if you
  had moved.
- **Mirroring happens in the last shader pass, not CSS**, so a `MediaRecorder`
  clip of the canvas looks like what you saw. That was checked by decoding a
  recorded frame.

---

### The office additions: shh and palm up / down

- **Shh** is the one pose that needs the face.
  - `mouthPoint()` (screens.js) takes the lip centre from face landmarks 13 and
    14. The recogniser gets it through `setMouth()`, or null once the last face
    reading is over 300 ms old.
  - `isShh()` wants the index alone, pointing within 45° of straight up, with
    the lips within 0.4 palm lengths of the finger's *top section*. The tip of
    a finger laid across the lips is often at the nose.
  - Binding `shh` turns head tracking on, like a screen action does.
- **Swipe up / down** is the sideways swipe turned 90°: the same travel, speed,
  off-axis and rearm rules, and nothing more by default.
  - **Two guards exist but are off** (`stillFirstMs`, `confirmMs` at 0). The
    first version had them on: still in view 200 ms before, and in view
    120 ms after. Live, that made it too hard to do, so on 25 Oct they were
    switched off. Raising or lowering an open hand quickly now scrolls.
  - **Each up/down movement gets a verdict** (`tracker.lastFlick`): scrolled,
    too short, too slow, fingers not all out, already scrolled, and so on. It
    reaches the Activity log, the Diagnostics row and the server's heartbeat,
    so a miss says which rule stopped it.
  - After any swipe fires, the rest of that stroke is not judged as a new
    attempt.

## 5. Bindings, and the two kinds

`config.json` maps a gesture name to one of four things:

```json
{
  "open_palm":   "audio_play",    // a key the server presses
  "swipe_left":  "space_right",   // a server-side action
  "ok_sign":     "toggle_armed",  // a client-side action
  "pinch":       "focus_screen"   // a screen action
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

**Screen actions** (`focus_screen`) need something only the page knows: which
display you were facing. The page sends it with the gesture, and the server
validates it and acts through the native helper, never a keyboard backend. The
list travels as `screenActions`, and the page only loads the face model when
one is bound.

Two consequences worth knowing, both of which were bugs first:

- `unsupportedBindings()` must skip client and screen bindings. They have no
  parsed shortcut, so testing them made every backend look incapable and dropped
  the whole app to dry-run.
- `POST /gesture` with a client action answers **400** explaining the page owns
  it, rather than failing deeper down on an unparseable shortcut.

Parsing happens at config **load** time, so a typo surfaces immediately with the
gesture name attached rather than doing nothing the first time you make that
gesture. Reloads are atomic: if anything in the new file is invalid the whole
reload is rejected and the previous good config stays live.

One binding is rejected outright: a bare `escape`. It is the page's panic disarm,
and the page is normally frontmost, so binding it would make the first firing
disarm everything after it — with nothing logged anywhere.

### Editing from the page

The Gestures page changes bindings through `POST /config/gestures {version,
edits}`. `applyBindingEdit()` in `server/config.js` decides what is allowed:
- **Gesture names:** only ones the page can emit, built-in or a valid `custom:`
  name.
- **Actions:** only ones on `EDITABLE_ACTIONS`, or `null` to unbind.
- **Hand-written shortcuts:** a shortcut outside the list is kept **if the edit
  leaves it unchanged**, so saving one row never disturbs another.
- **Flat shorthand:** a config written in the short form is refused, with how to
  fix it, rather than rewritten.

After that, the result goes through the same `validate()` as a hand edit.

The write is optimistic. `version` is a short sha256 of the file text the page
last loaded. If the file has changed on disk since, the answer is **409**, with
the current config so the page can redraw. Otherwise the server writes
`config.json.tmp` and renames it over the original. A crash can't leave half a
file, and the file watcher's reload afterwards changes nothing.

---

## 6. The server

| Route | Purpose |
| --- | --- |
| `POST /gesture` | The only route that presses keys or brings a screen's window forward. A desktop switch is answered at once and checked in the background |
| `GET /config` | Bindings, tunables, `clientActions`, `screenActions`, `knownGestures`, `editableActions`, `version` |
| `POST /config/gestures` | Change bindings, from the allow-list only (§5) |
| `GET /screens` | Connected displays in global points, read fresh each time (the page asks every 30 s) |
| `POST /experiment` | Append one check-up record to `experiments/<date>.jsonl` |
| `POST /mascot` | The page's current mood, gaze, label and last reaction |
| `GET /events` | Server-Sent Events, the live feed for the orb and every page: `hello` (everything), then `mascot`, `camera`, `engines`, `config` (config.json changed: read it again), `problem` (something found wrong after answering, such as a desktop switch macOS undid). The mood turns `offline` if nothing came for 5 s |
| `GET /orb` | The same state as one snapshot |
| `POST /camera` | The orb's click: `{on}`. Relayed to the engine page |
| `POST /camera/state` | What the engine's camera did: `off`, `starting`, `needs-permission`, `on`, `blocked`, `failed` |
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

Screen actions are the one place the body carries more than a name: a display
id. That widens what a compromised page could ask for by exactly one thing,
*which of your own screens*. The id must be an integer that is connected right
now, or the answer is 400 (missing) or 404 (not connected), so the worst it can
do is bring forward a window you already have open.

`POST /config/gestures` is the one route that writes a file the server acts
on. It widens what a compromised page could do to **choosing between the listed
actions**: media keys, desktop switching, Mission Control, lock screen, focus a
screen, arm / disarm. It can't make a gesture press an arbitrary shortcut (that
still means editing the file by hand) or bind the panic key. Verified:
stale version → 409, unlisted shortcut → 400.

`POST /mascot` stores display state only, and nothing acts on it. The mood must
be on the list, the gaze a number from −1 to 1, and the label is cut to 80
characters. `POST /camera` can only ask the page to turn its camera on or off,
which then happens in plain view: the orb lights up. `GET /events` refuses a
foreign Origin like the POST routes do, and carries display state only.

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
keysend displays                           # JSON: id, name, frame, main, builtin
keysend focus <display-id> [--no-pointer]  # bring that screen's front window forward
```

Shelled out to per press rather than bound in-process: a spawn is ~3 ms against a
1200 ms cooldown, and a separate process cannot leave a modifier stuck down in the
server if it crashes mid-chord.

The window commands are all public API. `CGWindowListCopyWindowInfo` finds the
frontmost layer-0 window whose centre is on the display. It needs no Screen
Recording permission, because only titles are gated and those come from
Accessibility instead. The Accessibility API focuses it. Matching
between the two is by frame, since they share CG global coordinates and no
public id links them. Focus sets `AXFrontmost` rather than relying on
`NSRunningApplication.activate`: since macOS 14 activation is cooperative, and
a background helper asking another app forward is exactly what it may ignore.
Exit 4 means Accessibility isn't granted, and the server turns it
into the same 503 as a refused key press.

Run inside a sandbox, `displays` prints `[]`: the process can't reach the
WindowServer. The server reports that as an error rather than "no screens".

---

## 9. The Tauri host

`src-tauri/src/lib.rs`, ~1,000 lines. It shows one panel, the orb, and keeps two
processes running: the server and the engine.

- **Server lifecycle.** Spawns `node server/index.js`, or attaches to a server
  already on the port — so `npm start` in a terminal and the app stay
  interchangeable. Kills it on quit.
- **Node discovery.** A GUI app inherits launchd's PATH, which contains none of
  the places Node is installed, so `Command::new("node")` works from a terminal
  and silently fails from a double-click. It checks the usual install locations,
  then PATH; `GESTURE_NODE` overrides.
- **Finding the project.** `GESTURE_ROOT`, then the bundle's resources, then
  the folders above the app (a bundle still inside the repo), then the folder
  the app was built from (`CARGO_MANIFEST_DIR`). The last is what lets a copy
  in `/Applications` run on the Mac that built it.
- **Start at Login** is a LaunchAgent holding the app's path at the moment it
  was switched on. An installed (release) app writes it again at each start,
  so a moved or replaced app heals it; `tauri dev` doesn't, or logging in
  would start a dev build. (One pointed at `~/gesture` after the project moved
  to `~/code/gesture`, and nothing started at login.)
- **Orphan protection.** The child is told the parent's pid and exits on its own
  if the app is force-killed — `RunEvent::Exit` cannot cover a SIGKILL, and an
  orphan holding port 4321 has its permissions attributed to a dead app.
- **The orb.** A non-activating `NSPanel` (tauri-nspanel) holding the
  island, which is SwiftUI: `island/Sources/Island/Island.swift`, compiled and
  linked by `build.rs` with swift-rs's `SwiftLinker` (swift-rs is already in
  the build through Tauri). The island is a notch fused to the top edge,
  flaring into it at the top corners: macOS 26's Liquid Glass (`glassEffect`
  in the notch's shape, with the content in the glass as Apple asks; dark
  before macOS 26), Jelly's few words and the warm light. The notch keeps its
  32 pt height and grows sideways to make room for the words. Jelly is the
  orb's web page, `/orb.html`, in a fixed 32 pt box at the left of the notch's
  body: centred at rest, carried sideways as the notch grows. Tauri's web view
  stays where Tauri put it, above the island; taking it out of the window
  makes WebKit drop a window observer the converted panel no longer knows
  about, and AppKit ends the app. The page decides what the island shows (in
  Jelly's words, from `saidFor()` and `explainProblem()` in `orb-state.js`;
  the detail goes to VoiceOver) and sends it with `orb_view`. It joins every
  desktop and shows over full-screen apps (`canJoinAllSpaces`,
  `fullScreenAuxiliary`, `stationary`), at the status-bar level: above the menu
  bar it sits on, below the menus that open over it. Clicking it never takes
  focus from the app you're in. It goes at the top centre of the built-in
  display, found with CoreGraphics' `CGDisplayIsBuiltin`, because Tauri names
  monitors only "Monitor #n". With the lid shut it goes on the main display.
- **Still while you switch desktops.** Joining all Spaces isn't enough: the
  window is still drawn into each desktop's picture, so a swipe slides it away
  and it jumps back after. The orb is moved onto a private WindowServer space
  at the top level, and off every desktop, with SkyLight's
  `SLSSpaceCreate` / `SLSSpaceSetAbsoluteLevel` / `SLSShowSpaces` /
  `SLSSpaceAddWindowsAndRemoveFromSpaces` (mask `0x7`). That is how notch apps
  do it ([boring.notch](https://github.com/TheBoredTeam/boring.notch),
  [Vitals #1](https://github.com/sfxarfn/Vitals/pull/1)). **Private API:**
  undocumented, and it may change with macOS. The functions are looked up at
  run time (all present on macOS 26.6), so if one disappears the orb still
  shows, just slides again, and the log says "couldn't pin the orb".
  `GESTURE_NO_PIN=1` turns it off, should a macOS update make it misbehave.
- **Why the island is native.** The first island had the page draw the words
  and Jelly and a native glass view moved along behind it, with the window
  resized at every open and close. It felt laggy and stiff: two animations in
  two processes drift apart, a resized web view shows stretched content until
  it redraws, `width`/`height` transitions relayout every frame, and a fixed
  curve loses its speed when interrupted. Now:
  - **One animation.** SwiftUI moves the glass and the words together, on
    springs that keep their speed when a new message interrupts them
    (`opening`: response 0.42, damping 0.8; `closing`: 0.45 and 1.0, no
    bounce; boring.notch's values).
  - **A panel that is never resized** (`ORB_PANEL`, 400 × 48 pt). The notch
    opens and closes inside it, and the panel lets clicks through except over
    the notch: `ignoresMouseEvents`, switched by an AppKit mouse-moved
    monitor, which needs no permission.
  - **Jelly moves in the same frame as the glass.** The notch's width is an
    animatable SwiftUI modifier (`BodyWidth`), which SwiftUI runs once a frame
    while the width springs; that is where Jelly's box is placed, so it never
    lags the glass. Jelly is never resized, so its page never lays out again.

  The page renders on events, plus one timer for the next moment its picture
  runs out by itself (`nextChangeIn()`), not on an interval, and tells the
  island only what changed. The app places the panel with one
  `setFrame:display:` (AppKit's bottom-left coordinates).
- **IPC, for the orb only:** `orb_view` (what the island shows: at rest or
  speaking, the state's colour, the two lines, the words for VoiceOver),
  `orb_menu` (the native right-click menu: Settings, Start at Login, Quit),
  `open_settings` and `hide_settings`. Clicks on the island go the other way:
  Swift calls the app, which runs the page's `orbClick()`, or shows the menu.
  Clicks on Jelly land on the page itself, which does the same.
  The orb's page comes from the server, so to Tauri it is a remote page, and
  a remote page may call only commands declared in `build.rs`'s app manifest
  and granted in `capabilities/orb.json` (scoped to the orb window and the
  server's origin). Anything else is refused silently, which is how the first
  build lost every resize. No plugin permission is granted.
- **Showing it.** The panel is made hidden and shown once it is in place. The
  plugin's `no_activate` option is deliberately not used: it bars the app from
  showing windows while the panel is made, and the orb never appeared. 1.5 s
  after start the app checks macOS really has it on screen, shows it again if
  not, and says so. `GESTURE_DEBUG=1` also prints its frame then, and
  everything the island is told to show.
- **The engine.** Chrome with a profile of its own
  (`~/Library/Application Support/Gesture/Engine`), loading `/?engine=1`,
  launched with `open -n -g -j`: a new instance, in the background, hidden.
  - Through `open`, not as a child process, because macOS charges a child's
    camera access to the app that spawned it (Gesture, or the terminal running
    `tauri dev`) instead of to Chrome, which already has it.
  - Not being a child, it is found by its profile directory in `ps`. One left
    over from an earlier run is adopted rather than doubled. Once its pid is
    known, a `kill(pid, 0)` each second says whether it still lives; `ps` runs
    only when it doesn't.
  - It is kept hidden for its first 10 s (Chrome shows its window on its own
    schedule), relaunched if it quits, and restarted if no engine page has
    been connected for 5 s, which means its window was closed.
  - Three Chrome switches keep the hidden page's own thread at full speed.
    Detection is in a Worker and doesn't need them; heartbeats, moods and
    gesture requests do. A fourth, `--autoplay-policy=no-user-gesture-required`,
    lets the sound cues play in a page nobody clicks.
  - If Chrome is missing or won't open, the app reports it as a failed camera
    (`POST /camera/state`), so the orb says so in words.
  - **Measured (25 Oct, M1 Air):** hidden by the app
    (`NSRunningApplication.hide`), the page detects at 32–39 fps, its
    heartbeats reporting `visibility: hidden` and `mode: worker`. Since the
    idle pacing (§4, "Doing less") it drops to about 8 fps with no hand in view,
    on purpose.
- **Settings** unhides and activates the engine's window. Chrome's camera
  prompt also appears there, so the orb opens it when the page reports
  `needs-permission`, and hides it again once the camera is on.
- **Exit handling.** The orb is a panel, not a window, so Tauri asks to exit as
  soon as it launches; `ExitRequested` is refused unless Quit set the flag.
  And `app.exit()` raises the same `CloseRequested` a red button does — a
  handler that prevents it unconditionally cancels the quit too, which is
  exactly the bug that made Quit do nothing. Quit also asks the engine's Chrome
  to quit, and so does Cmd+Q or the Dock's Quit, which skip the menu: the flag
  is set on exit too, so the supervisor can't relaunch the engine on the way
  out.

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

Desktop app (needs a Rust toolchain and Google Chrome):

```bash
npm run app:dev
npm run app:build         # -> src-tauri/target/release/bundle/macos/Gesture.app
```

```bash
npm test                  # 285 tests, no camera needed (cargo test: 5 more)
npm run probe:keysend     # measure which key-sending method moves a Space
```

**Not solved:** bundling the Node runtime into the `.app`. A built app still
expects `node` on `PATH` and the project directory present (`GESTURE_ROOT`
overrides). Nor is code signing — see §10.

---

## 12. End to end: what happens when you hold up an open hand

1. **Launch.** `Gesture.app` starts, finds `node`, spawns the server and waits
   for port 4321 to accept a connection. It shows the orb, and launches the
   engine: Chrome with its own profile at `/?engine=1`, hidden.
2. **Page load.** Fetches `/config` (bindings, tuning, `clientActions`) and
   `/health` (backend, permissions). Posts `/client` with its engine
   capabilities, and opens the `/events` stream.
3. **Start camera.** A click on the orb posts `/camera {on: true}`; the server
   sends a `camera` event; the engine calls `getUserMedia` at 640×360. If
   `MediaStreamTrackProcessor` exists, it clones the track, transfers `readable`
   into the Worker and posts `start`. The worker loads MediaPipe and answers
   `ready`; the page reports `on`, and the orb glows.
4. **Per frame.** The worker reads a `VideoFrame` and runs `HandLandmarker`:
   every frame while a hand is in view, one every 125 ms when none is. It posts
   21 landmarks. The main thread stamps `performance.now()`, converts to
   aspect-corrected points, and calls `recognizer.update()`.
5. **Recognition.** The hand reads `open_palm`, held still, for its 1.2 s hold
   (`holdMs.open_palm`). The recogniser returns `open_palm`.
6. **Dispatch.** `onGestureDetected('open_palm')`. It's not a client action,
   and the page is armed, so it sends `POST /gesture {"gesture":"open_palm"}`.
7. **Server.** Origin and content-type pass. `open_palm` resolves to
   `audio_play`. Cooldown is clear, so the slot is claimed. Not dry-run.
   Accessibility is checked *now*, because it can be revoked while running.
8. **Press.** The `cgevent` backend resolves `audio_play` to NX type 16 and runs
   `keysend media 16`, which posts an `NSSystemDefined` event at the HID tap.
9. **Answer.** `{ ok: true, fired: true, shortcut: "audio_play" }`. The page logs
   `open_palm -> audio_play` and posts the reaction to `/mascot`; the orb opens
   to "Open palm → play / pause". Music pauses.

With **close your hand** bound (`grab`, unbound by default) instead, step 5 is
`view.shape` reading `open_palm` for at least 150 ms, then `fist` within 600 ms,
and `GrabDetector` returns `grab`.

And when you **make an OK sign** instead:
- **Step 5:** it fires after its 500 ms hold, even while disarmed. The `canFire`
  predicate allows it, and records the cooldown so a held OK sign doesn't toggle
  on every frame.
- **Step 6:** it finds `toggle_armed` in `clientActions`, calls
  `setArmed(!armed, 'ok_sign')`, and **returns without contacting the server at
  all**.

And when you **cover the camera**, if `cover` is bound (it isn't by default;
`fist` locks the screen):
- **The worker:** besides the landmarks, it posts the mean and spread of a 16×9
  thumbnail's brightness. Only then: it isn't measured otherwise.
- **`CoverDetector`:** once the frame is darker than 30% of the last 5 s and
  flat for 1 s, it returns `cover`.
- **The rest:** from step 6 on, as for any key binding.

And when you **swipe left**: step 8 becomes `spaceStrategy: "osascript"` →
`osascript -e 'tell application "System Events" to key code 124 using control
down'`. The server answers at once, then samples `CGSGetActiveSpace` for 2 s
in the background. If the desktop didn't move, or moved and snapped back, it
sends a `problem` event: the page plays the fail cue and the orb says so.

And when you **look at the BenQ and pinch**:
1. Every other frame, the face landmarks move `ScreenTracker` onto the BenQ's
   display id, and the reading goes into the facing history.
2. Step 5 returns `pinch` after its 180 ms hold.
3. Step 6 finds `focus_screen` in `screenActions`. `screenDuring()` finds the
   BenQ held for the whole hold, and the page posts
   `{"gesture": "pinch", "screen": 2}`.
4. The server checks display 2 is connected and runs `keysend focus 2`, which
   raises the BenQ's front window and puts the pointer on it.

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
- **Taught gestures never run in the four-finger pose.** Remove that guard and a
  taught shape near it fires while you're getting ready to swipe.
- **A movement follows `view.shape`, never `view.pose`.** The pose is
  stillness-gated, and a hand closing moves a little, so `GrabDetector` fed
  `pose` misses the close.
- **A fist is not a gesture of intent.** It's also a resting hand and a
  thumbs-up, which the camera reads as a fist. In v1 it played music on both.
- **A held open palm is not either.** It's the commonest "hello" and resting
  hand, and as lock screen it locked the Mac by accident on 24 Oct.
- **Both are bound anyway, by choice.** After trying it live on 25 Oct, fist
  locks the screen and a 1.2 s open palm plays and pauses. Close-your-hand
  (`grab`) and covering the lens (`cover`) are the intent-only alternatives,
  built and unbound; switch to them if the check-up shows misfires.
- **No screen is not the nearest screen.** Past `screenMaxAngle` the tracker says
  `null` on purpose. "Helpfully" falling back to the closest one makes a glance at
  your notebook focus the laptop.
- **`app.exit()` fires `CloseRequested`.** A close handler that always prevents
  will cancel your quit.
- **Shutting the recogniser's gate does not stop a gesture.** `canFire` decides
  whether a fire is recorded; the pose still comes back and a client action acts
  on it. To silence gestures, don't dispatch, as the check-up and the Lab do.
- **MediaPipe masks come back at the input's size.** Feed the segmenter a full
  camera frame and the copy alone costs more than the model.

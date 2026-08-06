# gesture

Watch your hand through the webcam, press keyboard shortcuts on your machine.

A browser page reads 21 hand landmarks with MediaPipe and works out which gesture
you're making. When it spots one, it sends the gesture *name* to a small Node
server on localhost, which presses the matching shortcut. A fist pauses music, a
pinch opens Mission Control, an open palm locks the screen, and a 4-finger swipe
moves between Spaces.

Every mapping lives in [`config.json`](config.json). Change what a gesture does by
editing that file — the server picks it up on save, no restart and no code changes.

```
browser: camera -> landmarks -> gesture name  --POST-->  server: shortcut -> key press
```

## Desktop app (Tauri)

A thin native shell lives in [`src-tauri/`](src-tauri). It adds the three things a
browser tab cannot do — a menu bar item, start-at-login, and staying alive with
no window — while the recogniser and the key pressing stay exactly as they are.

```bash
npm run app:dev     # run it
npm run app:build   # produce Gesture.app
```

Needs a Rust toolchain (<https://rustup.rs>) on top of the normal setup.

**How it fits together.** The shell starts `node server/index.js` as a child
process and points a webview at `http://127.0.0.1:4321` — the same page you'd
open in a browser. Nothing in `public/` or `server/` changes. Loading over
`http://127.0.0.1` rather than bundled assets keeps the page same-origin with the
server it POSTs to, and keeps it on an origin macOS treats as a secure context,
which `getUserMedia` requires. If a server is already listening, the app attaches
to it instead of starting a second one, so `npm start` in a terminal and the app
remain interchangeable.

Closing the window hides it to the menu bar rather than quitting — detection is
meant to keep running while you work. **Quit Gesture** in the tray menu is the
way out, and it kills the server it started.

**The permissions move with it.** The Accessibility grant follows the
*responsible* app, so once you run the bundled app it is `Gesture` that needs
ticking, not your editor. `Info.plist` also declares `NSCameraUsageDescription`
and `NSAppleEventsUsageDescription`; the second is what lets the Automation
prompt appear for the `osascript` Space strategy, and without it Space switching
fails with error 1002.

**Known risk — the camera in the webview.** macOS `getUserMedia` inside a
WKWebView is the subject of open Tauri bugs
([wry#1195](https://github.com/tauri-apps/wry/issues/1195),
[tauri#11951](https://github.com/tauri-apps/tauri/issues/11951)), and this app is
a camera app. Verify it before building anything else on top: run
`npm run app:dev` and click **Start camera**. The tray has an **Open in Browser…**
item as the fallback — the same page works in Chrome, and the menu bar,
auto-launch and background behaviour are unaffected either way.

Bundling the Node runtime into the `.app` is **not** solved yet: a built app
still expects `node` on `PATH` and the project directory present. Set
`GESTURE_ROOT` if it cannot find `server/index.js`.

## Requirements

- **Node 22 or newer** (developed on 26.4)
- **macOS** for the key-press half. The browser half is cross-platform, but both
  keyboard backends are macOS-only right now.

## Setup

```bash
npm install
```

```bash
npm run build:native
```

```bash
npm start
```

`build:native` compiles a ~100-line Swift helper with the Xcode command line
tools. It is optional but strongly recommended: **without it, Space switching does
not work at all** — see *Backends* below. Everything else works either way.

Then open <http://127.0.0.1:4321>, click **Start camera**, and click **Armed**.

Nothing is sent to the server until you arm it. Press <kbd>Esc</kbd> at any time to
disarm.

### Grant Accessibility access first

macOS silently discards synthetic key events from apps without Accessibility
access. Not an error — the press just does nothing, which looks exactly like a
broken gesture detector.

**System Settings → Privacy & Security → Accessibility** → enable the terminal app
you run `npm start` from (Terminal, iTerm, VS Code, …), then restart the server.

The server checks this at startup and refuses to be quiet about it: you'll get a
warning in the console and a banner on the page if it's missing.

### For the swipe gestures

You need **more than one Space** for anything to be visible — add desktops in
Mission Control. Use the **test** button next to `swipe_left` in the UI to check
this independently of hand tracking.

You do *not* need the Mission Control keyboard shortcuts for this. The default
bindings are `space_right` / `space_left`, which route through System Events
rather than injecting `ctrl+←`/`→` directly — because on macOS 26 a directly
injected keystroke cannot switch Spaces. See *Why Spaces don't respond to a key this process presses*.

## Gestures

| Gesture      | Hand                                     | Default binding | Does                |
| ------------ | ---------------------------------------- | --------------- | ------------------- |
| `fist`       | all fingers curled                       | `audio_play`    | pause/play music    |
| `pinch`      | thumb and index tip together             | `ctrl+up`       | Mission Control     |
| `open_palm`  | all five out, **still for 1.2s**         | `cmd+ctrl+q`    | lock screen         |
| `swipe_left` | four fingers out, hand travels **left**  | `space_right`   | next Space          |
| `swipe_right`| four fingers out, hand travels **right** | `space_left`    | previous Space      |

### Not every shortcut is equal — this is the main gotcha

The server presses keys; **something has to be listening.** Bindings fall into three
kinds, and only the first works with no setup at all:

1. **macOS built-ins** — `cmd+ctrl+q` (lock screen), `ctrl+up` (Mission Control).
   System-wide, always listening.

   **Space switching is the exception.** `ctrl+←` / `ctrl+→` work from your
   keyboard but not from one this process synthesizes — macOS refuses the match
   while still handing the keystroke to the focused app, so the tab navigates and
   the desktop sits still. Use the `space_left` / `space_right` actions instead,
   which route through System Events. See *Why Spaces don't respond to a key this
   process presses*.
2. **Media keys** — `audio_play`, `audio_mute`, `audio_next`, `audio_vol_up`… These
   go to whatever owns media playback regardless of focus, which is why `fist` uses
   `audio_play` rather than `space`. A plain `space` is *not* a shortcut: it's
   delivered to the frontmost app, so it only pauses music if the music app is
   focused — and it won't be, because you'll be looking at this page.
3. **App shortcuts** — need that app to be listening, and most are focus-only.
   macOS ships **no** global mic-mute shortcut, which is why `pinch` defaults to
   `ctrl+up` (Mission Control) rather than a mute. If you want mic mute, Zoom can
   do it globally: **Zoom → Settings → Keyboard Shortcuts → Mute/Unmute My Audio →
   Enable Global Shortcut** (`cmd+shift+a`). Without that checkbox Zoom only hears
   it while focused. Teams' `cmd+shift+m` is focused-only with no global option.

   One shortcut is rejected outright: a bare `escape`. It is this page's panic
   disarm, and the page is normally the frontmost window — so binding it would
   make the first pinch silently disarm everything after it.

If a gesture shows `-> shortcut` in the Activity log but nothing happens, the
detection worked and the *binding* has no listener — look at this list, not at your
hand.

### How to make a swipe

The swipe is the fussiest gesture, because a swipe is a *motion* while the other
three are *poses*. Concretely:

1. **Four fingers extended.** Thumb wherever — it's ignored.
2. **Move your whole hand sideways, briskly.** Your palm needs to cover about
   **1.2 palm-widths** (roughly 10–12 cm) within **350 ms**. That's a flick, not a
   drift. This is what people get wrong first: a slow, careful sweep registers as
   nothing at all.
3. **Keep it level.** Vertical movement must stay under half the horizontal
   movement, so a diagonal wave is rejected.
4. **Curl your fingers afterwards** to re-arm before the next swipe.

Watch **Palm speed** on the page while you try it — it shows your current speed
next to the threshold, so you can see which side of the line you're on. If your
swipes are honest and still not registering, lower `swipeMinTravel` toward `0.8`.

### Why the open palm and the swipe fight each other

The swipe pose — four fingers out — is a **subset** of the open-palm pose. There's
no hand shape that is one and not the other, so all three phases of a swipe collide
with `open_palm`, and each needs its own guard:

| Phase | Problem | Guard |
| --- | --- | --- |
| **Before** | Getting into position means holding a stationary open palm | `open_palm` needs a deliberate **1200 ms** hold (`holdMs`) |
| **During** | The moving hand still matches `open_palm` | Static poses ignored above `stillnessMaxVelocity` |
| **After** | The swipe *ends* in the swipe pose, so resting matches `open_palm` | Static poses suppressed until the pose is broken |

Miss any one and a swipe locks your screen. If `open_palm` still fires when you
meant to swipe, either start moving sooner after raising your hand, or raise its
`holdMs` further.

A few other things worth knowing:

- **Swipe direction is the direction your hand travels**, matching the mirrored
  preview. The defaults are trackpad-like — you push the current screen out of the
  way — so travelling left brings in the next Space from the right. If that feels
  backwards, swap the two values in `config.json`.
- **It keeps working when you switch apps.** Detection runs in a Web Worker, which
  browsers don't throttle, so the window needs neither focus nor visibility. The
  *Detection* row shows a live frame rate so you can confirm it. (See
  [Always-on detection](#always-on-detection) for why this isn't the obvious
  implementation.)

## config.json

```json
{
  "gestures": {
    "fist": "audio_play",
    "pinch": "ctrl+up",
    "open_palm": "cmd+ctrl+q",
    "swipe_left": "space_right",
    "swipe_right": "space_left"
  },
  "holdMs": {
    "default": 180,
    "open_palm": 1200
  },
  "cooldownMs": 1200,
  "requireReleaseBetweenFires": true,
  "stillnessMaxVelocity": 0.8,
  "swipeWindowMs": 350,
  "swipeMinTravel": 1.2,
  "swipeMinVelocity": 3.0,
  "swipeMaxVerticalRatio": 0.5,
  "swipeRearmRequiresPoseBreak": true,
  "invertSwipeDirection": false,
  "backend": "auto",
  "keysendSource": "hid",
  "spaceStrategy": "osascript",
  "dockSwipeVariant": "iss",
  "dockSwipeVelocity": 400,
  "dockSwipeLingerMs": 300,
  "dockSwipeWithTap": true,
  "verifySpaceSwitch": true,
  "dryRun": false,
  "port": 4321
}
```

The flat shorthand also works, if you only care about bindings:

```json
{ "fist": "space", "pinch": "cmd+shift+m" }
```

### Shortcut syntax

Modifiers `cmd` `ctrl` `alt` `shift` (plus `command`/`meta`/`super`, `control`,
`opt`/`option`), joined with `+`, ending in a key:

- letters `a`–`z`, digits `0`–`9`
- `space` `enter` `tab` `escape` `up` `down` `left` `right` `delete` `backspace`
  `home` `end` `pageup` `pagedown` `f1`–`f12`
- punctuation: `minus` `equal` `comma` `period` `slash` `semicolon` `quote`
  `backslash` `backtick` `leftbracket` `rightbracket`
- media: `audio_play` `audio_mute` `audio_next` `audio_prev` `audio_vol_up`
  `audio_vol_down`

Shortcuts are parsed when the config loads, so a typo is reported immediately with
the gesture name attached instead of failing silently the first time you make that
gesture. An invalid file is rejected whole and the previous config stays live.

> The `audio_*` media keys need `cgevent` or `nutjs` — System Events, and therefore
> the `osascript` fallback, cannot synthesize them.
>
> A bare `escape` is rejected: it is the page's panic disarm, so binding it would
> make that gesture silently switch everything off.

### Backends

Three ways to press a key, tried in this order under `"backend": "auto"`:

| Backend | Needs | Can switch Spaces | Can send media keys |
| --- | --- | --- | --- |
| `cgevent` | `npm run build:native` | **yes** | yes |
| `nutjs` | nothing (prebuilt) | **no** | yes |
| `osascript` | nothing | no | no |

**Why `nutjs` cannot switch Spaces.** Its native module, libnut, sets the modifier
as a *flag* on the key event and never emits a `kCGEventFlagsChanged`. It
structurally cannot: `nm` on `libnut.node` shows `CGEventCreateKeyboardEvent`,
`CGEventSetFlags` and `CGEventPost`, and no `CGEventSetType` anywhere — and
`CGEventSetType` is the only way to turn a keyboard event into a `flagsChanged`
one. Applications read flags straight off the event, so Chrome sees a real
`Ctrl+→` and navigates. macOS matches symbolic hotkeys, including Mission
Control's *Move left/right a space*, against the WindowServer's **global**
modifier state, which only `flagsChanged` updates — so the desktop never moves.
The symptom is unmistakable: *the tab goes back, but the Space doesn't change*.

`cgevent` shells out to `native/keysend.swift`, which posts the `flagsChanged`
pair around the key at `kCGHIDEventTap`, exactly as a real keyboard does.

### Why Spaces don't respond to a key this process presses

On macOS 26.4, a `Ctrl+→` that **this process** synthesizes will not switch
Spaces — measured with `npm run probe:keysend` against `CGSGetActiveSpace`:

| Method | Result |
| --- | --- |
| nut.js, both ways | never moves |
| Swift helper, real `flagsChanged`, all four `CGEventSource` state tables | never moves |
| **`osascript` via System Events** | **moves, and stays** |
| `CGSManagedDisplaySetCurrentSpace` (private) | moves; can snap back |
| Dock-swipe gesture (private fields) | moves; snapped back in 2 of 4 configs |

The giveaway on the failing rows is that the terminal echoes `^[[1;5C`. The
keystroke *is* delivered to the focused application; the WindowServer just
declines to match it against the Space-navigation hotkey. Synthetic `ctrl+up`
still opens Mission Control, so this is specific to Space navigation.

What works is routing the keystroke through **System Events** rather than
injecting it directly — the OS pressing its own key, which is evidently a
different path. That is `spaceStrategy: "osascript"`, the default, and it uses no
private API at all. It needs Accessibility *and* Automation permission for
whichever app runs the server.

Two private fallbacks exist for when that stops working, selectable via
`spaceStrategy`. Both move the Space and both can be undone by macOS ~1.5s later
when keyboard focus stays with an app on the Space you left — which is what
`"the desktop moved and then snapped back"` in the log means. One of them posts
the trackpad's **dock-swipe gesture**, the way Mac Mouse Fix and BetterTouchTool
do it:

That is what `space_left` and `space_right` are. They are actions, not key
chords — `cmd+space_right` is rejected at config load, because there is no chord
to modify.

```bash
native/build/keysend swipe right --verbose
```

Three `kCGSEventDockControl` events (phases began / changed / ended), **each
followed by a companion `kCGSEventGesture` event**, posted to the *session* tap
— not the HID tap where key events go in. Both the pairing and the tap are
required; a lone dock event on the HID tap is silently ignored, which is the
easiest way to write this and have it do nothing.

Two field layouts ship, because the two known-good implementations disagree and
neither is documentation:

| `--variant` | Field 119 | Field 135 encoding | Exit velocity |
| --- | --- | --- | --- |
| `iss` (default) | `0` | float bits as **int32** | X only |
| `mmf` | `FLT_TRUE_MIN` | float bits as **uint32** | X and Y |

Neither reference posts a dock swipe from a short-lived process: both are daemons
holding a session event tap. `dockSwipeWithTap` and `dockSwipeLingerMs` exist so
this helper can match that, because a one-shot that posts and exits microseconds
later is measurably not the same thing.

`npm run probe:keysend -- --swipe-only` sweeps the configurations and reports
which moved the desktop.

The field indices are undocumented and reverse-engineered — stable in practice
but not API, and Apple moved the payload layout again in the macOS 27 betas
(where a serialized IOHID blob in field 4205 is needed instead). Treat this as
one backend among several, never as the only way the app can act.

**`keysendSource`.** Emitting a `flagsChanged` is necessary but not sufficient —
it also has to land in a state table the WindowServer consults. A `CGEventSource`
created with `.privateState` has a table nobody else reads, which could satisfy
the focused application and still be invisible to Mission Control: the same shape
of bug as libnut's flag bit, one level up. So the table is a setting, defaulting
to `hid` (`.hidSystemState`, what real hardware uses), and `npm run probe:keysend`
measures which one actually moves a Space on your machine.

`auto` skips any backend that cannot express one of your actual bindings, so
`osascript` is passed over while `fist` is bound to a media key rather than
500-ing once per press.

To check the mechanism on your own machine, with the server stopped:

```bash
npm run probe:keysend
```

It sends the chord every way there is — nut.js two ways, the Swift helper once per
`keysendSource`, and `osascript` as a baseline — reading the current Space from
`com.apple.spaces` before and after each, then prints a plain-language verdict
naming the value to pin in `config.json`. It picks the direction with room to move
each time, so starting on the last Space cannot produce a false negative, and it
walks the desktop back where it found it.

It refuses to run without Accessibility, because macOS discards synthetic keys
silently and every method would otherwise report a false negative. Run it from the
same app you start the server from — the grant follows that app, not `node`.

Once the server is running, you don't need the probe to see this: with
`verifySpaceSwitch` on, every swipe reports whether the desktop actually moved.

```
swipe_left -> space_right  (space main 2/4 -> main 3/4)
```

and when it didn't:

```
swipe_left -> space_right
  !! sent, but the desktop did not move — still on main 2/4.
  !! The press itself succeeded, so this is not the gesture detector,
  !! not the cooldown and not the binding. backend=cgevent
```

That line is the whole point: it separates *the key was never sent* from *the key
was sent and macOS ignored it*, which are the two halves this bug kept blurring.

### Tuning

| Setting | Meaning |
| --- | --- |
| `cooldownMs` | Minimum gap between two fires of the same gesture. |
| `holdMs` | How long a pose must be held, in ms. A number applies to all; an object like `{ "default": 180, "open_palm": 1200 }` sets it per gesture. Swipes bypass this. |
| `requireReleaseBetweenFires` | Change pose before the same one can fire again. |
| `stillnessMaxVelocity` | Above this palm speed, static poses are ignored. |
| `swipeWindowMs` | How far back swipe travel is measured. |
| `swipeMinTravel` | Horizontal distance needed, in palm-widths. |
| `swipeMinVelocity` | Speed floor, in palm-widths per second. |
| `swipeMaxVerticalRatio` | How diagonal a swipe may be before it's rejected. |
| `swipeRearmRequiresPoseBreak` | Curl fingers between swipes. |
| `invertSwipeDirection` | Flip left/right, for already-mirrored cameras. |
| `backend` | `auto`, `cgevent`, `nutjs`, `osascript`, or `dryrun`. See *Backends*. |
| `keysendSource` | Which `CGEventSource` state table the `cgevent` helper posts from: `hid`, `combined`, `private` or `null`. Only this backend reads it. See *Backends*. |
| `spaceStrategy` | How `space_left`/`space_right` are performed: `osascript` (default, no private API), `direct`, or `dockswipe`. |
| `dockSwipeVariant` | Field layout when `spaceStrategy` is `dockswipe`: `iss` or `mmf`. |
| `dockSwipeVelocity` | Exit speed of the simulated flick. Too low and the Dock rubber-bands back. |
| `dockSwipeLingerMs` | How long the helper stays alive after posting, so the Dock can finish acting on the gesture. |
| `dockSwipeWithTap` | Hold a session event tap while posting, as both reference implementations do. |
| `verifySpaceSwitch` | After a Space-switching gesture, check whether the desktop actually moved and say so in the log. |
| `dryRun` | Recognize and log gestures, press nothing. |

Speeds and distances are in **palm-widths** (multiples of wrist→middle-knuckle
distance), so they hold at any distance from the camera. The page shows live palm
speed next to the threshold, which is the easiest way to tune by feel.

## Layout

```
config.json          bindings and tuning — the only file most people touch
server/
  index.js           Express: static page, POST /gesture, /config, /health
  config.js          load, validate, hot-reload
  shortcut.js        "cmd+shift+m" -> { modifiers, key }
  permissions.js     Accessibility check
  macos.js           Spaces, symbolic hotkeys, responsible-app lookup
  backends/          cgevent, nutjs, osascript, resolution order
public/
  app.js             camera, detection loop, overlay, POST
  landmarks.js       shared geometry over the 21 landmarks
  gestures.js        static pose classification (pure)
  swipe.js           motion tracking (stateful)
test/                node:test — 45 tests, no camera needed
```

`npm test` covers the parts where the real logic lives: pose classification,
swipe detection, and shortcut parsing. Hands are generated geometrically rather
than recorded, so cases like *fist that looks like a pinch* and *swipe followed by
a return stroke* are explicit fixtures.

```bash
npm test
```

## Always-on detection

The app exists to drive *other* applications, so its own window is almost never the
visible one — and browsers aggressively suspend hidden pages. Measured on this
machine with the tab hidden:

| Loop | fps while hidden |
| --- | --- |
| `requestAnimationFrame` | 0 |
| `requestVideoFrameCallback` | 0 |
| `setInterval` | 1.5 |
| `setInterval` while playing audio | 1.5 |
| **`setInterval` inside a Web Worker** | **62.5** |

The usual "keep the tab awake by playing silent audio" trick does nothing here. Only
workers escape the throttle. Note also that the *camera never stops* — it's the
page's loop that gets suspended — so the frames are there to be read.

So detection lives in [`public/detector-worker.js`](public/detector-worker.js):

- Frames are read straight off the camera track with `MediaStreamTrackProcessor`,
  which hands the worker `VideoFrame`s without involving the page's render loop.
- The track is **cloned** for the worker, because a track processor consumes the
  track it's given and would otherwise blank the preview.
- The worker posts landmarks to the main thread, which is unthrottled for message
  delivery (measured 188 sent, 188 received while hidden) even though its own timers
  are clamped. So the recognizer and the `fetch` to the server can stay on the main
  thread, unchanged.
- It's a **classic** worker, not a module worker: MediaPipe's WASM glue fails with
  `ModuleFactory not set.` when its ESM bundle is loaded in a worker. `importScripts`
  of the UMD build works and exposes a `Vision` global.

`MediaStreamTrackProcessor` is Chrome-only, so there's a fallback to the in-page
`requestVideoFrameCallback` loop. That path genuinely does pause when hidden, and
says so in the *Detection* row rather than looking broken.

One trap worth knowing if you touch this: a Worker has its own
`performance.timeOrigin`, so its `performance.now()` is on a different clock than the
page's. Timestamps are therefore taken on the main thread, and the worker's clock is
used only for MediaPipe's internal monotonicity requirement and never sent across.

## Design notes

**The wire protocol carries gesture names, never key combos.** `POST /gesture`
takes `{"gesture": "fist"}` and the server resolves the shortcut from its own
config. The worst a compromised page can do is trigger something you already
bound; it can't ask for arbitrary keys.

**The server only listens on 127.0.0.1** and rejects cross-origin requests. Both
matter: without the origin check, any website open in your browser could POST to
this port while the server runs and lock your screen as a drive-by.

**Cooldown is enforced server-side too**, not just in the page, so a duplicated
tab or a reload mid-gesture can't spam key presses.

**On the two dependency choices:**

- `@nut-tree-fork/nut-js` rather than `@nut-tree/nut-js` — the original was pulled
  from npm (it 404s) and its prebuilt binaries moved behind a paid subscription.
  The fork is Apache-2.0 and maintained, and `libnut` under it is an N-API module,
  which is why the prebuilt binary works on current Node.
- `@mediapipe/tasks-vision` rather than `@mediapipe/hands` — the legacy Hands
  solution was last published in 2023 and its docs now redirect to
  `HandLandmarker`. Same 21 landmarks, same indices, maintained package.

MediaPipe's WASM runtime, its JS bundles and the 7.8 MB model load from a CDN at
runtime. To vendor all of it (~30 MB, gitignored):

```bash
npm run fetch-model
```

The page prefers the local copies when they exist, and logs a note when it falls
back to the CDN.

This is worth doing for more than offline support. `detector-worker.js` calls
`importScripts()` on the tasks-vision bundle *inside the worker that holds raw
camera `VideoFrame`s*, and `importScripts` cannot carry a Subresource Integrity
hash — so loading it from a CDN lets a third party execute code in the one context
with direct access to your camera. Vendoring is what closes that.

## Troubleshooting

**Gestures fire in the log but nothing happens.** Accessibility access — see
above. This is the common one.

**Swipes fire, the log says the key was sent, and the desktop never moves.** With
`verifySpaceSwitch` on, the server tells you this explicitly rather than leaving
you to notice. It means the press succeeded and macOS ignored it, which rules out
the detector, the cooldown and the binding. On macOS 26 the cause is the OS
itself refusing Space navigation from directly injected keys — see *Why Spaces
don't respond to a key this process presses*. Confirm with `ctrl+→` on your own keyboard: if that *does*
work while gestures don't, that is the signature.

**Nothing fires at all.** Check the *Detection* row. It should read `running` with a
frame rate in the 20–60 range. `off` means the camera isn't started; `stalled` means
frames stopped arriving; `paused (tab hidden)` means you're on the fallback path in a
browser without `MediaStreamTrackProcessor` — use Chrome. Also check you're armed.

**Swipes don't register.** Watch *Palm speed* while you swipe. If it stays under
`swipeMinVelocity` you're moving too slowly for a deliberate gesture; either swipe
harder or lower the threshold. If *Swipe ready* says `curl fingers`, you're still
in the previous swipe's pose.

**Open palm locks the screen when I meant to swipe.** You're holding the pose too
long before moving — raise `holdMs.open_palm` above 1200, or start the sweep sooner
after your hand comes up. See *Why the open palm and the swipe fight each other*.

**The tab navigates but the Space doesn't change.** You're on the `nutjs` backend.
Run `npm run build:native` and restart — the console says which backend loaded, and
warns explicitly when `nutjs` is in use with a Space-switching binding. See
*Backends*.

**It worked for a while, then stopped.** Check the arm state on the page. Anything
that presses <kbd>Esc</kbd> while the page is frontmost disarms it — a bare
`escape` binding is now rejected at config load for exactly this reason. The
Activity log records every arm and disarm.

**Detection died after the screen locked.** `open_palm` defaults to `cmd+ctrl+q`,
which locks the screen, which mutes the camera. The page watches for this and
restarts detection on its own once the camera comes back; the Activity log shows
`camera muted` → `camera unmuted` → `detection recovered`. If it says `camera
restart failed`, press **Start camera**.

**The wrong direction.** Set `invertSwipeDirection: true` — some virtual cameras
deliver an already-mirrored stream.

**Something else pressed a key.** Press <kbd>Esc</kbd> to disarm, or set
`"dryRun": true` to watch what would fire without anything happening.

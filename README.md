# gesture

Watch your hand through the webcam, press keyboard shortcuts on your machine.

A browser page reads 21 hand landmarks with MediaPipe and works out which gesture
you're making. When it spots one, it sends the gesture *name* to a small Node
server on localhost, which presses the matching shortcut. A fist pauses music, a
pinch mutes the mic, an open palm locks the screen, and a 4-finger swipe moves
between Spaces.

Every mapping lives in [`config.json`](config.json). Change what a gesture does by
editing that file — the server picks it up on save, no restart and no code changes.

```
browser: camera -> landmarks -> gesture name  --POST-->  server: shortcut -> key press
```

## Requirements

- **Node 22 or newer** (developed on 26.4)
- **macOS** for the key-press half. The browser half is cross-platform, but both
  keyboard backends are macOS-only right now.

## Setup

```bash
npm install
```

```bash
npm start
```

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

`ctrl+←` / `ctrl+→` need **System Settings → Keyboard → Keyboard Shortcuts →
Mission Control → Move left/right a space** enabled. They're on by default but
frequently switched off, and you need more than one Space for anything to be
visible. Use the **test** button next to `swipe_left` in the UI to check this
independently of hand tracking.

## Gestures

| Gesture      | Hand                                     | Default binding | Does                |
| ------------ | ---------------------------------------- | --------------- | ------------------- |
| `fist`       | all fingers curled                       | `audio_play`    | pause/play music    |
| `pinch`      | thumb and index tip together             | `cmd+shift+a`   | mute mic (Zoom)     |
| `open_palm`  | all five out, **still for 1.2s**         | `cmd+ctrl+q`    | lock screen         |
| `swipe_left` | four fingers out, hand travels **left**  | `ctrl+right`    | next Space          |
| `swipe_right`| four fingers out, hand travels **right** | `ctrl+left`     | previous Space      |

### Not every shortcut is equal — this is the main gotcha

The server presses keys; **something has to be listening.** Bindings fall into three
kinds, and only the first works with no setup at all:

1. **macOS built-ins** — `cmd+ctrl+q` (lock screen) and `ctrl+←`/`ctrl+→` (switch
   Spaces). System-wide, always listening. The Spaces ones need **Keyboard →
   Keyboard Shortcuts → Mission Control → Move left/right a space** enabled (on by
   default) and more than one Space to exist.
2. **Media keys** — `audio_play`, `audio_mute`, `audio_next`, `audio_vol_up`… These
   go to whatever owns media playback regardless of focus, which is why `fist` uses
   `audio_play` rather than `space`. A plain `space` is *not* a shortcut: it's
   delivered to the frontmost app, so it only pauses music if the music app is
   focused — and it won't be, because you'll be looking at this page.
3. **App shortcuts** — need that app to be listening. macOS ships **no** global
   mic-mute shortcut, so `pinch` uses Zoom's: set **Zoom → Settings → Keyboard
   Shortcuts → Mute/Unmute My Audio → Enable Global Shortcut** (`cmd+shift+a`).
   Without that checkbox Zoom only hears it while focused. Teams uses
   `cmd+shift+m` natively, focused only.

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
    "pinch": "cmd+shift+a",
    "open_palm": "cmd+ctrl+q",
    "swipe_left": "ctrl+right",
    "swipe_right": "ctrl+left"
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

> The `audio_*` media keys need the `nutjs` backend — System Events, and therefore
> the `osascript` fallback, cannot synthesize them.

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
| `backend` | `auto`, `nutjs`, `osascript`, or `dryrun`. |
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
  backends/          nutjs, osascript, resolution order
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

MediaPipe's WASM and the 7.8 MB model load from a CDN at runtime. To work offline:

```bash
npm run fetch-model
```

The page prefers the local copy when it exists. It's gitignored.

## Troubleshooting

**Gestures fire in the log but nothing happens.** Accessibility access — see
above. This is the common one.

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

**The wrong direction.** Set `invertSwipeDirection: true` — some virtual cameras
deliver an already-mirrored stream.

**Something else pressed a key.** Press <kbd>Esc</kbd> to disarm, or set
`"dryRun": true` to watch what would fire without anything happening.

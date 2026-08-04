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
| `open_palm`  | all five out, **held still**             | `cmd+ctrl+q`    | lock screen         |
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

A few things worth knowing about how these behave:

- **Open palm vs. swipe is decided by motion, not by your thumb.** An open hand
  held still locks the screen; the same hand swept sideways switches Spaces. The
  thumb is the least reliable of the 21 landmarks, so it never decides anything on
  its own.
- **Swipe direction is the direction your hand travels**, matching the mirrored
  preview. The defaults are trackpad-like — you push the current screen out of the
  way — so travelling left brings in the next Space from the right. If that feels
  backwards, swap the two values in `config.json`.
- **Between swipes, curl your fingers.** Otherwise the return stroke of your hand
  would fire the opposite swipe and undo the one you just made.
- **Keep the window visible while gesturing.** It doesn't need focus — put it on a
  second monitor or beside your work — but browsers suspend camera processing in
  hidden tabs. The page's *Detection* row tells you when this happens.

## config.json

```json
{
  "gestures": {
    "fist": "space",
    "pinch": "cmd+shift+m",
    "open_palm": "cmd+ctrl+q",
    "swipe_left": "ctrl+right",
    "swipe_right": "ctrl+left"
  },
  "cooldownMs": 1200,
  "confirmFrames": 4,
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

> `fist: "space"` only pauses music if the player has focus. `audio_play` is the
> system-wide media key and works regardless of what's focused — but it needs the
> `nutjs` backend, since System Events can't send media keys.

### Tuning

| Setting | Meaning |
| --- | --- |
| `cooldownMs` | Minimum gap between two fires of the same gesture. |
| `confirmFrames` | Frames a static pose must hold before it counts. Swipes bypass this. |
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

**Nothing fires at all.** Check the *Detection* row. `paused (tab hidden)` means
the window isn't visible. `off` means the camera isn't started. Also check you're
armed.

**Swipes don't register.** Watch *Palm speed* while you swipe. If it stays under
`swipeMinVelocity` you're moving too slowly for a deliberate gesture; either swipe
harder or lower the threshold. If *Swipe ready* says `curl fingers`, you're still
in the previous swipe's pose.

**Open palm locks the screen when I meant to swipe.** Raise
`stillnessMaxVelocity`, or start moving before your fingers are fully extended.

**The wrong direction.** Set `invertSwipeDirection: true` — some virtual cameras
deliver an already-mirrored stream.

**Something else pressed a key.** Press <kbd>Esc</kbd> to disarm, or set
`"dryRun": true` to watch what would fire without anything happening.

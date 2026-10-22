# Gesture

**A camera-based input layer for a multi-display workspace.**

Hand-tracking models output noisy estimates. Operating systems execute commands. Gesture is the layer in between. It decides when a guess is confident enough to act on, acts through the OS, and tells you whether it worked.

Most webcam gesture demos stop at recognition. This project is about what happens after: when to trust a guess, how to know an action landed, and how to let a person teach the system their own gestures.

| Role | Stack | Timeline | Type |
| --- | --- | --- | --- |
| Concept, interaction design, system design, evaluation. Implementation by Claude Code under my direction. | MediaPipe Hand Landmarker (on-device), Web Workers, Web Audio, Node.js, Swift, Rust (Tauri) | 3-day build, August 2026. Launcher, sound cues and taught gestures added October 2026. | Self-initiated creative technology R&D |

> **Overview**
> **Context:** pen-and-paper planning beside a multi-display Mac. Every screen switch broke focus to go through the keyboard.
> **Question:** can a commodity webcam become an input device reliable enough to trust with real system actions?
> **Outcome:** a background, on-device gesture layer for macOS. It keeps working with its window hidden, confirms every gesture by sound, verifies every desktop switch it makes, and learns new gestures from five examples.

> **Visual:** one-take real-time video: notebook in the foreground, a hand swipes, the display changes. The cover is a still from it.

---

## Context

I plan in a notebook and work across several displays. Switching between them was constant, and every switch went through the keyboard: pen down, shortcut, find my place again.

The laptop's camera was already pointed at the desk. The project asked whether it could be a dependable input device rather than a demo, one that works in the background, never acts by accident, and needs no new hardware.

---

## Design principles

1. **No new hardware.** A commodity webcam and on-device inference. Nothing to wear, nothing to buy, nothing leaves the machine.
2. **Background-first.** The interface is invisible by design. The system has to work while its own window is hidden.
3. **Intent, not detection.** A detected hand is not a command. Acting needs confidence, duration and consent.
4. **Closed loop.** An action isn't finished until the system has confirmed the world changed, and told you.

Each section below tests one of these.

---

## System: perception → intent → action

| Layer | What it does | Where it runs |
| --- | --- | --- |
| **Perception** | MediaPipe's pretrained hand-landmark model returns 21 landmarks per frame. | On-device, in a Web Worker in Chrome |
| **Intent** | A recognizer I designed turns landmark streams into a single gesture name, or nothing. Built-in rules first, then gestures the user taught. | Chrome, as pure tested logic |
| **Action** | Maps the name to a system action through a config file, performs it, verifies the result, and answers with a sound. | Local Node.js server, with a Swift helper and macOS System Events |

**Privacy by architecture.** Video never leaves the device, and neither do the samples of taught gestures. Only a gesture name like `{"gesture":"fist"}` travels from the browser to the server, never a key code. The server binds to loopback and rejects cross-origin requests, so a website can't trigger it.

> **Visual:** a three-layer diagram, perception → intent → action, with the data passed at each step: frames → 21 landmarks → `"fist"` → media key → sound.

---

## Designing the intent layer

The model never says "fist". It returns 21 coordinates, every frame, with noise. Everything between those coordinates and a pressed key is design.

| Decision | Rule | Why |
| --- | --- | --- |
| Scale invariance | Every distance is measured in palm lengths (wrist to middle knuckle). | The same gesture works at 30 cm or at arm's length. |
| Rotation invariance | A finger counts as extended when its tip is farther from the wrist than its middle joint. | The common shortcut of comparing heights inverts as soon as the hand tilts. |
| Consequence-weighted dwell | Music: 180 ms. Screen lock: 1.2 s, held still. | The cost of a false positive sets the threshold. |
| Motion vs pose | Static poses are ignored above a velocity threshold. A swipe needs 1.2 palm lengths in 350 ms, with vertical movement under half the horizontal. | A swipe passes through the open-palm shape on the way. |
| Ambiguity | A pinch needs the index tip to reach more than 1.15 palm lengths from the wrist. | In a fist the thumb also touches the index finger. |
| Consent | The system starts disarmed. A pinch arms it. | A hand in frame is not intent. |

**The vocabulary**

| Gesture | Action | Threshold |
| --- | --- | --- |
| Four-finger swipe | Next or previous desktop | 1.2 palm lengths in 350 ms |
| Fist | Play or pause media | 180 ms |
| Pinch | Arm or disarm the system | 180 ms |
| Open palm | Lock the screen | 1.2 s, held still |

Bindings live in a config file that reloads on save. Remapping a gesture is a one-line change with no restart.

---

## Why these gestures

I chose the vocabulary for three things: what each shape already means, how far apart the shapes are, and what each action costs if it fires by mistake.

| Gesture → action | Why |
| --- | --- |
| Swipe → desktop | It's the trackpad gesture: you push the current screen aside. The thumb is ignored, because it's MediaPipe's least reliable landmark. |
| Fist → media | A closed hand reads as "stop". It's bound to the media key, not the space bar, so it reaches the music wherever it's playing, whichever app is in front. |
| Open palm → lock | The universal "stop" sign, for the most disruptive action, so it gets the longest hold. |
| Pinch → arm | A small, deliberate "click". It started as a keyboard shortcut and became the on/off switch, because consent has to live where the armed state lives. |

**The measurement agrees.** On generated hands, the two closest pairs of shapes are exactly the two collisions the project had to engineer around:

| Pair | Distance (palm lengths) | What keeps them apart |
| --- | ---: | --- |
| Fist and pinch | 0.20 | The index-reach rule |
| Open palm and the four-finger swipe shape | 0.27 | The 1.2 s hold and the stillness gate |
| Every other pair | 0.46–0.56 | Nothing extra needed |

The vocabulary also changed along the way. The first bindings pressed shortcuts nothing was listening for, so they did nothing. They were rebound to ones that have a system-wide listener on day one.

> **Visual:** a 4 × 4 distance matrix of the built-in shapes, with the two close pairs highlighted and labelled with the rule that separates them.

---

## Interface: an instrument panel for the model

Day to day the interface is invisible: the window is minimised and the gestures just work. While I was designing the intent layer, though, I needed to see what the model and the rules were doing in real time. So the page is built as an instrument panel. Every row answers a question that came up while tuning.

| Element | Shows | The question it answers |
| --- | --- | --- |
| Landmark overlay | The 21 landmarks drawn over the mirrored camera feed | What does the model actually see? |
| Detection | Background-worker or in-page mode, and the live frame rate | Is it still running now that I've switched apps? |
| Pose and Held | The current pose and how long it's been held | How close is this gesture to firing? |
| Palm speed | Current speed next to the stillness threshold, e.g. `0.42 / 0.8` | Was that a swipe or a held palm? |
| Swipe pose and Swipe ready | Four fingers detected, and whether the next swipe is armed | Why didn't my second swipe fire? |
| Taught match | The closest taught gesture and its distance next to the threshold, e.g. `peace 0.11 / 0.18` | How close was that near-miss? |
| Backend and Sound | The active key-sending method, and whether sound cues are on | Is this a detection problem or an OS problem? Will I hear it? |
| Arm button | Armed or Disarmed. Esc disarms instantly. | Is it allowed to act right now? |
| Bindings, test buttons, taught gestures | Each gesture, its action, a button that sends it without the camera, and the gestures you've taught | Does the action work on its own? |
| Activity log and permission banner | Every gesture and its outcome. The banner names the exact app that needs Accessibility permission. | What happened, and what do I need to fix? |

> **Visual:** a screenshot of the page mid-gesture, with the landmark overlay, the readout and the log visible. Numbered callouts point to five of the rows above.

---

## Problem 1: Browsers suspend what you can't see

Principle 2 failed first. With the window hidden, Chrome throttled the page and detection stopped. The common workaround, playing silent audio to keep the tab alive, made no difference.

I measured five ways to run a loop in a hidden page:

| Loop, window hidden | Runs per second |
| --- | ---: |
| `requestAnimationFrame` (animation loop) | 0 |
| `requestVideoFrameCallback` (per camera frame) | 0 |
| `setInterval` (plain timer) | 1.5 |
| `setInterval` + silent audio (keep-awake trick) | 1.5 |
| **`setInterval` inside a Web Worker** | **62.5** |

**Decision.** Inference moved into a Web Worker, with camera frames passed in directly through `MediaStreamTrackProcessor`.

**Trade-off.** Only Chrome supports that API. The native app's built-in webview doesn't, so I removed the app's window entirely. The Tauri app became a headless supervisor that sits in the menu bar, keeps the server alive and starts at login, while Chrome renders the UI. I gave up a native interface in exchange for background reliability.

---

## Problem 2: The OS rejects synthetic input

Desktop switching is the core use case. The key event was delivered, and the terminal echoed `^[[1;5C` (Ctrl + →), but macOS would not treat a synthetic key as the Space-switch shortcut.

I benchmarked five injection methods against the window server's record of the active desktop:

| Method | Desktop changed? |
| --- | --- |
| nut.js (two ways) | Never |
| Custom Swift CGEvent helper, four event-source states | Never |
| Private window-server call | Yes, but could snap back |
| Synthesized trackpad dock-swipe | Yes, but reverted in 2 of 4 configurations |
| **macOS System Events** | **Yes, and it held** |

**Decision.** Use System Events, the only reliable path that needs no private API. The private methods stay available as fallbacks, because macOS can change undocumented behaviour in any release.

**Closed loop.** After every desktop switch, the server samples the active desktop for two seconds and reports whether it moved, didn't move, or moved and snapped back. A silent failure becomes a diagnosable one.

```
swipe_left -> space_right  (space main 2/4 -> main 3/4)

swipe_left -> space_right
  !! sent, but the desktop did not move — still on main 2/4.
```

---

## Problem 3: The instrument was wrong

The longest delay wasn't a bug in the system. It was a bug in how I measured it.

Six rounds of investigation chased theories about how the keys were being sent. The real fault was the check. It was reading `com.apple.spaces`, a cache written by the Dock. It only updates when the Dock itself switches, and it lags. So it couldn't see a switch made any other way, and it couldn't tell "never moved" from "moved, then snapped back".

**Fix.** Read the active desktop straight from the window server. The benchmarking probe also refuses to run without Accessibility permission, because without it every method returns a false negative.

**Principle I took from it:** validate the instrument before trusting a negative result.

---

## Feedback: hearing the result

The window is usually hidden, so the only confirmation used to be the effect itself, and some effects have none: a key the focused app ignores, a desktop switch macOS undoes. Now every gesture answers with a sound.

| Sound | Means |
| --- | --- |
| Two rising notes | It happened |
| Two falling notes | It didn't: refused, unbound, or a desktop switch macOS ignored or undid |
| One short tick | Recognised in dry-run mode, nothing pressed |
| Silence | Cooldown: the gesture is still being held, which is expected |
| A rising or falling blip | Armed or disarmed |

Rising means yes and falling means no, so the meaning carries without learning a code. The tones are quiet sines, short enough to sit under music.

Because the server verifies a desktop switch before it answers, the closed loop from Problem 2 is now something you hear: a swipe that macOS ignored sounds like a failure, not a success.

One constraint shaped it. Browsers only allow sound after a real click or key press on the page, and a hand gesture doesn't count. So the page asks for one click after launch, and the Sound row says when that's still needed.

---

## Teaching it new gestures (v0)

The built-in gestures are rules I wrote. Taught gestures are learned from the user's own examples, on-device. This is the first part of the system that adapts to the person using it.

**The flow:**
1. **Name.** Type a short name, like `peace`.
2. **Record.** After a countdown, hold the shape in view. Gesture keeps five samples, 250 ms apart.
3. **Bind.** Add it to the config like any other gesture: `"custom:peace": "audio_next"`.
4. **Use.** It gets the same arming, cooldown and release rules as the built-in set, and a 400 ms hold.

**How a match is decided:**

| Decision | Rule | Why |
| --- | --- | --- |
| Representation | 21 landmarks relative to the wrist, in palm lengths | The same scale invariance as the built-in rules |
| Tilt | Best-fit rotation, clamped to ±30° | Forgives a tilted hand, but keeps thumb up and thumb down apart |
| Distance | Root-mean-square over landmarks | A plain average hid a raised finger (below) |
| Threshold | Nearest sample within 0.18 palm lengths | A re-made gesture lands 0.05–0.09 away. One finger different lands 0.25 or more. |
| Ambiguity | The nearest gesture must be at most 0.8× the distance of the runner-up | A hand halfway between two taught shapes matches neither |
| Hold | 400 ms | A nearest-neighbour match is looser than a rule, so it has to prove itself for longer |

**Refused on purpose:** shapes that are already a built-in gesture, the four-finger shape that starts every swipe, samples that disagree with each other, and anything too close to a gesture already taught. That way a saved gesture is always one that can still fire.

**The measurement that changed the design.** The first version compared hands by plain average distance. On generated hands it put "peace" and "three fingers" 0.055 apart, which is closer than the jitter of the same gesture made twice (0.065). Averaging over 21 landmarks drowned the one fingertip that differed. Root-mean-square moved them to 0.25 apart, while jitter stayed under 0.09.

The samples stay in the browser. The server only ever sees the name.

> **Visual:** four panels (Name → Record → Match → Bind), with the Match panel showing a live distance against the 0.18 threshold.

---

## AI-directed development

Claude Code wrote the implementation. I worked as designer and director: I defined the behaviour, decided what counted as proof before accepting a fix, and tested every change physically in front of the camera.

**Practices that made that work:**
- **Pure, testable decision logic.** The recognizer and the taught-gesture matcher are separate from camera and I/O. 103 automated tests, 65 of them on synthetically generated hands, cover edge cases like a fist that reads as a pinch, the return stroke after a swipe, or a hand halfway between two taught gestures.
- **Instrumentation before intuition.** A diagnostic log keeps the last 200 events across the page and the server: engine, frame flow, visibility, and what happened to each gesture.
- **Benchmarks, not guesses.** A probe script runs every key-injection method and reports which one moved the desktop. The taught-gesture threshold was set the same way, from measured distances.
- **Discard what the evidence contradicts.** The first written plan was deleted once measurements proved its conclusions wrong. The first distance measure was replaced once it averaged away a raised finger.

| Day 1 · 4 Aug | Day 2 · 6 Aug | Day 3 · 7 Aug | 1 Oct | 22 Oct |
| --- | --- | --- | --- | --- |
| Gestures fire real keys. Inference moves into a worker. | Desktop switching solved. Menu-bar host added. | Native window removed. Pinch-to-arm added. | One-key launcher for the whole system. | Sound cues. Taught gestures v0. |

---

## Evaluation

Saying "n = 1" is honest, but it isn't a measurement. This protocol takes about 25 minutes at my own desk. It tests the two halves of the system separately: **recognition** (did it see the right gesture?) and **execution** (did the OS actually do it?).

| Test | Setup | What it measures |
| --- | --- | --- |
| **A · Writing** | 10 minutes of normal notebook work. Armed, window minimised, no deliberate gestures. | False triggers, taught gestures included, and whether the pen grip arms or disarms the system |
| **B · Recognition** | Dry-run mode: gestures are recognised and logged, but nothing is pressed. 20 deliberate attempts of each gesture, including one taught gesture. | Hit rate per gesture, and how often the wrong gesture fires |
| **C · Execution** | Live. 20 swipes, 10 each way, with the window minimised. | Desktop switches that moved and held, didn't move, or snapped back |
| **D · Latency** *(optional)* | Hand and screen filmed together in slow motion. | Time from the end of a gesture to the screen changing |

**Results**

| Measure | Result |
| --- | --- |
| False triggers during 10 minutes of writing | __ |
| Times the pen grip changed the armed state | __ |
| Swipe left recognised | __ / 20 |
| Swipe right recognised | __ / 20 |
| Fist recognised | __ / 20 |
| Open palm recognised | __ / 20 |
| Pinch recognised | __ / 20 |
| Taught gesture recognised | __ / 20 |
| Wrong gesture fired during Test B | __ |
| Desktop switches that moved and held | __ / 20 |
| Median latency *(optional)* | __ ms |

> Fill these in from the self-test (see *Production notes*). Never estimate. A weak number reported honestly reads better than a strong one nobody can check.

---

## Results

In use at my desk for multi-display work. Swipe and fist carry most of it.

| | |
| --- | --- |
| **0 → 62.5 / s** | detection loop rate with the window hidden |
| **5 methods** | of key injection benchmarked. One was reliable without private APIs. |
| **2 s** | post-action verification on every desktop switch, now audible |
| **5 samples** | to teach a new gesture, matched on-device |
| **103 tests** | 65 of them on synthetic hands, no camera required |
| **0 frames** | of video leave the device |

Measured accuracy is in *Evaluation* above.

> **Visual:** the real-time video, and the 71-second architecture film (`gesture-film.mp4`).

---

## Limitations

- **Ambiguity with the writing hand.** A pen grip is close to a pinch, and the system tracks one hand. Test A measures how often this happens.
- **Taught gestures are v0.**
  - The 0.18 threshold comes from generated hands, not a real camera yet. Test B is where it gets checked.
  - Samples live in one browser and are lost if its site data is cleared.
  - A gesture is learned for the hand you taught it with.
- **Sound needs one click after launch.** With sound off, nothing confirms a gesture whose result is off-screen.
- **Sample of one.** One user, one camera, one lighting setup. The evaluation needs other people, cameras and conditions.
- **Partial closed loop.** Only desktop switches are verified. Other actions confirm that the key was sent and permission was granted, not that the effect happened.
- **Platform.** macOS and Chrome only. The app isn't code-signed and needs Node.js installed.

---

## What I learned

**The model is the easy part.** Hand tracking worked on day one. The intent layer and the operating system are where the product actually is.

**Validate the instrument.** It happened twice. Six rounds of investigation went to the wrong theory because the desktop check read a stale cache. Later, a plain-average distance made two different gestures look closer than one gesture made twice. A result is only as good as the tool that measured it.

**With an AI agent writing code, design moves to specification and evaluation.** The leverage is in deciding what "working" means, and refusing to accept "it should work" without a measurement.

---

## Next: tuned by data, not feel

1. **Two-hand tracking with handedness,** so the writing hand can be ignored. This addresses the pen-grip ambiguity directly.
2. **Per-gesture thresholds** learned from each taught gesture's own spread of samples, instead of one global 0.18.
3. **The self-test as a built-in harness** that logs false positives and negatives per gesture, so thresholds are tuned from real errors.
4. **Export and import of taught gestures,** so they survive a browser reset and move between machines.

---

**Tools:** MediaPipe · Web Workers · Web Audio · Node.js · Swift · Rust (Tauri) · Claude Code
**Source:** [github.com/Abhi-desig/Gesture](https://github.com/Abhi-desig/Gesture)

---
---

## Production notes (for you, not for Behance)

**Where each version goes**
- **Behance:** post the deck slides ([CASE-STUDY-DECK.md](CASE-STUDY-DECK.md)) as image modules, with one or two sentences of caption between them. Behance readers scroll images, so this full text is too long there.
- **Portfolio site or PDF:** use this full text.

**Behance setup**
- **Title:** Gesture: A Camera-Based Input Layer for macOS
- **Tags:** creative technology, human-computer interaction, computer vision, on-device ML, MediaPipe, interaction design, prototyping, AI-assisted development
- **Creative fields:** Interaction Design, Programming, UI/UX
- **Cover:** 808 × 632, a still from the real-time video, mid-swipe, with the display changing.
- **Images:** 1400 px wide. Turn every table into an image. Behance text modules don't show tables or code.
- **If the video isn't ready:** use a desk photo as the cover, not the dot animation.

**Real-time video shot list** (30–45 s, one take, captions, sound on so the cues are heard)
1. Desk: notebook, pen, displays. Gesture window visible.
2. Click the window once, then pinch: armed, with a rising blip.
3. Minimise the Gesture window on camera.
4. Swipe: the desktop changes, two rising notes. Swipe back.
5. Fist: media pauses.
6. Your taught gesture: its action fires.
7. Open palm held still: the screen locks. End.

**How to run the self-test**

1. Quit Gesture if it's running, then start it with ⌃⌥⌘G. The launcher writes the server's log to `~/Library/Logs/gesture-server.log`, which the counts below read. Click the window once so the sound cues work.
2. **Teach one gesture first:** type a name (for example `peace`), press Record and hold the shape. Then bind it in `config.json`, for example `"custom:peace": "audio_next"`.
3. Before each test, add a marker to the log:
   ```bash
   echo "=== TEST START $(date '+%H:%M:%S')" >> ~/Library/Logs/gesture-server.log
   ```
4. **Test A:** arm with a pinch, minimise the window, write for 10 minutes. Then count what fired. Also check the page's Activity log for `pinch -> armed` or `pinch -> disarmed`, because pinches never reach the server.
5. **Test B:** set `"dryRun": true` in `config.json` (it reloads on save) and arm with a pinch. Do 20 of each gesture, adding a new marker before each block, and count after each block. Each recognised gesture ticks, so you can hear misses as they happen.
   - Wait about 2 seconds between attempts and relax your hand in between. The 1.2 s cooldown and the release rule would otherwise count good gestures as misses.
   - Do the pinch block last, because each pinch toggles arming. Count pinches from the page's Activity log.
   - Set `"dryRun": false` when you're done.
6. **Test C:** live, window minimised, 20 swipes. Then count the desktop-switch results.
7. **Test D (optional):** film your hand and the screen together at 240 fps. Count the frames from the end of the gesture to the screen changing, and multiply by 4.2 ms.

Count gestures since the last marker (taught gestures show up as `custom:<name>`):

```bash
awk '/^=== TEST START/{delete c} /^(\[dry-run\] )?[a-z_:]+ -> /{sub(/^\[dry-run\] /,""); c[$1]++} END{for (g in c) print c[g], g}' ~/Library/Logs/gesture-server.log
```

Count desktop-switch results since the last marker:

```bash
awk '/^=== TEST START/{m=0;n=0;s=0} /\(space /{m++} /did not move/{n++} /snapped back/{s++} END{print "moved and held:", m, " no move:", n, " snapped back:", s}' ~/Library/Logs/gesture-server.log
```

**Interface screenshot:** open the page with the camera on, hold a gesture, and screenshot the whole window so the overlay, the readout and the Activity log are all visible. Take a second one while holding your taught gesture, so the Taught match row shows a live distance.

**Before posting**
- [ ] Every `__` in *Evaluation* is filled in from the self-test.
- [ ] The GitHub repo is public, or the source link is removed.
- [ ] The rationale in *Why these gestures* reads as your own reasoning. Edit any line that doesn't.

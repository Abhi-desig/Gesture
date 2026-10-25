# Gesture: Case Study Deck

Slide-by-slide copy, layout and a placeholder for every visual. 26 slides, plus a 16-slide short cut at the end.

**Deck rules**
- **Format:** 16:9, 1920 × 1080.
- **One idea per slide.**
- **Copy limits:** headline up to 10 words. Body 20–45 words. Captions up to 12 words.
- **Text never sits directly on a busy image.** It goes on a plain white slide, on the electric-blue background, or inside a frosted glass card.
- **Tone:** research-lab precision. Measured claims, real numbers, no hype words.
- **Look:** white and electric-blue slides, large light-weight headlines, frosted glass cards, one glossy 3D accent at most per slide. Full spec in [CLAUDE-DESIGN-PROMPT.md](CLAUDE-DESIGN-PROMPT.md).
- **Placeholders** are marked `[TYPE]`. **Source** says whether you shoot it, make it, run it, or it's already in the repo.
- **`__` means a number from the self-test.** Fill it in before the deck is designed. Never estimate.

---

## Slide 1 · Cover

**Layout:** full-bleed image. Title inside a frosted glass card, bottom-left.

**Eyebrow:** Creative technology · Human-computer interaction · 2026
**Headline:** Gesture
**Subhead:** A camera-based input layer for a multi-display workspace.

**Visual:** `[VIDEO STILL]` a hand mid-swipe, notebook in the foreground, a display changing behind.
**Source:** shoot

---

## Slide 2 · Thesis

**Layout:** large statement, left-aligned. Small visual on the right.

**Eyebrow:** Thesis
**Headline:** Models guess. Operating systems execute.
**Body:** Most webcam gesture demos stop at recognition. Gesture is about what happens after: when a noisy guess is confident enough to act on, whether the action landed, and how a person teaches it new gestures.

**Visual:** `[DIAGRAM]` left: a cloud of jittering landmark points. Right: one clean key press. A thin line between them labelled "intent".
**Source:** make

---

## Slide 3 · Overview

**Layout:** desk photo full-bleed. Three glass cards along the bottom, role bar beneath.

**Eyebrow:** Overview

| Context | Question | Outcome |
| --- | --- | --- |
| Pen-and-paper planning beside a multi-display Mac. Every screen switch broke focus to go through the keyboard. | Can a commodity webcam become an input device reliable enough to trust with real system actions? | A background, on-device gesture layer that confirms every gesture by sound and learns new ones from five examples. |

**Role bar:** Concept, interaction design, system design, evaluation · Implementation by Claude Code under my direction · August–October 2026

**Visual:** `[PHOTO]` desk from a three-quarter angle: notebook, pen, several displays, laptop webcam.
**Source:** shoot

---

## Slide 4 · Design principles

**Layout:** headline on top · four cards in a row

**Eyebrow:** Design principles
**Headline:** Four constraints shaped every decision.

| 01 · No new hardware | 02 · Background-first | 03 · Intent, not detection | 04 · Closed loop |
| --- | --- | --- | --- |
| Commodity webcam, on-device inference. Nothing leaves the machine. | It must work while its own window is hidden. | A detected hand isn't a command. Acting needs confidence, duration and consent. | An action isn't done until the system confirms it, and tells you. |

**Visual:** `[ICON × 4]` small glossy 3D glass icons: camera, hidden window, hand with a check mark, loop arrow.
**Source:** make

---

## Slide 5 · System

**Layout:** three-layer diagram across the top 60% · three columns below

**Eyebrow:** System
**Headline:** Perception → intent → action.

| Perception | Intent | Action |
| --- | --- | --- |
| A pretrained hand-landmark model returns 21 landmarks per frame, on-device, in a Web Worker. | Built-in rules first, then gestures the user taught, turn landmarks into one gesture name, or nothing. | A local server performs the action, verifies it, and the page answers with a sound. |

**Footer:** Privacy by architecture: video and taught samples never leave the device. Only gesture names travel from browser to server.

**Visual:** `[DIAGRAM]` frames → 21 landmarks → `"fist"` → media key → sound, with the layer boundaries marked.
**Source:** make

---

## Slide 6 · Perception

**Layout:** 3D hero left 55% · text right 45%

**Eyebrow:** Perception
**Headline:** Twenty-one landmarks, every frame.
**Body:** MediaPipe's hand-landmark model runs entirely on-device. It never names a gesture. It returns 21 coordinates per frame, with noise, and everything after that is design.

**Visual:** `[3D HERO]` an open hand as 21 glossy glass beads joined by chrome tubes, wrist bead in green. Indices 0–20 as small labels.
**Source:** make. Base geometry from [`gesture-film.jpg`](gesture-film.jpg).

---

## Slide 7 · Intent layer

**Layout:** headline on top · six-row table graphic across the full width

**Eyebrow:** Designing the intent layer
**Headline:** Everything between coordinates and a key press.

| Decision | Rule | Why |
| --- | --- | --- |
| Scale invariance | Distances in palm lengths | Works at 30 cm or arm's length |
| Rotation invariance | Extended = tip farther from wrist than middle joint | Height comparisons invert when the hand tilts |
| Consequence-weighted dwell | Music 180 ms · lock 1.2 s, held still | False-positive cost sets the threshold |
| Motion vs pose | Poses ignored above a velocity threshold | A swipe passes through the open-palm shape |
| Ambiguity | Pinch needs index reach > 1.15 palm lengths | A fist also brings thumb and index together |
| Consent | Starts disarmed. Pinch arms. | A hand in frame isn't intent |

**Visual:** `[TABLE GRAPHIC]` hairline rows. Each Decision cell gets a tiny landmark sketch of the rule.
**Source:** make

---

## Slide 8 · Vocabulary

**Layout:** four glass tiles in a row over the blue wave

**Eyebrow:** Vocabulary
**Headline:** Four gestures, thresholds tuned to risk.

| Four-finger swipe | Fist | Pinch | Open palm |
| --- | --- | --- | --- |
| Next or previous desktop | Play or pause media | Arm or disarm | Lock the screen |
| 1.2 palm lengths in 350 ms | 180 ms | 180 ms | 1.2 s, held still |

**Footer:** Bindings live in a config file that reloads on save. Remapping is a one-line change.

**Visual:** `[4 GESTURE TILES]` each hand as 21 points (blue lines, white dots, green wrist) inside a glass tile. The swipe gets faded motion copies.
**Source:** make

---

## Slide 9 · Why these gestures

**Layout:** distance matrix left 55% · text right 45%

**Eyebrow:** Why these gestures
**Headline:** The closest shapes are exactly where rules were needed.
**Body:** Each shape matches its meaning: the trackpad swipe, a "stop" for the lock, a small "click" for arming. Measured on generated hands, the two closest pairs are the two collisions the project engineered around.

| Pair | Apart | Kept apart by |
| --- | --- | --- |
| Fist · pinch | 0.20 | index-reach rule |
| Open palm · swipe shape | 0.27 | 1.2 s hold, stillness gate |
| Every other pair | 0.46–0.56 | nothing extra |

**Visual:** `[MATRIX]` a 4 × 4 heat grid of the built-in shapes, with the two close cells highlighted and labelled with their rule.
**Source:** make

---

## Slide 10 · Interface

**Layout:** screenshot left 60% with numbered callouts · text and callout key right 40%

**Eyebrow:** Interface
**Headline:** An instrument panel for the model.
**Body:** Day to day the window is minimised. While tuning, it shows what the model and the rules are doing in real time. Every row answers a question that came up while designing the intent layer.

**Callouts:**
1. **Landmark overlay:** what the model actually sees.
2. **Detection:** worker or page mode, and the live frame rate.
3. **Palm speed:** current speed against the stillness threshold.
4. **Taught match:** nearest taught gesture and its distance, e.g. `0.11 / 0.18`.
5. **Activity log:** every gesture and its outcome.

**Visual:** `[SCREENSHOT]` the real Gesture page mid-gesture, with the overlay, readout and log visible. Five numbered pills over the matching rows.
**Source:** screenshot (see *Production notes* in CASE-STUDY.md)

---

## Slide 11 · Problem 1

**Layout:** text left 40% · screen recording right 60%

**Eyebrow:** Problem 1 · Background inference
**Headline:** Browsers suspend what you can't see.
**Body:** Principle 02 failed first. With the window hidden, Chrome throttled the page and detection stopped. The common workaround, silent audio to keep the tab alive, made no difference.

**Visual:** `[SCREEN RECORDING, 5–8 s LOOP]` detection runs with the window visible → the window is hidden → the frame counter drops to 0.
**Source:** shoot, or make as a two-state diagram. Recreate it at commit `e28b6b9`, the last one before the worker change.

---

## Slide 12 · Problem 1: measurement

**Layout:** chart in a glass card left 65% · text right 35%

**Eyebrow:** Problem 1 · Measurement
**Headline:** One loop survived.
**Body:** I benchmarked five ways to run a loop in a hidden page. Only a loop inside a Web Worker kept full rate. Inference moved there, fed directly with camera frames.

**Visual:** `[BAR CHART]` runs per second, window hidden: requestAnimationFrame (animation loop) 0 · requestVideoFrameCallback (per frame) 0 · setInterval (timer) 1.5 · setInterval + silent audio 1.5 · **Web Worker 62.5**, in green. Drawn to scale.
**Source:** make

---

## Slide 13 · Problem 1: trade-off

**Layout:** segmented Before / After control on top · two glass panels side by side

**Eyebrow:** Problem 1 · Trade-off
**Headline:** I removed the app's window.
**Body:** The native webview can't feed frames to a worker. So the Tauri app became a headless supervisor in the menu bar, and Chrome renders the UI. I gave up a native interface for background reliability.

**Visual:** `[BEFORE / AFTER]` Before: the app's own window, labelled "detects only while visible". After: menu-bar icon only, with Chrome minimised, labelled "detects in background".
**Source:** screenshot for "after". Mock the "before".

---

## Slide 14 · Problem 2

**Layout:** text left 40% · terminal screenshot right 60%

**Eyebrow:** Problem 2 · Synthetic input
**Headline:** The OS rejected synthetic input.
**Body:** Desktop switching is the core use case. The key event arrived, and the terminal echoed `^[[1;5C`, but macOS refused to treat a synthetic key as the Space-switch shortcut.

**Visual:** `[SCREENSHOT]` a terminal echoing `^[[1;5C` beside a log line marked "sent", with the desktop unchanged.
**Source:** recreate or mock

---

## Slide 15 · Problem 2: benchmark

**Layout:** table graphic left 60% · text right 40%

**Eyebrow:** Problem 2 · Benchmark
**Headline:** Five injection methods, one reliable path.
**Body:** Each method was measured against the window server's record of the active desktop. System Events was the only one that held without private APIs. The private methods stay available as fallbacks.

**Visual:** `[TABLE GRAPHIC]`
- nut.js, two ways: never (red)
- Swift CGEvent helper, four source states: never (red)
- Private window-server call: could snap back (grey)
- Synthesized dock-swipe: reverted 2 of 4 (grey)
- **System Events: moved and held (green)**

**Source:** make

---

## Slide 16 · Problem 2: closed loop

**Layout:** log in a glass card, centred on the blue wave

**Eyebrow:** Problem 2 · Closed loop
**Headline:** Every desktop switch verifies itself.
**Body:** After each desktop switch, the server samples the active desktop for two seconds and reports moved, didn't move, or snapped back. A silent failure becomes a diagnosable one.

**Visual:** `[LOG GRAPHIC]` the two real log lines, success in green and failure in red:
```
swipe_left -> space_right  (space main 2/4 -> main 3/4)
swipe_left -> space_right
  !! sent, but the desktop did not move — still on main 2/4.
```
**Source:** make

---

## Slide 17 · Problem 3

**Layout:** text left 45% · comparison diagram right 55%

**Eyebrow:** Problem 3 · Measurement error
**Headline:** The instrument was wrong.
**Body:** Six rounds chased theories about how keys were sent. The real fault was the check: it read the Dock's cache, which lags and can't see switches made any other way. Reading the window server fixed it.
**Pull line:** Validate the instrument before trusting a negative.

**Visual:** `[DIAGRAM]` two timelines of the same switch. "Dock cache": flat, reads "never moved". "Window server": a step up, and sometimes a snap back.
**Source:** make

---

## Slide 18 · Feedback

**Layout:** four sound glyphs in glass cards on the blue wave · one line of text on top

**Eyebrow:** Feedback
**Headline:** You can hear whether it worked.
**Body:** The window is usually hidden, so every gesture now answers with a sound. A desktop switch macOS ignored sounds like a failure, because the server checks before it answers. The closed loop becomes something you hear.

| Two rising notes | Two falling notes | One tick | Silence |
| --- | --- | --- | --- |
| It happened | Refused, unbound, or macOS ignored it | Recognised in dry-run | Cooldown: still holding |

**Visual:** `[SOUND GLYPHS]` each cue drawn as notes on a thin pitch line: two rising dots, two falling dots, one short dot, an empty line.
**Source:** make

---

## Slide 19 · Teaching new gestures

**Layout:** four glass panels across the full width over the blue wave · one line on top · footer below

**Eyebrow:** Taught gestures · v0
**Headline:** Five examples teach it a new gesture.
**Body:** The first part of the system that adapts to its user. Matching is nearest neighbour over 21 landmarks in palm lengths, forgiving 30° of tilt but keeping thumb up and thumb down apart.

| Name | Record | Match | Bind |
| --- | --- | --- | --- |
| A short name, like `peace` | 5 samples, 250 ms apart | Same gesture 0.05–0.09 · one finger off 0.25+ · threshold 0.18 | `"custom:peace": "audio_next"` |

**Footer:** Refused on purpose: built-in shapes, the swipe pose, near-copies, and samples that disagree.

**Visual:** `[4 PANELS]` Name field → five sample frames of a hand → a live distance meter at the 0.18 line → a config line.
**Source:** make. Optionally use a real screenshot of the Taught match row.

---

## Slide 20 · Process

**Layout:** four practices in a 2 × 2 grid on top · timeline strip along the bottom

**Eyebrow:** AI-directed development
**Headline:** I directed. The agent implemented.

| | |
| --- | --- |
| **Pure, testable logic.** 103 tests, 65 on synthetic hands. | **Instrumentation first.** A 200-event diagnostic log across page and server. |
| **Benchmarks, not guesses.** Injection methods and the taught-gesture threshold were both measured. | **Evidence over plans.** The first plan, and the first distance measure, were replaced when data contradicted them. |

**Timeline:** 4 Aug · inference moves into a worker → 6 Aug · desktop switching solved → 7 Aug · native window removed, pinch-to-arm → 1 Oct · one-key launcher → 22 Oct · sound cues, taught gestures

**Visual:** `[TIMELINE]` five nodes on a hairline, with a tiny screenshot above each.
**Source:** make

---

## Slide 21 · Evaluation

**Layout:** three protocol cards across the top · results table below

**Eyebrow:** Evaluation
**Headline:** Measured on my own desk.
**Body:** A 25-minute protocol that separates recognition from execution: false triggers while writing, hit rate per gesture in dry-run mode, and live desktop-switch reliability.

| A · Writing | B · Recognition | C · Execution |
| --- | --- | --- |
| 10 min of notebook work, armed, no gestures | 20 attempts per gesture, taught one included, nothing pressed | 20 live swipes, window minimised |

| Measure | Result |
| --- | --- |
| False triggers in 10 min of writing | __ |
| Pen grip changed armed state | __ |
| Swipe left / right recognised | __ / 20 · __ / 20 |
| Fist / open palm / pinch recognised | __ / 20 · __ / 20 · __ / 20 |
| Taught gesture recognised | __ / 20 |
| Wrong gesture fired | __ |
| Desktop switches that moved and held | __ / 20 |

**Visual:** `[RESULTS TABLE]` mono numbers, with the best result in green. If any number is weak, show it anyway.
**Source:** run the self-test first (steps in CASE-STUDY.md, *Production notes*)

---

## Slide 22 · Results

**Layout:** video left 55% · six stats stacked on the right

**Eyebrow:** Results
**Headline:** In use for multi-display work.
**Body:** Swipe and fist carry most of it.

| Stat | Meaning |
| --- | --- |
| **0 → 62.5 / s** | detection loop with the window hidden |
| **5 methods** | of key injection benchmarked |
| **2 s** | verification after every desktop switch, now audible |
| **5 samples** | to teach a new gesture |
| **103 tests** | 65 on synthetic hands |
| **0 frames** | of video leave the device |

**Visual:** `[VIDEO]` the real-time recording, sound on. Until it exists, use [`gesture-film.mp4`](gesture-film.mp4).
**Source:** shoot / in repo

---

## Slide 23 · Limitations

**Layout:** photo with landmark overlay left 45% · list right 55%

**Eyebrow:** Limitations
**Headline:** What isn't solved yet.
- **Writing-hand ambiguity.** A pen grip is close to a pinch, and only one hand is tracked.
- **Taught gestures are v0.** The threshold comes from generated hands. Samples live in one browser.
- **Sound needs one click after launch.**
- **Sample of one.** One user, one camera, one lighting setup.
- **Partial closed loop.** Only desktop switches are verified.
- **Platform.** macOS and Chrome. Unsigned, and needs Node.js.

**Visual:** `[PHOTO + OVERLAY]` a hand holding a pen, with 21 landmarks drawn over it and thumb and index touching. Caption: "Pinch, or a pen?"
**Source:** shoot, then add the overlay

---

## Slide 24 · Learnings

**Layout:** three statements in large type on the electric-blue background. No image.

**Eyebrow:** What I learned

1. **The model is the easy part.** The intent layer and the OS are where the product is.
2. **Validate the instrument.** It happened twice: a stale cache, then an average that hid a raised finger.
3. **AI agents move design to specification and evaluation.** The leverage is defining "working" and proving it.

---

## Slide 25 · Next

**Layout:** one line on top · four glass panels across the full width

**Eyebrow:** Next
**Headline:** Tuned by data, not feel.
**Body:** Taught gestures work. Next, the self-test becomes a built-in harness, so every threshold is set from real errors on real cameras rather than from generated hands.

| Two hands | Per-gesture thresholds | Built-in harness | Export / import |
| --- | --- | --- | --- |
| Track handedness, ignore the writing hand | Learned from each gesture's own sample spread | Log false positives and negatives, tune from them | Taught gestures survive a reset and move between machines |

**Visual:** `[4 PANELS]` two hands with the writing hand greyed out → a threshold line per gesture → an error log → a file moving between two laptops.
**Source:** make

---

## Slide 26 · Close

**Layout:** centred, on the electric-blue background

**Headline:** Gesture
**Body:** MediaPipe · Web Workers · Web Audio · Node.js · Swift · Rust (Tauri) · Claude Code
**Links:** github.com/Abhi-desig/Gesture · `[your email / portfolio link]`

**Visual:** `[LOOP]` [`demo.gif`](demo.gif), small, above the title.
**Source:** in repo

---
---

## Short version (16 slides)

**1, 2, 3, 5, 7, 9, 10, 12, 15, 17, 18, 19, 21, 22, 24, 26.**

That keeps the thesis, the intent layer, why these gestures, the interface, the strongest slide from each problem, sound feedback, taught gestures, the evaluation and the results. If you have room for one more, add slide 13 (the trade-off).

---

## Visual checklist

**Run first**
- [ ] Teach one gesture, then run the self-test, to fill every `__` on slide 21

**Shoot**
- [ ] Real-time one-take video, sound on (slides 1, 22)
- [ ] Desk photo (slide 3)
- [ ] Interface screenshot mid-gesture, and one holding your taught gesture (slides 10, 19)
- [ ] Screen recording: works visible, stops hidden (slide 11)
- [ ] Menu-bar screenshot (slide 13)
- [ ] Pen-grip photo for the landmark overlay (slide 23)

**Make**
- [ ] Thesis diagram (slide 2)
- [ ] Principle icons (slide 4)
- [ ] Three-layer system diagram (slide 5)
- [ ] 3D landmark hand (slide 6)
- [ ] Intent table with rule sketches (slide 7)
- [ ] Gesture tiles (slide 8)
- [ ] Distance matrix (slide 9)
- [ ] Interface callouts (slide 10)
- [ ] Bar chart, to scale (slide 12)
- [ ] Before / after panels (slide 13)
- [ ] Terminal mock (slide 14)
- [ ] Benchmark table (slide 15)
- [ ] Log graphic (slide 16)
- [ ] Dock cache vs window server timelines (slide 17)
- [ ] Sound glyphs (slide 18)
- [ ] Taught-gesture panels (slide 19)
- [ ] Process timeline (slide 20)
- [ ] Evaluation table (slide 21)
- [ ] Next panels (slide 25)

**Already in the repo**
- [x] [`gesture-film.jpg`](gesture-film.jpg): base geometry for slide 6
- [x] [`gesture-film.mp4`](gesture-film.mp4): stand-in for slide 22
- [x] [`demo.gif`](demo.gif): slide 26

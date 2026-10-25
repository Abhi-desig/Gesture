# Gesture roadmap

Every feature agreed so far, in the order it will be built, with what decides
when each one happens. Measured claims only: anything that rests on a guess
says so, and nothing moves past a **gate** until its numbers are in.

Branch: `spatial-desk`. Last updated 25 Oct 2026.

## The idea in one line

**Spatial Desk:** the laptop webcam knows which screen you're facing, and a
hand gesture acts on that screen. Head says *where*, hand says *what*. It is
measured against the mouse, because a 2005 study found that switching monitors
by head direction made tasks *slower*.

---

## ✅ Built

| Feature | What it does | State |
| --- | --- | --- |
| Gesture (base app) | Fist, pinch, open palm, swipes and taught gestures → keyboard shortcuts; sound cues | Committed (`0a1777c`) |
| Spatial Desk v1 | Face tracking, head direction, per-screen calibration, screens map, focus or move windows through the Swift helper | Committed (`dd38672`). First live test: **0 gestures fired in about 80 s** |
| Check-up (Phase A) | About 4 minutes of spoken prompts. Measures facing accuracy, plus whether each bound gesture (pinch, OK sign, shh, swipe up and down, close-your-hand, cover) is seen and how fast; candidate poses can be added to try them out. Saves to `experiments/`; replay script picks the smoothing | Built, uncommitted, not yet run live |
| Web-tool layout (UI step 1) | Sidebar, status chips, plain-language Home, self-ticking setup checklist, Diagnostics drawer, light/dark | Built, uncommitted, checked in the browser |
| Mascot as live status (UI step 2) | A face in the page header and (since 25 Oct) in the orb: asleep, watching, hold ring, nod, shrug, eyes to the screen you face. The art is Jelly (25 Oct), chosen from the concepts in `docs/mascot/` and refined in [jelly.html](mascot/jelly.html); [MASCOT.md](MASCOT.md) is its contract | Built, uncommitted. Page checked in the browser. The menu-bar face it first had was replaced by the orb |
| Edit gestures in the app (UI step 3) | Pick each gesture's action from a list on the Gestures page; saved to `config.json`. Arbitrary shortcuts still need a hand edit | Built, uncommitted, checked against a temp config |
| **Gesture set v2: locked** (24 Oct, adjusted 25 Oct) | OK sign arms, look + pinch focuses a screen (aimed by where you looked *while* pinching), swipes switch desktops. On 25 Oct, after trying it live, **open palm (1.2 s) plays/pauses and fist locks the screen**, by choice; close-your-hand and cover-the-camera stay available but unbound. Point, carry and window moving removed; a refused pinch gives its cooldown back | Built, uncommitted. `test/config.test.js` pins the set. Fist can misfire on a thumbs-up; watch for it in the check-up |
| **Office additions** (24 Oct) | From the 8 most annoying daily office tasks: **shh** (finger on lips) mutes Zoom, **palm up / down** scrolls a page while you write; camera on/off and next/previous slide added to the list. Guards: shh needs the face; palm up/down works like the side swipe (its still-first and confirm guards are built but off, by choice on 25 Oct) | Built, uncommitted. **Shh is a candidate:** no study tests it for mute, so it stays only if the check-up shows ≥ 90% with no misfires |
| **The orb** (25 Oct) | Gesture as a small orb under the camera, since 25 Oct a Liquid Glass notch fused to the top edge, with Jelly in it: says good morning at login and when the lid opens; a click turns the camera on, with the mascot as the loading animation; gestures and problems shown in words. Replaces the menu-bar icon and the visible Chrome window: the page runs in a hidden Chrome of its own, and is Settings | Built, uncommitted. Every orb state checked in the browser, and an orb click reached a second tab acting as the engine and came back "blocked". Host builds, 4 Rust tests. First live run (25 Oct): on screen under the camera, camera granted through the orb, and detection runs at 32–39 fps with Chrome hidden. Two first-run bugs fixed: the panel was never shown, and the page's calls to the app were refused |
| **Lighter and smoother** (25 Oct) | A full pass: dead code out (the old launch script, the shell plugin, window-moving leftovers), the mascot art in one file, the Lab and check-up loaded on demand. Detection slows to ~8 checks a second with no hand in view and runs at 640×360; nothing is drawn while hidden; config is pushed, not polled; a swipe is answered at once and checked after. The orb resizes in one step with room for its spring, and renders only when something changes. A pose flickering for under 150 ms no longer counts as a release | Built, uncommitted, 285 JS + 5 Rust tests. **Measured: 61% → 19% of one CPU core** with the camera on and no hand in view ([PERFORMANCE.md](PERFORMANCE.md)). With a hand in view, and gestures at 640×360, still to be checked by you |
| Lab: snap and vanish (experimental) | Snap and you turn to dust; the room shows through; snap again to come back. Dust sliders, Record (MP4), and snap practice that measures the snap | Built, uncommitted. Dust, room and recording checked on a drawn test scene. First live run (24 Oct) left a smeared copy of you behind: fixed, the room no longer learns you. Snap thresholds still unmeasured guesses |

## ▶️ Next, in order

### Gate A: run the check-up
You plus 3–5 friends, about 15 minutes each, every person under their own
participant code.

Proposed pass marks:

| Check | Pass mark |
| --- | --- |
| Picks the right screen | ≥ 95% |
| "Away" reads as no screen | ≥ 80% |
| Each gesture, including shh and palm up / down, succeeds | ≥ 90% |
| Pinch fires within | 800 ms |

The check-up now measures the locked v2 set. The results decide the smoothing
settings and the angle limits, and whether any locked gesture has to change.
That would be a deliberate change to the locked set, with the numbers behind it.

### Phase B: Spatial Desk v2 (focus only)

| Feature | What changes | Why |
| --- | --- | --- |
| ~~Horns arms and disarms~~ | Replaced by the **OK sign** in the locked set | "Yes" in a mid-air TV study |
| ~~Look + pinch~~ | **Done** in the locked set | |
| **Smarter head smoothing (1€ filter)** | Replaces the fixed smoothing; settings chosen from recorded head traces | The current smoothing lags about 270 ms behind a turn |
| ~~Target from the pinch's own hold~~ | **Done** | |
| ~~A refused pinch doesn't cost a wait~~ | **Done** | |
| **Warning for overridden taught gestures** | Warns if a taught gesture is now overridden by a built-in one | The OK sign became built in |
| ~~Remove point, hold-turn-release and window moving~~ | **Done** | |
| New settings | Smoothing strength and speed response, hold window | Tunable without code |

Then run the check-up again for before-and-after numbers.

### Phase C: experiment mode (gestures vs mouse)
- Timed trials: "bring the BenQ forward", done with gestures, then with the
  mouse, in alternating order (ABBA, then BAAB for the next person), 10 per
  block, about 15 minutes each.
- **Graded automatically:** the helper reads which app is actually in front,
  on which screen. Nothing is self-reported.
- Results per method: median time, spread, errors, refusals, and the
  difference with a confidence range.
- **Gate C:** at least 3 sessions per person. One person's results count as
  personal evidence only.

### Phase D: facing log (opt-in)
- Daily totals only: minutes facing each screen, time away, switches. No app
  names, with a delete button.
- Its one purpose: decide whether window moving earns its way back.

### Mascot art (you)
- Design the real face from [MASCOT.md](MASCOT.md): one SVG, used in the page
  header and in the orb. Keep the part ids, and it drops in without code
  changes.
- It was built before Phase B on purpose: moods follow events (fired, refused,
  armed), not particular gestures, so Phase B changes no mood.

---

## 🧪 Later: only if the data says so

| Feature | Comes in when |
| --- | --- |
| **Snap as a bindable gesture** | The detector is built and works in the Lab. It joins the Gestures list once snap practice shows it catches most snaps with few misfires. A click-sound check on the microphone comes in only if misfires stay high |
| Window moving (pick and drop) | The facing log shows you move windows between screens often |
| Pointer flash after a switch | Measured to help (time to your next mouse action) |
| App-aware gestures (fist = undo in Figma, play in Music) | Version 2 is stable; limited to one or two remappings |
| Self-calibration from your clicks | Calibration drift shows up in the check-up |
| Dwell mode (look only, no hand) | Only as an accessibility option: research found it slowest, though with fewest errors |
| TouchDesigner tuning and visuals lab | Experiment results exist to visualise |

## 📦 Parked for another project

| Idea | Where it belongs |
| --- | --- |
| **Thanos snap dissolve as a live camera** (for Zoom, OBS) | **Project 1 (Stream Canvas)**. The effect itself now lives in Gesture's Lab (24 Oct: you chose to add it here as an experiment). Sending it out as a virtual camera is Project 1's job |

## ❌ Decided against

| Idea | Why |
| --- | --- |
| Thermal printer + Python "AI interpreter" brief | No evidence of need; adds unpredictability; nothing to measure |
| 3D pen space, hand-driven depth video, puppetry | The webcam can't see depth, and they overlap Projects 1 and 2 |
| Air notepad | At least three open-source versions exist; overlaps Project 1's drawing overlays |
| Point gesture | Fired nothing live, likely because the finger looks foreshortened when aimed at a screen |
| Thumbs-up arming | Reads as a fist, so it would play music |
| Automatic focus-follows-your-head | Glancing at a screen would steal focus (the "Midas touch" problem) |

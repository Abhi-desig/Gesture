# Gesture: Visual Brief

What to put on each slide of [CASE-STUDY-DECK.md](CASE-STUDY-DECK.md), and how to get it.

| Tag | Meaning | Count |
| --- | --- | --- |
| 📷 **Capture** | You shoot, record or screenshot it. Only you can do these. | 6 essential, 4 optional |
| ✏️ **Make** | Claude Design draws it from the deck and the prompt. No action from you. | 16 |
| ✅ **Have** | Already in the repo. | 3 |

**Before any capture**
- **Clean the screens.** Close work apps and anything confidential. Use a neutral browser page or an empty desktop.
- **Stage the notebook.** Write a believable task list on a fresh page, not your real one.
- **Teach one gesture** (for example `peace`) and bind it, so the taught-gesture captures and the self-test have something to show.
- **Save everything** in `docs/assets/` using the file names below, at full resolution. Retina screenshots are fine.

---

## Slide-by-slide

| # | Slide | Visual | Type | File |
| --- | --- | --- | --- | --- |
| 1 | Cover | Still from the real-time video: hand mid-swipe, notebook in front, display changing | 📷 | `s01-cover.jpg` |
| 2 | Thesis | Jittering landmark cloud → one clean key press, linked by a line labelled "intent" | ✏️ | |
| 3 | Overview | Desk photo: notebook, pen, displays, laptop webcam | 📷 | `s03-desk.jpg` |
| 4 | Design principles | Four glossy glass icons: camera, hidden window, hand with check, loop arrow | ✏️ | |
| 5 | System | Perception → intent → action: frames → 21 landmarks → `"fist"` → media key → sound | ✏️ | |
| 6 | Perception | 3D hand of 21 glass beads with chrome tubes, wrist in green | ✏️ + ✅ | base: `gesture-film.jpg` |
| 7 | Intent layer | Six-row rule table, with a tiny landmark sketch per rule | ✏️ | |
| 8 | Vocabulary | Four glass tiles: swipe (motion ghosts), fist, pinch, open palm | ✏️ | |
| 9 | Why these gestures | 4 × 4 distance matrix with the two close pairs highlighted | ✏️ | |
| 10 | Interface | **Real screenshot of the Gesture page mid-gesture**, plus five numbered callouts | 📷 + ✏️ | `s10-interface.png` |
| 11 | Problem 1 | Detection running while visible, then dropping to 0 when hidden | ✏️ (or 📷) | `s11-hidden.mp4` |
| 12 | Measurement | Bar chart to scale: 0 · 0 · 1.5 · 1.5 · **62.5** | ✏️ | |
| 13 | Trade-off | Before: app window. After: **real menu-bar screenshot** with the Gesture menu open | 📷 + ✏️ | `s13-menubar.png` |
| 14 | Problem 2 | Terminal echoing `^[[1;5C` while the desktop stays put | 📷 (or ✏️) | `s14-terminal.png` |
| 15 | Benchmark | Five-method results table in red, grey and green | ✏️ | |
| 16 | Closed loop | The two log lines, green and red, in a glass card | 📷 (or ✏️) | `s16-log.png` |
| 17 | Problem 3 | Two timelines of one switch: flat Dock cache vs window-server step | ✏️ | |
| 18 | Feedback | Four sound glyphs: two rising notes, two falling, one tick, silence | ✏️ | |
| 19 | Teaching gestures | Four panels: name → five samples → distance meter at 0.18 → config line | ✏️ (+ 📷 optional) | `s19-taught-match.png` |
| 20 | Process | 2 × 2 practices grid plus a five-node timeline | ✏️ | |
| 21 | Evaluation | Results table with **your self-test numbers** | ✏️ from your numbers | |
| 22 | Results | Real-time video, sound on. Until then, the 71-second film. | 📷 / ✅ | `s22-demo.mp4` |
| 23 | Limitations | **Real screenshot of the model's landmarks on your pen grip** | 📷 | `s23-pen-grip.png` |
| 24 | Learnings | No visual, on purpose | — | |
| 25 | Next | Four panels: two hands, threshold lines, error log, file moving between laptops | ✏️ | |
| 26 | Close | `demo.gif`, small, above the title | ✅ | `demo.gif` |

---

## How to capture each one

### Real-time video (slides 1 and 22)
- **Camera:** a phone on a tripod or a stack of books, behind your left shoulder at about 45°. Frame the notebook, your free hand and at least one display.
- **Settings:** 4K, 30 fps, **sound on**, so the cues are heard. Lock exposure on the screen, so it doesn't blow out.
- **Light:** window or lamp light from the side. Avoid strong backlight, which hurts both the shot and hand tracking.
- **Take:** follow the 7-shot list in CASE-STUDY.md (*Production notes*). Click the Gesture window once before you start, so the sound is on. Do 3–4 takes and keep the cleanest.
- **Cover still:** export the frame where your hand is mid-swipe and the next desktop is half in view. Crop to 808 × 632 for Behance.
- **Bonus:** record one extra take at 240 fps slow motion. It doubles as Test D (latency) in the self-test.

### Desk photo (slide 3)
- Three-quarter angle from standing height. Notebook open with the staged task list, pen across it, displays on with neutral content, and the laptop webcam visible.
- Shoot it wide (16:9 or 3:2). The slide puts glass cards over the bottom third, so keep that area calm.

### Interface screenshot (slide 10). The most important capture.
1. Start Gesture with ⌃⌥⌘G, or:
   ```bash
   cd ~/code/gesture && npm start
   ```
   then open <http://127.0.0.1:4321> in Chrome.
2. Click **Start camera**, then pinch to arm.
3. Hold an open palm, or start a slow swipe, so Pose, Held and Palm speed all show live values and the landmark overlay is drawn.
4. Press ⌘⇧4, then Space, then click the Chrome window to capture the whole window.
5. Take 3–4 versions (palm held, mid-swipe, fist) and keep the one where the readout is most alive.

Claude Design adds the five numbered callouts: overlay, Detection, Palm speed, Taught match, Activity log.

### Taught match (slide 19, optional)
With your taught gesture recorded, hold it in view and screenshot the readout. The **Taught match** row shows something like `peace 0.11 / 0.18`. A real number beats a drawn meter.

### Pen grip with landmarks (slide 23)
This is real evidence for the limitation, not a mock-up.
1. With the page open and the camera on (disarmed is fine), hold your pen in front of the camera the way you write.
2. Wait until the overlay draws the landmarks on your hand, and look at what **Pose** reads.
3. Screenshot just the camera area: ⌘⇧4 and drag.

If Pose reads `pinch`, that's the finding. If it doesn't, that's a finding too. Either way, mention it in your self-test notes.

### Menu bar (slide 13)
1. Run the desktop app:
   ```bash
   cd ~/code/gesture && npm run app:dev
   ```
2. Click the Gesture icon in the menu bar so its menu (Open Gesture · Start at Login · Quit Gesture) is open.
3. Press ⌘⇧4 and drag over the menu bar and the open menu.

The "Before" panel (the old app window) is drawn by Claude Design.

### Terminal echo (slide 14). Optional real capture.
The benchmark script presses Ctrl + → every way there is, and the terminal echoes `^[[1;5C` when a key lands in it but the desktop doesn't move.
1. Quit Gesture first, then run this in the Terminal app (it needs Accessibility permission):
   ```bash
   cd ~/code/gesture && npm run probe:keysend
   ```
2. Screenshot the terminal when `^[[1;5C` appears.

It will switch your desktops during the run and walk them back afterwards. If you'd rather not run it, let Claude Design draw the terminal from the deck text.

### Server log (slide 16). Optional real capture.
After Test C of the self-test, show the latest lines:
```bash
tail -n 20 ~/Library/Logs/gesture-server.log
```
Screenshot the terminal. A real "did not move" line is gold. If every swipe held, use only the success line, or let Claude Design draw both from the deck.

### Hidden-window loop (slide 11)
Recommended: let Claude Design draw it as two states of the Detection readout ("running · 62 fps" → "0"), clearly as a diagram.

Optional real recording: rebuild the old version at commit `e28b6b9` in its own folder. Then screen-record (⌘⇧5) detection running, minimise the window, and show nothing firing.
```bash
cd ~/code/gesture && git worktree add ../gesture-old e28b6b9 && cd ../gesture-old && npm install && npm start
```

---

## One capture session (about 1 hour 10 minutes)

Do these in one sitting, because the setup is shared.

1. **Prep** (10 min): clean the screens, stage the notebook, set the light, mount the phone.
2. **Teach a gesture** (5 min): record it and bind it in `config.json`.
3. **Interface, taught match and pen grip** (10 min): slides 10, 19 and 23.
4. **Self-test** (25 min): fills slide 21. Keep the 240 fps take for Test D.
5. **Real-time video and desk photo** (15 min): slides 1, 3 and 22.
6. **Menu bar and log** (5 min): slides 13 and 16.

After that, open Claude Design, attach the deck, the prompt, both reference images and the `docs/assets/` files, and every placeholder can be replaced.

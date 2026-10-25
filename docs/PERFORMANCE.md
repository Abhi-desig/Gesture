# What Gesture costs the Mac

Measured, not estimated. Every number here comes from
`node scripts/measure-load.mjs 60`, run with the camera on and the page hidden:
the normal state of a running Gesture.

The script averages macOS `top` over 60 seconds for each of Gesture's
processes. `top` gives CPU % and its POWER column, the same "energy impact"
Activity Monitor shows. The script also reads the page's own frame rate from
the server's heartbeats. 100% is one CPU core.

Machine: MacBook Air M1, macOS 26.6.2.

## 25 Oct 2026: before and after the lighter, smoother pass

| Process | Before | After |
| --- | ---: | ---: |
| Chrome GPU process (the hand and face models, and the video) | 39.1 | 7.2 |
| Chrome renderer (the hidden page) | 15.1 | 5.9 |
| Chrome camera capture | 3.0 | 4.7 |
| Chrome itself, and its network service | 1.0 | 0.5 |
| The desktop app | 1.2 | 0.3 |
| The orb's WebKit processes | 1.4 | 0.3 |
| The Node server | 0.4 | 0.3 |
| **Total, % of one core** | **61.1** | **19.3** |
| Page frame rate | 31.9 fps | 8.7 fps |

CPU % and energy impact came out identical for every process in both runs.

**Both runs are the idle case: camera on, no hand in view.** That is most of
the day. The 8.7 fps is the idle pacing at work: with no hand for a second,
the camera is checked about 8 times a second. A hand in view puts it back to
every frame at once. That case hasn't been measured here yet; to measure it,
hold a hand up while the script runs.

## What changed, by size of effect

- **Slow when idle** (`public/worker-lib.js`, `shouldDetect`). No hand for
  1 s → the models run every 125 ms instead of on every frame. Full rate
  returns on the first frame with a hand, and is forced for calibration, the
  check-up, teaching a gesture and the Lab. This is most of the GPU saving.
- **640×360 instead of 1280×720.**
  - MediaPipe shrinks every frame to 192–256 px before its models see it, and
    everything after works in palm lengths, so the extra pixels bought nothing.
  - The Lab still asks for 720p while it is open, so recordings stay sharp.
  - The frame rate is capped at 30.
- **Less copying between threads.** 8 face points instead of 478, about 17
  times a second. The lens-brightness thumbnail is made only while covering
  the lens is bound, or a check-up runs.
- **Nothing drawn while hidden.** No overlay canvas and no readout writes;
  only the mood that feeds the orb. The preview video pauses.
- **No polling:**
  - the config is pushed when it changes, not fetched every 3 s;
  - the screens are read every 30 s, not 5 s (each read spawns a helper);
  - the desktop app checks the engine with a signal, not by spawning `ps`
    every second.
- **The orb** redraws on events, plus one timer for when a message expires,
  instead of every 250 ms. It measures text once per message.

## Not measured yet

- With a hand in view (full rate, but each frame now cheaper).
- Battery drain over an hour, and temperature. `top`'s energy impact is a
  relative score, not watts. `sudo powermetrics --samplers cpu_power,gpu_power`
  gives milliwatts, but needs administrator rights.
- Gesture accuracy at 640×360 against 720p, at your usual distance. The
  check-up (Measure) is the tool for that. If far hands miss, 960×540 is the
  next step up (`CAMERA_DETECT` in `public/app.js`).

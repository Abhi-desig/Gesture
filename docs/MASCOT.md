# The mascot: Jelly, and its artwork contract

The mascot is Gesture's live status as a face. It shows in two places:
- the page's top bar;
- the orb under the camera (the desktop app), which is the one place you can
  see while the page is hidden behind your work.

It is **Jelly**: a soft, glossy gumdrop in a peach-to-pink gradient, with
capsule eyes in deep plum. It was picked from the concepts in
[`docs/mascot/`](mascot/) and refined in
[`docs/mascot/jelly.html`](mascot/jelly.html), its design sheet: every mood
moving, before and after, the glass island on several wallpapers, the sizes and
the colours. This document is the contract between that art and the code.

## Rules (from the research, not taste)

1. **It is the status. It never talks.** It only reacts to what already
   happened, and never offers help or asks for anything. Clippy guessed what
   you were doing and interrupted; Microsoft switched it off by default in
   Office XP and removed it in Office 2007.
2. **Its eyes look at your screens, never at you.** A face backed by a camera
   that stares back is unsettling. One that looks where *you* look just shows
   what the head tracking sees.
3. **It goes still during the check-up.** Movement near a timed trial could cue
   the person being measured.
4. **Reduce motion is respected.** With macOS "Reduce motion" on, nothing
   animates, but every mood still changes.
5. **Every mood has words.** They appear in the tooltip, in the orb and to
   screen readers, so the face is never the only signal.

## Moods

The page's moods come from `public/ui/mascot.js`, first matching row wins. The
orb adds three of its own (`orbView()` in `public/orb/orb-state.js`).

| Mood | When | Jelly |
| --- | --- | --- |
| `off` | Camera off | Covers its eyes with both hands: it isn't looking. Dimmed |
| `still` | Check-up running | Open eyes, level mouth, **no motion at all** |
| `nod` | A gesture worked | Happy eyes (^ ^), a grin, a squash-and-stretch bounce |
| `shrug` | A gesture was refused | Brows up, level mouth, hands out, a tilt |
| `asleep` | Disarmed | Eyes shut, "z z", slow deep breathing, dimmed |
| `learning` | Calibrating, teaching a gesture, or the camera starting | Looks up with an "o" mouth and a twinkle |
| `watching` | A hand is in view | Eyes a little wider. On the page, a ring fills while a pose is held |
| `away` | Your face is seen but faces no screen | Level mouth, eyes down |
| `awake` | Armed, nothing happening | Open eyes, a smile, breathing |
| `hello` (orb) | The greeting at login and wake | Happy eyes, a grin, two hops and a wave |
| `armed` (orb) | The arming gesture worked ("OK sign → armed") | A wink, a grin and an OK sign, with the bounce |
| `problem` (orb) | Something is broken: camera blocked, server stopped | Worried brows, a wavy mouth, a bead of sweat, a shake |

**Gaze:** the face turns toward the screen you're facing, from −1 (far left)
to 1 (far right), and down when you face none. The eyes turn a little further
than the face, like a head turning.

## The art: one SVG file

**Where:** `public/ui/mascot.svg`, `viewBox="0 0 32 32"`. That one file is the
face everywhere: `public/ui/mascot-art.js` mounts it into the page header
(`<span id="mascot">`, about 32 px) and into the orb (`#ball`, 22 px at rest,
34 px when it says something). Its colours are in the file, not themed: Jelly
looks the same in light and dark.

It holds **every mood's parts**. Anything with class `m-alt` is hidden until
`public/ui/mascot.css` shows it for a mood. Keep these ids and classes and new
art drops in:

| Part | Id or class | What happens to it |
| --- | --- | --- |
| Hold ring | `#m-ring` (a circle with `pathLength="100"`) | Fills with `--ring`, 0 to 1. Header only |
| Ground shadow | `#m-shadow` | — |
| Body | `#m-body` | Holds the face |
| Face | `#m-face` | Turns with `--gaze-x`, `--gaze-y` |
| Eyes | `#m-eyes`, then `.m-look`, then `#m-eye-l`, `#m-eye-r` | `#m-eyes` turns further with the gaze; `.m-look` looks up while learning |
| Open eye | `.m-open` | Blinks (`--blink`), widens (`--eye`) |
| Other eyes | `.m-happy`, `.m-closed` | Shown per mood |
| Brows | `.m-brow` with `.m-worried` or `.m-raised` | Shown per mood |
| Mouth | `#m-mouth`, holding `.m-smile` (the default), `.m-small`, `.m-flat`, `.m-wavy`, `.m-o`, `.m-grin` | One shown per mood |
| Hands | `.m-hand-cover`, `.m-hand-ok`, `.m-hand-shrug`, `.m-hand-wave` (moving part `.m-waving`) | Shown per mood |
| Signs | `.m-z`, `.m-sweat`, `.m-spark` | Shown per mood |

**State hooks:** on the mascot's element, `data-mood`, `data-blink` (set for
140 ms every 3.5 to 6.5 s by `ui/mascot-view.js`), and the CSS variables
`--gaze-x` and `--gaze-y` (−1 to 1) and `--ring` (0 to 1). The header sets
`--m-ring`, the hold ring's colour.

**Power, which decides where motion goes:** anything that runs for long, like
breathing, is a transform on the element holding the SVG, which the compositor
animates without repainting the drawing. An animation *inside* the SVG redraws
it on every frame, so those are kept to short reactions and to moods that last
seconds (the twinkle while the camera starts). Blinks are a timer, not a
looping animation, for the same reason.

## In the orb

The orb is a notch of Liquid Glass fused to the top edge of the screen:
small around Jelly at rest, growing sideways when it says something, with a
few words beside Jelly in its own voice ("Going to sleep", "Hey, I'm
looking"), chosen to match its face (`saidFor()` in `orb/orb-state.js`).
- **The island is native.** SwiftUI (`src-tauri/island`) draws the glass, the
  words and the warm light Jelly casts into the glass: peach, gold for a
  gesture that worked, amber for a warning, red for a problem; dim when the
  camera is off. Before macOS 26 the notch is dark.
- **Jelly is the orb's page,** `public/orb.html`, drawn 24 pt in a fixed box
  at the left of the notch's body: centred at rest, carried sideways in the
  same frame as the glass as the notch grows. It is never resized.
- **In a browser,** `http://127.0.0.1:4321/orb.html` shows Jelly with the
  island's words under it, for previews.
- **No ring:** the orb doesn't show the hold ring.

## How it gets to the orb

```
page (works out the mood) ──POST /mascot──▶ server ──GET /events, streamed──▶ orb
```

- **Page → server:** the page sends the mood whenever it changes, and every
  2 s anyway, with its last reaction numbered. The number is what lets the orb
  say "Swipe up → page down" for 1.5 s, once, though the face's nod lasts
  0.5 s.
- **Server → orb:** each change is streamed as it happens. If nothing has
  arrived for 5 s (the page is closed), the mood turns `offline`, which the orb
  shows as `off`.
- **Starting it:** the orb needs the desktop app (`npm run app:dev`). In a
  browser, `http://127.0.0.1:4321/orb.html` shows Jelly with the orb's words.
- **Turning it off:** Settings → "Show the mascot in this page's header" hides
  the header face. The orb always has it.

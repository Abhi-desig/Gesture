# Mascot reactions: one per gesture

One mascot is always there, in its **base pose**: awake and calm. When a gesture
fires, it plays a short reaction of about half a second, then returns to the base
pose. Each reaction copies the gesture, so you can tell which one fired without
reading anything.

This adds to [MASCOT.md](MASCOT.md), which covers the states the mascot sits in
(asleep, watching, away and so on), the SVG part ids and the menu-bar file
names.

## The main mascot (decided 25 Oct 2026)

- **What it is:** a round blob with two small hands.
- **Signature detail:** a fingerprint ring.

| Part | Decision | Why |
| --- | --- | --- |
| Body | One round shape, big head, no separate body | Reads best at 18 pt; big-headed proportions read as friendly |
| Eyes | Large, simple, cartoon | They carry every mood; realistic eyes feel "off" |
| Hands | Two small mitten hands, **shown only during a reaction** | Needed for shh, the shrug, peekaboo and the OK wink; hidden at rest keeps it calm |
| Signature | The hold ring is drawn as **fingerprint lines** around the body, and fills while you hold a gesture | Ties it to hands, and it does a real job, so it isn't decoration |
| Colour | One colour in the menu bar; the page's colour tokens in the header | macOS template images; works in light and dark |

**Ruled out:**
- **A hand character with a face:** fingers blur at 18 pt, and a face on a palm looks odd.
- **A single eye:** it feels like being watched, and it has no hands.

## Reactions

| Gesture | Does | Reaction |
| --- | --- | --- |
| **OK sign** | Arm / disarm | **Arm:** eyes pop open, a tiny OK wink. **Disarm:** a slow yawn, then eyes close |
| **Look + pinch** | Focus the screen you look at | Eyes dart to that screen, and a small pinch-spark appears there |
| **Close your hand** | Play / pause | **Play:** it bobs to a beat with ♪. **Pause:** freezes mid-bob |
| **Swipe left** | Next desktop | Slides off to the left and pops back in from the right |
| **Swipe right** | Previous desktop | Slides off to the right and pops back in from the left |
| **Swipe up** | Page down | Eyes scroll down, like reading |
| **Swipe down** | Page up | Eyes scroll up |
| **Cover the camera** | Lock screen | Hands over its eyes, a peekaboo |
| **Shh** | Mute / unmute mic | **Mute:** finger to its lips, mouth disappears. **Unmute:** the mouth comes back |
| **Snap** (Lab) | Vanish / return | **Vanish:** crumbles to dust. **Return:** reassembles |
| **Taught gesture** | Whatever it's bound to | A small sparkle; the gesture's name is in the tooltip |

Shared by every gesture:

| When | Reaction |
| --- | --- |
| A gesture is **refused** (facing no screen, still turning, and so on) | A small shrug and head tilt |

## What to draw

- **1 base pose:** every reaction starts and ends here.
- **15 reactions:** the 11 gestures above. Arm/disarm, play/pause, mute/unmute
  and vanish/return each need two versions.
- **1 shrug.**

## Rules

- **Short:** about 0.5 s, then back to the base pose. It never loops and never
  waits for you.
- **It never talks or pops up.** It only reacts to what already happened.
- **Its eyes look at your screens, never at you.**
- **Still during the check-up:** no reactions, so it can't cue the person being
  measured.
- **Reduce motion:** show each reaction's key frame for 0.5 s, with no
  movement.
- **Menu bar (18 px, one colour):**
  - one key frame per reaction, not the whole animation;
  - each must read from the eyes and hands alone.
- **Words:** every reaction also has a tooltip label, for example "OK sign →
  armed".

## Status

- **Built:** the nod (for any gesture that works) and the shrug.
- **Not built yet:** the per-gesture reactions above. They need your art first,
  then one event name per reaction added to the mood model in
  `public/ui/mascot.js`.

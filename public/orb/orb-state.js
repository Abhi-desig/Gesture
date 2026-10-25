// What the orb under the camera shows.
//
// The orb is Gesture's whole face on the desktop: a small glass bubble under
// the camera with Jelly, the mascot, in it, which widens into a pill only when
// it has something to say. It says good morning when the Mac starts or wakes, what a
// gesture just did, and what went wrong, in words.
//
// Pure and tested: the state the server streams in, one picture out. The page
// that draws it (orb.js) only does I/O.

// How long each kind of message stays before the orb shrinks back.
export const GREETING_MS = 4000;
export const ACTION_MS = 1500;
export const PROBLEM_MS = 4000;

/**
 * A gap this long between the page's clock ticks means the Mac slept:
 * timers don't run while it does. That is how the orb knows the lid was just
 * opened, without hooking macOS's wake notifications.
 */
export const SLEEP_GAP_MS = 60_000;

/** The camera page gets this long to open before the orb says it didn't. */
export const ENGINE_START_MS = 20_000;

/** The server has to be unreachable this long before the orb says so. */
export const DOWN_AFTER_MS = 3000;

/** @param {Date} date */
export function greetingFor(date) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Hello';
}

/**
 * Did the Mac sleep between two ticks?
 * Wall-clock times (Date.now()), not performance.now(): the monotonic clock
 * may not advance while the Mac sleeps, which would hide the very gap
 * being looked for.
 */
export function sleptBetween(lastTick, now, gap = SLEEP_GAP_MS) {
  return Number.isFinite(lastTick) && now - lastTick > gap;
}

// The orb speaks in Jelly's voice: a few words beside its face, matching
// it. What exactly happened, and what to do, is the detail: VoiceOver reads
// it, the island doesn't show it.

// When a gesture works: matched on the action, the words after the arrow
// ("Swipe left → next desktop", from ui/words.js). The face goes with them.
const SAID = [
  [/→ armed$/, "I'm awake", 'armed'],
  [/→ disarmed$/, 'Going to sleep', 'asleep'],
  [/→ (next|previous) desktop$/, "Hey, I'm looking", 'nod'],
  [/→ page down$/, 'Down we go', 'nod'],
  [/→ page up$/, 'Up we go', 'nod'],
  [/→ lock screen$/, 'See you soon', 'nod'],
  [/→ focus the screen you face$/, 'Over there', 'nod'],
  [/→ (mute|mute mic \(Zoom\))$/, 'Shh', 'nod'],
  [/→ volume up$/, 'Louder', 'nod'],
  [/→ volume down$/, 'Quieter', 'nod'],
  [/→ next track$/, 'Next song', 'nod'],
  [/→ previous track$/, 'Last song', 'nod'],
  [/→ next slide$/, 'Next slide', 'nod'],
  [/→ previous slide$/, 'Back a slide', 'nod'],
  [/→ Mission Control$/, "Here's everything", 'nod'],
];

/**
 * What Jelly says when a gesture works, and the face it makes.
 * @returns {{words: string, mood: string}}
 */
export function saidFor(text) {
  for (const [pattern, words, mood] of SAID) {
    if (pattern.test(text)) return { words, mood };
  }
  return { words: 'Got it', mood: 'nod' };
}

// When a gesture is refused: Jelly's words, and the fix, for the detail.
const PROBLEMS = [
  [/accessibility/i, 'Mac blocked me', 'Allow Gesture in System Settings → Privacy → Accessibility'],
  [/not answering/i, 'Something broke', 'Quit Gesture and open it again'],
  [/calibrat/i, 'Show me your screens', 'Right-click → Settings → Screens'],
  [/head tracking is still starting/i, 'Still waking up', 'Try again in a moment'],
  [/head tracking is not running/i, "I can't see your face", 'Turn the camera off and on again'],
  [/still turning/i, 'Hold still', 'Look at one screen, then pinch'],
  [/not facing/i, 'Look at a screen', 'Look at a calibrated screen, then pinch'],
  [/no face/i, "I can't see you", 'Face the camera, then try again'],
  [/moved it back/i, 'It bounced back', 'Click the window you want, then swipe'],
  [/didn't move/i, "That didn't work", 'The key went out; the terminal says more'],
];

/**
 * A refusal in Jelly's words, with the page's own words and the fix as the
 * detail.
 * @returns {{words: string, detail: string}}
 */
export function explainProblem(text) {
  for (const [pattern, words, hint] of PROBLEMS) {
    if (pattern.test(text)) return { words, detail: `${text}. ${hint}` };
  }
  return { words: "That didn't work", detail: text };
}

// Moods whose words are never the steady state: reactions, which the first
// line already shows, and the camera being off, which the orb says itself.
const NOT_STEADY = new Set(['nod', 'shrug', 'off', 'offline']);

/**
 * The orb's second line while the camera is on: "Ready" or "Disarmed", never
 * the reaction it is already showing on the first line.
 */
export function steadyLabel(previous, mascot) {
  if (!mascot || NOT_STEADY.has(mascot.mood)) return previous;
  return mascot.label;
}

/**
 * Take a reaction from a streamed mood, once.
 *
 * The page numbers its reactions and keeps sending the latest, so a number not
 * seen before is what makes it new. The orb notes the number in the snapshot
 * it gets on connecting, without showing it: a gesture from before the orb
 * loaded is not news.
 *
 * @param {number|null} lastSeq The last number seen, or null for none.
 * @returns {{lastSeq: number|null, event: {type: string, text: string, at: number}|null}}
 */
export function takeEvent(lastSeq, incoming, now) {
  if (!incoming || incoming.seq === lastSeq) return { lastSeq, event: null };
  return { lastSeq: incoming.seq, event: { type: incoming.type, text: incoming.text, at: now } };
}

/** The same problem is said once in this long, however often it happens. */
export const REPEAT_QUIET_MS = 20_000;

/**
 * Has this problem already been said, just now?
 *
 * @param {Map<string, number>} said When each problem's words were last shown.
 */
export function saidRecently(said, event, now) {
  if (event.type !== 'refused') return false;
  const at = said.get(event.text);
  return at !== undefined && now - at < REPEAT_QUIET_MS;
}

/**
 * A one-off note for a camera change the user made: turning it off says so
 * once, then the orb goes quiet. Turning it on needs no note: the loading pill
 * and the glow say it.
 *
 * @returns {{line1: string, line2: string, at: number}|null}
 */
export function cameraNote(before, after, now) {
  if (before?.state === 'on' && after.state === 'off' && !after.want) {
    return { line1: "I'm not looking", line2: 'Camera off. Click me to turn it back on', at: now };
  }
  return null;
}

const CAMERA_TROUBLE = new Set(['blocked', 'failed']);

/**
 * @param {object} s
 * @param {number|null} s.downSince When the stream to the server dropped, or null.
 * @param {number} s.engines Camera pages connected.
 * @param {{want: boolean, state: string, error: string|null}} s.camera
 * @param {number|null} s.cameraAt When the camera state last changed.
 * @param {number|null} s.wantSince When the camera was asked for, while it isn't on yet.
 * @param {{mood: string, gaze: {x: number, y: number}, label: string}} s.mascot
 * @param {string} s.steady From steadyLabel().
 * @param {{type: string, text: string, at: number}|null} s.event From takeEvent().
 * @param {{line1: string, line2: string, at: number}|null} [s.note] From cameraNote().
 * @param {{text: string, at: number}|null} s.greeting
 * @param {number} now
 * @returns {{size: 'tab'|'pill', tone: string, mood: string, gaze: {x: number, y: number}, line1: string, line2: string}}
 *   line1: what Jelly says, beside it. line2: the detail, for VoiceOver.
 *   tone: off, loading, rest (camera on, disarmed), live (armed), nod, warn, bad.
 *   mood: the page's moods (ui/mascot.js), plus three only the orb shows:
 *   hello for a greeting, armed for arming, problem for something broken.
 */
export function orbView(s, now) {
  const camera = s.camera;
  const on = camera.state === 'on';
  const gaze = on ? s.mascot.gaze : { x: 0, y: 0 };
  const pill = (tone, mood, line1, line2) => ({ size: 'pill', tone, mood, gaze, line1, line2: line2 ?? '' });
  const within = (at, ms) => at !== null && at !== undefined && now - at >= 0 && now - at < ms;

  if (s.downSince !== null && now - s.downSince >= DOWN_AFTER_MS) {
    return pill('bad', 'problem', 'Something broke', "Gesture's server stopped. Quit Gesture and open it again");
  }

  if (camera.state === 'needs-permission') {
    return pill('warn', 'awake', 'Let me see you', 'Allow the camera in the Gesture window that just opened');
  }
  if (CAMERA_TROUBLE.has(camera.state) && within(s.cameraAt, PROBLEM_MS)) {
    return camera.state === 'blocked'
      ? pill('bad', 'problem', 'My camera is blocked', 'Right-click → Settings to allow it')
      : pill('bad', 'problem', "My camera didn't start", camera.error);
  }

  if (s.event?.type === 'refused' && within(s.event.at, PROBLEM_MS)) {
    const { words, detail } = explainProblem(s.event.text);
    return pill('warn', 'shrug', words, detail);
  }
  if (s.event?.type === 'fired' && within(s.event.at, ACTION_MS)) {
    const { words, mood } = saidFor(s.event.text);
    return pill('nod', mood, words, s.event.text);
  }
  if (s.note && within(s.note.at, ACTION_MS)) {
    return pill('off', 'off', s.note.line1, s.note.line2);
  }

  if (camera.want && !on) {
    if (s.engines === 0 && within(s.wantSince, Infinity) && now - s.wantSince >= ENGINE_START_MS) {
      return pill('bad', 'problem', "I couldn't start", "The camera page didn't open. Quit Gesture and open it again");
    }
    return pill('loading', 'learning', 'Waking up…', s.engines === 0 ? 'Opening the camera page' : 'Loading hand tracking');
  }

  // Camera on: the glow shows the state, and the face is the mascot's.
  const mood = on && s.mascot.mood !== 'offline' ? s.mascot.mood : 'off';
  let tone = 'off';
  if (on) tone = mood === 'asleep' || mood === 'off' ? 'rest' : 'live';
  else if (CAMERA_TROUBLE.has(camera.state)) tone = 'warn';

  if (s.greeting && within(s.greeting.at, GREETING_MS)) {
    return pill(tone, 'hello', s.greeting.text, on ? s.steady : 'Click me to turn on the camera');
  }

  return {
    size: 'tab',
    tone,
    mood,
    gaze,
    line1: 'Gesture',
    line2: on ? s.steady : 'Camera off. Click to turn it on',
  };
}

/**
 * How long until the orb's picture can change by itself: a message running
 * out, or a wait turning into a warning. The page renders on every event from
 * the server, and otherwise sleeps until then, instead of redrawing on a timer.
 *
 * @returns {number} ms, Infinity when nothing is pending.
 */
export function nextChangeIn(s, now) {
  const deadlines = [
    s.greeting && s.greeting.at + GREETING_MS,
    s.note && s.note.at + ACTION_MS,
    s.event && s.event.at + (s.event.type === 'refused' ? PROBLEM_MS : ACTION_MS),
    s.cameraAt !== null && s.cameraAt !== undefined && s.cameraAt + PROBLEM_MS,
    s.downSince !== null && s.downSince + DOWN_AFTER_MS,
    s.wantSince !== null && s.wantSince !== undefined && s.wantSince + ENGINE_START_MS,
  ];
  let soonest = Infinity;
  for (const at of deadlines) if (typeof at === 'number' && at > now) soonest = Math.min(soonest, at - now);
  return soonest;
}

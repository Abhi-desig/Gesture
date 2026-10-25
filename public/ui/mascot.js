// The mascot: Gesture's live status as a face.
//
// It exists for the moment the page is hidden — which is most of the time —
// and the chips go unseen. The same face sits in the page header and in the
// orb under the camera, so a glance at the top of the screen answers "is it
// on, is it watching, did that work?".
//
// Two rules decide everything here:
//   - It *is* the status, never a helper that talks. Clippy guessed what you
//     were doing and interrupted; it was switched off by default in Office XP
//     and removed in Office 2007. This face reacts only to what already
//     happened, and never asks for anything.
//   - Its eyes look at your screens, never at you. A character with a camera
//     behind it that stares back is unsettling; one that looks where you are
//     looking is just showing what the head tracking sees.
//
// Pure and tested: a snapshot of app state in, one mood out. Moods follow
// events (fired, refused, armed) rather than particular gestures, so changing
// which gesture does what never changes the face.

export const MOODS = [
  'off',
  'still',
  'nod',
  'shrug',
  'asleep',
  'learning',
  'watching',
  'away',
  'awake',
];

// How long a reaction shows before the face goes back to its steady state.
export const NOD_MS = 500;
export const SHRUG_MS = 700;

const LABEL_MAX = 80;
const clip = (text) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);
const clamp = (x) => Math.max(-1, Math.min(1, x));

/**
 * Where on the desk a screen sits, from -1 (far left) to 1 (far right).
 *
 * @param {{id:number,x:number,width:number}[]} displays
 * @param {number} id
 * @returns {number} 0 when the screen is unknown or there is only one.
 */
export function screenGazeX(displays, id) {
  const screen = displays.find((d) => d.id === id);
  if (!screen || displays.length < 2) return 0;
  const left = Math.min(...displays.map((d) => d.x));
  const right = Math.max(...displays.map((d) => d.x + d.width));
  if (right <= left) return 0;
  const centre = screen.x + screen.width / 2;
  return clamp(((centre - left) / (right - left)) * 2 - 1);
}

/**
 * @param {object} s
 * @param {boolean} s.cameraOn
 * @param {boolean} [s.paused] On, but no frames are arriving.
 * @param {boolean} s.checkup Check-up running: the face holds still so it can
 *   never be a cue during a timed trial.
 * @param {{type: 'fired'|'refused', at: number, text: string}|null} s.event
 *   The last reaction-worthy thing that happened.
 * @param {boolean} s.armed
 * @param {boolean} s.learning Calibrating screens or teaching a gesture.
 * @param {{handPresent: boolean, pose: string|null, heldMs: number, holdMs: number}|null} s.view
 * @param {string} s.poseName The held pose, in words.
 * @param {boolean} s.headWanted
 * @param {boolean} s.faceSeen
 * @param {number|null} s.facingScreen
 * @param {number} s.gazeX Where the faced screen sits, from screenGazeX().
 * @param {number} now
 * @returns {{mood: string, gaze: {x: number, y: number}, ring: number, label: string}}
 */
export function mascotMood(s, now) {
  // Eyes follow the screen you face; looking at nothing in particular looks down.
  let gaze = { x: 0, y: 0 };
  if (s.headWanted && s.faceSeen) {
    gaze = s.facingScreen !== null ? { x: clamp(s.gazeX ?? 0), y: 0 } : { x: 0, y: 1 };
  }
  const result = (mood, label, ring = 0) => ({ mood, gaze, ring, label: clip(label) });

  if (!s.cameraOn) return { mood: 'off', gaze: { x: 0, y: 0 }, ring: 0, label: 'Camera off' };
  // On but seeing nothing: eyes shut, rather than a face that looks awake.
  if (s.paused) return { mood: 'off', gaze: { x: 0, y: 0 }, ring: 0, label: 'Camera paused' };
  if (s.checkup) return { mood: 'still', gaze: { x: 0, y: 0 }, ring: 0, label: 'Measuring — staying still' };

  const age = s.event ? now - s.event.at : Infinity;
  if (s.event?.type === 'fired' && age >= 0 && age < NOD_MS) return result('nod', `Did it: ${s.event.text}`);
  if (s.event?.type === 'refused' && age >= 0 && age < SHRUG_MS) return result('shrug', s.event.text);

  if (!s.armed) return result('asleep', 'Disarmed');
  if (s.learning) return result('learning', 'Learning…');

  const view = s.view;
  if (view?.handPresent && view.pose && view.holdMs > 0) {
    return result('watching', `Holding ${s.poseName}`, Math.min(1, view.heldMs / view.holdMs));
  }
  if (view?.handPresent) return result('watching', 'Watching your hand');
  if (s.headWanted && s.faceSeen && s.facingScreen === null) return result('away', 'Looking away');
  return result('awake', 'Ready');
}

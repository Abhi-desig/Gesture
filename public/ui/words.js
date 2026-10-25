// Plain words for what the app knows.
//
// The readout speaks the detector's language — "Palm speed 0.80", "Backend
// cgevent", "space_right". That is right for the Diagnostics drawer and wrong
// for everyone else, including a friend sitting down for the check-up. These
// turn the same facts into sentences. Pure, so the wording is tested.

const ACTIONS = {
  audio_play: 'play / pause',
  audio_next: 'next track',
  audio_prev: 'previous track',
  audio_mute: 'mute',
  audio_vol_up: 'volume up',
  audio_vol_down: 'volume down',
  space_right: 'next desktop',
  space_left: 'previous desktop',
  'cmd+ctrl+q': 'lock screen',
  'ctrl+up': 'Mission Control',
  focus_screen: 'focus the screen you face',
  toggle_armed: 'arm / disarm',
  pagedown: 'page down',
  pageup: 'page up',
  'cmd+shift+a': 'mute mic (Zoom)',
  'cmd+shift+v': 'camera on / off (Zoom)',
  right: 'next slide',
  left: 'previous slide',
};

const GESTURES = {
  ok_sign: 'OK sign',
  pinch: 'pinch',
  fist: 'fist',
  open_palm: 'open hand',
  grab: 'close your hand',
  cover: 'cover the camera',
  shh: 'shh (finger on lips)',
  swipe_left: 'swipe left',
  swipe_right: 'swipe right',
  swipe_up: 'swipe up',
  swipe_down: 'swipe down',
};

const HOW_TO = {
  ok_sign: 'Make an OK sign',
  pinch: 'Pinch',
  grab: 'Close your open hand',
  cover: 'Cover the camera for a second',
  shh: 'Put a finger to your lips',
  open_palm: 'Hold up an open hand',
  swipe_left: 'Swipe left',
  swipe_right: 'Swipe right',
  swipe_up: 'Swipe up',
  swipe_down: 'Swipe down',
};

/** An instruction for making a gesture: "Make an OK sign", "Pinch". */
export function howToMake(name) {
  return HOW_TO[name] ?? `Make a ${describeGesture(name)}`;
}

/** What a binding does, in words; an unfamiliar shortcut is shown as itself. */
export function describeAction(combo) {
  if (!combo) return 'not bound';
  return ACTIONS[combo] ?? combo;
}

/** A gesture's name as a person would say it. */
export function describeGesture(name) {
  if (!name) return 'nothing';
  if (name.startsWith('custom:')) return `“${name.slice('custom:'.length)}” (taught)`;
  return GESTURES[name] ?? name.replaceAll('_', ' ');
}

/**
 * The Home card: what Gesture sees right now, in four lines.
 *
 * @param {object} s
 * @param {boolean} s.cameraOn
 * @param {object|null} s.view The recogniser's view for the latest frame.
 * @param {boolean} s.headWanted Something is bound to a screen action.
 * @param {boolean} s.headAvailable
 * @param {object|null} s.facing The screen tracker's latest answer.
 * @param {boolean} s.calibrated
 * @param {(id: number) => string} s.screenName
 * @param {{gesture: string}|null} s.last The last gesture that acted.
 * @param {Record<string, string>} s.bindings
 * @returns {{seeing: string, holdPct: number, facing: string|null, last: string}}
 */
export function liveSummary(s) {
  const view = s.view;
  let seeing;
  if (!s.cameraOn) seeing = 'Camera is off';
  else if (!view?.handPresent) seeing = 'No hand in view';
  else if (view.pose) seeing = describeGesture(view.pose);
  else seeing = 'A hand — no gesture shape';

  const holdPct = view?.pose && view.holdMs > 0 ? Math.min(1, view.heldMs / view.holdMs) : 0;

  let facing = null;
  if (s.headWanted) {
    if (!s.cameraOn || !s.headAvailable) facing = 'Head tracking is off';
    else if (!s.facing?.pose) facing = 'No face in view';
    else if (!s.calibrated) facing = 'Screens not calibrated';
    else if (s.facing.screen !== null) facing = s.screenName(s.facing.screen);
    else facing = 'No screen — looking away';
  }

  const last = s.last
    ? `${describeGesture(s.last.gesture)} → ${describeAction(s.bindings?.[s.last.gesture])}`
    : 'Nothing yet';

  return { seeing, holdPct, facing, last };
}

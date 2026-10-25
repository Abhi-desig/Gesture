// The status bar: five chips that answer "is it working?" at a glance.
//
// Each chip is a word as well as a colour — tone alone would leave out anyone
// who can't tell the colours apart — and the rules behind them are the same
// ones the Diagnostics readout uses, moved here so they're tested once.

/**
 * What the camera is doing, as one of a fixed set of states.
 *
 * Shared by the Camera chip and the Diagnostics "Detection" row, so the two can
 * never disagree about whether detection is alive.
 *
 * @returns {'off'|'paused'|'muted'|'restarting'|'stalled'|'running'}
 */
export function cameraState({ on, mode, hidden, muted, recovering, msSinceFrame }) {
  if (!on) return 'off';
  // Only the in-page fallback stops when hidden; the worker keeps going.
  if (mode === 'page' && hidden) return 'paused';
  if (muted) return 'muted';
  if (recovering) return 'restarting';
  if (msSinceFrame > 1500) return 'stalled';
  return 'running';
}

const CAMERA = {
  off: ['Camera off', 'off'],
  paused: ['Camera paused', 'warn'],
  muted: ['Camera muted', 'warn'],
  restarting: ['Camera restarting', 'warn'],
  stalled: ['Camera stalled', 'bad'],
};

/**
 * @param {object} s
 * @param {object} s.camera  { on, mode, hidden, muted, recovering, msSinceFrame, fps }
 * @param {boolean} s.armed
 * @param {boolean} s.dryRun
 * @param {object|null|undefined} s.health GET /health, null when the server
 *   didn't answer, undefined before the first answer.
 * @param {object} s.head    { wanted, available, faceSeen, calibrated, facingName }
 * @param {'on'|'off'|'locked'} s.sound
 * @returns {{id: string, label: string, tone: 'on'|'warn'|'bad'|'off', detail: string}[]}
 */
export function statusChips(s) {
  const chips = [];

  const cam = cameraState(s.camera);
  if (cam === 'running') {
    chips.push({ id: 'camera', label: `Camera ${Math.round(s.camera.fps || 0)} fps`, tone: 'on', detail: `Detecting in ${s.camera.mode} mode.` });
  } else {
    const [label, tone] = CAMERA[cam];
    const detail = cam === 'paused'
      ? 'This browser pauses detection while the window is hidden — use Chrome to keep it running.'
      : cam === 'stalled'
        ? 'No camera frames for over a second and a half.'
        : '';
    chips.push({ id: 'camera', label, tone, detail });
  }

  chips.push({
    id: 'armed',
    label: s.armed ? 'Armed' : 'Disarmed',
    tone: s.armed ? 'on' : 'off',
    detail: s.armed ? 'Gestures act. Press Esc to disarm.' : 'Gestures are seen but do nothing.',
  });

  const h = s.head;
  if (h?.wanted) {
    let chip;
    if (!h.available) chip = s.camera.on ? ['Head tracking starting', 'warn'] : ['Head tracking off', 'off'];
    else if (!h.faceSeen) chip = ['No face', 'warn'];
    else if (!h.calibrated) chip = ['Not calibrated', 'warn'];
    else if (h.facingName) chip = [`Facing ${h.facingName}`, 'on'];
    else chip = ['Facing no screen', 'off'];
    chips.push({ id: 'head', label: chip[0], tone: chip[1], detail: '' });
  }

  const health = s.health;
  if (health === undefined) {
    chips.push({ id: 'keys', label: 'Checking keys…', tone: 'off', detail: '' });
  } else if (!health) {
    chips.push({ id: 'keys', label: 'Server unreachable', tone: 'bad', detail: 'Is the Gesture server running?' });
  } else if (health.backend === 'dryrun') {
    chips.push({ id: 'keys', label: 'No key backend', tone: 'bad', detail: health.backendReason ?? '' });
  } else if (s.dryRun) {
    chips.push({ id: 'keys', label: 'Dry-run', tone: 'warn', detail: 'Gestures are logged, nothing is pressed.' });
  } else if (health.accessibility?.granted === false) {
    chips.push({ id: 'keys', label: 'Keys blocked', tone: 'bad', detail: `Allow Accessibility: ${health.accessibilityHelp ?? ''}`.trim() });
  } else {
    chips.push({ id: 'keys', label: 'Keys ready', tone: 'on', detail: `Through ${health.backend}.` });
  }

  const sound = {
    on: ['Sound on', 'on'],
    off: ['Sound off', 'off'],
    locked: ['Click to enable sound', 'warn'],
  }[s.sound] ?? ['Sound off', 'off'];
  chips.push({ id: 'sound', label: sound[0], tone: sound[1], detail: '' });

  return chips;
}

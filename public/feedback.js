// Audible confirmation, for the normal case where this window isn't on screen.
//
// The page is usually minimised behind whatever you're working in, so the log
// and the readout can't tell you a gesture landed. Sound can, and it can carry
// the closed loop too: a desktop switch that macOS ignored sounds different from
// one that happened, because the server checked before it answered.
//
// `cueFor` is pure and tested. `Chime` is the Web Audio half: short sine notes,
// quiet enough to sit under music.

/**
 * Which sound a POST /gesture response deserves.
 *
 * @param {number} status HTTP status.
 * @param {object} data Response body.
 * @returns {'done'|'failed'|'tick'|null} null means stay silent.
 */
export function cueFor(status, data = {}) {
  // Expected noise, not a failure: the gesture is still held, or was repeated.
  if (data.reason === 'cooldown') return null;
  // Recognised but deliberately not pressed — a lighter sound, so a dry-run
  // session (the self-test's recognition pass) is still audible.
  if (data.reason === 'dryRun') return 'tick';
  if (!data.fired) return 'failed';
  // The server verified a desktop switch and it didn't stick.
  if (data.spaceChanged === false) return 'failed';
  return status < 400 ? 'done' : 'failed';
}

// Frequencies in Hz and durations in seconds. Rising for yes, falling for no,
// so the meaning survives without anyone learning which sound is which.
const CUES = {
  done: [[659, 0.07], [880, 0.09]],
  failed: [[247, 0.12], [196, 0.16]],
  tick: [[1047, 0.04]],
  armed: [[523, 0.06], [784, 0.08]],
  disarmed: [[784, 0.06], [523, 0.08]],
};

const VOLUME = 0.08;

export class Chime {
  constructor() {
    this.context = null;
    this.enabled = true;
  }

  /**
   * Create or resume the audio context. Browsers only allow that inside a user
   * gesture — a click or a key press on this page, not a hand gesture — so the
   * page calls this from its own input handlers.
   */
  unlock() {
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') this.context.resume();
    } catch {
      this.context = null;
    }
  }

  /** 'on', 'off', or 'locked' until the page has been clicked once. */
  get status() {
    if (!this.enabled) return 'off';
    return this.context?.state === 'running' ? 'on' : 'locked';
  }

  play(cue) {
    const notes = CUES[cue];
    if (!notes || !this.enabled || this.context?.state !== 'running') return;

    const ctx = this.context;
    let at = ctx.currentTime + 0.01;
    for (const [freq, length] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // A soft attack and an exponential tail: no click at either end.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(VOLUME, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + length + 0.02);
      at += length * 0.85;
    }
  }
}

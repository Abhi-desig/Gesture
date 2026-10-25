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
  // A desktop switch that didn't stick is found afterwards and sounded then
  // (the server's 'problem' event).
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
  // The check-up's starting signal: one bright, short note. Time zero for every
  // measured trial is the moment this is played.
  go: [[1319, 0.06]],
};

const VOLUME = 0.08;

// A running audio context keeps an audio thread awake even in silence, so it
// is suspended this long after the last cue, and woken for the next one.
const IDLE_SUSPEND_MS = 30_000;

export class Chime {
  constructor() {
    this.context = null;
    this.enabled = true;
    // True while suspended by the idle timer rather than by the browser.
    this.resting = false;
    this.restTimer = null;
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
    return this.context?.state === 'running' || this.resting ? 'on' : 'locked';
  }

  play(cue) {
    const notes = CUES[cue];
    if (!notes || !this.enabled || !this.context) return;
    if (this.resting) {
      this.resting = false;
      this.context.resume().then(() => this.play(cue), () => {});
      return;
    }
    if (this.context.state !== 'running') return;
    this.#restLater();

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

  #restLater() {
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => {
      if (this.context?.state !== 'running') return;
      this.resting = true;
      this.context.suspend().catch(() => {
        this.resting = false;
      });
    }, IDLE_SUSPEND_MS);
  }
}

/**
 * Spoken prompts for the check-up, through the browser's own speech (local
 * system voices; nothing is sent anywhere).
 *
 * Speech is unreliable in ways a measurement must not depend on: it can take a
 * few hundred ms to start, and Chrome sometimes never reports the end of an
 * utterance it was not holding a reference to. So the utterance is kept, any
 * earlier one is cancelled first, and `say` always settles — on the end event,
 * an error, or a timeout — with `fallback: true` whenever the words may not
 * have been heard, so the caller can play a chime instead.
 */
export class Voice {
  constructor({ timeoutMs = 2500 } = {}) {
    this.timeoutMs = timeoutMs;
    this.current = null;
  }

  get available() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance === 'function';
  }

  /** @returns {Promise<{fallback: boolean}>} */
  say(text) {
    if (!this.available) return Promise.resolve({ fallback: true });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (fallback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ fallback });
      };
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.1;
      utterance.onend = () => finish(false);
      utterance.onerror = () => finish(true);
      this.current = utterance;
      const timer = setTimeout(() => finish(true), this.timeoutMs + text.length * 60);
      speechSynthesis.speak(utterance);
    });
  }

  cancel() {
    if (this.available) speechSynthesis.cancel();
    this.current = null;
  }
}

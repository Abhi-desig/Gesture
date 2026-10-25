// When the vanish happens, and how it looks: the timeline and the dust
// settings. Pure — the renderer draws whatever these say.
//
//   idle ─snap→ dissolving ─→ gone ─snap or 10 s→ returning ─→ idle
//
// A snap in the middle of an animation is ignored rather than queued: a second
// snap while you're still turning to dust would otherwise bring you straight
// back. With "Reduce motion" on, both animations become a short cross-fade.

export const VANISH_DEFAULTS = {
  returnFactor: 0.6,
  autoReturnMs: 10000,
  reducedMs: 300,
};

const NEXT = { dissolving: 'gone', gone: 'returning', returning: 'idle' };

export class VanishTimeline {
  constructor(options = {}) {
    this.o = { ...VANISH_DEFAULTS, ...options };
    this.dissolveMs = 2500;
    this.reduced = false;
    this.phase = 'idle';
    this.since = 0;
  }

  /** Duration from the sliders, and the system's reduce-motion setting. */
  configure({ dissolveMs = this.dissolveMs, reduced = this.reduced } = {}) {
    this.dissolveMs = dissolveMs;
    this.reduced = reduced;
  }

  #length(phase) {
    if (phase === 'dissolving') return this.reduced ? this.o.reducedMs : this.dissolveMs;
    if (phase === 'returning') return this.reduced ? this.o.reducedMs : this.dissolveMs * this.o.returnFactor;
    if (phase === 'gone') return this.o.autoReturnMs;
    return Infinity;
  }

  /**
   * A snap or the Vanish button. Returns the phase it started, or null when it
   * was ignored. The caller freezes a snapshot when dissolving starts; the
   * renderer retakes it on its own while returning.
   */
  trigger(now) {
    if (this.phase === 'idle') return this.#enter('dissolving', now);
    if (this.phase === 'gone') return this.#enter('returning', now);
    return null;
  }

  /** Back to idle at once, as when leaving the Lab. */
  reset() {
    this.phase = 'idle';
    this.since = 0;
  }

  /**
   * @returns {{phase: string, t: number, entered: string|null}}
   *   `t` is the effect's clock, 0 → 1 while dissolving and 1 → 0 while
   *   returning (the same animation, backwards). `entered` names a phase
   *   started by this call, like the automatic return or the end of the effect.
   *
   *   There is no cross-fade at the end: the return redraws you from the live
   *   picture every frame, so by its last frame it already is the live picture.
   */
  update(now) {
    // Each phase starts when the last one ended, not when a frame noticed — and
    // a long gap between frames (a hidden tab) can pass through several.
    let entered = null;
    for (;;) {
      const next = NEXT[this.phase];
      const endsAt = this.since + this.#length(this.phase);
      if (!next || now < endsAt) break;
      entered = this.#enter(next, endsAt);
    }

    const p = Math.min(1, Math.max(0, (now - this.since) / this.#length(this.phase)));
    switch (this.phase) {
      case 'dissolving':
        return { phase: this.phase, t: p, entered };
      case 'gone':
        return { phase: this.phase, t: 1, entered };
      case 'returning':
        return { phase: this.phase, t: 1 - p, entered };
      default:
        return { phase: 'idle', t: 0, entered };
    }
  }

  #enter(phase, now) {
    this.phase = phase;
    this.since = now;
    return phase;
  }
}

// ------------------------------------------------------------- dust settings

/** The Lab's sliders: range, step and default. Ash brown-grey by default, like the film. */
export const DUST_SETTINGS = {
  seconds: { min: 1, max: 5, step: 0.1, value: 2.5, label: 'How long' },
  direction: { min: 0, max: 359, step: 1, value: 60, label: 'Drift direction' },
  speed: { min: 0.2, max: 2, step: 0.05, value: 1, label: 'Speed' },
  size: { min: 0.5, max: 3, step: 0.1, value: 1.2, label: 'Speck size' },
  ash: { min: 0, max: 1, step: 0.05, value: 0.85, label: 'Turns to ash' },
};

/** Saved or typed settings, clamped to the slider ranges; anything missing is the default. */
export function dustSettings(raw = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(DUST_SETTINGS)) {
    const v = Number(raw?.[key]);
    out[key] = Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.value;
  }
  return out;
}

/**
 * The drift direction as a vector in *texture* space. The slider means what you
 * see: 0° is to the right of the mirrored picture and 90° is up. The picture is
 * mirrored and texture rows run top to bottom, so both components flip.
 */
export function windInTexture(directionDeg) {
  const a = (directionDeg * Math.PI) / 180;
  return { x: -Math.cos(a), y: -Math.sin(a) };
}

// "Close your hand": an open palm that becomes a fist. Play / pause.
//
// In a mid-air TV gesture study, participants' consensus for play/pause was to
// open or close the palm (Dim et al., DIS '16). It is also why this is a
// *movement* rather than a pose: a fist on its own is what a resting hand, a
// thumbs-up and a hand on its way to the mouse all look like, and the v1 fist
// fired music on all of them. Closing an open hand is something you only do on
// purpose.
//
// Fed the recogniser's `view.shape`, which reports the hand's shape even while
// it moves, because a hand closing moves a little. Pure: no DOM, no timers.

/** Gestures that are movements, not poses: closing an open hand, covering the lens (cover.js). */
export const MOVEMENTS = ['grab', 'cover'];

export const GRAB_DEFAULTS = {
  // The open hand has to be shown first, deliberately…
  openMs: 150,
  // …and the fist has to follow within this, or it's just a hand that rested.
  closeWithinMs: 600,
};

export class GrabDetector {
  constructor(options = {}) {
    this.o = { ...GRAB_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.openSince = null;
    // When the last open palm held long enough ended; a fist must come soon after.
    this.openEndedAt = null;
    // One grab per closing: the fist has to open again before the next.
    this.fired = false;
  }

  /**
   * @param {string|null} shape `view.shape`: a built-in pose name, or null.
   * @returns {'grab'|null}
   */
  update(shape, now) {
    if (shape === 'open_palm') {
      this.openSince ??= now;
      this.fired = false;
      if (now - this.openSince >= this.o.openMs) this.openEndedAt = now;
      return null;
    }
    this.openSince = null;

    if (shape === 'fist') {
      const recent = this.openEndedAt !== null && now - this.openEndedAt <= this.o.closeWithinMs;
      if (recent && !this.fired) {
        this.fired = true;
        this.openEndedAt = null;
        return 'grab';
      }
      return null;
    }

    // Anything else (no hand, a pinch, half-closed) leaves the window running:
    // the frames between open and fist are usually neither.
    if (this.openEndedAt !== null && now - this.openEndedAt > this.o.closeWithinMs) this.openEndedAt = null;
    return null;
  }
}

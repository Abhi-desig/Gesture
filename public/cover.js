// "Cover the camera": a hand over the lens for a second. Locks the screen.
//
// Covering a phone with the hand was blind participants' consensus for pause
// and for ignoring a call (Dim & Ren, 2014). It replaces a held open palm,
// which is the commonest resting and "hello" hand there is, and which locked
// the Mac by accident in a live session on 24 Oct.
//
// The hand model can't see this, since a covered lens shows no hand at all.
// The worker sends two numbers per frame instead: the brightness of a 16×9
// thumbnail, and how much it varies. Covered means both:
//   - dark, against this camera's own recent brightness (a dim room is not a
//     covered lens);
//   - flat: a hand over the lens is featureless, while a dark room still has
//     edges.
// Pure: no DOM, no timers.

import { median } from './stats.js';

export const COVER_DEFAULTS = {
  holdMs: 1000,
  // Darker than this share of the recent brightness…
  darkRatio: 0.3,
  // …and flatter than this (standard deviation, 0–255).
  maxSpread: 12,
  // How far back "recent brightness" looks.
  baselineMs: 5000,
  // Below this the room itself is too dark to tell a cover from it.
  minBaseline: 25,
};

export class CoverDetector {
  constructor(options = {}) {
    this.o = { ...COVER_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.samples = [];
    this.darkSince = null;
    this.fired = false;
    this.covered = false;
  }

  /** The recent brightness, from uncovered frames only. */
  baseline(now) {
    while (this.samples.length > 0 && this.samples[0].t < now - this.o.baselineMs) this.samples.shift();
    return this.samples.length >= 5 ? median(this.samples.map((s) => s.mean)) : null;
  }

  /**
   * @param {{mean: number, spread: number}|null} luma Brightness of this frame, 0–255.
   * @returns {'cover'|null}
   */
  update(luma, now) {
    if (!luma) return null;
    const base = this.baseline(now);
    const dark = base !== null
      && base >= this.o.minBaseline
      && luma.mean < base * this.o.darkRatio
      && luma.spread < this.o.maxSpread;
    this.covered = dark;

    if (!dark) {
      // Uncovered: it can fire again next time, and this frame is the room.
      this.darkSince = null;
      this.fired = false;
      this.samples.push({ t: now, mean: luma.mean });
      return null;
    }

    this.darkSince ??= now;
    if (!this.fired && now - this.darkSince >= this.o.holdMs) {
      this.fired = true;
      return 'cover';
    }
    return null;
  }
}

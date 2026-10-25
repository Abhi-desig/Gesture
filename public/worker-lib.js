// Pure helpers for the detection worker, in a file both it and the tests load.
//
// The worker is a classic worker (MediaPipe's WASM glue fails in a module
// worker), and a classic worker can't import an ES module. So this file has no
// exports: it puts its functions on globalThis.GestureWorkerLib, which the
// worker reads after importScripts() and the tests read after import.

(() => {
  // No hand for this long, and the camera is checked less often.
  const IDLE_AFTER_MS = 1000;
  // How often it is checked then: about 8 times a second. A hand appearing is
  // seen within this long, and full rate resumes from that frame on.
  const IDLE_EVERY_MS = 125;

  /**
   * Should this frame go through the models?
   *
   * Most of the time nobody is gesturing, and running hand and face tracking on
   * every frame of an empty desk is most of what Gesture costs. With no hand
   * for a second, frames are sampled every IDLE_EVERY_MS instead; the first one
   * with a hand puts it back to every frame.
   *
   * @param {{now: number, lastHandAt: number, lastRunAt: number, full: boolean}} s
   *   full: every frame regardless, for calibration, the check-up, teaching and
   *   the Lab, which all need an unbroken stream.
   */
  function shouldDetect({ now, lastHandAt, lastRunAt, full }) {
    if (full || now - lastHandAt < IDLE_AFTER_MS) return true;
    return now - lastRunAt >= IDLE_EVERY_MS;
  }

  /**
   * Brightness of an RGBA thumbnail: the mean and standard deviation of its
   * luma, 0–255. Only these two numbers leave the worker, never pixels.
   */
  function lumaStats(rgba) {
    const n = rgba.length / 4;
    if (n === 0) return null;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      sum += y;
      sq += y * y;
    }
    const mean = sum / n;
    return { mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  }

  /**
   * Just the face points the page reads, at their own indices, in an array as
   * long as the original. Copying 8 of 478 points to the page instead of all
   * of them, about 17 times a second, is most of the traffic between the
   * threads.
   */
  function pickPoints(points, indices) {
    if (!points) return points;
    const picked = new Array(points.length);
    for (const i of indices) picked[i] = points[i];
    return picked;
  }

  globalThis.GestureWorkerLib = { IDLE_AFTER_MS, IDLE_EVERY_MS, shouldDetect, lumaStats, pickPoints };
})();

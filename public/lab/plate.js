// How much of the room behind you has been seen: the "Room seen" meter.
//
// The renderer learns the room on the GPU, pixel by pixel, only where you
// haven't been for about a second. Reading that back every frame would stall
// the GPU, so this keeps a coarse copy on the CPU instead: a 64×36 grid, a cell
// marked seen once it has stayed clear of you for a run of mask updates. The
// same rules decide both, so the meter and the picture agree. Pure: fed the
// mask, no DOM.
//
// There is deliberately no "count everything" switch. "Capture the room" used
// to have one, and anyone who didn't manage to leave the frame was learned into
// the room and left a smeared copy behind when they vanished.

export const COVERAGE_DEFAULTS = {
  cols: 64,
  rows: 36,
  // A cell counts as clear below this person confidence…
  threshold: 0.2,
  // …and so must its neighbours this many cells out, so your edges don't count…
  grow: 1,
  // …for this many mask updates in a row: about 0.7 s at 30 a second.
  clearUpdates: 20,
};

export class RoomCoverage {
  constructor(options = {}) {
    this.o = { ...COVERAGE_DEFAULTS, ...options };
    this.seen = new Uint8Array(this.o.cols * this.o.rows);
    this.clearFor = new Uint16Array(this.o.cols * this.o.rows);
    this.cellMax = new Float32Array(this.o.cols * this.o.rows);
  }

  reset() {
    this.seen.fill(0);
    this.clearFor.fill(0);
  }

  /** Share of the room seen so far, 0–1. */
  get fraction() {
    let n = 0;
    for (const s of this.seen) n += s;
    return n / this.seen.length;
  }

  /**
   * @param {Float32Array|null} mask Person confidence, row-major from the top.
   * @param {number} width
   * @param {number} height
   * @param {object} [opts]
   * @param {{x0:number,y0:number,x1:number,y1:number}[]} [opts.boxes] Also a
   *   person: areas the mask may miss, like a raised hand, in 0–1 coordinates.
   */
  update(mask, width, height, { boxes = [] } = {}) {
    const { cols, rows, threshold, grow, clearUpdates } = this.o;
    if (!mask || !width || !height) return;

    // The highest person confidence inside each cell.
    this.cellMax.fill(0);
    for (let y = 0; y < height; y += 1) {
      const row = Math.min(rows - 1, Math.floor((y * rows) / height)) * cols;
      for (let x = 0; x < width; x += 1) {
        const v = mask[y * width + x];
        const c = row + Math.min(cols - 1, Math.floor((x * cols) / width));
        if (v > this.cellMax[c]) this.cellMax[c] = v;
      }
    }
    for (const b of boxes) {
      const c0 = Math.max(0, Math.floor(b.x0 * cols));
      const c1 = Math.min(cols - 1, Math.floor(b.x1 * cols));
      const r0 = Math.max(0, Math.floor(b.y0 * rows));
      const r1 = Math.min(rows - 1, Math.floor(b.y1 * rows));
      for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) this.cellMax[r * cols + c] = 1;
    }

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        let near = 0;
        for (let dr = -grow; dr <= grow; dr += 1) {
          for (let dc = -grow; dc <= grow; dc += 1) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) near = Math.max(near, this.cellMax[rr * cols + cc]);
          }
        }
        const k = r * cols + c;
        this.clearFor[k] = near < threshold ? Math.min(this.clearFor[k] + 1, 65535) : 0;
        if (this.clearFor[k] >= clearUpdates) this.seen[k] = 1;
      }
    }
  }
}

/**
 * A box around the hand, padded by half a palm length, in 0–1 video
 * coordinates. Raw MediaPipe landmarks, not the aspect-corrected points.
 */
export function handBox(landmarks, pad = 0.5) {
  if (!landmarks?.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of landmarks) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const palm = Math.hypot(landmarks[9].x - landmarks[0].x, landmarks[9].y - landmarks[0].y) * pad;
  return { x0: x0 - palm, y0: y0 - palm, x1: x1 + palm, y1: y1 + palm };
}

// Small, dependency-free statistics for the check-up and the experiment.
//
// Medians and quartiles rather than means throughout: reaction times are
// skewed — one distracted trial can be ten times the typical one — and a mean
// would let it speak for all the rest. The bootstrap is there so a difference
// between two methods comes with an honest range, not just a single number.
//
// Seeded randomness everywhere it matters, so a test can pin the exact trial
// order and a published result can be reproduced from its seed.

/** Median of the finite numbers in `xs`, or null when there are none. */
export function median(xs) {
  return quantile(xs, 0.5);
}

/**
 * Quantile by linear interpolation between order statistics (the same rule
 * spreadsheets use), or null for an empty input.
 */
export function quantile(xs, q) {
  const sorted = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Lower and upper quartiles — the middle half of the results. */
export function iqr(xs) {
  return { p25: quantile(xs, 0.25), p75: quantile(xs, 0.75) };
}

/**
 * A seeded random number generator (mulberry32), returning floats in [0, 1).
 * Not for anything secret — for shuffling trials reproducibly.
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number in [min, max], from a generator like `seededRandom`. */
export function randomBetween(rng, min, max) {
  return Math.round(min + rng() * (max - min));
}

/**
 * Difference of medians (a − b) with a 95% bootstrap interval.
 *
 * Resamples each group with replacement and takes the 2.5th and 97.5th
 * percentiles of the resampled differences. With a handful of trials the range
 * is wide — which is the point: it says how much the data can actually claim.
 *
 * @returns {{diff: number|null, ci95: [number, number]|null}}
 */
export function bootstrapMedianDiff(a, b, { n = 2000, rng = seededRandom(1) } = {}) {
  const xa = a.filter(Number.isFinite);
  const xb = b.filter(Number.isFinite);
  if (xa.length === 0 || xb.length === 0) return { diff: null, ci95: null };

  const resample = (xs) => Array.from(xs, () => xs[Math.floor(rng() * xs.length)]);
  const diffs = [];
  for (let i = 0; i < n; i += 1) diffs.push(median(resample(xa)) - median(resample(xb)));
  return { diff: median(xa) - median(xb), ci95: [quantile(diffs, 0.025), quantile(diffs, 0.975)] };
}

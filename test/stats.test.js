import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapMedianDiff, iqr, median, quantile, randomBetween, seededRandom } from '../public/stats.js';

test('median and quartiles interpolate, and ignore anything that is not a number', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([1, null, 3, NaN, 2]), 2);
  assert.equal(median([]), null);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.deepEqual(iqr([1, 2, 3, 4, 5]), { p25: 2, p75: 4 });
});

test('a seed always gives the same sequence, inside [0, 1)', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const first = Array.from({ length: 50 }, () => a());
  assert.deepEqual(first, Array.from({ length: 50 }, () => b()));
  assert.ok(first.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(first, Array.from({ length: 50 }, seededRandom(43)));
});

test('randomBetween stays inside its bounds', () => {
  const rng = seededRandom(7);
  for (let i = 0; i < 200; i += 1) {
    const x = randomBetween(rng, 800, 1500);
    assert.ok(x >= 800 && x <= 1500 && Number.isInteger(x));
  }
});

test('the bootstrap interval brackets a clear difference and spans zero for none', () => {
  const fast = [600, 620, 640, 650, 700, 610, 630, 660];
  const slow = [900, 950, 980, 1000, 920, 940, 990, 960];
  const clear = bootstrapMedianDiff(slow, fast);
  assert.ok(clear.diff > 250);
  assert.ok(clear.ci95[0] > 0, 'the whole interval is above zero');

  const same = bootstrapMedianDiff(fast, [...fast].reverse());
  assert.equal(same.diff, 0);
  assert.ok(same.ci95[0] <= 0 && same.ci95[1] >= 0);

  assert.deepEqual(bootstrapMedianDiff([], fast), { diff: null, ci95: null });
});

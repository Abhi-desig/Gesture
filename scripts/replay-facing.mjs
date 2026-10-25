#!/usr/bin/env node
// Replay recorded check-up head traces through other tracker settings.
//
// Every facing trial keeps the raw head angles it saw, so a filter can be tried
// on the same heads after the fact. This is how the smoothing gets chosen: by
// which setting picked the right screen soonest without jittering, on real
// people at this desk — not by feel.
//
//   node scripts/replay-facing.mjs                      every file in experiments/
//   node scripts/replay-facing.mjs experiments/2026-10-23.jsonl
//
// Prints one row per setting: accuracy at the answer time, how often an "away"
// look read as no screen, median time to settle, and jitter of the smoothed
// reading at rest. Each session is replayed against its own calibration.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { replayFacing } from '../public/checkup.js';
import { median } from '../public/stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.GESTURE_EXPERIMENTS_DIR ?? path.join(ROOT, 'experiments');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(DIR, f))
    : [];

if (files.length === 0) {
  console.error(`no results yet — run the check-up first (looked in ${DIR})`);
  process.exit(1);
}

// Group by session: each brings its own calibration and tracker tuning.
const sessions = new Map();
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const s = sessions.get(record.session) ?? { facing: [], calibration: null, tuning: null, participant: record.participant };
    if (record.kind === 'session') {
      s.calibration = record.calibration;
      s.tuning = record.tuning?.screen ?? null;
    } else if (record.kind === 'facing' && Array.isArray(record.trace)) {
      s.facing.push(record);
    }
    sessions.set(record.session, s);
  }
}

const usable = [...sessions.values()].filter((s) => s.calibration?.length && s.facing.length);
if (usable.length === 0) {
  console.error('no session has both a calibration and facing trials to replay');
  process.exit(1);
}

const settings = [
  { label: 'raw (no smoothing)', options: { filter: 'none' } },
  ...[0.35, 0.5, 0.7].map((a) => ({ label: `EMA ${a}`, options: { filter: 'ema', smoothing: a } })),
  ...[0.5, 1, 2].flatMap((minCutoff) =>
    [0, 0.05, 0.1, 0.2, 0.4].map((beta) => ({
      label: `1€ min ${minCutoff} Hz, beta ${beta}`,
      options: { filter: 'oneEuro', minCutoff, beta },
    })),
  ),
];

const pct = (v) => (v === null ? '   —' : `${String(Math.round(v * 100)).padStart(3)}%`);
const num = (v, unit) => (v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}${unit}`);

const people = new Set(usable.map((s) => s.participant ?? 'me'));
const trials = usable.reduce((n, s) => n + s.facing.length, 0);
console.log(`\n${usable.length} session(s), ${people.size} participant(s), ${trials} facing trials\n`);
console.log(`${'setting'.padEnd(28)} ${'right'.padStart(5)} ${'away'.padStart(5)} ${'settle'.padStart(8)} ${'jitter'.padStart(7)}`);

for (const { label, options } of settings) {
  // Per session (its own calibration and margins), then the median across sessions.
  const results = usable.map((s) =>
    replayFacing(s.facing, s.calibration, { ...(s.tuning ?? {}), ...options }),
  );
  const pick = (key) => median(results.map((r) => r[key]));
  console.log(
    `${label.padEnd(28)} ${pct(pick('accuracy'))}  ${pct(pick('awayNullRate'))} ${num(pick('settleMedian'), ' ms').padStart(8)} ${num(pick('smoothJitter'), '°').padStart(7)}`,
  );
}
console.log('');

#!/usr/bin/env node
// Replay recorded snap-practice traces through other detector settings.
//
// Every practice trial keeps the hand landmarks it saw, so thresholds can be
// tried on the same snaps after the fact. This is how the snap detector's
// settings get chosen: the most snaps caught for the fewest misfires, on real
// hands, not by feel.
//
//   node scripts/replay-snaps.mjs                      every file in experiments/
//   node scripts/replay-snaps.mjs experiments/2026-10-24.jsonl
//
// Prints one row per setting: snaps caught out of the snap trials, median time
// from the chime, and misfires per minute of moving without snapping.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SNAP_DEFAULTS, replaySnaps } from '../public/snap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.GESTURE_EXPERIMENTS_DIR ?? path.join(ROOT, 'experiments');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(DIR, f))
    : [];

const records = [];
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.kind === 'snap' && Array.isArray(record.frames)) records.push(record);
    } catch {
      // A torn last line from an interrupted write is skipped, not fatal.
    }
  }
}

if (records.length === 0) {
  console.error(`no snap practice yet — run it from the Lab first (looked in ${DIR})`);
  process.exit(1);
}

const settings = [{ label: 'current defaults', options: {} }];
for (const setMaxGap of [0.3, 0.35, 0.45]) {
  for (const setMinReach of [1.1, 1.3]) {
    for (const minDrop of [0.25, 0.4, 0.55]) {
      settings.push({ label: `gap ${setMaxGap}, reach ${setMinReach}, drop ${minDrop}`, options: { setMaxGap, setMinReach, minDrop } });
    }
  }
}

const sessions = new Set(records.map((r) => r.session));
console.log(`\n${sessions.size} session(s), ${records.length} records. Defaults: ${JSON.stringify(SNAP_DEFAULTS)}\n`);
console.log(`${'setting'.padEnd(32)} ${'caught'.padStart(8)} ${'median'.padStart(8)} ${'misfires/min'.padStart(13)}`);

for (const { label, options } of settings) {
  const s = replaySnaps(records, options);
  const caught = `${s.hits}/${s.trials}`;
  const med = s.detectedMedian === null ? '—' : `${Math.round(s.detectedMedian)} ms`;
  const mis = s.misfiresPerMin === null ? '—' : String(s.misfiresPerMin);
  console.log(`${label.padEnd(32)} ${caught.padStart(8)} ${med.padStart(8)} ${mis.padStart(13)}`);
}
console.log('');

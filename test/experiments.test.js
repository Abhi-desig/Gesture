import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RECORD_BYTES,
  appendRecord,
  experimentsDir,
  validateRecord,
} from '../server/experiments.js';

const ok = { kind: 'facing', session: 'ck-20261023-142501-x7k2', participant: 'p1', target: 2 };

test('validateRecord accepts a record and names what is wrong with the rest', () => {
  assert.deepEqual(validateRecord(ok), { record: ok });
  assert.match(validateRecord([ok]).error, /JSON object/);
  assert.match(validateRecord(null).error, /JSON object/);
  assert.match(validateRecord({ ...ok, kind: 'anything' }).error, /"kind"/);
  assert.match(validateRecord({ ...ok, session: '../../etc' }).error, /"session"/);
  assert.match(validateRecord({ ...ok, participant: 'Has Spaces' }).error, /"participant"/);
  assert.match(validateRecord({ ...ok, trace: 'x'.repeat(MAX_RECORD_BYTES) }).error, /under/);
});

test('a snap-practice trace is a record the server keeps', async () => {
  const { SnapPractice, snapPracticePlan } = await import('../public/snap.js');
  const { seededRandom } = await import('../public/stats.js');
  // The biggest one practice can send: a full window of frames with a hand in each.
  const runner = new SnapPractice(snapPracticePlan({ rng: seededRandom(1), snaps: 1 }));
  const hand = Array.from({ length: 21 }, (_, k) => ({ x: 1.777 - k / 100, y: 0.999 - k / 100 }));
  let saved = null;
  for (let now = 0; now < 20000 && !saved; now += 1000 / 60) {
    for (const c of runner.tick(now, { pts: hand, snap: false })) {
      if (c.type === 'say') runner.speechEnded(now);
      if (c.type === 'save') saved = c.record;
    }
  }
  assert.ok(saved, 'practice saved a trial');
  assert.ok(validateRecord({ ...saved, session: 'sn-20261024-101500-ab12' }).record, 'under the size cap at 60 fps');
});

test('records are appended one per line, stamped by the server, not the page', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gesture-exp-'));
  const now = new Date(2026, 9, 23, 14, 25, 1);
  const { file } = await appendRecord(dir, { ...ok, t: '1999-01-01T00:00:00Z', v: 99 }, now);
  await appendRecord(dir, { ...ok, kind: 'pose' }, now);

  assert.equal(path.basename(file), '2026-10-23.jsonl');
  const lines = (await fs.promises.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].v, 1);
  assert.equal(lines[0].t, now.toISOString(), 'a page cannot backdate a result');
  assert.equal(lines[1].kind, 'pose');
});

test('results never go inside an app bundle, and the env var wins', () => {
  assert.equal(
    experimentsDir({ root: '/Users/a/code/gesture', env: {} }),
    path.join('/Users/a/code/gesture', 'experiments'),
  );
  assert.equal(
    experimentsDir({ root: '/Applications/Gesture.app/Contents/Resources/app', env: {}, home: '/Users/a' }),
    path.join('/Users/a', 'Library', 'Application Support', 'gesture', 'experiments'),
  );
  assert.equal(experimentsDir({ root: '/x', env: { GESTURE_EXPERIMENTS_DIR: '/tmp/results' } }), '/tmp/results');
});

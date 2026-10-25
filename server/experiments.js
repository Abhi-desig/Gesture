// Where check-up and experiment results are written, and what is accepted.
//
// One JSON object per line, one file per day: append-only, readable with any
// tool, and safe to concatenate across sessions and people. These are
// measurements of people's heads and hands at a desk, so they live in
// experiments/ (gitignored) on this machine and go nowhere else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RECORD_KINDS = [
  'session',
  'facing',
  'pose',
  'checkup_summary',
  'aborted',
  // Snap practice in the Lab: one trial's hand trace.
  'snap',
  'snap_summary',
];

const SESSION = /^[\w.:-]{1,64}$/;
const PARTICIPANT = /^[a-z0-9_-]{1,16}$/;

// Generous for one record — a facing trial's head trace is a couple of kB —
// and a hard stop for anything that is not one.
export const MAX_RECORD_BYTES = 32 * 1024;

// A runaway page appending forever should fill a log, not a disk.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * @returns {{record: object}|{error: string}}
 */
export function validateRecord(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'a record must be a JSON object' };
  }
  if (!RECORD_KINDS.includes(body.kind)) {
    return { error: `"kind" must be one of ${RECORD_KINDS.join(', ')}` };
  }
  if (typeof body.session !== 'string' || !SESSION.test(body.session)) {
    return { error: '"session" must be 1–64 letters, digits, or . : _ -' };
  }
  if (body.participant !== undefined && !(typeof body.participant === 'string' && PARTICIPANT.test(body.participant))) {
    return { error: '"participant" must be 1–16 lowercase letters, digits, _ or -' };
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_RECORD_BYTES) {
    return { error: `a record must be under ${MAX_RECORD_BYTES} bytes` };
  }
  return { record: body };
}

/**
 * The results folder: GESTURE_EXPERIMENTS_DIR if set, otherwise experiments/
 * beside the project — except when running from inside an app bundle, which
 * must never be written to (it would break the code signature), where it is
 * Application Support instead.
 */
export function experimentsDir({ root, env = process.env, home = os.homedir() }) {
  if (env.GESTURE_EXPERIMENTS_DIR) return path.resolve(env.GESTURE_EXPERIMENTS_DIR);
  if (/\.app\/Contents\//.test(root + path.sep)) {
    return path.join(home, 'Library', 'Application Support', 'gesture', 'experiments');
  }
  return path.join(root, 'experiments');
}

/** Local calendar date, so a late-night session lands in the day it was run. */
function day(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Append one record. The server stamps the format version and the time, so a
 * page cannot backdate a result.
 *
 * @returns {Promise<{file: string}>}
 */
export async function appendRecord(dir, record, now = new Date()) {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${day(now)}.jsonl`);
  const size = await fs.promises.stat(file).then((s) => s.size, () => 0);
  if (size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} is over ${MAX_FILE_BYTES} bytes`);
  // The page's own `v` and `t`, if it sent any, are dropped rather than trusted.
  const { v: _v, t: _t, ...rest } = record;
  await fs.promises.appendFile(file, `${JSON.stringify({ v: 1, t: now.toISOString(), ...rest })}\n`);
  return { file };
}

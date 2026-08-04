#!/usr/bin/env node
// Vendor the MediaPipe hand landmarker model into public/models/.
//
// Optional. The page falls back to fetching it from Google's CDN at runtime, so
// this is only needed to work offline or to avoid a ~7.8 MB download on each
// cold page load. The file is gitignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST_DIR = path.join(ROOT, 'public', 'models');
const DEST = path.join(DEST_DIR, 'hand_landmarker.task');

const res = await fetch(MODEL_URL);
if (!res.ok) {
  console.error(`download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

fs.mkdirSync(DEST_DIR, { recursive: true });

// Write to a temp file and rename, so an interrupted download can't leave a
// truncated model in place that the page would then try to load.
const tmp = `${DEST}.partial`;
await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
await fs.promises.rename(tmp, DEST);

const mb = (fs.statSync(DEST).size / 1024 / 1024).toFixed(1);
console.log(`saved public/models/hand_landmarker.task (${mb} MB)`);
console.log('the page will now prefer this local copy over the CDN');

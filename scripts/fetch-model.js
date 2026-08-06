#!/usr/bin/env node
// Vendor MediaPipe locally: the hand landmarker model, the tasks-vision bundles
// and the WASM runtime.
//
// Not just a download convenience. detector-worker.js runs `importScripts()` on
// the tasks-vision bundle *inside the worker that holds raw camera VideoFrames*,
// and importScripts cannot carry a Subresource Integrity hash. Loading that
// bundle from a CDN means a third party can execute code in the one context with
// direct access to the camera. Vendoring is what closes that.
//
// Everything written here is gitignored. Re-run it to update.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned, and it must match the version app.js falls back to — a vendored bundle
// paired with a different CDN wasm build fails in ways that look like a broken
// camera rather than a version skew.
const TASKS_VISION_VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/** @type {{url: string, dest: string, note?: string}[]} */
const ASSETS = [
  { url: MODEL_URL, dest: 'models/hand_landmarker.task' },

  // Two builds of the same library, and both are needed: the page imports the
  // ESM one, while the worker has to importScripts the UMD one — the ESM build
  // fails inside a worker with "ModuleFactory not set."
  { url: `${CDN}/vision_bundle.mjs`, dest: 'vendor/vision_bundle.mjs' },
  { url: `${CDN}/vision_bundle.js`, dest: 'vendor/vision_bundle.js' },

  // FilesetResolver picks between these at runtime based on whether the browser
  // has WASM SIMD, so both pairs have to be present or a non-SIMD browser breaks.
  { url: `${CDN}/wasm/vision_wasm_internal.js`, dest: 'vendor/wasm/vision_wasm_internal.js' },
  { url: `${CDN}/wasm/vision_wasm_internal.wasm`, dest: 'vendor/wasm/vision_wasm_internal.wasm' },
  {
    url: `${CDN}/wasm/vision_wasm_nosimd_internal.js`,
    dest: 'vendor/wasm/vision_wasm_nosimd_internal.js',
  },
  {
    url: `${CDN}/wasm/vision_wasm_nosimd_internal.wasm`,
    dest: 'vendor/wasm/vision_wasm_nosimd_internal.wasm',
  },
];

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function download({ url, dest }) {
  const target = path.join(PUBLIC, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }

  // Write to a temp file and rename, so an interrupted download can't leave a
  // truncated file in place that the page would then try to load — a truncated
  // wasm blob fails with an error that says nothing about a bad download.
  const tmp = `${target}.partial`;
  await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fs.promises.rename(tmp, target);

  return fs.statSync(target).size;
}

let total = 0;
for (const asset of ASSETS) {
  process.stdout.write(`  ${asset.dest} … `);
  try {
    const size = await download(asset);
    total += size;
    console.log(mb(size));
  } catch (err) {
    console.log('FAILED');
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
}

console.log('');
console.log(`vendored ${ASSETS.length} files (${mb(total)}) into public/`);
console.log('the page will now load MediaPipe locally — nothing goes to a CDN');

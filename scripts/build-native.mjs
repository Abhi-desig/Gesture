// Build the Swift key-sending helper.
//
// Opt-in (`npm run build:native`), never a postinstall: this needs an Xcode
// toolchain, and a missing compiler must not turn `npm install` into a failure
// for anyone who is happy with the nut.js backend.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'native', 'keysend.swift');
export const BINARY = path.join(ROOT, 'native', 'build', 'keysend');

const SWIFTC = '/usr/bin/swiftc';

export function build({ log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('the native key-sending helper is macOS-only');
  }
  if (!fs.existsSync(SWIFTC)) {
    throw new Error(`${SWIFTC} not found — install the Xcode command line tools`);
  }

  fs.mkdirSync(path.dirname(BINARY), { recursive: true });

  const result = spawnSync(SWIFTC, ['-O', '-o', BINARY, SOURCE], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`swiftc exited ${result.status}:\n${result.stderr || result.stdout}`);
  }

  log(`built ${path.relative(ROOT, BINARY)}`);
  return BINARY;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    build();
  } catch (err) {
    console.error(`\nbuild:native failed: ${err.message}\n`);
    process.exit(1);
  }
}

// Screen actions: list the displays, focus one, move a window onto one.
//
// All three go through the native helper (native/keysend.swift), for the same
// reason key presses do — nothing in npm reaches the Accessibility API — and,
// like key presses, they shell out per call: ~10ms against a gesture held for a
// third of a second.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import { BINARY } from '../scripts/build-native.mjs';

const execFileAsync = promisify(execFile);

// The helper's exit code when Accessibility is not granted. Kept distinct so
// it can become the same 503 a refused key press does, with the same advice.
const EXIT_NOT_TRUSTED = 4;

export class ScreenError extends Error {
  constructor(message, { notTrusted = false } = {}) {
    super(message);
    this.notTrusted = notTrusted;
  }
}

async function helper(args) {
  if (!fs.existsSync(BINARY)) {
    throw new ScreenError('native/build/keysend is not built — run "npm run build:native"');
  }
  try {
    const { stdout } = await execFileAsync(BINARY, args, { timeout: 3000 });
    return JSON.parse(stdout);
  } catch (err) {
    if (err.code === EXIT_NOT_TRUSTED) {
      throw new ScreenError('Accessibility access is not granted', { notTrusted: true });
    }
    throw new ScreenError((err.stderr || err.message).toString().replace(/^keysend: /, '').trim());
  }
}

/**
 * Every connected display, in CoreGraphics global points (origin at the top
 * left of the main display, y down), which is also how the page lays them out.
 *
 * @returns {Promise<{id:number,name:string,x:number,y:number,width:number,
 *   height:number,main:boolean,builtin:boolean}[]>}
 */
export async function listDisplays() {
  const displays = await helper(['displays']);
  // An empty list is not "no screens": every Mac has one. It means the helper
  // could not reach the WindowServer — run from a sandbox or an ssh session.
  if (!Array.isArray(displays) || displays.length === 0) {
    throw new ScreenError('no displays were reported — is this running inside a logged-in session?');
  }
  return displays;
}

const pointerArgs = (movePointer) => (movePointer ? [] : ['--no-pointer']);

/**
 * Bring forward the front window on a display.
 *
 * @returns {Promise<{display:number, focused:boolean, app?:string, window?:string,
 *   reason?:string}>}
 */
export function focusScreen(id, { movePointer = true } = {}) {
  return helper(['focus', String(id), ...pointerArgs(movePointer)]);
}

/**
 * Move the focused window onto a display, keeping its relative position.
 *
 * @returns {Promise<{moved:boolean, app:string, window:string, from:number,
 *   to:number, reason?:string}>}
 */
export function moveWindowTo(id, { movePointer = true } = {}) {
  return helper(['move', String(id), ...pointerArgs(movePointer)]);
}

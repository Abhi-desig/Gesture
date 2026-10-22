import test from 'node:test';
import assert from 'node:assert/strict';

import { cueFor } from '../public/feedback.js';

test('a pressed key sounds done', () => {
  assert.equal(cueFor(200, { ok: true, fired: true, shortcut: 'audio_play' }), 'done');
});

test('a desktop switch that moved sounds done; one that did not, or snapped back, sounds failed', () => {
  // The server verifies Space switches before it answers, so the sound can say
  // whether the desktop actually changed — not just whether a key went out.
  assert.equal(cueFor(200, { fired: true, spaceChanged: true }), 'done');
  assert.equal(cueFor(200, { fired: true, spaceChanged: false, spaceReverted: false }), 'failed');
  assert.equal(cueFor(200, { fired: true, spaceChanged: false, spaceReverted: true }), 'failed');
});

test('cooldown is silent, dry-run ticks, and every refusal sounds failed', () => {
  assert.equal(cueFor(429, { ok: true, fired: false, reason: 'cooldown' }), null);
  assert.equal(cueFor(200, { ok: true, fired: false, reason: 'dryRun' }), 'tick');
  assert.equal(cueFor(404, { ok: false, fired: false, error: 'not bound' }), 'failed');
  assert.equal(cueFor(503, { ok: false, fired: false }), 'failed');
  assert.equal(cueFor(500, {}), 'failed');
});

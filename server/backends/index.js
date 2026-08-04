// Backend resolution: pick something that can actually press keys.

import { create as createNutjs } from './nutjs.js';
import { create as createOsascript } from './osascript.js';

const CANDIDATES = {
  nutjs: createNutjs,
  osascript: createOsascript,
};

export const BACKEND_NAMES = ['auto', ...Object.keys(CANDIDATES), 'dryrun'];

function createDryRun(reason) {
  return {
    name: 'dryrun',
    reason,
    supports: () => true,
    async press() {
      // Intentionally does nothing.
    },
  };
}

/**
 * @param {'auto'|'nutjs'|'osascript'|'dryrun'} preference
 * @param {(msg: string) => void} log
 */
export async function resolveBackend(preference = 'auto', log = console.log) {
  if (preference === 'dryrun') {
    return createDryRun('selected in config');
  }

  const order = preference === 'auto' ? Object.keys(CANDIDATES) : [preference];
  const failures = [];

  for (const name of order) {
    const factory = CANDIDATES[name];
    if (!factory) {
      failures.push(`${name}: unknown backend`);
      continue;
    }
    try {
      const backend = await factory();
      log(`keyboard backend: ${backend.name}`);
      return backend;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }

  // Loud, because a silently key-pressing-nothing server looks identical to a
  // missing Accessibility permission and wastes a lot of debugging time.
  log('');
  log('!! No keyboard backend could be loaded. Running in dry-run mode:');
  log('!! gestures will be recognized and logged, but no keys will be pressed.');
  for (const f of failures) log(`!!   ${f}`);
  log('');

  return createDryRun(failures.join('; '));
}

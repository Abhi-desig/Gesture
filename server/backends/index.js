// Backend resolution: pick something that can actually press keys.

import { create as createCgevent } from './cgevent.js';
import { create as createNutjs } from './nutjs.js';
import { create as createOsascript } from './osascript.js';

// Order matters for `auto`. cgevent leads because it is the only one that emits
// a real kCGEventFlagsChanged, which is what macOS matches symbolic hotkeys
// against — without it ctrl+left/right navigates inside the focused app and
// never switches Spaces. It needs `npm run build:native`, so nut.js stays right
// behind it as the no-toolchain default.
const CANDIDATES = {
  cgevent: createCgevent,
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
 * Which of these bindings the backend cannot send.
 *
 * Checked at startup rather than at press time because the failure is otherwise
 * invisible until you happen to make that one gesture, and then it is a 500 per
 * press with no hint that the other four gestures are fine.
 *
 * @param {{supports?: (combo: object) => boolean}} backend
 * @param {Record<string, {combo: string, parsed: object}>} bindings
 */
function unsupportedBindings(backend, bindings) {
  if (typeof backend.supports !== 'function') return [];
  return Object.entries(bindings)
    // Client actions are performed by the page and never pressed, so a backend
    // that cannot express one is not thereby unsuitable. Without this skip they
    // have no `parsed` to test and every backend looks incapable, which drops
    // the whole app to dry-run.
    .filter(([, binding]) => !binding.client)
    .filter(([, binding]) => !backend.supports(binding.parsed))
    .map(([name, binding]) => `${name} -> ${binding.combo}`);
}

/**
 * @param {'auto'|'cgevent'|'nutjs'|'osascript'|'dryrun'} preference
 * @param {Record<string, {combo: string, parsed: object}>} bindings Configured
 *   gestures, so a backend that cannot express one of them can be passed over.
 * @param {{log?: (msg: string) => void, keysendSource?: string}} [options]
 *   `keysendSource` reaches the cgevent backend; every other backend ignores it.
 */
export async function resolveBackend(preference = 'auto', bindings = {}, options = {}) {
  const { log = console.log, ...backendOptions } = options;

  if (preference === 'dryrun') {
    return createDryRun('selected in config');
  }

  const order = preference === 'auto' ? Object.keys(CANDIDATES) : [preference];
  const failures = [];

  // A backend that loaded but can't send every binding. Kept as a last resort:
  // pressing four gestures out of five beats pressing none, which is what
  // dropping to dry-run would mean.
  let partial = null;

  for (const name of order) {
    const factory = CANDIDATES[name];
    if (!factory) {
      failures.push(`${name}: unknown backend`);
      continue;
    }

    let backend;
    try {
      backend = await factory(backendOptions);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      continue;
    }

    const missing = unsupportedBindings(backend, bindings);
    if (missing.length > 0) {
      failures.push(`${name}: cannot send ${missing.join(', ')}`);
      partial ??= { backend, missing };
      continue;
    }

    log(`keyboard backend: ${backend.name}`);
    return backend;
  }

  if (partial) {
    log('');
    log(`!! Using the ${partial.backend.name} backend, but it cannot send:`);
    for (const m of partial.missing) log(`!!   ${m}`);
    log('!! Those gestures will fail; everything else works.');
    for (const f of failures) log(`!!   (${f})`);
    log('');
    partial.backend.reason = `partial: cannot send ${partial.missing.join(', ')}`;
    return partial.backend;
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

// macOS Accessibility permission check.
//
// Synthetic key events are silently dropped when the host process lacks
// Accessibility access — no error, no exception, the press just does nothing.
// That failure is indistinguishable from a broken gesture detector, so it's worth
// detecting up front rather than leaving the user to debug it.
//
// This uses AXIsProcessTrusted via node-mac-permissions, which answers directly
// for the calling process. The obvious alternative — asking System Events over
// osascript — was tried first and rejected: it sits behind a *second* TCC gate
// (Automation), so it can't distinguish "Accessibility denied" from "not allowed
// to ask", and it pops a confusing "wants to control System Events" prompt at
// server startup. This API neither prompts nor requires any permission of its own.

import { createRequire } from 'node:module';

export const ACCESSIBILITY_HELP =
  'System Settings > Privacy & Security > Accessibility — enable the terminal app running this server.';

/**
 * The same instruction, naming the app that actually needs the checkbox.
 *
 * The generic wording says "the terminal app running this server", which is
 * wrong once the server is a child of the bundled desktop app — it sends people
 * to tick their editor while the grant is owed by Gesture. The caller knows the
 * responsible app; this just puts its name in the sentence.
 *
 * The rebuild note is not incidental. An ad-hoc signed build's designated
 * requirement is `cdhash H"…"` — the literal hash of that one binary — so every
 * rebuild is a different application as far as TCC is concerned and the grant
 * silently stops applying. Anyone who has just granted access and is still
 * seeing this needs to know that before they go looking for a bug.
 */
export function accessibilityHelpFor(owner) {
  if (!owner?.name) return ACCESSIBILITY_HELP;
  return (
    `System Settings > Privacy & Security > Accessibility — enable "${owner.name}". ` +
    'If it is already ticked, remove it with the − button and add it again: an ' +
    'unsigned build gets a new identity every time it is rebuilt, and macOS ties ' +
    'the permission to the exact binary it was granted to.'
  );
}

/**
 * @returns {Promise<{relevant: boolean, granted: boolean|null, status?: string, error?: string}>}
 *   `granted: null` means genuinely undetermined — never guessed.
 */
export async function checkAccessibility() {
  if (process.platform !== 'darwin') {
    return { relevant: false, granted: null };
  }

  try {
    // A CommonJS native addon, so require rather than import.
    const require = createRequire(import.meta.url);
    const permissions = require('@nut-tree-fork/node-mac-permissions');

    // One of: 'authorized' | 'denied' | 'restricted' | 'not determined'
    const status = permissions.getAuthStatus('accessibility');
    return { relevant: true, granted: status === 'authorized', status };
  } catch (err) {
    return { relevant: true, granted: null, error: err.message };
  }
}

// The setup checklist on Home: every step ticks itself off when the thing it
// asks for becomes true, so it can't fall out of date with what you actually
// did — permissions, camera, head tracking, calibration, arming.
//
// It replaces "read the README first". Each step that the page can do for you
// carries an action; the ones it can't (an Accessibility grant lives in System
// Settings) carry a hint instead.

import { howToMake } from './words.js';

/**
 * @param {object} s
 * @param {object|null} s.health GET /health.
 * @param {boolean} s.cameraOn
 * @param {boolean} s.headWanted Something is bound to a screen action.
 * @param {boolean} s.headAvailable
 * @param {number} s.displays Connected displays.
 * @param {number} s.calibrated Connected displays that are calibrated.
 * @param {boolean} s.armedOnce Armed at least once in this browser.
 * @param {string|null} s.armGesture The gesture bound to toggle_armed.
 * @returns {{steps: {id: string, label: string, done: boolean, action: string|null,
 *   actionLabel?: string, hint: string}[], done: number, total: number}}
 */
export function setupSteps(s) {
  const steps = [
    {
      id: 'keys',
      label: 'Allow Gesture to press keys',
      // Not done until the server has answered: unknown is not "allowed".
      done: Boolean(s.health) && s.health.accessibility?.granted !== false && s.health.backend !== 'dryrun',
      action: null,
      hint: s.health?.accessibilityHelp ?? 'System Settings → Privacy & Security → Accessibility',
    },
    {
      id: 'camera',
      label: 'Start the camera',
      done: s.cameraOn,
      action: s.cameraOn ? null : 'start-camera',
      actionLabel: 'Start camera',
      hint: 'Chrome asks once; after that it remembers.',
    },
  ];

  if (s.headWanted) {
    steps.push(
      {
        id: 'head',
        label: 'Head tracking on',
        done: s.headAvailable,
        action: null,
        hint: s.cameraOn ? 'Starting with the camera…' : 'Starts with the camera.',
      },
      {
        id: 'screens',
        label: 'Calibrate your screens',
        done: s.displays > 0 && s.calibrated >= s.displays,
        action: 'calibrate',
        actionLabel: 'Calibrate',
        hint: 'Look at each screen when you hear its name — about two seconds each.',
      },
    );
  }

  steps.push({
    id: 'arm',
    label: 'Arm it',
    done: s.armedOnce,
    action: 'arm',
    actionLabel: 'Arm',
    hint: s.armGesture
      ? `${howToMake(s.armGesture)}, or press Arm. Esc disarms.`
      : 'Press Arm. Esc disarms.',
  });

  return { steps, done: steps.filter((x) => x.done).length, total: steps.length };
}

// Puts a mood from mascot.js onto a face: the page header's or the orb's.
//
// All the motion lives in CSS, keyed off `data-mood` and three custom
// properties, so the artwork can be redrawn without touching this file: keep
// the part ids listed in docs/MASCOT.md and the animations still land.

// Blinks come from a timer here rather than a looping CSS animation: a loop
// inside the SVG would redraw it on every frame between blinks, for good.
const BLINK_MS = 140;
const blinking = new WeakSet();

function blinkNow(root) {
  if (document.hidden || root.dataset.mood === 'still') return;
  root.dataset.blink = '';
  setTimeout(() => delete root.dataset.blink, BLINK_MS);
}

function keepBlinking(root) {
  if (blinking.has(root)) return;
  blinking.add(root);
  const next = () => {
    // Every 3.5 to 6.5 s, and now and then twice in a row, as people do.
    setTimeout(() => {
      blinkNow(root);
      if (Math.random() < 0.2) setTimeout(() => blinkNow(root), BLINK_MS * 2.5);
      next();
    }, 3500 + Math.random() * 3000);
  };
  next();
}

/**
 * @param {HTMLElement} root The `.mascot` element.
 * @param {{mood: string, gaze: {x: number, y: number}, ring: number, label: string}} m
 */
export function renderMascot(root, m) {
  keepBlinking(root);
  // Changing the attribute is what restarts a reaction's animation, so two
  // gestures in a row each get their own nod.
  if (root.dataset.mood !== m.mood) root.dataset.mood = m.mood;
  root.style.setProperty('--gaze-x', m.gaze.x.toFixed(2));
  root.style.setProperty('--gaze-y', m.gaze.y.toFixed(2));
  root.style.setProperty('--ring', m.ring.toFixed(3));
  if (root.getAttribute('aria-label') !== m.label) {
    root.setAttribute('aria-label', m.label);
    root.title = m.label;
  }
}

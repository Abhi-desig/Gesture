// The orb's live feed: what the page knows, pushed the moment it changes.
//
// Three parties meet here, and none can reach another directly:
//   - the page, in a hidden Chrome window (the "engine"), runs the camera and
//     works out the mascot's mood;
//   - the orb, a small panel under the camera drawn by the Tauri host, shows
//     that mood and turns the camera on and off when clicked;
//   - this server, which both already talk to.
// So the server keeps the current state and streams every change to both over
// Server-Sent Events: one GET that stays open, with no polling and nothing to
// install.
//
// Kept apart from server/index.js so it can be tested without a socket: a
// client is anything with write() and end().

import { MOODS } from '../public/ui/mascot.js';

/** A mood older than this means the page is closed or frozen. */
export const MASCOT_STALE_MS = 5000;
/** Comment lines that keep an idle stream from being cut by anything in between. */
export const PING_MS = 15000;

/**
 * What the engine page reports about its camera.
 * `needs-permission`: Chrome is about to ask, in a window that is hidden, so
 * the orb has to bring it forward.
 */
export const CAMERA_STATES = ['off', 'starting', 'needs-permission', 'on', 'blocked', 'failed'];

const OFFLINE = Object.freeze({ mood: 'offline', gaze: { x: 0, y: 0 }, label: 'Gesture page is not open' });
const LABEL_MAX = 80;
const EVENT_TEXT_MAX = 120;
const ERROR_MAX = 160;

const inRange = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1;

/**
 * Check a POST /mascot body.
 *
 * `event` is the last thing the face reacted to, numbered by the page. The orb
 * shows it as text for longer than the face's half-second nod, and the number
 * is what tells a new reaction from the same one sent again.
 *
 * @returns {{mascot: object} | {error: string}}
 */
export function readMascot(b) {
  if (!MOODS.includes(b?.mood) || !inRange(b.gaze?.x) || !inRange(b.gaze?.y) || typeof b.label !== 'string') {
    return { error: 'expected {mood, gaze: {x, y} in -1..1, label}' };
  }
  let event = null;
  if (b.event != null) {
    const e = b.event;
    if (
      !Number.isInteger(e.seq) ||
      e.seq < 0 ||
      (e.type !== 'fired' && e.type !== 'refused') ||
      typeof e.text !== 'string'
    ) {
      return { error: 'event must be {seq, type: "fired" | "refused", text}' };
    }
    event = { seq: e.seq, type: e.type, text: e.text.slice(0, EVENT_TEXT_MAX) };
  }
  return {
    mascot: { mood: b.mood, gaze: { x: b.gaze.x, y: b.gaze.y }, label: b.label.slice(0, LABEL_MAX), event },
  };
}

/** Check a POST /camera/state body. */
export function readCameraState(b) {
  if (!CAMERA_STATES.includes(b?.state)) return { error: `state must be one of ${CAMERA_STATES.join(', ')}` };
  const error = b.error == null ? null : String(b.error).slice(0, ERROR_MAX);
  return { camera: { state: b.state, error } };
}

/** Only what the orb can see change: gaze is rounded, as the eyes only move that far. */
function mascotKey(m) {
  return `${m.mood}|${m.gaze.x.toFixed(1)}|${m.gaze.y.toFixed(1)}|${m.label}|${m.event?.seq ?? ''}`;
}

export class OrbHub {
  #clients = new Set();
  #mascot = { ...OFFLINE, event: null };
  #mascotAt = -Infinity;
  #stale = true;
  #camera = { want: false, state: 'off', error: null };
  #lastPing;
  #now;

  /** @param {{now?: () => number}} [options] */
  constructor({ now = () => performance.now() } = {}) {
    this.#now = now;
    this.#lastPing = now();
  }

  /** Engine pages listening. 0 means nothing can turn the camera on. */
  get engines() {
    let n = 0;
    for (const c of this.#clients) if (c.role === 'engine') n += 1;
    return n;
  }

  snapshot() {
    return { engines: this.engines, camera: { ...this.#camera }, mascot: this.#currentMascot() };
  }

  /**
   * Start streaming to a client. It gets the whole state first, so a page that
   * loads or reconnects never waits for the next change to know where it is.
   *
   * @param {{write: (s: string) => unknown, end: () => unknown}} client
   * @param {string} role 'engine' for the page that runs the camera, anything else is a viewer.
   * @returns {() => void} Call when the connection closes.
   */
  attach(client, role) {
    const c = { client, role: role === 'engine' ? 'engine' : 'orb' };
    this.#clients.add(c);
    this.#send(c, 'hello', this.snapshot());
    if (c.role === 'engine') this.#broadcast('engines', { engines: this.engines });

    return () => {
      if (!this.#clients.delete(c) || c.role !== 'engine') return;
      this.#broadcast('engines', { engines: this.engines });
      // The page that ran the camera is gone, and its camera with it. "want"
      // is kept: a relaunched engine picks it up and starts again.
      if (this.engines === 0 && this.#camera.state !== 'off') {
        this.#camera = { ...this.#camera, state: 'off', error: null };
        this.#broadcast('camera', this.#camera);
      }
    };
  }

  /** A mood from the page. Sent on to listeners only when it looks different. */
  setMascot(mascot) {
    const before = mascotKey(this.#currentMascot());
    this.#mascot = mascot;
    this.#mascotAt = this.#now();
    this.#stale = false;
    if (mascotKey(mascot) !== before) this.#broadcast('mascot', this.#currentMascot());
  }

  /** config.json changed: pages read it again, instead of polling for it. */
  configChanged() {
    this.#broadcast('config', {});
  }

  #problems = 0;

  /**
   * Something the server found wrong after it had already answered, such as a
   * desktop switch macOS undid. Pages play the fail cue and shrug, which the
   * orb then shows like any refusal.
   */
  problem(text) {
    this.#problems += 1;
    this.#broadcast('problem', { seq: this.#problems, text: String(text).slice(0, 120) });
  }

  /** The orb was clicked. The engine does the work and reports back. */
  wantCamera(on) {
    this.#camera = { ...this.#camera, want: on, error: on ? null : this.#camera.error };
    this.#broadcast('camera', this.#camera);
  }

  /**
   * What the engine's camera is actually doing.
   *
   * The page is the authority, including when its own Start / Stop button was
   * used in Settings, so "want" follows what it reports. A camera that was
   * refused or failed is not retried until the orb is clicked again.
   */
  reportCamera({ state, error }) {
    const want = state === 'on' || state === 'starting' || state === 'needs-permission';
    this.#camera = { want, state, error };
    this.#broadcast('camera', this.#camera);
  }

  /** Run every second or so: notices a page gone quiet, and keeps idle streams open. */
  tick() {
    const now = this.#now();
    if (!this.#stale && now - this.#mascotAt > MASCOT_STALE_MS) {
      this.#stale = true;
      this.#broadcast('mascot', this.#currentMascot());
    }
    if (now - this.#lastPing >= PING_MS) {
      this.#lastPing = now;
      for (const c of this.#clients) this.#write(c, ': ping\n\n');
    }
  }

  /** End every stream, so the server can close without waiting on them. */
  close() {
    for (const c of this.#clients) {
      try {
        c.client.end();
      } catch {
        // Already gone.
      }
    }
    this.#clients.clear();
  }

  // The last reaction is kept while offline, so its number still rules out
  // showing it twice when the page comes back.
  #currentMascot() {
    return this.#stale ? { ...OFFLINE, event: this.#mascot.event } : { ...this.#mascot };
  }

  #broadcast(type, data) {
    for (const c of this.#clients) this.#send(c, type, data);
  }

  #send(c, type, data) {
    this.#write(c, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #write(c, text) {
    try {
      c.client.write(text);
    } catch {
      // A socket that died mid-write is removed when its close event arrives.
    }
  }
}

// The Lab page: snap your fingers and turn to dust.
//
// I/O only, like app.js: it wires the camera, the person cutout, the renderer,
// the timeline, the recorder and the controls. The decisions live in pure,
// tested modules: snap.js (is that a snap?), vanish.js (what happens when),
// plate.js (how much of the room is known).
//
// Nothing here presses keys or leaves the page, apart from snap practice's
// results, which go to experiments/ on this Mac like the check-up's. app.js
// stops every gesture from firing while the Lab is open.

import { SnapDetector, SnapPractice, snapPracticePlan, summarizeSnapPractice } from '../snap.js';
import { seededRandom } from '../stats.js';
import { RoomCoverage, handBox } from './plate.js';
import { VanishRenderer } from './renderer.js';
import { CDN_SEGMENT_MODEL_URL, LOCAL_SEGMENT_MODEL_URL, Segmenter } from './segmenter.js';
import { DUST_SETTINGS, VanishTimeline, dustSettings, windInTexture } from './vanish.js';

const SETTINGS_KEY = 'gesture.lab.v1';
// The cutout runs at most this often; the picture redraws every display frame.
const SEGMENT_EVERY_MS = 30;
// Hand landmarks older than this are not drawn into the person mask.
const HAND_FRESH_MS = 150;
// "Capture the room", for someone who can't step out of view, like on a sofa:
// lean one way, then the other, so the camera sees what you were covering. In
// a drawn test room, leaning cut the error where you were from 14.5 out of 255
// to 0.2. Stepping out of view works just as well.
const CAPTURE_STEPS = [
  { say: 'Lean far to your left', status: 'Lean far to your left…', ms: 3000 },
  { say: 'Now lean far to your right', status: 'Now lean far to your right…', ms: 3000 },
];
// Below this much of the room seen, vanishing leaves a smudge: say so.
const ROOM_ENOUGH = 0.85;
// High enough that a cloud of 2-pixel specks survives the encoder.
const RECORD_BITS_PER_SECOND = 16_000_000;
// Development only: ?labclip=name.mp4 plays public/lab-clips/name.mp4 instead
// of the camera, so everything but the snap can be checked without one.
const CLIP_NAME = /^[\w.-]{1,64}\.(mp4|webm|mov)$/;

const $ = (id) => document.getElementById(id);

/** Share of the mask that is confidently a person. */
function personShare(data) {
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] > 0.5) n += 1;
  return data.length ? n / data.length : 0;
}

/**
 * @param {object} deps What the Lab borrows from app.js.
 * @param {() => Promise<object>} deps.resolveAssets
 * @param {(url: string) => Promise<boolean>} deps.exists
 * @param {(create: () => Promise<any>) => Promise<any>} deps.oneAtATime
 * @param {() => MediaStream|null} deps.stream
 * @param {() => void} deps.startCamera
 * @param {object} deps.voice
 * @param {object} deps.chime
 * @param {(session: string, record: object) => Promise<string|null>} deps.postRecord
 * @param {(prefix: string) => string} deps.sessionId
 * @param {(what: string, kind?: string) => void} deps.log
 * @param {(type: string, text: string) => void} deps.react
 */
export function createLab(deps) {
  const el = {
    stage: $('lab-stage'),
    video: $('lab-video'),
    canvas: $('lab-canvas'),
    msg: $('lab-msg'),
    msgText: $('lab-msg-text'),
    cameraBtn: $('lab-camera'),
    vanishBtn: $('lab-vanish'),
    roomBtn: $('lab-room-btn'),
    recordBtn: $('lab-record'),
    save: $('lab-save'),
    snapState: $('lab-snap-state'),
    counts: $('lab-counts'),
    roomBar: $('lab-room-bar'),
    roomPct: $('lab-room-pct'),
    cutout: $('lab-cutout'),
    status: $('lab-status'),
    dust: $('lab-dust'),
    dustReset: $('lab-dust-reset'),
    practiceBtn: $('lab-practice'),
    practiceStatus: $('lab-practice-status'),
  };

  const clipParam = new URLSearchParams(location.search).get('labclip');
  const clip = clipParam && CLIP_NAME.test(clipParam) ? clipParam : null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const lab = {
    open: false,
    renderer: null,
    rendererError: null,
    segmenter: null,
    segmenterState: 'idle', // 'idle' | 'loading' | 'ready' | 'failed'
    hasMask: false,
    // Someone is in the latest mask: with nobody there, Vanish does nothing.
    personInView: false,
    lastSegAt: -Infinity,
    segMs: null,
    hand: null,
    handAt: -Infinity,
    detector: new SnapDetector(),
    snapState: 'none',
    snapFlashUntil: 0,
    snaps: 0,
    vanishes: 0,
    timeline: new VanishTimeline(),
    pendingFreeze: false,
    coverage: new RoomCoverage(),
    capture: null, // { phase: 'countdown'|'capturing', since, lastCount }
    recorder: null,
    clipUrl: null,
    practice: null,
    settings: dustSettings(readSettings()),
    raf: 0,
    shownKey: '',
  };

  // ---------------------------------------------------------------- settings

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(lab.settings));
    } catch {
      // Private window or blocked storage: the sliders still work for this visit.
    }
  }

  function formatSetting(key, v) {
    if (key === 'seconds') return `${v.toFixed(1)} s`;
    if (key === 'direction') return `${Math.round(v)}°`;
    if (key === 'ash') return `${Math.round(v * 100)}%`;
    return `${v.toFixed(2)}×`;
  }

  function renderSliders() {
    el.dust.replaceChildren(
      ...Object.entries(DUST_SETTINGS).map(([key, spec]) => {
        const row = document.createElement('label');
        row.className = 'slider';
        const name = document.createElement('span');
        name.textContent = spec.label;
        const input = document.createElement('input');
        Object.assign(input, { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: lab.settings[key] });
        const out = document.createElement('output');
        out.textContent = formatSetting(key, lab.settings[key]);
        input.addEventListener('input', () => {
          lab.settings = dustSettings({ ...lab.settings, [key]: input.value });
          out.textContent = formatSetting(key, lab.settings[key]);
          saveSettings();
        });
        row.append(name, input, out);
        return row;
      }),
    );
  }

  // ------------------------------------------------------------------ source

  /** The camera, or the development clip; the stage says which is missing. */
  function attachSource() {
    if (clip) {
      if (!el.video.src.endsWith(`/lab-clips/${clip}`)) {
        el.video.srcObject = null;
        el.video.src = `./lab-clips/${clip}`;
        el.video.loop = true;
      }
    } else {
      const stream = deps.stream();
      if (el.video.srcObject !== stream) el.video.srcObject = stream;
    }
    const live = clip || el.video.srcObject;
    if (live) el.video.play().catch(() => {});
    showStageMessage(live ? null : 'Start the camera to use the Lab.', !live);
  }

  function showStageMessage(text, withCamera = false) {
    el.msg.hidden = !text;
    el.msgText.textContent = text ?? '';
    el.cameraBtn.hidden = !withCamera;
  }

  el.video.addEventListener('loadedmetadata', () => {
    if (el.video.videoWidth) el.stage.style.aspectRatio = `${el.video.videoWidth} / ${el.video.videoHeight}`;
  });

  // ---------------------------------------------------------------- set-up

  function ensureRenderer() {
    if (lab.renderer || lab.rendererError) return;
    try {
      lab.renderer = new VanishRenderer(el.canvas);
      if (!lab.renderer.floatTargets) deps.log('Lab: no half-float render targets, the room is learned in 8 bits', 'note');
    } catch (err) {
      lab.rendererError = err.message;
      el.canvas.hidden = true;
      setStatus(`The effect can't run here: ${err.message}.`, 'failed');
    }
  }

  async function ensureSegmenter() {
    if (lab.segmenterState !== 'idle') return;
    lab.segmenterState = 'loading';
    renderReadout(true);
    try {
      const assets = await deps.resolveAssets();
      const model = (await deps.exists(LOCAL_SEGMENT_MODEL_URL)) ? LOCAL_SEGMENT_MODEL_URL : CDN_SEGMENT_MODEL_URL;
      lab.segmenter = await deps.oneAtATime(() => Segmenter.create({ esm: assets.esm, wasm: assets.wasm, model }));
      lab.segmenterState = 'ready';
      deps.log(`Lab: person cutout ready (${lab.segmenter.delegate})`, 'note');
    } catch (err) {
      lab.segmenterState = 'failed';
      setStatus(`The person cutout didn't load: ${err.message}`, 'failed');
    }
    renderReadout(true);
  }

  // ------------------------------------------------------------------ status

  function setStatus(text, kind = '') {
    el.status.textContent = text;
    el.status.className = `hint ${kind}`.trim();
  }

  function setPracticeStatus(text, kind = '') {
    el.practiceStatus.textContent = text;
    el.practiceStatus.className = `hint ${kind}`.trim();
  }

  /** The readout, redrawn only when what it says changes. */
  function renderReadout(force = false) {
    const now = performance.now();
    const snap = now < lab.snapFlashUntil ? 'Snap!' : lab.snapState === 'set' ? 'Set: thumb on middle finger' : 'Ready';
    const pct = Math.round(lab.coverage.fraction * 100);
    const cutout = {
      idle: '—',
      loading: 'Loading…',
      failed: 'Did not load',
      ready: lab.segMs === null ? `Ready (${lab.segmenter?.delegate})` : `${Math.round(lab.segMs)} ms a frame (${lab.segmenter?.delegate})`,
    }[lab.segmenterState];
    const key = `${snap}|${lab.snaps}|${lab.vanishes}|${pct}|${cutout}|${lab.timeline.phase}|${el.video.videoWidth}|${Boolean(lab.recorder)}|${lab.personInView}`;
    if (!force && key === lab.shownKey) return;
    lab.shownKey = key;

    el.snapState.textContent = snap;
    el.counts.textContent = `${lab.snaps} ${lab.snaps === 1 ? 'snap' : 'snaps'} · ${lab.vanishes} ${lab.vanishes === 1 ? 'vanish' : 'vanishes'}`;
    el.roomBar.style.width = `${pct}%`;
    el.roomBar.classList.toggle('full', pct >= 95);
    el.roomPct.textContent = `${pct}%`;
    el.cutout.textContent = cutout;
    el.vanishBtn.disabled =
      lab.segmenterState !== 'ready' || !lab.hasMask || (!lab.personInView && lab.timeline.phase === 'idle') || lab.practice !== null;
    // Nothing to record until the stage is drawing; a running recording can always stop.
    el.recordBtn.disabled = !lab.recorder && (!lab.renderer || !el.video.videoWidth);
    el.vanishBtn.textContent = lab.timeline.phase === 'gone' ? 'Come back' : 'Vanish';
  }

  // ------------------------------------------------------------------- vanish

  function vanish(source) {
    if (!lab.open) return;
    if (lab.segmenterState !== 'ready' || !lab.hasMask) {
      setStatus('The person cutout is still loading.', 'failed');
      return;
    }
    if (!lab.personInView && lab.timeline.phase === 'idle') {
      setStatus('Nobody is in view to vanish. Sit where the camera can see you.', 'failed');
      return;
    }
    const started = lab.timeline.trigger(performance.now());
    if (!started) return;
    lab.pendingFreeze = true;
    if (started === 'dissolving') {
      lab.vanishes += 1;
      deps.react('fired', 'Snap → vanish');
      const seen = lab.coverage.fraction;
      if (seen < ROOM_ENOUGH) {
        // The part of the room you've always covered has to be guessed from
        // the colours around it, which shows as a smudge where you were.
        setStatus(
          `Only ${Math.round(seen * 100)}% of the room is known, so the part behind you is a guess. Capture the room (lean left, then right) to see it.`,
          'failed',
        );
      } else {
        setStatus(`${source === 'snap' ? 'Snap!' : 'Gone.'} Snap again, or press Come back, to return. Back on your own after 10 s.`);
      }
    } else {
      setStatus('Coming back.');
    }
    renderReadout(true);
  }

  // ------------------------------------------------------------- the room

  /**
   * Forget the room and learn it again, faster for a moment. It never counts
   * you as room, whether or not you manage to step out: it only fills in
   * faster where you aren't, so stepping out is what gets the part behind you.
   */
  function startCapture() {
    if (lab.capture) return;
    deps.chime.unlock();
    lab.renderer?.resetRoom();
    lab.coverage.reset();
    lab.capture = { step: -1, since: performance.now() };
    el.roomBtn.disabled = true;
    renderReadout(true);
  }

  /** Walk through the lean steps; true while the room is being captured. */
  function stepCapture(now) {
    const c = lab.capture;
    if (!c) return false;
    const current = CAPTURE_STEPS[c.step];
    if (c.step === -1 || now - c.since >= current.ms) {
      c.step += 1;
      c.since = now;
      const next = CAPTURE_STEPS[c.step];
      if (next) {
        deps.chime.play('tick');
        deps.voice.say(next.say);
        setStatus(`${next.status} (or step out of view)`);
        return true;
      }
      lab.capture = null;
      el.roomBtn.disabled = false;
      deps.chime.play('done');
      const seen = Math.round(lab.coverage.fraction * 100);
      if (lab.coverage.fraction >= ROOM_ENOUGH) {
        setStatus(`Room captured: ${seen}% seen. Sit back in the middle and snap.`, 'on');
      } else {
        setStatus(
          `${seen}% of the room seen. Lean further each way, or step out of view, and capture again; the rest is guessed from the room around it.`,
          'failed',
        );
      }
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- recording

  function pickMime() {
    const options = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    return options.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
  }

  function toggleRecording() {
    if (lab.recorder) {
      lab.recorder.stop();
      return;
    }
    if (!lab.renderer) return;
    const mimeType = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(el.canvas.captureStream(30), { mimeType, videoBitsPerSecond: RECORD_BITS_PER_SECOND });
    } catch (err) {
      setStatus(`Can't record here: ${err.message}`, 'failed');
      return;
    }
    const chunks = [];
    const startedAt = Date.now();
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      lab.recorder = null;
      el.recordBtn.textContent = 'Record';
      el.recordBtn.classList.remove('recording');
      const type = recorder.mimeType || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      if (lab.clipUrl) URL.revokeObjectURL(lab.clipUrl);
      lab.clipUrl = URL.createObjectURL(blob);
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      el.save.href = lab.clipUrl;
      el.save.download = `gesture-vanish-${stamp}.${ext}`;
      el.save.hidden = false;
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      setStatus(`Recorded ${seconds} s (${(blob.size / 1e6).toFixed(1)} MB, ${ext.toUpperCase()}). Save clip keeps it.`, 'on');
    });
    recorder.start(1000);
    lab.recorder = recorder;
    el.recordBtn.textContent = 'Stop recording';
    el.recordBtn.classList.add('recording');
    el.save.hidden = true;
    setStatus('Recording the stage…');
  }

  // ---------------------------------------------------------------- practice

  function startPractice() {
    if (lab.practice) {
      runPractice(lab.practice.runner.abort(performance.now(), 'cancelled'));
      return;
    }
    if (clip || !deps.stream()) {
      setPracticeStatus('Practice needs the camera: start it first.', 'failed');
      return;
    }
    lab.timeline.reset();
    deps.chime.unlock();
    const seed = Date.now() >>> 0;
    const plan = snapPracticePlan({ rng: seededRandom(seed) });
    const session = deps.sessionId('sn');
    lab.practice = { runner: new SnapPractice(plan), session, records: [], file: null };
    lab.detector.reset();
    el.practiceBtn.textContent = 'Stop practice';
    setPracticeStatus(`Starting — ${plan.length - 1} snaps, then 20 s without snapping. Wait for the chime each time.`);
    deps.postRecord(session, { kind: 'session', mode: 'snap_practice', seed, prompts: plan.length, snap: lab.detector.o }).then((file) => {
      if (file && lab.practice?.session === session) lab.practice.file = file;
    });
    renderReadout(true);
  }

  function runPractice(commands) {
    const pr = lab.practice;
    if (!pr) return;
    for (const command of commands) {
      switch (command.type) {
        case 'say':
          deps.voice.say(command.text).then(({ fallback }) => {
            if (fallback) deps.chime.play('tick');
            if (lab.practice === pr) pr.runner.speechEnded(performance.now());
          });
          break;
        case 'chime':
          deps.chime.play(command.cue);
          break;
        case 'status':
          setPracticeStatus(command.text);
          break;
        case 'save':
          pr.records.push(command.record);
          deps.postRecord(pr.session, command.record).then((file) => {
            if (file) pr.file = file;
          });
          break;
        case 'done':
          finishPractice(pr, command.aborted === true);
          break;
        default:
          break;
      }
    }
  }

  function finishPractice(pr, aborted) {
    if (lab.practice !== pr) return;
    lab.practice = null;
    deps.voice.cancel();
    lab.detector.reset();
    el.practiceBtn.textContent = 'Start practice';
    renderReadout(true);
    if (aborted) {
      setPracticeStatus('Practice stopped. The trials so far are saved.', 'failed');
      return;
    }
    const s = summarizeSnapPractice(pr.records);
    deps.postRecord(pr.session, { kind: 'snap_summary', summary: s });
    deps.chime.play('done');
    const misfires = s.misfires === 0 ? 'no misfires' : `${s.misfires} misfire${s.misfires === 1 ? '' : 's'}`;
    setPracticeStatus(
      `Caught ${s.hits} of ${s.trials} snaps, ${misfires} in ${s.freeSeconds} s of not snapping. Saved to ${pr.file ?? 'experiments/'}.`,
      'on',
    );
    deps.log(`snap practice: ${s.hits}/${s.trials} caught, ${s.misfires} misfires`, 'note');
  }

  // -------------------------------------------------------------------- loop

  function loop() {
    if (!lab.open) return;
    lab.raf = requestAnimationFrame(loop);
    const now = performance.now();

    if (lab.segmenter && el.video.videoWidth && now - lab.lastSegAt >= SEGMENT_EVERY_MS) {
      lab.lastSegAt = now;
      const mask = lab.segmenter.segment(el.video, now);
      if (mask) {
        lab.hasMask = true;
        lab.personInView = personShare(mask.data) > 0.02;
        if (mask.warm) lab.segMs = lab.segMs === null ? mask.ms : lab.segMs * 0.9 + mask.ms * 0.1;
        lab.renderer?.setMask(mask);
        const fresh = now - lab.handAt < HAND_FRESH_MS ? handBox(lab.hand) : null;
        lab.coverage.update(mask.data, mask.width, mask.height, { boxes: fresh ? [fresh] : [] });
      }
    }

    const capturing = stepCapture(now);
    if (lab.renderer) {
      lab.renderer.setHand(now - lab.handAt < HAND_FRESH_MS ? lab.hand : null);
      lab.timeline.configure({ dissolveMs: lab.settings.seconds * 1000, reduced: reducedMotion.matches });
      const f = lab.timeline.update(now);
      // The renderer retakes the snapshot by itself while you come back.
      const freeze = lab.pendingFreeze;
      lab.pendingFreeze = false;
      if (f.entered === 'idle') setStatus('Snap to vanish.');
      lab.renderer.render(el.video, {
        phase: f.phase,
        t: f.t,
        freeze,
        capture: capturing,
        reduced: reducedMotion.matches,
        dust: { ...lab.settings, wind: windInTexture(lab.settings.direction) },
        now,
      });
    }
    renderReadout();
  }

  // --------------------------------------------------------------- the API

  el.vanishBtn.addEventListener('click', () => vanish('button'));
  el.roomBtn.addEventListener('click', startCapture);
  el.recordBtn.addEventListener('click', toggleRecording);
  el.practiceBtn.addEventListener('click', startPractice);
  el.cameraBtn.addEventListener('click', () => deps.startCamera());
  el.dustReset.addEventListener('click', () => {
    lab.settings = dustSettings();
    saveSettings();
    renderSliders();
  });
  renderSliders();
  renderReadout(true);

  return {
    get isOpen() {
      return lab.open;
    },

    open() {
      if (lab.open) return;
      lab.open = true;
      // Detection runs at 640×360; recordings are worth the full picture.
      deps.cameraDetail?.(true);
      lab.detector.reset();
      attachSource();
      ensureRenderer();
      ensureSegmenter();
      setStatus(clip ? `Playing ${clip} instead of the camera (development).` : 'Snap to vanish. Gestures are paused while the Lab is open.');
      lab.raf = requestAnimationFrame(loop);
    },

    close() {
      if (!lab.open) return;
      lab.open = false;
      deps.cameraDetail?.(false);
      cancelAnimationFrame(lab.raf);
      if (lab.practice) runPractice(lab.practice.runner.abort(performance.now(), 'left the Lab'));
      if (lab.recorder) lab.recorder.stop();
      lab.timeline.reset();
      lab.capture = null;
      el.roomBtn.disabled = false;
      el.video.pause();
      // Only let go of the stream: it is Home's camera, and its tracks stay on.
      el.video.srcObject = null;
      // The person cutout holds its model and memory; it loads again next time.
      lab.segmenter?.close();
      lab.segmenter = null;
      lab.segmenterState = 'idle';
    },

    /** The camera started or stopped. */
    cameraChanged() {
      if (lab.open) attachSource();
      else el.video.srcObject = null;
    },

    /**
     * Every camera frame while the Lab is open, from app.js's handleLandmarks.
     *
     * @param {number} now
     * @param {{x:number,y:number}[]|null} pts Aspect-corrected, for the detector.
     * @param {{x:number,y:number}[]|null} landmarks Raw, 0–1 of the video.
     */
    frame(now, pts, landmarks) {
      if (!lab.open) return;
      lab.hand = landmarks;
      if (landmarks) lab.handAt = now;
      const { state, snap } = lab.detector.update(pts, now);
      lab.snapState = state;
      if (snap) {
        lab.snaps += 1;
        lab.snapFlashUntil = now + 600;
      }
      if (lab.practice) runPractice(lab.practice.runner.tick(now, { pts, snap }));
      else if (snap) vanish('snap');
    },
  };
}

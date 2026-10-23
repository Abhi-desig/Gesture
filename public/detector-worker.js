// Hand detection in a Web Worker, so it keeps running when the page is hidden.
//
// This exists because the whole point of the app is driving *other* applications,
// which means the browser window is almost never the visible one. Measured on this
// machine, with the tab hidden:
//
//   requestAnimationFrame        0 fps
//   requestVideoFrameCallback    0 fps
//   setInterval                1.5 fps   (Chrome clamps hidden-tab timers)
//   setInterval + audio playing 1.5 fps   (the "keep the tab alive" trick does not work)
//   setInterval in a worker    62.5 fps   <- only timers are throttled, not workers
//
// The camera itself never stops — it's the page's loop that gets suspended — so
// reading frames from the track in a worker sidesteps the problem entirely.
// postMessage delivery to the main thread is also unthrottled (measured 188 sent,
// 188 received while hidden), so the main thread can still run the recognizer and
// talk to the server.
//
// Deliberately a *classic* worker, not a module worker: MediaPipe's WASM glue fails
// with "ModuleFactory not set." when the bundle is loaded as an ES module in a
// worker. importScripts of the UMD build works, and exposes a `Vision` global.

let landmarker = null;
let faceLandmarker = null;
let running = false;

// Head tracking runs on every other frame. A head turns far more slowly than a
// hand moves, so half the rate costs nothing you could notice — and the face
// model is the heavier of the two.
const FACE_EVERY = 2;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

/** Create a MediaPipe task, preferring the GPU and falling back to the CPU. */
async function createTask(Task, vision, modelUrl, options) {
  let lastError;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Task.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode: 'VIDEO',
        ...options,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function createLandmarkers({ wasmUrl, modelUrl, faceModelUrl }) {
  // `Vision` is the global the UMD bundle installs; the ESM build's named exports
  // aren't available here because this is a classic worker.
  const { FilesetResolver, HandLandmarker, FaceLandmarker } = self.Vision;
  const vision = await FilesetResolver.forVisionTasks(wasmUrl);

  landmarker = await createTask(HandLandmarker, vision, modelUrl, { numHands: 1 });

  // Only when a gesture is bound to a screen action: nobody else should pay for
  // a second model. And never fatal — hands without a head is still the whole
  // of the original app.
  if (!faceModelUrl) return;
  try {
    faceLandmarker = await createTask(FaceLandmarker, vision, faceModelUrl, { numFaces: 1 });
    post('head', { available: true });
  } catch (err) {
    post('head', { available: false, message: err.message });
  }
}

async function loop(readable) {
  const reader = readable.getReader();
  let lastTs = 0;
  let frameIndex = 0;

  while (running) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    if (!running) {
      frame.close();
      break;
    }

    try {
      // detectForVideo throws INVALID_ARGUMENT if the timestamp doesn't strictly
      // increase. performance.now() is monotonic; the max() guards against two
      // frames landing inside the same millisecond.
      //
      // This clock is deliberately not sent to the main thread. A worker has its
      // own performance.timeOrigin, so this value is meaningless there — comparing
      // it against the page's performance.now() breaks by a constant offset.
      const ts = Math.max(performance.now(), lastTs + 1);
      lastTs = ts;

      const result = landmarker.detectForVideo(frame, ts);
      const payload = {
        landmarks: result.landmarks?.[0] ?? null,
        width: frame.displayWidth,
        height: frame.displayHeight,
      };

      // `face` is present only on frames where the face model ran: absent means
      // "no new reading", null means "looked, and there is no face".
      frameIndex += 1;
      if (faceLandmarker && frameIndex % FACE_EVERY === 0) {
        payload.face = faceLandmarker.detectForVideo(frame, ts).faceLandmarks?.[0] ?? null;
      }

      post('landmarks', payload);
    } catch (err) {
      post('error', { message: err.message, fatal: false });
    } finally {
      // Frames are backed by real buffers; not closing them stalls the pipeline.
      frame.close();
    }
  }

  reader.releaseLock?.();
  post('stopped');
}

self.onmessage = async (event) => {
  const { type } = event.data;

  if (type === 'stop') {
    running = false;
    return;
  }

  if (type !== 'start') return;

  const { readable, wasmUrl, modelUrl, faceModelUrl, bundleUrl } = event.data;

  try {
    importScripts(bundleUrl);
  } catch (err) {
    post('error', { message: `could not load MediaPipe: ${err.message}`, fatal: true });
    return;
  }

  try {
    await createLandmarkers({ wasmUrl, modelUrl, faceModelUrl });
  } catch (err) {
    post('error', { message: `could not create hand landmarker: ${err.message}`, fatal: true });
    return;
  }

  post('ready');
  running = true;

  try {
    await loop(readable);
  } catch (err) {
    post('error', { message: err.message, fatal: true });
  }
};

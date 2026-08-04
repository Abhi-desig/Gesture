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
let running = false;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

async function createLandmarker({ wasmUrl, modelUrl }) {
  // `Vision` is the global the UMD bundle installs; the ESM build's named exports
  // aren't available here because this is a classic worker.
  const { FilesetResolver, HandLandmarker } = self.Vision;
  const vision = await FilesetResolver.forVisionTasks(wasmUrl);

  let lastError;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function loop(readable) {
  const reader = readable.getReader();
  let lastTs = 0;

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
      post('landmarks', {
        landmarks: result.landmarks?.[0] ?? null,
        width: frame.displayWidth,
        height: frame.displayHeight,
      });
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

  const { readable, wasmUrl, modelUrl, bundleUrl } = event.data;

  try {
    importScripts(bundleUrl);
  } catch (err) {
    post('error', { message: `could not load MediaPipe: ${err.message}`, fatal: true });
    return;
  }

  try {
    landmarker = await createLandmarker({ wasmUrl, modelUrl });
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

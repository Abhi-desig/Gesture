// The person cutout for the Lab: which pixels of the frame are you.
//
// MediaPipe's selfie segmenter, landscape version (144×256 input, made for
// 16:9 webcams), on the page rather than in the detection worker. The effect is
// only visible while you are looking at the Lab, and hand and face detection
// stay exactly as they were.
//
// Two things measured on this Mac (M1, Chrome) decided how it runs:
// - The mask comes back at the size of the input. Fed the 1280×720 camera
//   frame, that is 921,600 values to copy, upload and count every frame, which
//   brought the Lab down to 2 fps. The model only looks at 256×144 anyway, so
//   each frame is shrunk to that first: the mask is then 36,864 values.
// - At that size it takes about 7 ms a frame on the CPU and on the GPU alike.
//   The CPU goes first: it warms up in 25 ms rather than 170, and doesn't compete
//   with the renderer for the GPU or stall it to read a mask back.
//
// MediaPipe frees each mask as soon as the callback returns, so the confidence
// values are copied out inside it.

const INPUT_W = 256;
// The first few calls include setting the model up; they don't count toward
// the speed shown in the Lab.
const WARMUP_CALLS = 3;

export const CDN_SEGMENT_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite';
export const LOCAL_SEGMENT_MODEL_URL = './models/selfie_segmenter_landscape.tflite';

export class Segmenter {
  /**
   * @param {object} assets
   * @param {string} assets.esm The tasks-vision ES module.
   * @param {string} assets.wasm Its wasm folder.
   * @param {string} assets.model The segmenter model.
   */
  static async create({ esm, wasm, model }) {
    const { FilesetResolver, ImageSegmenter } = await import(esm);
    const vision = await FilesetResolver.forVisionTasks(wasm);
    let lastError;
    for (const delegate of ['CPU', 'GPU']) {
      try {
        const task = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: model, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        return new Segmenter(task, delegate);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  constructor(task, delegate) {
    this.task = task;
    this.delegate = delegate;
    this.lastTs = 0;
    // Which mask is the person. The labels say when they can; otherwise the
    // last mask, which is the person in every selfie model's label order.
    const labels = task.getLabels?.() ?? [];
    const named = labels.findIndex((l) => /person|selfie|foreground|human/i.test(l));
    this.personIndex = named >= 0 ? named : null;
    this.labels = labels;
    this.input = null;
    this.calls = 0;
  }

  /**
   * @param {HTMLVideoElement} video
   * @returns {{data: Float32Array, width: number, height: number, ms: number, warm: boolean}|null}
   */
  segment(video, now) {
    if (!video.videoWidth) return null;
    // Must strictly increase, like detectForVideo's.
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    const started = performance.now();

    const h = Math.max(1, Math.round((INPUT_W * video.videoHeight) / video.videoWidth));
    if (!this.input || this.input.height !== h) {
      this.input = new OffscreenCanvas(INPUT_W, h);
      this.inputCtx = this.input.getContext('2d');
    }
    this.inputCtx.drawImage(video, 0, 0, INPUT_W, h);

    let out = null;
    this.task.segmentForVideo(this.input, ts, (result) => {
      const masks = result.confidenceMasks ?? [];
      const mask = masks[this.personIndex ?? masks.length - 1];
      if (!mask) return;
      out = { data: new Float32Array(mask.getAsFloat32Array()), width: mask.width, height: mask.height };
    });
    this.calls += 1;
    if (out) {
      out.ms = performance.now() - started;
      out.warm = this.calls > WARMUP_CALLS;
    }
    return out;
  }

  close() {
    this.task?.close();
    this.task = null;
  }
}

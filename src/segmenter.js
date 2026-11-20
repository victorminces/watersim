// Person segmentation with MediaPipe Tasks Vision (selfie segmenter).
// Loaded straight from a CDN; no build step, nothing leaves the machine.

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

export class Segmenter {
  constructor() {
    this.ready = false;
    this.buf = null;       // Uint8Array, 0 or 255 per pixel
    this.width = 0;
    this.height = 0;
    this.generation = 0;   // bumped on every new mask
    this.coverage = 0;     // fraction of the frame marked as person
    this.busy = false;
    this.stamp = 0;
    this.lastVideoTime = -1;
    this.delegate = null;
  }

  async load() {
    const { ImageSegmenter, FilesetResolver } = await import(/* @vite-ignore */ CDN);
    const vision = await FilesetResolver.forVisionTasks(CDN + '/wasm');
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    try {
      this.seg = await ImageSegmenter.createFromOptions(vision, opts('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU delegate unavailable, falling back to CPU.', err);
      this.seg = await ImageSegmenter.createFromOptions(vision, opts('CPU'));
      this.delegate = 'CPU';
    }
    this.ready = true;
  }

  // Call once per animation frame; skips work when there is no new video frame.
  process(video) {
    if (!this.ready || this.busy) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    this.stamp += 33;
    this.busy = true;
    try {
      this.seg.segmentForVideo(video, this.stamp, (result) => {
        try {
          this.#consume(result);
        } finally {
          result.close();
          this.busy = false;
        }
      });
    } catch (err) {
      this.busy = false;
      console.warn('Segmentation step failed.', err);
    }
  }

  #consume(result) {
    const mask = result.categoryMask;
    if (!mask) return;
    const src = mask.getAsUint8Array();
    if (!this.buf || this.buf.length !== src.length) this.buf = new Uint8Array(src.length);
    // The model's category index for "person" has varied between releases, so
    // treat any non-zero label as body and let the UI invert if it looks wrong.
    let hit = 0;
    for (let i = 0; i < src.length; i++) {
      const on = src[i] !== 0;
      this.buf[i] = on ? 255 : 0;
      if (on) hit++;
    }
    this.width = mask.width;
    this.height = mask.height;
    this.coverage = hit / src.length;
    this.generation++;
  }

  close() {
    if (this.seg) this.seg.close();
    this.ready = false;
  }
}

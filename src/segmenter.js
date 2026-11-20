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
    // What the masks say about themselves, for working out which label is the
    // person and whether detection works at all on this device:
    this.cornerOn = 0;     // share of the top corners carrying the non-zero label
    this.uniform = true;   // the latest mask is all one label (nobody, or broken)
    this.varied = false;   // some mask since loading has had two labels in it
  }

  async load() {
    const { ImageSegmenter, FilesetResolver } = await import(/* @vite-ignore */ CDN);
    this.ImageSegmenter = ImageSegmenter;
    this.vision = await FilesetResolver.forVisionTasks(CDN + '/wasm');
    try {
      await this.#create('GPU');
    } catch (err) {
      console.warn('GPU delegate unavailable, falling back to CPU.', err);
      await this.#create('CPU');
    }
  }

  // Start over on the CPU. Some phone graphics drivers load the GPU version
  // without complaint and then return masks with nobody in them, ever.
  async useCpu() {
    this.ready = false;
    if (this.seg) this.seg.close();
    this.seg = null;
    await this.#create('CPU');
  }

  async #create(delegate) {
    this.seg = await this.ImageSegmenter.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    this.delegate = delegate;
    this.varied = false;
    this.busy = false;
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
    // Which label is the person has differed between model releases and
    // devices: keep the non-zero label as "body" here, and let the app invert
    // it (it decides automatically from cornerOn, below).
    let hit = 0;
    for (let i = 0; i < src.length; i++) {
      const on = src[i] !== 0;
      this.buf[i] = on ? 255 : 0;
      if (on) hit++;
    }
    const w = mask.width, h = mask.height;
    this.width = w;
    this.height = h;
    this.coverage = hit / src.length;
    this.uniform = hit === 0 || hit === src.length;
    if (!this.uniform) this.varied = true;

    // Top corners (row 0 is the top of the picture): in a selfie frame they
    // are background almost always, which tells the labels apart.
    const rows = Math.max(1, Math.round(h * 0.12)), cols = Math.max(1, Math.round(w * 0.2));
    let on = 0;
    for (let y = 0; y < rows; y++) {
      const row = y * w;
      for (let x = 0; x < cols; x++) {
        if (src[row + x]) on++;
        if (src[row + w - 1 - x]) on++;
      }
    }
    this.cornerOn = on / (rows * cols * 2);
    this.generation++;
  }

  close() {
    if (this.seg) this.seg.close();
    this.ready = false;
  }
}

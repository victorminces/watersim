// Person segmentation with MediaPipe Tasks Vision (selfie segmenter).
// Loaded straight from a CDN; no build step, nothing leaves the machine.

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

export class Segmenter {
  // maxSide: shrink camera frames to at most this many pixels on their long
  // side before segmenting (0 keeps them as they come). The model only ever
  // sees 256x256, but the mask comes back at the size it was given, and a
  // phone camera's 2560x1280 frame made a 3.3-megapixel mask to copy, scan
  // and upload: 270 ms a frame on a Pixel, against 0.7 ms for the water.
  //
  // worker: segment in a Web Worker (segworker.js). On a Pixel even the
  // shrunk frame takes ~35 ms on the CPU, and on the page's main thread that
  // holds every frame of the water to it. In a worker the water draws at the
  // screen's rate and the masks arrive when they are ready. If the worker
  // cannot start, segmentation runs on the page as before.
  constructor({ maxSide = 0, worker = false } = {}) {
    this.maxSide = maxSide;
    this.useWorker = worker;
    this.worker = null;
    this.lastMs = 0;
    this.pending = null;   // {resolve, reject} for the worker's next 'ready'
    this.small = null;     // canvas holding the shrunk frame (main-thread path)
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
    this.readyAt = Infinity; // performance.now() when it last became ready
    this.failed = false;     // set by the app when loading failed
    // What the masks say about themselves, for working out which label is the
    // person and whether detection works at all on this device:
    this.cornerOn = 0;     // share of the top corners carrying the non-zero label
    this.uniform = true;   // the latest mask is all one label (nobody, or broken)
    this.varied = false;   // some mask since loading has had two labels in it
  }

  async load() {
    if (this.useWorker && typeof Worker !== 'undefined' && typeof createImageBitmap !== 'undefined') {
      try {
        await this.#startWorker();
        return;
      } catch (err) {
        console.warn('Body detection could not start in a worker; running it on the page.', err);
        this.#stopWorker();
      }
    }
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
    if (this.worker) {
      await this.#ask({ type: 'cpu' });
      return;
    }
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
    this.#isReady(delegate);
  }

  #isReady(delegate) {
    this.readyAt = performance.now();
    this.delegate = delegate;
    this.varied = false;
    this.busy = false;
    this.ready = true;
  }

  // ------------------------------------------------------------ worker

  #startWorker() {
    // The same version query as this module, so a deploy never pairs a fresh
    // page with a stale worker.
    const url = new URL('segworker.js' + new URL(import.meta.url).search, import.meta.url);
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this.#fromWorker(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.#settle(new Error(e.message || 'worker failed'));
    };
    return this.#ask({ type: 'load', cdn: CDN, model: MODEL });
  }

  #stopWorker() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }

  #ask(msg) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(msg);
    });
  }

  #settle(err) {
    const p = this.pending;
    this.pending = null;
    if (p) err ? p.reject(err) : p.resolve();
  }

  #fromWorker(m) {
    if (m.type === 'mask') {
      if (m.data) this.#consume(m.data, m.width, m.height);
      this.lastMs = m.ms; // time the worker spent on it, for the curious
      this.busy = false;
    } else if (m.type === 'ready') {
      this.#isReady(m.delegate);
      this.#settle(null);
    } else if (m.type === 'error') {
      this.#settle(new Error(m.message));
    } else if (m.type === 'log') {
      console.warn(m.text);
    }
  }

  // ------------------------------------------------------------ per frame

  // Call once per animation frame; skips work when there is no new video frame.
  process(video) {
    if (!this.ready || this.busy) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    this.stamp += 33;
    this.busy = true;
    if (this.worker) {
      const [w, h] = this.#size(video);
      const stamp = this.stamp;
      createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }).then(
        (bitmap) => this.worker.postMessage({ type: 'frame', bitmap, stamp }, [bitmap]),
        () => { this.busy = false; },
      );
      return;
    }
    try {
      this.seg.segmentForVideo(this.#shrink(video), this.stamp, (result) => {
        try {
          const mask = result.categoryMask;
          if (mask) this.#consume(mask.getAsUint8Array(), mask.width, mask.height);
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

  #size(video) {
    const k = this.maxSide ? Math.min(1, this.maxSide / Math.max(video.videoWidth, video.videoHeight)) : 1;
    return [Math.round(video.videoWidth * k), Math.round(video.videoHeight * k)];
  }

  #shrink(video) {
    const [w, h] = this.#size(video);
    if (w === video.videoWidth) return video;
    if (!this.small) this.small = document.createElement('canvas');
    if (this.small.width !== w || this.small.height !== h) {
      this.small.width = w;
      this.small.height = h;
    }
    this.small.getContext('2d').drawImage(video, 0, 0, w, h);
    return this.small;
  }

  #consume(src, w, h) {
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
    this.#stopWorker();
    this.ready = false;
  }
}

// Body detection off the page's main thread, for phones (see segmenter.js).
//
// A classic worker on purpose: MediaPipe pulls its wasm loader in with
// importScripts, which module workers do not have. Its CommonJS build is run
// the way Node runs it, as a function of `exports`. (Not with importScripts:
// the CDN serves .cjs as application/node, which browsers refuse as script.)
//
// Messages in:  {type: 'load', cdn, model} · {type: 'cpu'} · {type: 'frame', bitmap, stamp}
// Messages out: {type: 'ready', delegate} · {type: 'error', message}
//               {type: 'mask', data, width, height, ms} (data null when there was none;
//                ms is the time it took: ~70 ms on a Pixel's CPU, whatever the model or size)
//               {type: 'log', text}

let lib = null, vision = null, seg = null, model = null, delegate = null;

const log = (text) => postMessage({ type: 'log', text: String(text) });

async function create(kind) {
  const old = seg;
  seg = null; // frames that arrive meanwhile are skipped
  if (old) old.close();
  seg = await lib.ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: model, delegate: kind },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
  delegate = kind;
}

function segment(bitmap, stamp) {
  let reply = { type: 'mask', data: null };
  const transfer = [];
  const t0 = performance.now();
  try {
    if (seg) {
      seg.segmentForVideo(bitmap, stamp, (result) => {
        const mask = result.categoryMask;
        if (mask) {
          const data = mask.getAsUint8Array().slice(); // a copy that outlives the result
          reply = { type: 'mask', data, width: mask.width, height: mask.height };
          transfer.push(data.buffer);
        }
        result.close();
      });
    }
  } catch (err) {
    log('Segmentation step failed: ' + (err && err.message || err));
  } finally {
    bitmap.close();
  }
  reply.ms = performance.now() - t0;
  postMessage(reply, transfer);
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'frame') {
    segment(m.bitmap, m.stamp);
    return;
  }
  try {
    if (m.type === 'load') {
      const res = await fetch(m.cdn + '/vision_bundle.cjs');
      if (!res.ok) throw new Error('vision_bundle.cjs: HTTP ' + res.status);
      lib = {};
      new Function('exports', await res.text())(lib);
      model = m.model;
      vision = await lib.FilesetResolver.forVisionTasks(m.cdn + '/wasm');
      try {
        await create('GPU');
      } catch (err) {
        log('GPU delegate unavailable, falling back to CPU. ' + (err && err.message || err));
        await create('CPU');
      }
    } else if (m.type === 'cpu') {
      await create('CPU');
    }
    postMessage({ type: 'ready', delegate });
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

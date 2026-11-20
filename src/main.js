// Water Contour — top-down surface waves driven by a camera silhouette.
//
// Per frame: upload the camera frame and its person mask, ease the mask and
// measure how it moved, add any point impulses, step the wave equation a
// couple of times, then shade the height field.

import { VERT, MASK_FRAG, SPLAT_FRAG, SIM_FRAG, RENDER_FRAG } from './shaders.js';
import { createGL, Program, PingPong, makeTexture, fullscreenQuad, bindTarget } from './glx.js';
import { Segmenter } from './segmenter.js';
import { DemoMask } from './demo.js';

const CELLS = 512 * 288;          // simulation grid budget, laid out to the screen aspect
// Wave steps per animation frame. This also sets the shortest wave the pool can
// make: a moving contour can only emit at the distance a wave travels between
// camera frames, so too few substeps and the body sheds grid-scale fizz instead
// of ripples.
const SUBSTEPS = 16;
const MAX_DROPS = 16;             // must match uDrops[] in the splat shader

const PALETTES = {
  'Sunlit blue': {
    deep: [0.012, 0.09, 0.22], shallow: [0.30, 0.72, 0.88],
    spec: [1.0, 0.99, 0.92], void: [0.015, 0.02, 0.03], rim: [0.72, 0.93, 1.0],
  },
  'Dark monochrome': {
    deep: [0.008, 0.010, 0.013], shallow: [0.42, 0.46, 0.50],
    spec: [1.0, 1.0, 1.0], void: [0.0, 0.0, 0.0], rim: [1.0, 1.0, 1.0],
  },
  'Lagoon': {
    deep: [0.015, 0.16, 0.17], shallow: [0.48, 0.92, 0.80],
    spec: [1.0, 1.0, 0.95], void: [0.01, 0.03, 0.03], rim: [0.80, 1.0, 0.95],
  },
  'Ink and copper': {
    deep: [0.04, 0.035, 0.055], shallow: [0.95, 0.56, 0.28],
    spec: [1.0, 0.86, 0.68], void: [0.02, 0.018, 0.028], rim: [1.0, 0.76, 0.52],
  },
  'Moonlit': {
    deep: [0.03, 0.05, 0.12], shallow: [0.62, 0.70, 0.95],
    spec: [0.92, 0.96, 1.0], void: [0.01, 0.012, 0.02], rim: [0.86, 0.90, 1.0],
  },
};

const el = (id) => document.getElementById(id);
const canvas = el('stage');
const boot = el('boot');
const bootMsg = el('boot-msg');
const panel = el('panel');
const maskview = el('maskview');

let gl, quad, progMask, progSplat, progSim, progRender;
let sim, mask;                       // PingPong buffers
let texRawCam, texRawDemo, texVideo, texBlank;
let simW = 0, simH = 0, viewW = 0, viewH = 0;

let video = null;
let stream = null;
let segmenter = null;
let demo = null;
let source = null;                   // 'camera' | 'demo'
let lastMaskGen = -1;
let calibrated = false;
let calibSum = 0, calibN = 0;

const drops = [];
const pointer = { down: false, x: 0.5, y: 0.5, last: 0 };
let frames = 0, fpsClock = 0, fps = 0;

// ---------------------------------------------------------------- setup

function initGL() {
  gl = createGL(canvas);
  quad = fullscreenQuad(gl);
  progMask = new Program(gl, VERT, MASK_FRAG);
  progSplat = new Program(gl, VERT, SPLAT_FRAG);
  progSim = new Program(gl, VERT, SIM_FRAG);
  progRender = new Program(gl, VERT, RENDER_FRAG);

  texRawCam = makeTexture(gl);
  texRawDemo = makeTexture(gl);
  texVideo = makeTexture(gl);
  texBlank = makeTexture(gl, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, texBlank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([6, 10, 16, 255]));

  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = Math.max(2, Math.round(window.innerWidth * dpr));
  viewH = Math.max(2, Math.round(window.innerHeight * dpr));
  canvas.width = viewW;
  canvas.height = viewH;

  const aspect = viewW / viewH;
  const w = Math.max(96, Math.round(Math.sqrt(CELLS * aspect)));
  const h = Math.max(96, Math.round(w / aspect));
  if (w !== simW || h !== simH) {
    simW = w;
    simH = h;
    if (sim) sim.dispose();
    if (mask) mask.dispose();
    sim = new PingPong(gl, simW, simH);
    mask = new PingPong(gl, simW, simH);
    if (demo) demo.resize(aspect);
  }
}

// ---------------------------------------------------------------- sources

async function startCamera() {
  bootMsg.textContent = 'Asking for the camera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
  } catch (err) {
    bootMsg.textContent = 'No camera available (' + err.name + '). You can still run without one.';
    return;
  }
  video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play();

  bootMsg.textContent = 'Loading the body-segmentation model…';
  segmenter = new Segmenter();
  try {
    await segmenter.load();
  } catch (err) {
    console.error(err);
    bootMsg.textContent = 'Could not load the segmentation model (offline?). Running without a camera instead.';
    startDemo();
    return;
  }
  source = 'camera';
  begin();
}

function startDemo() {
  source = 'demo';
  demo = new DemoMask();
  demo.resize(viewW / viewH);
  begin();
}

function begin() {
  boot.hidden = true;
  panel.hidden = false;
  sim.clear();
  mask.clear();
}

// ---------------------------------------------------------------- uploads

function uploadCamera() {
  gl.bindTexture(gl.TEXTURE_2D, texVideo);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);

  if (segmenter.generation !== lastMaskGen && segmenter.buf) {
    lastMaskGen = segmenter.generation;
    gl.bindTexture(gl.TEXTURE_2D, texRawCam);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, segmenter.width, segmenter.height, 0,
      gl.RED, gl.UNSIGNED_BYTE, segmenter.buf);
    autoCalibrate();
    if (ui.showmask.checked) drawMaskPreview();
  }
}

function uploadDemo(t) {
  demo.update(t);
  gl.bindTexture(gl.TEXTURE_2D, texRawDemo);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, demo.canvas);
}

// The model's person/background label order has changed between releases, so
// if nearly the whole frame comes back as "body" we flip the mask once.
function autoCalibrate() {
  if (calibrated) return;
  calibSum += segmenter.coverage;
  calibN++;
  if (calibN < 45) return;
  calibrated = true;
  if (calibSum / calibN > 0.62) {
    ui.invert.checked = !ui.invert.checked;
    note('Mask looked inverted — flipped it for you.');
  }
}

function drawMaskPreview() {
  const { buf, width, height } = segmenter;
  if (!buf) return;
  if (maskview.width !== width || maskview.height !== height) {
    maskview.width = width;
    maskview.height = height;
  }
  const ctx = maskview.getContext('2d');
  const img = ctx.createImageData(width, height);
  const inv = ui.invert.checked;
  for (let i = 0, j = 0; i < buf.length; i++, j += 4) {
    const v = inv ? 255 - buf[i] : buf[i];
    img.data[j] = img.data[j + 1] = img.data[j + 2] = v;
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Centred cover-fit of a source frame onto the simulation grid.
function camXform(srcW, srcH) {
  const srcA = srcW / srcH, simA = simW / simH;
  if (srcA > simA) {
    const s = simA / srcA;
    return [s, 1, (1 - s) / 2, 0];
  }
  const s = srcA / simA;
  return [1, s, 0, (1 - s) / 2];
}

// ---------------------------------------------------------------- passes

function runMaskPass(rawTex, xform) {
  bindTarget(gl, mask.write);
  progMask.use()
    .tex('uRaw', rawTex)
    .tex('uPrev', mask.read.tex)
    .v2('uTexel', 1 / simW, 1 / simH)
    .f('uEase', +ui.ease.value)
    .f('uSoft', +ui.soft.value)
    .i('uInvert', ui.invert.checked ? 1 : 0)
    .i('uMirror', ui.mirror.checked ? 1 : 0)
    .v4('uCamXform', xform);
  quad.draw();
  mask.swap();
}

function runSplatPass() {
  const data = new Float32Array(MAX_DROPS * 4);
  const n = Math.min(drops.length, MAX_DROPS);
  for (let i = 0; i < n; i++) {
    const d = drops[i];
    data[i * 4] = d.x;
    data[i * 4 + 1] = d.y;
    data[i * 4 + 2] = d.amp;
    data[i * 4 + 3] = d.r;
  }
  drops.length = 0;

  bindTarget(gl, sim.write);
  progSplat.use()
    .tex('uSim', sim.read.tex)
    .v4a('uDrops', data)
    .i('uDropCount', n)
    .f('uAspect', simW / simH);
  quad.draw();
  sim.swap();
}

function runSimPass(step) {
  bindTarget(gl, sim.write);
  progSim.use()
    .tex('uSim', sim.read.tex)
    .tex('uMask', mask.read.tex)
    .v2('uTexel', 1 / simW, 1 / simH)
    .f('uC2', +ui.speed.value)
    // The slider is wave life per frame; the solver wants it per substep.
    .f('uDamp', Math.pow(+ui.damp.value, 1 / SUBSTEPS))
    .f('uPush', +ui.push.value)
    .i('uObstacle', ui.obstacle.checked ? 1 : 0)
    .i('uRipples', ui.ripples.checked ? 1 : 0)
    // The frame's impulse and the frame's worth of body movement are both
    // spread evenly over the substeps.
    .f('uInject', 1 / SUBSTEPS)
    .f('uBlend', (step + 1) / SUBSTEPS);
  quad.draw();
  sim.swap();
}

function runRenderPass(videoTex, xform) {
  const p = PALETTES[ui.palette.value] || PALETTES['Sunlit blue'];
  bindTarget(gl, null, viewW, viewH);
  progRender.use()
    .tex('uSim', sim.read.tex)
    .tex('uMask', mask.read.tex)
    .tex('uVideo', videoTex)
    .v2('uTexel', 1 / simW, 1 / simH)
    .f('uRelief', +ui.relief.value)
    .f('uRefract', +ui.refract.value)
    .i('uMode', +ui.look.value)
    .i('uMirror', ui.mirror.checked ? 1 : 0)
    .v4('uCamXform', xform)
    .v3('uDeep', p.deep)
    .v3('uShallow', p.shallow)
    .v3('uSpec', p.spec)
    .v3('uVoid', p.void)
    .v3('uRim', p.rim);
  quad.draw();
}

// ---------------------------------------------------------------- loop

function frame(now) {
  requestAnimationFrame(frame);
  if (!source) return;

  const t = now / 1000;
  let rawTex, videoTex, xform;

  if (source === 'camera') {
    segmenter.process(video);
    if (video.videoWidth) {
      uploadCamera();
      xform = camXform(video.videoWidth, video.videoHeight);
    } else {
      xform = [1, 1, 0, 0];
    }
    rawTex = texRawCam;
    videoTex = texVideo;
  } else {
    uploadDemo(t);
    rawTex = texRawDemo;
    videoTex = texRawDemo;
    xform = [1, 1, 0, 0];
  }

  // rain
  const rain = +ui.rain.value;
  if (rain > 0 && Math.random() < rain * 0.75) {
    drops.push({ x: Math.random(), y: Math.random(), amp: 0.05 + 0.2 * rain, r: 0.006 });
  }

  runMaskPass(rawTex, xform);
  if (drops.length) runSplatPass();
  for (let i = 0; i < SUBSTEPS; i++) runSimPass(i);
  runRenderPass(videoTex, xform);

  frames++;
  if (!fpsClock) fpsClock = now;
  if (now - fpsClock > 500) {
    fps = Math.round((frames * 1000) / (now - fpsClock));
    frames = 0;
    fpsClock = now;
    updateStat();
  }
}

function updateStat() {
  const bits = [fps + ' fps', simW + '×' + simH];
  if (source === 'camera') {
    bits.push(segmenter.delegate ? 'mask ' + segmenter.delegate : 'mask —');
    bits.push('body ' + Math.round(segmenter.coverage * 100) + '%');
  } else {
    bits.push('demo silhouette');
  }
  el('stat').textContent = bits.join(' · ') + (noteText ? '\n' + noteText : '');
}

let noteText = '';
function note(msg) {
  noteText = msg;
  setTimeout(() => { noteText = ''; }, 6000);
}

// ---------------------------------------------------------------- ui

const ui = {};
for (const id of ['obstacle', 'ripples', 'look', 'palette', 'speed', 'damp', 'push',
  'relief', 'refract', 'rain', 'mirror', 'invert', 'soft', 'ease', 'showmask']) {
  ui[id] = el(id);
}

for (const name of Object.keys(PALETTES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  ui.palette.appendChild(opt);
}

ui.showmask.addEventListener('change', () => {
  maskview.hidden = !ui.showmask.checked;
});
ui.invert.addEventListener('change', () => {
  calibrated = true; // the operator has an opinion; stop second-guessing it
  if (source === 'camera' && ui.showmask.checked) drawMaskPreview();
});

el('btn-start').addEventListener('click', startCamera, { once: true });
el('btn-demo').addEventListener('click', startDemo, { once: true });
el('btn-calm').addEventListener('click', () => sim.clear());

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, button')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') panel.hidden = !panel.hidden;
  else if (k === 'c') sim.clear();
  else if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});

function dropAt(e, amp) {
  const r = canvas.getBoundingClientRect();
  drops.push({
    x: (e.clientX - r.left) / r.width,
    y: 1 - (e.clientY - r.top) / r.height,
    amp,
    r: 0.02,
  });
}
canvas.addEventListener('pointerdown', (e) => {
  pointer.down = true;
  dropAt(e, 0.9);
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointer.down) return;
  if (performance.now() - pointer.last < 25) return;
  pointer.last = performance.now();
  dropAt(e, 0.35);
});
window.addEventListener('pointerup', () => { pointer.down = false; });

// ---------------------------------------------------------------- go

try {
  initGL();
  // Console handle for poking at the simulation: __water.read('mask', x, y, w)
  window.__water = {
    get gl() { return gl; }, get sim() { return sim; }, get mask() { return mask; },
    read(which, x, y, w = 1, h = 1) {
      const t = (which === 'sim' ? sim : mask).read;
      const out = new Float32Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    },
  };
  requestAnimationFrame(frame);
} catch (err) {
  console.error(err);
  bootMsg.textContent = err.message;
  el('btn-start').disabled = true;
  el('btn-demo').disabled = true;
}

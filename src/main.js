// Water Contour — top-down surface waves driven by a camera silhouette.
//
// Per frame: upload the camera frame and its person mask, ease the mask and
// measure how it moved, add any point impulses, step the wave equation, shade
// the height field, and boil the pool down to a grid of zone stats for sound.

// The modules load as one versioned set: index.html asks for main.js?v=...,
// and the same query goes on everything main.js pulls in. GitHub Pages lets
// browsers keep files for ten minutes, and a fresh main.js running against a
// stale module from the last deploy breaks in confusing ways.
const V = new URL(import.meta.url).search;
const { VERT, MASK_FRAG, SPLAT_FRAG, SIM_FRAG, RENDER_FRAG, REDUCE_FRAG, TRAIL_FRAG, GRATE_FRAG } = await import('./shaders.js' + V);
const {
  createGL, Program, PingPong, makeTexture, makeTarget, fullscreenQuad, bindTarget, Readback,
} = await import('./glx.js' + V);
const { Segmenter } = await import('./segmenter.js' + V);
const { DemoMask } = await import('./demo.js' + V);
const { WaterAudio, SCALES } = await import('./audio.js' + V);

// Phones and tablets: a lighter grid and pixel ratio, and a button for the
// panel since there is no H key.
const TOUCH = window.matchMedia('(pointer: coarse)').matches;
// Grid budget, laid out to the screen aspect; the Detail slider scales it.
// The waves a moving body makes are a set number of cells long (see SUBSTEPS),
// so the grid decides how big they look. A laptop's ~265 cells across its
// short side make ripples ~2% of it, which on a ~19 cm screen reads well; the
// same 2% of a ~7 cm phone is fizz. Phones get ~120 cells across, so ripples
// are ~2.5x larger relative to the screen (and the GPU has far less to do).
const CELLS = TOUCH ? 120 * 267 : 512 * 288;
// Wave steps per animation frame. This also sets the shortest wave the pool can
// make: a moving contour can only emit at the distance a wave travels between
// camera frames, so too few substeps and the body sheds grid-scale fizz instead
// of ripples.
const SUBSTEPS = 16;
const MAX_DROPS = 16;             // must match uDrops[] in the splat shader
const ZONES_X = 16, ZONES_Y = 8;  // sound grid laid over the pool
const VEL_SCALE = 32;             // see uVelScale in the reduce shader

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
const panelBtn = el('btn-panel');

function setPanel(show) {
  panel.hidden = !show;
  panelBtn.textContent = show ? 'Hide' : 'Controls';
}

let gl, quad, progMask, progSplat, progSim, progRender, progReduce, progTrail;
let trail = null, trailFresh = true; // the liquid-trails picture (look 5)
let progGrate, grate = null;          // ripple structure for diffraction (look 8)

let statsTarget, readback;
const audio = new WaterAudio(ZONES_X, ZONES_Y);
let lastFrame = 0, frameDt = 1 / 60;
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
  progTrail = new Program(gl, VERT, TRAIL_FRAG);
  progGrate = new Program(gl, VERT, GRATE_FRAG);
  progReduce = new Program(gl, VERT, REDUCE_FRAG);
  statsTarget = makeTarget(gl, ZONES_X, ZONES_Y * 2); // water band, then movement band
  readback = new Readback(gl, ZONES_X, ZONES_Y * 2);

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
  const dpr = Math.min(window.devicePixelRatio || 1, TOUCH ? 1.5 : 2);
  viewW = Math.max(2, Math.round(window.innerWidth * dpr));
  viewH = Math.max(2, Math.round(window.innerHeight * dpr));
  canvas.width = viewW;
  canvas.height = viewH;

  const aspect = viewW / viewH;
  const cells = CELLS * (ui.detail ? +ui.detail.value : 1);
  const w = Math.max(96, Math.round(Math.sqrt(cells * aspect)));
  const h = Math.max(96, Math.round(w / aspect));
  if (w !== simW || h !== simH) {
    simW = w;
    simH = h;
    if (sim) sim.dispose();
    if (mask) mask.dispose();
    sim = new PingPong(gl, simW, simH);
    mask = new PingPong(gl, simW, simH);
    if (grate) { gl.deleteTexture(grate.tex); gl.deleteFramebuffer(grate.fbo); }
    grate = makeTarget(gl, simW, simH);
    if (demo) demo.resize(aspect);
  }
  // The trails picture: finer than the grid (it carries the camera's detail)
  // but no finer than the screen.
  const tw = Math.min(viewW, simW * 2), th = Math.min(viewH, simH * 2);
  if (!trail || trail.w !== tw || trail.h !== th) {
    if (trail) trail.dispose();
    trail = new PingPong(gl, tw, th);
    trailFresh = true;
  }
}

// ---------------------------------------------------------------- sources

let starting = false;

async function startCamera() {
  if (starting || source) return;
  starting = true;
  el('btn-start').disabled = true;
  startAudio(); // first, while still inside the tap that allows sound
  try {
    await openCamera();
    if (!segmenter) {
      bootMsg.textContent = 'Loading body detection…';
      segmenter = new Segmenter();
      try {
        await segmenter.load();
      } catch (err) {
        console.error(err);
        segmenter = null;
        stopCamera();
        bootMsg.textContent = 'Could not load body detection (offline?). Running without a camera instead.';
        startDemo();
        return;
      }
    }
    source = 'camera';
    begin();
  } catch (err) {
    console.error(err);
    bootMsg.textContent = err.message;
  } finally {
    starting = false;
    el('btn-start').disabled = false;
  }
}

// Opens the camera and resolves only once it is really delivering pictures.
// Throws an Error whose message is meant for the person holding the phone.
async function openCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('The camera only works over https (or on localhost). Open the https link, or run without a camera.');
  }
  bootMsg.textContent = 'Asking for the camera…';
  // Phones: of the camera's own (uncropped) modes, the one closest to the
  // screen's shape. Letting the browser crop the sensor to the screen's tall,
  // narrow shape instead is a heavy digital zoom. camXform frames the result.
  const wanted = TOUCH
    ? { facingMode: 'user', resizeMode: 'none', aspectRatio: { ideal: viewW / viewH }, height: { ideal: 1280 } }
    : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: wanted, audio: false });
  } catch (err) {
    const why = {
      NotAllowedError: 'Camera permission was refused. Allow it in the browser’s site settings, then tap Start camera again.',
      NotFoundError: 'No camera was found.',
      NotReadableError: 'The camera is busy in another app. Close it and tap Start camera again.',
      OverconstrainedError: 'The camera could not provide a usable picture.',
    }[err.name];
    throw new Error((why || 'Could not open the camera (' + err.name + ').') + ' You can also run without one.');
  }
  // Android Chrome and iOS Safari can leave a camera video that is not in the
  // page at zero frames; the attributes keep iOS from going fullscreen.
  // Invisible, but not display:none, which pauses it.
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.playsInline = true;
    video.muted = true;
    video.className = 'feed';
    document.body.appendChild(video);
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    console.warn('video.play() was refused; waiting for frames anyway.', err);
  }
  const live = await waitFor(() => video.readyState >= 2 && video.videoWidth > 0, 8000);
  if (!live) {
    stopCamera();
    throw new Error('The camera opened but sent no picture. Tap Start camera to try again.');
  }
}

function stopCamera() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

let restarting = false;
async function restartCamera() {
  if (restarting) return;
  restarting = true;
  toast('Restarting the camera…');
  stopCamera();
  try {
    await openCamera();
    toast(null);
  } catch (err) {
    toast(err.message, restartCamera);
  } finally {
    restarting = false;
  }
}

let cpuTried = false;
async function switchToCpu() {
  if (cpuTried) return;
  cpuTried = true;
  try {
    await segmenter.useCpu();
    cameraSince = performance.now();
  } catch (err) {
    console.error(err);
    toast('Body detection could not restart on the CPU.');
  }
}

function waitFor(test, ms) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const poll = () => {
      if (test()) resolve(true);
      else if (performance.now() - t0 > ms) resolve(false);
      else setTimeout(poll, 50);
    };
    poll();
  });
}

// ---------------------------------------------------------------- toast

// A notice over the water, for problems worth knowing about while the panel is
// tucked away (it always is, at first, on a phone). Tapping it runs `action`.
const toastEl = el('toast');
let toastAction = null;
function toast(msg, action = null) {
  toastEl.hidden = !msg;
  if (msg) toastEl.textContent = msg;
  toastAction = action;
  toastEl.classList.toggle('actionable', !!action);
}
toastEl.addEventListener('click', () => {
  if (toastAction) toastAction();
});

// Camera health, checked every frame, so trouble shows as a notice instead of
// black water. A live stream's clock runs on without new frames, so watch the
// track itself: "ended" when the camera is gone, "muted" when it cannot
// deliver (screen locked, another app took it).
let cameraSince = 0, cameraWarned = false;
function watchCamera(now) {
  if (!stream) return; // restarting: the restart reports for itself
  const track = stream.getVideoTracks()[0];
  let msg = null, action = null;
  if (!track || track.readyState === 'ended') {
    msg = 'The camera was switched off. Tap here to turn it back on.';
    action = restartCamera;
  } else if (track.muted || !video.videoWidth) {
    msg = 'The camera stopped sending pictures. Tap here to restart it.';
    action = restartCamera;
  } else if (segmenter.generation === 0 && now - cameraSince > 8000) {
    msg = 'Body detection has not started. This device may be too slow for it.';
  } else if (TOUCH && !cpuTried && !segmenter.varied && segmenter.delegate === 'GPU' && segmenter.generation > 150) {
    // Five-odd seconds of masks with nobody in them, on a phone's GPU: on some
    // phones that path runs but returns blanks. Try the CPU once. (Not on a
    // laptop, where an empty room at start is the likelier story.)
    switchToCpu();
    msg = 'Switching body detection to the CPU…';
  } else if (!segmenter.varied && now - cameraSince > 6000) {
    msg = 'Body detection does not see anyone yet. Step back so your head and shoulders are in view.';
  }
  if (msg) {
    if (toastEl.textContent !== msg || toastEl.hidden) toast(msg, action);
    cameraWarned = true;
  } else if (cameraWarned) {
    toast(null);
    cameraWarned = false;
  }
}

function startDemo() {
  if (source) return;
  startAudio();
  source = 'demo';
  demo = new DemoMask();
  demo.resize(viewW / viewH);
  begin();
}

function begin() {
  boot.hidden = true;
  cameraSince = performance.now();
  // On a phone the panel would cover half the water; it starts tucked away.
  setPanel(!TOUCH);
  panelBtn.hidden = !TOUCH;
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
// Which label is the person? The model's numbering has differed between
// releases and devices, and how much of the frame a person fills says little
// (a phone selfie can be half face). The top corners of a selfie frame,
// though, are background almost always: whichever label fills them is the
// background. Decided once, over the first masks that actually contain
// someone, unless the invert box has been touched by hand.
function autoCalibrate() {
  if (calibrated || segmenter.uniform) return;
  calibSum += segmenter.cornerOn;
  calibN++;
  if (calibN < 30) return;
  calibrated = true;
  const invert = calibSum / calibN > 0.5; // the non-zero label is in the corners: it is the background
  if (invert !== ui.invert.checked) {
    ui.invert.checked = invert;
    note('Body and water were swapped — fixed that for you.');
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

// Frames the camera picture on the grid. "Fill" covers the screen, cutting
// off what does not fit (on a tall phone, the sides of a 3:4 picture); "whole"
// shows all of it, with water-only margins where the picture does not reach.
function camXform(srcW, srcH) {
  const r = (srcW / srcH) / (simW / simH); // > 1: picture wider than the screen
  const fill = ui.framing.value !== 'whole';
  let sx, sy;                               // share of the picture spanned by the screen
  if (r >= 1) {
    sx = fill ? 1 / r : 1;
    sy = sx * r;
  } else {
    sy = fill ? r : 1;
    sx = sy / r;
  }
  return [sx, sy, (1 - sx) / 2, (1 - sy) / 2];
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
    // Invert corrects the segmenter's label order; the demo figure needs none.
    .i('uInvert', source === 'camera' && ui.invert.checked ? 1 : 0)
    .i('uEmpty', source === 'camera' && segmenter.generation > 0 && segmenter.uniform ? 1 : 0)
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

function runTrailPass(videoTex, xform) {
  bindTarget(gl, trail.write);
  progTrail.use()
    .tex('uPrev', trail.read.tex)
    .tex('uSim', sim.read.tex)
    .tex('uMask', mask.read.tex)
    .tex('uVideo', videoTex)
    .v2('uTexel', 1 / simW, 1 / simH)
    .f('uRelief', +ui.relief.value)
    .f('uDeform', +ui.deform.value)
    .f('uTurn', +ui.cycle.value * 0.04)
    .f('uFresh', trailFresh ? 1 : 0)
    .i('uMirror', ui.mirror.checked ? 1 : 0)
    .v4('uCamXform', xform);
  quad.draw();
  trail.swap();
  trailFresh = false;
}

function runGratePass() {
  bindTarget(gl, grate);
  progGrate.use()
    .tex('uSim', sim.read.tex)
    .v2('uTexel', 1 / simW, 1 / simH);
  quad.draw();
}

const SKIES = { sunset: 0, aurora: 1, neon: 2, midday: 3 };

function runRenderPass(videoTex, xform, now) {
  const p = PALETTES[ui.palette.value] || PALETTES['Sunlit blue'];
  bindTarget(gl, null, viewW, viewH);
  progRender.use()
    .tex('uSim', sim.read.tex)
    .tex('uMask', mask.read.tex)
    .tex('uVideo', videoTex)
    .tex('uTrail', trail.read.tex)
    .tex('uGrate', grate.tex)
    .f('uGrating', +ui.grating.value)
    .f('uLightAz', +ui.lightaz.value * Math.PI / 180)
    .i('uSky', SKIES[ui.sky.value] ?? 0)
    .f('uSunH', +ui.sunh.value)
    .f('uFx', +ui.fx.value)
    .f('uDepth', +ui.depth.value)
    .f('uCaustics', +ui.causticamt.value)
    .v2('uTexel', 1 / simW, 1 / simH)
    .f('uRelief', +ui.relief.value)
    .f('uRefract', +ui.refract.value)
    .f('uDeform', +ui.deform.value)
    .f('uTime', (now / 1000) % 1000)
    .f('uCycle', +ui.cycle.value)
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

function runReducePass() {
  bindTarget(gl, statsTarget);
  progReduce.use()
    .tex('uSim', sim.read.tex)
    .tex('uMask', mask.read.tex)
    .v2('uZones', ZONES_X, ZONES_Y)
    .v2('uTexel', 1 / simW, 1 / simH)
    .f('uVelScale', VEL_SCALE);
  quad.draw();
}

// ---------------------------------------------------------------- sound

function startAudio() {
  if (!ui.sound.checked) return;
  for (const k of ['volume', 'melody', 'voices', 'clarity', 'slush', 'water']) audio.set(k, +ui[k].value);
  audio.setScale(ui.scale.value);
  audio.setPitch(ui.pitch.value);
  audio.start();
}

// ---------------------------------------------------------------- loop

function frame(now) {
  requestAnimationFrame(frame);
  step(now);
}

function step(now) {
  if (!source) return;

  const t = now / 1000;
  let rawTex, videoTex, xform;

  if (lastFrame) frameDt += (Math.min(0.1, (now - lastFrame) / 1000) - frameDt) * 0.1;
  lastFrame = now;

  // Zone stats requested on an earlier frame; the GPU is usually done by now.
  if (readback.poll() && audio.running) {
    audio.update(readback.out, {
      velScale: VEL_SCALE,
      stepsPerSecond: SUBSTEPS / frameDt,
      fps: 1 / frameDt,
      shortCells: Math.min(simW, simH),
      touching: ui.obstacle.checked || ui.ripples.checked,
    });
  }

  if (source === 'camera') {
    watchCamera(now);
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
    drops.push({ x: Math.random(), y: Math.random(), amp: 0.05 + 0.2 * rain, r: dropRadius(0.006, 2.5) });
  }

  runMaskPass(rawTex, xform);
  if (drops.length) runSplatPass();
  for (let i = 0; i < SUBSTEPS; i++) runSimPass(i);
  const look = +ui.look.value;
  if (look === 5) runTrailPass(videoTex, xform);
  else trailFresh = true; // start clean next time the look is picked
  if (look === 8) runGratePass();
  runRenderPass(videoTex, xform, now);
  if (audio.running && !readback.pending) {
    runReducePass();
    readback.request(statsTarget);
  }

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
    const cov = segmenter.uniform ? 0 : ui.invert.checked ? 1 - segmenter.coverage : segmenter.coverage;
    bits.push('body ' + Math.round(cov * 100) + '%');
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
  'relief', 'refract', 'rain', 'mirror', 'invert', 'soft', 'ease', 'showmask',
  'sound', 'volume', 'melody', 'voices', 'clarity', 'slush', 'water', 'pitch', 'scale', 'detail', 'framing',
  'deform', 'cycle', 'grating', 'fx', 'lightaz', 'sky', 'sunh', 'depth', 'causticamt']) {
  ui[id] = el(id);
}

for (const name of Object.keys(PALETTES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  ui.palette.appendChild(opt);
}

for (const name of Object.keys(SCALES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  ui.scale.appendChild(opt);
}

ui.sound.addEventListener('change', () => {
  if (ui.sound.checked) startAudio();
  else audio.setEnabled(false);
});
for (const k of ['volume', 'melody', 'voices', 'clarity', 'slush', 'water']) {
  ui[k].addEventListener('input', () => audio.set(k, +ui[k].value));
}
ui.scale.addEventListener('change', () => audio.setScale(ui.scale.value));
ui.pitch.addEventListener('change', () => {
  audio.setPitch(ui.pitch.value);
  ui.scale.disabled = ui.pitch.value === 'glide'; // a free glide has no scale
});

// The frame loop stops in a hidden tab; stop the sound with it rather than
// leave the last chord hanging.
document.addEventListener('visibilitychange', () => {
  if (!audio.ctx) return;
  audio.setEnabled(!document.hidden && ui.sound.checked);
});

// Each look shows only the sliders that do something in it: a control row
// with data-looks="2 3 4" appears for those looks and hides for the rest.
function showLookControls() {
  const look = ui.look.value;
  for (const row of panel.querySelectorAll('[data-looks]')) {
    row.hidden = !row.dataset.looks.split(' ').includes(look);
  }
}
ui.look.addEventListener('change', showLookControls);
showLookControls();

ui.showmask.addEventListener('change', () => {
  maskview.hidden = !ui.showmask.checked;
});
ui.invert.addEventListener('change', () => {
  calibrated = true; // the operator has an opinion; stop second-guessing it
  if (source === 'camera' && ui.showmask.checked) drawMaskPreview();
});

// Not once-only: after a refused permission or a camera that sent nothing,
// a second tap tries again.
el('btn-start').addEventListener('click', startCamera);
el('btn-demo').addEventListener('click', startDemo);
el('btn-calm').addEventListener('click', () => sim.clear());
// A new grid size means new buffers (and still water): on release, not per tick.
ui.detail.addEventListener('change', () => {
  simW = simH = 0;
  resize();
});
panelBtn.addEventListener('click', () => setPanel(panel.hidden));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, button')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') setPanel(panel.hidden);
  else if (k === 'm') {
    ui.sound.checked = !ui.sound.checked;
    ui.sound.dispatchEvent(new Event('change'));
  }
  else if (k === 'c') sim.clear();
  else if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});

// Drop sizes are fractions of the screen's short side, so a tap makes the
// same size of ripple on a tall phone as on a wide laptop. (The splat shader
// measures in units of the screen's height.)
function shortSide() {
  return Math.min(1, simW / simH);
}

// Drop radius, in the splat shader's units (screen heights): a share of the
// screen's short side, but never under a few grid cells. A drop narrower than
// that is mostly grid-scale detail and rings as fizz instead of a ripple.
function dropRadius(share, minCells) {
  return Math.max(share * shortSide(), minCells / simH);
}

function dropAt(e, amp) {
  const r = canvas.getBoundingClientRect();
  drops.push({
    x: (e.clientX - r.left) / r.width,
    y: 1 - (e.clientY - r.top) / r.height,
    amp,
    r: dropRadius(0.02, 4),
  });
  pointer.x = e.clientX;
  pointer.y = e.clientY;
}
canvas.addEventListener('pointerdown', (e) => {
  pointer.down = true;
  dropAt(e, 0.9);
});
// Dragging leaves a trail of drops spaced by distance, not time: a finger
// always wobbles a little, and a drop every few milliseconds of wobble turned
// one tap into a cluster of tiny ripples.
canvas.addEventListener('pointermove', (e) => {
  if (!pointer.down) return;
  const r = canvas.getBoundingClientRect();
  const step = 0.04 * Math.min(r.width, r.height);
  if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < step) return;
  dropAt(e, 0.35);
});
window.addEventListener('pointerup', () => { pointer.down = false; });

// ---------------------------------------------------------------- go

try {
  initGL();
  // Console handle for poking at the simulation: __water.read('mask', x, y, w)
  window.__water = {
    get gl() { return gl; }, get sim() { return sim; }, get mask() { return mask; },
    get audio() { return audio; }, get stats() { return readback.out; }, get drops() { return drops; },
    get segmenter() { return segmenter; },
    get demo() { return demo; }, // swap demo.update to drive a test silhouette
    // Advance one frame by hand at a chosen timestamp (ms), e.g. to measure the
    // pool at a steady 60 fps in a throttled background tab.
    step,
    // Zone stats right now, read synchronously.
    zoneStats() {
      runReducePass();
      const out = new Float32Array(ZONES_X * ZONES_Y * 2 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, statsTarget.fbo);
      gl.readPixels(0, 0, ZONES_X, ZONES_Y * 2, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    },
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

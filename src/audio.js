// The sound of the pool. Everything is one water sound and what is done to it:
//
//   Water       brown noise, a low wash, swelling with the energy of the whole
//               pool and lapping on two slow undulations.
//   Slush       on the water's peaks the same wash surges and opens up.
//   Resonators  the same water sound again, through narrow band-pass filters:
//               the water itself made to sing. They are steered by the pool's
//               ripple spectrum — how much wave energy is moving at each
//               ripple speed, smoothed over about a second — lifted into
//               hearing range, so long slow swells sound low and quick fine
//               ripples high. The strongest two or three bands sing, each from
//               the side of the pool where its ripples are; they change only as
//               the character of the water changes. Snapped to a scale, or
//               gliding to follow the spectrum's peaks freely. The body, a hole
//               in the water, contributes nothing where it covers.
//               Or, following movement speed: the body's own movement is fed
//               to the resonators, so they sing while it moves, and how fast it
//               moves picks the note, slow low and quick high.
//
// Because the resonators filter the water rather than a source of their own,
// they breathe with it: silent when the pool is still, loudest when it surges.
// Nothing is modulated at random per frame and parameters move through
// smoothed ramps: per-frame jitter on gains and filters crackles.

export const SCALES = {
  'Major pentatonic': [0, 2, 4, 7, 9],
  'Minor pentatonic': [0, 3, 5, 7, 10],
  'Hirajoshi': [0, 2, 3, 7, 8],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Lydian': [0, 2, 4, 6, 7, 9, 11],
};

// Ripple frequency (Hz, measured in the pool) onto pitch: HZ_LO..HZ_HI maps
// logarithmically onto SEMIS semitones up from PITCH_LO. Measured at the
// default wave settings, ripples in active zones run ~0.65-4.2 Hz (5th-95th
// percentile), median ~2.5. Scales are rooted on A.
const HZ_LO = 0.7;
const HZ_HI = 4.5;
// Movement speed onto pitch, for the "movement speed" mode. Speed is how fast
// the body's contour moves, in lengths of the screen's short side per second,
// weighted towards the parts that move most (see REDUCE_FRAG); SPEED_LO..
// SPEED_HI maps it logarithmically onto the three octaves: each doubling of
// speed is an octave up, so an ordinary change of pace is a clear change of
// note. Measured with a shape moving at known speeds, the reading is ~0.8x
// the true speed (a contour's sides slide along themselves) and, at the
// default mask easing, tops out near 0.7 once movement passes ~1 screen per
// second. A body standing still reads ~0.01-0.06 where the segmenter's edge
// flickers by a pixel or two; under SPEED_LO that is faded out.
const SPEED_LO = 0.08;
const SPEED_HI = 0.65;
// How much of the body moves, as the share of the screen its contour sweeps
// per second: MOVE_LO is the least that sings, MOVE_HI full voice. The bottom
// also follows the quietest sweep of the last few seconds (the flicker of a
// still body), so a body at rest falls silent wherever the segmenter's noise
// lies.
const MOVE_LO = 0.004;
const MOVE_HI = 0.06;
const MOVE_GAIN = 1.0;   // the movement's feed into the resonators at full voice
// Following movement, the chord stacked on the speed's note by Voices: each
// added voice is every other scale note further up, at this share of the lead.
const CHORD = [1, 0.7, 0.55, 0.45];
const PITCH_LO = 110;    // A2: the demo's ripples then sing around A4-E5
const SEMIS = 36;
const PC_LO = 0;         // pitch class of the bottom band, counted up from A

// Activity is RMS water velocity per substep in a zone. Measured on the demo
// figure at 60 fps on the 16x8 grid: busiest zone ~0.002-0.0056.
const MIN_REF = 0.0012;  // floor for the gain reference, so a calm pool stays silent
const MAX_REF = 0.009;   // ceiling, so one violent moment cannot deafen the pool for long

const NOTE_RMS = 0.3;    // a resonator at full strength, when the water is fully excited
const GLIDERS = 4;       // resonators available to the glide mode
// Leaky-integrator brown noise rolls off like 1/f^2 above this corner (Hz);
// it sets how much each band-pass must lift its slice of the water.
const BROWN_CORNER = 15.3;

export class WaterAudio {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.ctx = null;
    this.scale = Object.keys(SCALES)[0];
    this.snap = true;      // pitches on the scale, or gliding freely
    this.bySpeed = false;  // pitch from how fast the body moves, not from ripple size
    this.mode = null;
    this.ref = MIN_REF * 2;
    const n = cols * rows;
    this.fast = new Float32Array(n);
    this.slow = new Float32Array(n);
    this.spec = new Float32Array(SEMIS);   // smoothed ripple energy per semitone band
    this.specX = new Float32Array(SEMIS);  // ... and where it is, as energy-weighted column
    this.peak = 0;
    this.energy = 0;
    this.drive = 0;        // movement feeding the resonators (speed mode), 0..1
    this.floor = MOVE_LO;  // the sweep of a body at rest: segmentation flicker
    this.moveU = 0.3;      // the movement's place in the three octaves, 0..1
    this.moveCol = (cols - 1) / 2;
    this.move = { speed: 0, sweep: 0 }; // last measurement, for the console
    this.bank = [];      // one resonator per semitone, used snapped
    this.gliders = [];   // free resonators, used gliding
    this.active = new Set();
    this.sent = { excite: -1, cut: -1, pan: 2 };
    this.lastUpdate = 0;
    this.settings = { volume: 0.7, melody: 0.16, voices: 3, clarity: 150, slush: 0.22, water: 0.45 };
    // For checking the engine from the console without listening to it.
    this.sounding = [];
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Must be called from a click or key handler: browsers only allow sound
  // after a gesture.
  start() {
    if (!this.ctx) this.#build();
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  setEnabled(on) {
    if (!this.ctx) return;
    if (on) this.ctx.resume();
    else this.ctx.suspend();
  }

  set(name, value) {
    this.settings[name] = value;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (name === 'volume') this.master.gain.setTargetAtTime(value, t, 0.05);
    if (name === 'melody') this.melodyBus.gain.setTargetAtTime(value, t, 0.05);
    if (name === 'water') this.waterBus.gain.setTargetAtTime(value, t, 0.05);
    if (name === 'clarity') {
      for (const r of [...this.bank, ...this.gliders]) {
        r.bp.Q.setTargetAtTime(value, t, 0.1);
        r.mk.gain.setTargetAtTime(this.#makeup(r.f), t, 0.1);
      }
    }
  }

  setScale(name) {
    if (SCALES[name]) this.scale = name;
  }

  // 'snap': ripple size, on the scale. 'glide': ripple size, sliding freely.
  // 'speed': how fast the body moves, on the scale.
  setPitch(mode) {
    this.snap = mode !== 'glide';
    this.bySpeed = mode === 'speed';
  }

  // stats: Float32Array, 4 floats per zone, rows bottom to top: the water band,
  // then the movement band (see REDUCE_FRAG).
  // o.velScale: the reduce shader's velocity scale. o.stepsPerSecond: water
  // steps per second. o.fps: frames per second. o.shortCells: grid cells across
  // the screen's short side. o.touching: whether the body acts on the water.
  update(stats, o) {
    if (!this.running) return;
    const { velScale, stepsPerSecond, fps, shortCells, touching = true } = o;
    const now = this.ctx.currentTime;
    const dt = Math.min(0.1, Math.max(0.001, now - this.lastUpdate || 0.016));
    this.lastUpdate = now;
    const n = this.cols * this.rows;

    // Per-zone activity and ripple frequency. For a ripple of angular
    // frequency w, RMS velocity / RMS height = w * dt per substep.
    const act = new Float32Array(n);
    const hz = new Float32Array(n);
    let peakAct = 0, total = 0, cx = 0;
    for (let z = 0; z < n; z++) {
      const v2 = stats[z * 4] / (velScale * velScale);
      const h2 = stats[z * 4 + 1];
      act[z] = Math.sqrt(Math.max(0, v2));
      hz[z] = h2 > 1e-6 ? (Math.sqrt(v2 / h2) * stepsPerSecond) / (2 * Math.PI) : 0;
      peakAct = Math.max(peakAct, act[z]);
      total += act[z];
      cx += act[z] * (z % this.cols);
    }

    // Automatic gain, following the busiest zone: rises over half a second,
    // relaxes over a few, between a floor (calm water is silent) and a ceiling
    // (the jolt of a body appearing does not deafen the pool for long).
    const goal = Math.min(MAX_REF, Math.max(MIN_REF, peakAct));
    this.ref += (goal - this.ref) * (1 - Math.exp(-dt / (goal > this.ref ? 0.5 : 2.5)));

    // Zones: peaks (activity jumping above its own recent average) and the
    // ripple spectrum (energy binned by ripple speed, as pitch).
    const kFast = 1 - Math.exp(-dt / 0.06);
    const kSlow = 1 - Math.exp(-dt / 0.7);
    const bins = new Float32Array(SEMIS);
    const binsX = new Float32Array(SEMIS);
    let surge = 0;
    for (let z = 0; z < n; z++) {
      const cover = Math.min(1, stats[z * 4 + 2] * 1.4);
      const a = Math.min(1.5, act[z] / this.ref) * (1 - cover);
      this.fast[z] += (a - this.fast[z]) * kFast;
      this.slow[z] += (a - this.slow[z]) * kSlow;
      surge += Math.max(0, this.fast[z] - this.slow[z] - 0.03);
      if (touching) surge += Math.min(1, Math.max(0, stats[z * 4 + 3] - 0.012) / 0.012) * 0.12;

      if (this.bySpeed) continue;

      // Where in the three octaves this zone's ripple energy goes, and how much.
      if (a < 0.05 || hz[z] <= 0) continue;
      const u = rippleU(hz[z]), w = a * a;
      const s = Math.min(SEMIS - 1, u * (SEMIS - 1));
      const lo = Math.floor(s), f = s - lo, col = z % this.cols;
      bins[lo] += w * (1 - f);
      binsX[lo] += w * (1 - f) * col;
      if (lo + 1 < SEMIS) {
        bins[lo + 1] += w * f;
        binsX[lo + 1] += w * f * col;
      }
    }
    if (this.bySpeed) {
      this.#followMovement(stats, n, fps, shortCells, dt);
    } else {
      // Rise over ~0.2 s, fall over ~0.9 s: the spectrum follows the water's
      // character, not every passing crest.
      const up = 1 - Math.exp(-dt / 0.2);
      const down = 1 - Math.exp(-dt / 0.9);
      for (let b = 0; b < SEMIS; b++) {
        const k = bins[b] > this.spec[b] ? up : down;
        this.spec[b] += (bins[b] - this.spec[b]) * k;
        this.specX[b] += (binsX[b] - this.specX[b]) * k;
      }
      if (this.drive) {
        this.drive = 0;
        this.moveIn.gain.setTargetAtTime(0, now, 0.1);
      }
    }

    // Peaks: waves arriving anywhere (measured drive ~0.08 / 0.65 / 1.8 at the
    // 10th / 50th / 90th percentile with the demo figure), plus sudden shoves.
    const peakGoal = Math.min(1, surge / 2);
    this.peak += (peakGoal - this.peak) * (1 - Math.exp(-dt / (peakGoal > this.peak ? 0.05 : 0.35)));

    // The water: one excitation feeds both the wash you hear and the
    // resonators, so they rise and fall together.
    const e = Math.min(1.2, (total / n / this.ref) * 2.2);
    this.energy += (e - this.energy) * (1 - Math.exp(-dt / 0.3));
    const slush = this.settings.slush;
    const excite = Math.min(1.2, this.energy * this.energy * 0.5 + this.peak * slush * 0.9);
    const cut = 150 + 250 * Math.min(1, this.energy) + 900 * this.peak * slush;
    const pan = total > 0 ? colPanF(cx / total, this.cols) * 0.8 : 0;
    if (Math.abs(excite - this.sent.excite) > 0.005) {
      this.excite.gain.setTargetAtTime(excite, now, 0.08);
      this.sent.excite = excite;
    }
    if (Math.abs(cut - this.sent.cut) > this.sent.cut * 0.04) {
      this.waterLp.frequency.setTargetAtTime(cut, now, 0.1);
      this.sent.cut = cut;
    }
    if (Math.abs(pan - this.sent.pan) > 0.05) {
      this.waterPan.pan.setTargetAtTime(pan, now, 0.6);
      this.sent.pan = pan;
    }

    // Resonators.
    const mode = this.snap ? 'snap' : 'glide';
    if (mode !== this.mode) {
      for (const r of mode === 'snap' ? this.gliders : this.bank) this.#steer(r, 0, r.pan, now);
      this.active.clear();
      this.mode = mode;
    }
    if (this.snap) this.#steerBank(now);
    else this.#steerGliders(now);
  }

  // A meter for checking the engine without listening to it.
  rms() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (const x of buf) s += x * x;
    return Math.sqrt(s / buf.length);
  }

  // ------------------------------------------------------------- internals

  // Movement speed: one pitch for the whole body, from how fast its contour
  // moves, weighted towards the parts that move most. (Zones voting their own
  // speeds barely moved the chord: a moving body always has slow parts and
  // fast parts at once.) The movement itself feeds the resonators, so the note
  // sounds while the body moves, as loud as the movement is large, and falls
  // silent when it stops; the note nearest that pitch sings loudest, from the
  // side where the movement is.
  #followMovement(stats, n, fps, shortCells, dt) {
    let dm = 0, dm2 = 0, x = 0;
    for (let z = 0; z < n; z++) {
      const k = (n + z) * 4;
      dm += stats[k];
      dm2 += stats[k + 1] / 100;
      x += stats[k] * (z % this.cols);
    }
    const speed = dm > 1e-7 ? ((dm2 / dm) * fps) / shortCells : 0;
    const sweep = (dm / n) * fps;
    this.move = { speed, sweep, floor: this.floor };

    // A contour that merely flickers is slow, and sweeps no more than it did
    // a moment ago at rest: both gated out. Real movement keeps pausing and
    // turning, so the floor (the quietest recent sweep) stays below it.
    this.floor += (sweep - this.floor) * (1 - Math.exp(-dt / (sweep < this.floor ? 0.3 : 6)));
    const lo = Math.max(MOVE_LO, Math.min(this.floor * 1.6, MOVE_HI * 0.4));
    const gate = smooth01((speed - SPEED_LO * 0.5) / (SPEED_LO * 0.5));
    const over = Math.log(Math.max(sweep, 1e-9) / lo);
    // Even a small movement sings clearly; a large one sings full.
    const amount = gate * smooth01(over / Math.LN2) * (0.4 + 0.6 * clamp01(over / Math.log(MOVE_HI / lo)));
    this.drive += (amount - this.drive) * (1 - Math.exp(-dt / (amount > this.drive ? 0.05 : 0.3)));
    if (amount > 0.05) {
      const u = clamp01(Math.log(speed / SPEED_LO) / Math.log(SPEED_HI / SPEED_LO));
      const k = 1 - Math.exp(-dt / 0.1);
      this.moveU += (u - this.moveU) * k;
      this.moveCol += (x / dm - this.moveCol) * k;
    }
    // Held while the movement fades, so a gesture's note rings out rather
    // than sliding down to the bottom as it stops.
    const centre = this.moveU * (SEMIS - 1);
    for (let b = 0; b < SEMIS; b++) {
      const d = b - centre;
      this.spec[b] = this.drive * Math.exp(-(d * d) / 2);
      this.specX[b] = this.spec[b] * this.moveCol;
    }
    this.moveIn.gain.setTargetAtTime(this.drive * MOVE_GAIN, this.ctx.currentTime, 0.04);
  }

  // Snapped: each note of the scale gathers the ripple energy within a whole
  // tone of it; the strongest few sing. A note already singing keeps its place
  // until a rival is clearly stronger, so the chord does not flicker.
  #steerBank(now) {
    const steps = SCALES[this.scale];
    const want = Math.round(this.settings.voices);
    const cand = [];
    for (let i = 0; i < SEMIS; i++) {
      if (!steps.includes((PC_LO + i) % 12)) continue;
      let e = 0, x = 0;
      for (let b = Math.max(0, i - 2); b <= Math.min(SEMIS - 1, i + 2); b++) {
        const w = Math.max(0, 1 - Math.abs(b - i) / 2);
        e += this.spec[b] * w;
        x += this.specX[b] * w;
      }
      cand.push({ i, e, x });
    }
    let top = 0;
    for (const c of cand) top = Math.max(top, c.e);
    // Following movement, the spectrum is the movement itself, so its size is
    // the notes' loudness: without this, the last note of a gesture would go
    // on singing from the water after the body has stopped.
    const norm = this.bySpeed ? Math.max(top, 0.5) : top;
    // Notes already singing rank as if 1.4x stronger: a rival must clearly win.
    const ranked = cand
      .filter((c) => c.e > top * 0.05)
      .sort((a, b) => b.e * (this.active.has(b.i) ? 1.4 : 1) - a.e * (this.active.has(a.i) ? 1.4 : 1));

    // Which notes sing, how loud, and from where (the zone mix they pan by).
    const voices = new Map();
    if (this.bySpeed) {
      // Following movement there is one note, the speed's, and Voices stacks
      // a chord on it from the scale: every other scale note above it, each
      // quieter. (Ranked by strength like the water's notes, the extra voices
      // were only the lead's faint neighbours, too quiet to hear.)
      const lead = ranked[0];
      if (lead) {
        const r = cand.indexOf(lead);
        const level = Math.pow(lead.e / norm, 1.2);
        for (let k = 0; k < want; k++) {
          let j = r + 2 * k;
          if (j >= cand.length) j = r - 2 * k; // past the top: below the lead instead
          if (j >= 0) voices.set(cand[j].i, { level: level * CHORD[k], from: lead });
        }
      }
      this.active = new Set(lead ? [lead.i] : []);
    } else {
      for (const c of ranked.slice(0, want)) voices.set(c.i, { level: Math.pow(c.e / norm, 0.7), from: c });
      this.active = new Set(voices.keys());
    }

    const quiet = top < 1e-4;
    this.sounding = [];
    for (const c of cand) {
      const v = quiet ? undefined : voices.get(c.i);
      const from = v ? v.from : c;
      const pan = from.e > 0 ? colPanF(from.x / from.e, this.cols) * 0.85 : 0;
      this.#steer(this.bank[c.i], v ? v.level : 0, pan, now);
      if (v) this.sounding.push(noteName(this.bank[c.i].f) + ' ' + v.level.toFixed(2));
    }
    // Off-scale bands stay silent (a scale change lets them ring out).
    for (let i = 0; i < SEMIS; i++) if (!steps.includes((PC_LO + i) % 12)) this.#steer(this.bank[i], 0, this.bank[i].pan, now);
  }

  // Gliding: free resonators sit on the spectrum's peaks, between semitones
  // where the peak is, and slide as the peaks move.
  #steerGliders(now) {
    const want = Math.min(GLIDERS, Math.round(this.settings.voices));
    const s = this.spec;
    let top = 0;
    for (const v of s) top = Math.max(top, v);
    const peaks = [];
    for (let b = 0; b < SEMIS; b++) {
      const l = b > 0 ? s[b - 1] : 0, r = b < SEMIS - 1 ? s[b + 1] : 0;
      if (s[b] <= l || s[b] < r || s[b] < top * 0.08) continue;
      const den = l - 2 * s[b] + r;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
      const x = this.specX[b] / Math.max(1e-9, s[b]);
      peaks.push({ pos: b + off, e: s[b], pan: colPanF(x, this.cols) * 0.85 });
    }
    peaks.sort((a, b) => b.e - a.e);
    peaks.length = Math.min(peaks.length, want);

    // Each peak keeps the glider nearest it, so a tone slides rather than jumps.
    const free = new Set(this.gliders);
    const plan = new Map();
    for (const p of peaks) {
      const f = PITCH_LO * Math.pow(2, p.pos / 12);
      let best = null, bestD = 5;
      for (const g of free) {
        if (g.level <= 0.01) continue;
        const d = Math.abs(semis(g.f / f));
        if (d < bestD) { bestD = d; best = g; }
      }
      if (!best) best = [...free].find((g) => g.level <= 0.01) || [...free][0];
      if (!best) break;
      free.delete(best);
      plan.set(best, { f, p });
    }
    this.sounding = [];
    for (const g of this.gliders) {
      const job = plan.get(g);
      if (!job || top < 1e-4) {
        this.#steer(g, 0, g.pan, now);
        continue;
      }
      if (Math.abs(job.f - g.f) / g.f > 0.003) {
        // A glider coming in from silence jumps straight to its pitch.
        if (g.level <= 0.01) g.bp.frequency.setValueAtTime(job.f, now);
        else g.bp.frequency.setTargetAtTime(job.f, now, 0.25);
        g.mk.gain.setTargetAtTime(this.#makeup(job.f), now, 0.25);
        g.f = job.f;
      }
      const level = Math.pow(job.p.e / top, 0.7);
      this.#steer(g, level, job.p.pan, now);
      this.sounding.push(noteName(g.f) + ' ' + level.toFixed(2));
    }
  }

  // Ease a resonator towards a level and a place: in over ~0.15 s, out over
  // ~0.7 s, so voices come and go like swells rather than switches.
  #steer(r, level, pan, now) {
    if (Math.abs(level - r.level) > 0.01) {
      r.vg.gain.setTargetAtTime(level, now, level > r.level ? 0.15 : 0.7);
      r.level = level;
    }
    if (Math.abs(pan - r.pan) > 0.05) {
      r.p.pan.setTargetAtTime(pan, now, 0.5);
      r.pan = pan;
    }
  }

  // Lift that brings a band-pass slice of the brown water noise up to
  // NOTE_RMS. Brown noise of power P and corner fc has density
  // (2 fc P / pi) / f^2 near f; a two-pole band-pass passes (pi / 2) f / Q Hz
  // of it, so the slice carries P fc / (f Q).
  #makeup(f) {
    const slice = this.brownRms * Math.sqrt(BROWN_CORNER / (f * this.settings.clarity));
    return NOTE_RMS / slice;
  }

  #resonator(f) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = this.settings.clarity;
    const r = { f, bp, mk: gainNode(ctx, 0), vg: gainNode(ctx, 0), p: ctx.createStereoPanner(), level: 0, pan: 0 };
    r.mk.gain.value = this.#makeup(f);
    this.toResonators.connect(bp).connect(r.mk).connect(r.vg).connect(r.p).connect(this.melodyBus);
    return r;
  }

  #build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    // 'playback' asks for larger buffers: a little latency, which nobody can
    // hear against moving water, in exchange for no dropouts when the machine
    // is busy with the graphics.
    const ctx = (this.ctx = new AC({ latencyHint: 'playback' }));
    const s = this.settings;

    this.brown = brownNoise(ctx, 4);
    const d = this.brown.getChannelData(0);
    let p = 0;
    for (let i = 0; i < d.length; i++) p += d[i] * d[i];
    this.brownRms = Math.sqrt(p / d.length);

    // Output: everything meets in `mix`, then volume, then a gentle compressor.
    this.mix = ctx.createGain();
    this.master = gainNode(ctx, s.volume);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.3;
    this.mix.connect(this.master).connect(gainNode(ctx, 1.6)).connect(comp).connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.mix.connect(this.analyser);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 2.8, 0.75);
    this.reverb.connect(this.mix);

    this.melodyBus = gainNode(ctx, s.melody);
    this.melodyBus.connect(gainNode(ctx, 0.6)).connect(this.mix);
    this.melodyBus.connect(gainNode(ctx, 0.6)).connect(this.reverb);

    this.waterBus = gainNode(ctx, s.water);
    this.waterBus.connect(gainNode(ctx, 0.9)).connect(this.mix);
    this.waterBus.connect(gainNode(ctx, 0.2)).connect(this.reverb);

    // The water: brown noise, excited by the pool, lapping on two slow
    // undulations. `lap` is the shared point both the wash and the
    // resonators draw from.
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    src.start();
    this.excite = gainNode(ctx, 0);
    this.lap = gainNode(ctx, 1);
    for (const [rate, depth] of [[0.17, 0.25], [0.31, 0.15]]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      lfo.connect(gainNode(ctx, depth)).connect(this.lap.gain);
      lfo.start();
    }
    src.connect(this.excite).connect(this.lap);

    // The resonators hear the water through a high-pass: brown noise piles
    // up energy so fast towards the bass that a wide band-pass (low Clarity)
    // would otherwise pass mostly rumble from below its own pitch.
    this.toResonators = ctx.createBiquadFilter();
    this.toResonators.type = 'highpass';
    this.toResonators.frequency.value = 85;
    this.toResonators.Q.value = 0.7;
    this.lap.connect(this.toResonators);
    // Movement speed mode: the body's movement feeds the resonators directly.
    this.moveIn = gainNode(ctx, 0);
    src.connect(this.moveIn).connect(this.toResonators);

    this.waterLp = ctx.createBiquadFilter();
    this.waterLp.type = 'lowpass';
    this.waterLp.frequency.value = 200;
    this.waterLp.Q.value = 0.5;
    this.waterPan = ctx.createStereoPanner();
    this.lap.connect(this.waterLp).connect(gainNode(ctx, 0.5)).connect(this.waterPan).connect(this.waterBus);

    for (let i = 0; i < SEMIS; i++) this.bank.push(this.#resonator(PITCH_LO * Math.pow(2, i / 12)));
    for (let i = 0; i < GLIDERS; i++) this.gliders.push(this.#resonator(PITCH_LO * Math.pow(2, (i * 9 + 6) / 12)));

    this.lastUpdate = ctx.currentTime;
  }
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function rippleU(hz) {
  return Math.max(0, Math.min(1, Math.log(hz / HZ_LO) / Math.log(HZ_HI / HZ_LO)));
}

function semis(ratio) {
  return 12 * Math.log2(ratio);
}

function colPanF(col, cols) {
  return (col / (cols - 1)) * 2 - 1;
}

function gainNode(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

const NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
function noteName(f) {
  const s = Math.round(semis(f / 440));
  return NAMES[((s % 12) + 12) % 12] + (4 + Math.floor((s + 9) / 12));
}

// Brown noise: integrated white noise, so its energy falls 6 dB per octave
// and it rumbles where white noise hisses. Leaky, to stay centred.
function brownNoise(ctx, seconds) {
  const len = Math.round(ctx.sampleRate * seconds);
  const fade = Math.round(ctx.sampleRate * 0.25);
  const raw = new Float32Array(len + fade);
  let y = 0;
  for (let i = 0; i < raw.length; i++) {
    y = (y + 0.02 * (Math.random() * 2 - 1)) * 0.998;
    raw[i] = y;
  }
  // Seamless loop: the start is crossfaded from the stretch just past the end,
  // so the last sample flows straight into the first.
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    raw[i] = raw[i] * k + raw[len + i] * (1 - k);
  }
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(raw[i]));
  for (let i = 0; i < len; i++) d[i] = raw[i] / peak;
  return buf;
}

// A synthetic hall: decorrelated noise in each ear with an exponential tail,
// darkening as it decays the way real rooms do.
function impulse(ctx, seconds, decay) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const k = 0.1 + 0.6 * Math.exp(-t / 0.5); // low-pass coefficient closes over time
      lp += ((Math.random() * 2 - 1) - lp) * k;
      d[i] = lp * Math.exp(-t / decay) * (t < 0.015 ? t / 0.015 : 1);
    }
  }
  return buf;
}

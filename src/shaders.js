// GLSL ES 3.00 shaders for the water simulation.
//
// Three passes run on a fixed grid (the "sim space", v = 0 at the bottom):
//   MASK_FRAG   raw camera mask -> smoothed mask + signed per-frame change
//   SPLAT_FRAG  adds point impulses (clicks, rain) to the height field
//   SIM_FRAG    one step of the damped 2-D wave equation, with the silhouette
//               acting as a reflecting wall and/or a wave source
//   RENDER_FRAG shades the height field to the screen

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Maps sim-space uv onto the camera texture: optional mirror, vertical flip
// (textures from <video> and from the segmenter arrive top-row-first), then a
// centred cover-fit crop so the camera frame fills the grid without stretching.
const CAM_UV = `
uniform int uMirror;
uniform vec4 uCamXform; // xy = scale, zw = offset

vec2 camUv(vec2 uv) {
  if (uMirror == 1) uv.x = 1.0 - uv.x;
  uv.y = 1.0 - uv.y;
  return uv * uCamXform.xy + uCamXform.zw;
}

// 1 inside the camera picture, 0 in the margins around it (where the picture
// is narrower than the screen), with a soft edge between.
float inCam(vec2 c) {
  vec2 e = min(c, 1.0 - c);
  return smoothstep(0.0, 0.015, min(e.x, e.y));
}`;

export const MASK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uRaw;   // r = 1 where the segmenter found a person
uniform sampler2D uPrev;  // previous mask state
uniform vec2 uTexel;
uniform float uEase;      // temporal easing, 1 = no easing
uniform float uSoft;      // 0..1, how much the contour is smoothed each frame
uniform int uInvert;
uniform int uEmpty;       // the latest mask is all one label: nobody there
${CAM_UV}

float rawAt(vec2 uv) {
  // A mask that is one label from edge to edge has nobody in it, whichever
  // label that is. Without this, an empty room labelled all "0" and an
  // inverted mask would turn the whole screen into body and still the water.
  if (uEmpty == 1) return 0.0;
  vec2 c = camUv(uv);
  float m = texture(uRaw, c).r;
  if (uInvert == 1) m = 1.0 - m;
  return m * inCam(c); // nobody stands where the camera cannot see: water
}

void main() {
  // Taps exactly one cell apart. Spreading them wider to get a softer contour
  // would skip cells rather than average them, and neighbouring pixels landing
  // on different samples is precisely what stipples the edge.
  float m = 0.0, prevBlur = 0.0, wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      float w = (x == 0 && y == 0) ? 4.0 : ((x == 0 || y == 0) ? 2.0 : 1.0);
      m += rawAt(vUv + o) * w;
      prevBlur += texture(uPrev, vUv + o).r * w;
      wsum += w;
    }
  }
  m /= wsum;
  prevBlur /= wsum;

  // Softness is fed back through the mask state instead: a tight blur applied
  // every frame compounds into a wide, smooth one, while the easing keeps
  // pulling the state back towards the camera so the body never melts away.
  vec4 last = texture(uPrev, vUv);
  float prev = last.r;
  float base = mix(prev, prevBlur, clamp(uSoft, 0.0, 1.0));
  float eased = mix(base, m, uEase);
  // A second, calmer copy, for measuring how fast the body moves: a contour
  // that only flickers back and forth (segmentation noise) mostly cancels
  // out in it, while one that really moves keeps its speed.
  float calm = mix(last.b, eased, 0.25);
  outColor = vec4(eased, eased - prev, calm, calm - last.b);
}`;

export const SPLAT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSim;
uniform vec4 uDrops[16]; // xy = position, z = amplitude, w = radius
uniform int uDropCount;
uniform float uAspect;

void main() {
  vec4 s = texture(uSim, vUv);
  float add = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uDropCount) break;
    vec2 d = (vUv - uDrops[i].xy) * vec2(uAspect, 1.0);
    add += uDrops[i].z * exp(-dot(d, d) / max(uDrops[i].w * uDrops[i].w, 1e-6));
  }
  outColor = vec4(s.r + add, s.g, s.ba);
}`;

export const SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSim;   // r = height now, g = height one step ago
uniform sampler2D uMask;  // r = mask, g = per-frame change
uniform vec2 uTexel;
uniform float uC2;        // wave speed squared, stable below 0.5
uniform float uDamp;      // velocity retention
uniform float uPush;      // how hard a moving contour shoves the water
uniform int uObstacle;
uniform int uRipples;
uniform float uInject;    // share of this frame's impulse for one substep
uniform float uBlend;     // 0..1 through the camera frame

// The mask holds where the body is now (.r) and how far it moved this frame
// (.g). Walking the wall back along .g lets each substep see the body part way
// through its move, instead of the whole jump landing on one substep — a wall
// that teleports once per camera frame can only radiate at the grid scale.
float maskAt(vec2 uv) {
  vec2 m = texture(uMask, uv).rg;
  return m.r - m.g * (1.0 - uBlend);
}

// How open this cell is: 1 open water, 0 solid body. Graded rather than a
// hard test, because a wall that snaps between cells as the person moves rings
// at the grid scale.
float openAt(float m) {
  return uObstacle == 1 ? 1.0 - smoothstep(0.30, 0.70, m) : 1.0;
}

// Flux between this cell and one neighbour, for both heights at once
// (.x now, .y one step ago). The edge conducts by the product of both cells'
// openness, so A pulls on B exactly as hard as B pulls on A. That symmetry is
// what keeps the scheme stable: with a lopsided coupling the discrete
// Laplacian grows modes of its own, and they surface as a stippled rim of
// runaway checkerboard along the body. A closed edge carries no flux, which is
// a reflecting wall. The edge of the screen is open instead: see main().
vec2 fluxFrom(vec2 uv, float openC, vec2 c) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(0.0);
  return (texture(uSim, uv).rg - c) * openC * openAt(maskAt(uv));
}

void main() {
  vec2 c = texture(uSim, vUv).rg;
  vec2 mk = texture(uMask, vUv).rg;
  float mC = mk.r - mk.g * (1.0 - uBlend);
  float openC = openAt(mC);
  float h = c.x, hPrev = c.y;

  vec2 ox = vec2(uTexel.x, 0.0), oy = vec2(0.0, uTexel.y);
  vec2 lap = fluxFrom(vUv - ox, openC, c) + fluxFrom(vUv + ox, openC, c)
           + fluxFrom(vUv - oy, openC, c) + fluxFrom(vUv + oy, openC, c);

  // Viscosity on the velocity field (lap of now minus lap of one step ago).
  // Its bite grows with the square of the wave number, so it mops up
  // grid-scale fizz and leaves the long waves that carry the image alone.
  // (Smoothing the height itself would throw away the velocity and stop the
  // water dead.) Extra near the contour, where a moving wall sheds the most.
  // Stability: the checkerboard mode stays bounded only while
  // c² + 2·visc <= 0.5, so the viscosity is capped by the wave speed.
  float mL = maskAt(vUv - ox), mR = maskAt(vUv + ox);
  float mD = maskAt(vUv - oy), mU = maskAt(vUv + oy);
  float edge = clamp((abs(mR - mL) + abs(mU - mD)) * 2.5, 0.0, 1.0);
  float visc = min(0.03 + 0.12 * edge, max(0.0, (0.5 - uC2) * 0.45));

  float next = h + (h - hPrev) * uDamp + uC2 * lap.x + visc * (lap.x - lap.y);

  if (uRipples == 1) {
    // Spread the impulse over a good many cells. A source only a cell or two
    // wide emits at the grid scale, which shows up as a fingerprint of ringing
    // around the body instead of a wave.
    vec2 a = uTexel * 3.0, b = uTexel * 6.0;
    float d = mk.g * 0.24
      + texture(uMask, vUv + vec2(a.x, 0.0)).g * 0.11
      + texture(uMask, vUv - vec2(a.x, 0.0)).g * 0.11
      + texture(uMask, vUv + vec2(0.0, a.y)).g * 0.11
      + texture(uMask, vUv - vec2(0.0, a.y)).g * 0.11
      + texture(uMask, vUv + vec2(b.x, 0.0)).g * 0.08
      + texture(uMask, vUv - vec2(b.x, 0.0)).g * 0.08
      + texture(uMask, vUv + vec2(0.0, b.y)).g * 0.08
      + texture(uMask, vUv - vec2(0.0, b.y)).g * 0.08;
    // Inject outside the body only, so the impulse survives the wall below.
    float outside = (uObstacle == 1) ? 1.0 - smoothstep(0.35, 0.6, mC) : 1.0;
    // Cap it: after a stall or a hidden tab the mask can jump a whole body
    // width in one frame, and an uncapped impulse would detonate the pool.
    next += clamp(d, -0.3, 0.3) * uPush * uInject * outside;
  }

  next *= 0.9998;

  // Open edges: the outermost cells move as if the wave carried straight on
  // through them (dh/dt + c dh/dn = 0, a one-way wave equation), so waves
  // leave the screen instead of bouncing back. Measured with a straight
  // wavefront: a plain wall sends back ~45% of it head-on; this, nothing
  // measurable head-on and next to nothing at 45 degrees. (A damping "sponge"
  // band was tried too, and only added echo of its own.)
  float dx = min(vUv.x, 1.0 - vUv.x) / uTexel.x, dy = min(vUv.y, 1.0 - vUv.y) / uTexel.y;
  if (min(dx, dy) < 1.0) {
    vec2 inward = dx < dy ? vec2(vUv.x < 0.5 ? uTexel.x : -uTexel.x, 0.0)
                          : vec2(0.0, vUv.y < 0.5 ? uTexel.y : -uTexel.y);
    next = h - sqrt(uC2) * (h - texture(uSim, vUv + inward).r);
  }

  // Inside the body there is no water.
  next *= openC;
  h *= openC;

  outColor = vec4(clamp(next, -4.0, 4.0), h, 0.0, 1.0);
}`;

// Colour helpers for the psychedelic looks.
const COLOR = `
// A full, saturated rainbow around t (period 1).
vec3 rainbow(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}

// Turn a colour around the grey axis by angle a (radians).
vec3 hueTurn(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}`;

// Light and colour from nature, for the last three looks.
const NATURAL = `
// The colour of a single wavelength of light (nm), after Alan Zucconi's
// six-bump fit to the CIE curves; black outside the visible range.
vec3 bump3y(vec3 x, vec3 yoffset) {
  vec3 y = vec3(1.0) - x * x;
  return clamp(y - yoffset, 0.0, 1.0);
}
vec3 spectral(float nm) {
  float x = clamp((nm - 400.0) / 300.0, 0.0, 1.0);
  const vec3 c1 = vec3(3.54585104, 2.93225262, 2.41593945);
  const vec3 x1 = vec3(0.69549072, 0.49228336, 0.27699880);
  const vec3 y1 = vec3(0.02312639, 0.15225084, 0.52607955);
  const vec3 c2 = vec3(3.90307140, 3.21182957, 3.96587128);
  const vec3 x2 = vec3(0.11748627, 0.86755042, 0.66077860);
  const vec3 y2 = vec3(0.84897130, 0.88445281, 0.73949448);
  float seen = smoothstep(380.0, 410.0, nm) * (1.0 - smoothstep(690.0, 730.0, nm));
  return (bump3y(c1 * (x - x1), y1) + bump3y(c2 * (x - x2), y2)) * seen;
}

// Value noise and its fractal sum (0..1, mean ~0.5), for clouds.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    a *= 0.5;
  }
  return s / 0.97;
}

// Clouds lit from below by a setting sun: gold nearest it, then orange, rose,
// magenta, and slate violet in the shadow side of the sky.
vec3 sunsetCloud(float k) {
  vec3 c = mix(vec3(1.0, 0.82, 0.38), vec3(1.0, 0.48, 0.14), smoothstep(0.0, 0.25, k));
  c = mix(c, vec3(0.98, 0.27, 0.40), smoothstep(0.2, 0.5, k));
  c = mix(c, vec3(0.72, 0.24, 0.68), smoothstep(0.45, 0.75, k));
  return mix(c, vec3(0.32, 0.24, 0.55), smoothstep(0.7, 1.0, k));
}

// A sky dome, seen along direction r (z up). sunDir is where the sun is,
// sunH (0..1) how high, which also turns a sunset into day. cloudy (0..1):
// how much of the sunset and midday skies is cloud.
// Skies: 0 sunset, 1 aurora, 2 neon dusk, 3 midday.
vec3 skyColor(vec3 r, vec3 sunDir, float sunH, int sky, float time, float cloudy) {
  float t = clamp(r.z, 0.0, 1.0);                 // 0 at the horizon, 1 overhead
  float az = atan(r.y, r.x);
  float toSun = max(dot(r, sunDir), 0.0);
  vec3 c;
  if (sky == 1) {
    // Night, and curtains of light folding along the horizon.
    c = mix(vec3(0.03, 0.06, 0.10), vec3(0.01, 0.015, 0.05), t);
    float fold = sin(az * 3.0 + time * 0.15 + sin(az * 7.0 + time * 0.1) * 0.8);
    float curtain = smoothstep(0.2, 1.0, fold) * smoothstep(0.03, 0.25, t) * (1.0 - smoothstep(0.45, 0.9, t));
    c += mix(vec3(0.1, 1.0, 0.55), vec3(0.65, 0.25, 1.0), smoothstep(0.1, 0.6, t)) * curtain * 1.4;
    c += vec3(0.9, 0.95, 1.0) * step(0.9985, fract(sin(dot(floor(r.xy * 220.0), vec2(12.9898, 78.233))) * 43758.5453)) * t;
  } else if (sky == 2) {
    // Neon dusk: violet overhead, hot pink at the horizon, a big low sun.
    c = mix(vec3(1.0, 0.18, 0.55), vec3(0.42, 0.08, 0.68), smoothstep(0.0, 0.35, t));
    c = mix(c, vec3(0.05, 0.02, 0.22), smoothstep(0.3, 1.0, t));
    c += mix(vec3(1.0, 0.85, 0.2), vec3(1.0, 0.3, 0.6), 1.0 - toSun) * pow(toSun, 30.0) * 1.5;
  } else {
    float day = sky == 3 ? 1.0 : sunH;
    // Clear sky: warm towards the sun, pink and violet away from it (the
    // belt of Venus over the Earth's shadow), deep blue overhead.
    float sunward = 0.5 + 0.5 * dot(normalize(r.xy + vec2(1e-5)), normalize(sunDir.xy + vec2(1e-5)));
    vec3 horizon = mix(mix(vec3(0.62, 0.36, 0.62), vec3(1.0, 0.50, 0.15), sunward), vec3(0.75, 0.86, 1.0), day);
    vec3 middle  = mix(mix(vec3(0.38, 0.30, 0.70), vec3(0.95, 0.38, 0.42), sunward), vec3(0.45, 0.66, 0.96), day);
    vec3 zenith  = mix(vec3(0.08, 0.12, 0.36), vec3(0.14, 0.36, 0.85), day);
    c = mix(horizon, middle, smoothstep(0.0, 0.35, t));
    c = mix(c, zenith, smoothstep(0.3, 1.0, t));
    c += mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.95, 0.85), day) * pow(toSun, 8.0) * 0.8; // glow
    if (cloudy > 0.0) {
      // A layer of cloud overhead, seen in perspective and drifting. Each
      // cloud takes its colour from how far it lies from the sun, nudged by
      // a broader pattern so neighbouring clouds differ; thin edges glow,
      // thick cores are darker.
      vec2 p = r.xy / (max(r.z, 0.0) + 0.25) * 1.7 + vec2(time * 0.015, time * 0.006);
      float d = fbm(p);
      float th = mix(0.95, 0.22, cloudy);
      float amount = smoothstep(th, th + 0.16, d) * smoothstep(0.0, 0.1, r.z);
      float thick = smoothstep(th, th + 0.45, d);
      float vary = fbm(p * 0.35 + 31.0) - 0.5;
      float k = clamp(acos(clamp(dot(r, sunDir), -1.0, 1.0)) / 3.14159 * 1.1 + vary * 1.1 + thick * 0.25, 0.0, 1.0);
      vec3 dusk = sunsetCloud(k) * (1.25 - 0.6 * thick) + vec3(1.0, 0.7, 0.35) * pow(toSun, 6.0) * 0.6;
      vec3 noon = mix(vec3(1.0), vec3(0.70, 0.74, 0.82), thick);
      c = mix(c, mix(dusk, noon, smoothstep(0.15, 0.6, day)), amount);
    }
  }
  if (sky != 1) c += vec3(1.0, 0.95, 0.85) * smoothstep(0.9990, 0.9997, toSun) * 6.0; // sun (not at night)
  return c;
}`;

// Shades the height field. Looks:
//   0 water only, person as void
//   1 camera seen through the water
//   2 rippled camera, colour fringes
// and colour effects over the rippled camera:
//   3 oil slick                        7 caustic light
//   4 neon contours                    8 diffraction: ripples as a rainbow grating
//   5 liquid trails (the picture       9 sky reflection
//     smeared by the water)           10 clear water: depth and light
//   6 thermal camera
export const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSim;
uniform sampler2D uMask;
uniform sampler2D uVideo;
uniform sampler2D uTrail;   // the liquid-trails picture (look 5)
uniform vec2 uTexel;
uniform float uRelief;      // vertical exaggeration of the height field
uniform float uRefract;     // look 1's bend
uniform float uDeform;      // how hard the water bends the picture in the other looks
uniform float uTime;        // seconds
uniform float uCycle;       // how fast the psychedelic looks drift through colour
uniform int uMode;
uniform vec3 uDeep, uShallow, uSpec, uVoid, uRim;
uniform sampler2D uGrate;   // ripple structure (look 8), see GRATE_FRAG
uniform float uGrating;     // nm of light per cell of ripple spacing (look 8)
uniform float uLightAz;     // direction the light comes from, radians (looks 8, 9)
uniform int uSky;           // which sky (look 9)
uniform float uSunH;        // sun height, 0..1 (look 9)
uniform float uClouds;      // how much of the sky is cloud, 0..1 (look 9: sunset and midday)
uniform float uFx;          // how strongly a colour effect is laid over the rippled camera (looks 3-10)
uniform float uDepth;       // depth of the water (look 10)
uniform float uCaustics;    // strength of the caustics (look 10)
${CAM_UV}
${COLOR}
${NATURAL}

// The camera picture at uv, with a margin colour past its edges.
vec3 picture(vec2 uv, vec3 margin) {
  vec2 c = camUv(uv);
  return mix(margin, texture(uVideo, c).rgb, inCam(c));
}

// The camera picture bent by the water, each colour bent a little more than
// the last: spread 1 gives strong colour fringes, 0 none.
vec3 rippled(vec2 bend, float spread, vec3 margin) {
  return vec3(picture(vUv + bend, margin).r,
              picture(vUv + bend * (1.0 + 0.45 * spread), margin).g,
              picture(vUv + bend * (1.0 + 0.9 * spread), margin).b);
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// Curvature of the surface: negative where it bulges up, a converging lens
// that gathers light.
float curvAt(vec2 uv, vec2 t) {
  return texture(uSim, uv - vec2(t.x, 0.0)).r + texture(uSim, uv + vec2(t.x, 0.0)).r
       + texture(uSim, uv - vec2(0.0, t.y)).r + texture(uSim, uv + vec2(0.0, t.y)).r
       - 4.0 * texture(uSim, uv).r;
}

void main() {
  // A stencil wider than one cell: bilinear taps between cells average out the
  // grid-scale wobble that an exponent-60 highlight would otherwise turn into
  // a dither of sparkles along the contour.
  vec2 t = uTexel * 1.5;
  float hL = texture(uSim, vUv - vec2(t.x, 0.0)).r;
  float hR = texture(uSim, vUv + vec2(t.x, 0.0)).r;
  float hD = texture(uSim, vUv - vec2(0.0, t.y)).r;
  float hU = texture(uSim, vUv + vec2(0.0, t.y)).r;
  float h  = texture(uSim, vUv).r;

  vec2 slope = vec2(hL - hR, hD - hU) * uRelief;
  vec3 n = normalize(vec3(slope, 0.12));

  vec3 lightDir = normalize(vec3(-0.45, 0.55, 0.70));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(n, halfDir), 0.0), 60.0);
  float sheen = pow(max(dot(n, halfDir), 0.0), 8.0) * 0.35;
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

  // Light focused by the curvature of the surface, standing in for caustics.
  float curv = (hL + hR + hD + hU - 4.0 * h) * uRelief;
  float caustic = clamp(-curv * 4.0, 0.0, 1.2);

  float body = smoothstep(0.42, 0.58, texture(uMask, vUv).r);
  float hue = uTime * uCycle;
  vec2 bend = slope * 0.25 * uDeform; // where the water moves what lies under it

  vec3 col;
  if (uMode == 1) {
    // Past the edges of the camera picture there is only dark water.
    vec3 margin = uDeep * 0.7;
    vec3 flat_ = picture(vUv, margin);
    vec3 bent = picture(vUv + n.xy * uRefract, margin);
    vec3 tint = mix(uDeep, uShallow, 0.5);
    col = mix(bent, bent * tint * 2.4, 0.45);
    col += uSpec * (spec * 0.9 + sheen * 0.4) + uShallow * caustic * 0.18;
    col = mix(col, flat_ * 0.9, step(0.5, texture(uMask, vUv).r));
  } else if (uMode >= 2) {
    // From here on every look is the rippled camera, with its colour effect
    // laid on top. The water bends the picture, each colour a little more
    // than the last, like a lens with too much dispersion; where the body is
    // there is no water to bend it.
    vec3 m = uDeep * 0.5;
    vec3 cam = rippled(bend, uMode >= 8 ? 0.3 : 1.0, m);
    vec3 still = picture(vUv, m);
    vec3 glare = uSpec * (spec * 0.8 + sheen * 0.3);
    float fx = uFx, fx1 = clamp(uFx, 0.0, 1.0);

    if (uMode == 2) {
      col = cam + glare;
      col = mix(col, still, body * 0.7);
    } else if (uMode == 3) {
      // Oil slick: a thin film on the water, its colour set by its thickness,
      // which the waves stretch and squeeze. It tints what shows through it.
      float film = h * 2.5 * uRelief + length(slope) * 6.0 + hue * 0.25;
      float sheet = clamp((0.05 + length(slope) * 12.0) * fx, 0.0, 1.0); // flat water: barely any film
      vec3 oil = rainbow(film);
      col = mix(cam, cam * (0.3 + oil * 1.25) + oil * 0.1, sheet) + glare;
      col = mix(col, still, body);
    } else if (uMode == 4) {
      // Neon contours: lines of equal height, each its own colour, glowing
      // over the picture.
      float f = h * 14.0 * uRelief + 0.5;
      float d = abs(fract(f + 0.5) - 0.5);    // distance to the nearest contour
      float w = max(fwidth(f), 1e-4);
      float line = 1.0 - smoothstep(0.0, w * 1.3, d);
      float glow = 1.0 - smoothstep(0.0, w * 5.0, d);
      vec3 neon = rainbow(floor(f + 0.5) * 0.13 + hue * 0.3);
      col = cam * (1.0 - 0.35 * fx1) + neon * (line * 1.1 + glow * 0.3) * fx + glare * 0.5;
      col = mix(col, still, body);
    } else if (uMode == 5) {
      // Liquid trails: drawn by the feedback pass. Effect up to 1 fades them in
      // over the rippled camera; past 1 they last longer (see TRAIL_FRAG).
      col = mix(cam, texture(uTrail, vUv).rgb, fx1) + glare * 0.7;
    } else if (uMode == 6) {
      // Thermal camera: brightness read as heat on a rainbow scale, the water
      // shifting it and the body running hot.
      float lum = luma(cam);
      vec3 heat = rainbow(lum * 1.1 + h * 0.6 * uRelief + body * 0.35 + hue * 0.2) * (0.35 + 0.75 * lum + 0.2 * body);
      col = mix(cam, heat, clamp(min(fx * 0.6, 0.2 + fx * 0.4), 0.0, 1.0)) + glare * 0.6; // all heat at Effect 2
    } else if (uMode == 7) {
      // Caustic light: the waves focus light into bright threads on the
      // picture, each colour focused in a slightly different place.
      vec2 disp = normalize(slope + vec2(1e-6)) * uTexel * 4.0;
      vec3 light = clamp(-vec3(curvAt(vUv - disp, t), curvAt(vUv, t), curvAt(vUv + disp, t)) * uRelief * 24.0, 0.0, 3.0);
      vec3 tint = mix(mix(uShallow, vec3(1.0), 0.4), rainbow(hue * 0.4 + vUv.x * 0.6 + vUv.y * 0.3), 0.65);
      col = cam * (1.0 - 0.25 * fx1 + tint * light * 1.8 * fx) + tint * light * 0.12 * fx + glare * 0.5;
      col = mix(col, still, body);
    } else if (uMode == 8) {
      // Diffraction: the ripples as a grating, like the grooves of a CD. Their
      // spacing sets the colour (wider spacing, longer wavelength), their
      // direction against the light sweeps it through the rainbow, and only
      // orderly ripple trains shine; churned and flat water show the picture
      // plainly. Real ripples are about a thousand times too coarse for this;
      // here they are read as if they were fine enough.
      vec2 q = uTexel * 2.5;
      vec4 g = (texture(uGrate, vUv) * 2.0 + texture(uGrate, vUv + q) + texture(uGrate, vUv - q)
              + texture(uGrate, vUv + vec2(q.x, -q.y)) + texture(uGrate, vUv + vec2(-q.x, q.y))) / 6.0;
      float energy = g.y + g.z;                              // mean squared slope (scaled)
      float k = sqrt(max(g.x, 1e-9) / max(energy, 1e-9) * (25.0 / 400.0)); // ripple wavenumber, rad per cell
      float spacing = 6.28318 / max(k, 1e-3);                // cells between crests
      float across = 0.5 * atan(2.0 * g.w, g.y - g.z + 1e-9); // direction across the crests (defined on still water too)
      float order = sqrt((g.y - g.z) * (g.y - g.z) + 4.0 * g.w * g.w) / max(energy, 1e-9); // 1: one clean direction
      float light = uLightAz + hue * 0.5;
      float nm = spacing * uGrating * abs(cos(across - light));
      // First three orders: wide ripples, too coarse to colour the first order,
      // still colour the second and third, as on a real grating.
      vec3 rainbowLight = spectral(nm) + spectral(nm / 2.0) * 0.6 + spectral(nm / 3.0) * 0.4;
      float shine = order * order * smoothstep(0.0003, 0.01, energy) * fx;
      // Over a bright picture the colours need room: what shines darkens the
      // picture beneath it, as a grating's glare would wash it out.
      col = cam * (1.0 - 0.45 * clamp(shine, 0.0, 1.0)) + rainbowLight * shine * 2.0 + glare * 0.5;
      col = mix(col, still, body);
    } else if (uMode == 9) {
      // Sky reflection: each facet of the water mirrors its own patch of sky.
      // Like real water it mirrors little looking straight down, and more the
      // more a facet tilts towards the horizon, so the picture shows through
      // the flat water and the waves carry the sky's colour.
      // Seen from a point above the middle of the pool, so even flat water
      // mirrors a different patch of sky in each part of the screen.
      vec2 at = (vUv - 0.5) * vec2(uTexel.y / uTexel.x, 1.0);
      vec3 r = reflect(normalize(vec3(at, -1.3)), n);
      r.z = abs(r.z); // a facet steep enough to mirror below the horizon sees the sky in a neighbour
      float sunEl = mix(0.03, 1.25, uSunH);
      float sunAz = uLightAz + hue * 0.3;
      vec3 sunDir = vec3(cos(sunEl) * cos(sunAz), cos(sunEl) * sin(sunAz), sin(sunEl));
      vec3 sky = skyColor(r, sunDir, uSunH, uSky, uTime, uClouds);
      vec3 ambient = 0.5 * (skyColor(vec3(0.0, 0.0, 1.0), sunDir, uSunH, uSky, uTime, 0.0)
                          + skyColor(normalize(vec3(cos(sunAz), sin(sunAz), 0.15)), sunDir, uSunH, uSky, uTime, 0.0));
      vec3 tint = ambient / max(max(ambient.r, max(ambient.g, ambient.b)), 0.05); // the sky's light, at full brightness
      float mirror = clamp(fx * (0.06 + 1.6 * sqrt(1.0 - n.z)), 0.0, 1.0);
      col = mix(cam * mix(vec3(1.0), tint, 0.35 * fx1), sky, mirror);
      col = mix(col, still * mix(vec3(1.0), tint, 0.25 * fx1), body);
    } else {
      // Clear water: looking down through it at the picture as the floor.
      // Water soaks up red first, then green, so the deeper the water (troughs
      // deeper than crests) the bluer the floor; the waves focus sunlight into
      // caustics, each colour slightly apart. Light scattered by the water
      // itself gives it its own glow.
      float d = max(0.05, uDepth * (1.0 - h * 1.5 * uRelief));
      vec3 through = exp(-vec3(0.22, 0.06, 0.025) * d * 2.0);      // down and back up
      vec2 disp = normalize(slope + vec2(1e-6)) * uTexel * 1.5;
      vec3 focus = clamp(-vec3(curvAt(vUv - disp, t), curvAt(vUv, t), curvAt(vUv + disp, t)) * uRelief * 18.0, 0.0, 3.0) * uCaustics;
      vec3 water = cam * through * (0.95 + focus * 1.3) * vec3(1.0, 0.98, 0.93);
      water += (1.0 - through) * vec3(0.0, 0.12, 0.16);             // the water's own glow
      float F = 0.02 + 0.98 * pow(1.0 - n.z, 5.0);
      water = mix(water, vec3(0.55, 0.70, 0.90), F * 0.8) + vec3(1.0) * spec * 0.8;
      // Effect past 1 exaggerates the water: bluer depths, brighter caustics.
      col = max(mix(cam + glare, water, fx), 0.0);
      col = mix(col, still, body);
    }
  } else {
    // Rest height sits near the deep end so that crests, not the flat pool,
    // carry the light.
    float shade = clamp(h * 3.6 * uRelief + 0.14, 0.0, 1.0);
    col = mix(uDeep, uShallow, shade);
    col += uShallow * caustic * 0.45;
    col += uSpec * (spec + sheen * 0.5);
    col += uShallow * fresnel * 0.10;
    col = mix(col, uVoid, body);
  }

  // A thin bright rim traces the contour of the body.
  float mL = texture(uMask, vUv - vec2(t.x, 0.0)).r;
  float mR = texture(uMask, vUv + vec2(t.x, 0.0)).r;
  float mD = texture(uMask, vUv - vec2(0.0, t.y)).r;
  float mU = texture(uMask, vUv + vec2(0.0, t.y)).r;
  float grad = length(vec2(mR - mL, mU - mD));
  vec3 rim = (uMode >= 2 && uMode <= 6) ? rainbow(hue * 0.5 + vUv.y) : uRim;
  col += rim * smoothstep(0.10, 0.60, grad) * 0.22;

  outColor = vec4(col, 1.0);
}`;

// Liquid trails (look 5): a picture that persists from frame to frame, pushed
// along the slope of the water, slowly turning through the colours, and fed
// fresh camera picture — strongly where the body is, faintly everywhere else —
// so movement leaves smeared, rainbowing wakes.
// Ripple structure, per cell, for the diffraction look: squared curvature and
// the slope's structure tensor. Averaged over a small patch (in the render
// pass) these give the ripples' spacing — for a regular ripple train,
// curvature^2 / slope^2 is exactly the squared wavenumber — their direction,
// and how orderly they are. Scaled to keep clear of half-float underflow:
// curvature by 20, slope by 5.
export const GRATE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSim;
uniform vec2 uTexel;

void main() {
  float h  = texture(uSim, vUv).r;
  float hL = texture(uSim, vUv - vec2(uTexel.x, 0.0)).r;
  float hR = texture(uSim, vUv + vec2(uTexel.x, 0.0)).r;
  float hD = texture(uSim, vUv - vec2(0.0, uTexel.y)).r;
  float hU = texture(uSim, vUv + vec2(0.0, uTexel.y)).r;
  float curv = (hL + hR + hD + hU - 4.0 * h) * 20.0;
  vec2 g = vec2(hR - hL, hU - hD) * 0.5 * 5.0;
  outColor = vec4(curv * curv, g.x * g.x, g.y * g.y, g.x * g.y);
}`;

export const TRAIL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPrev;
uniform sampler2D uSim;
uniform sampler2D uMask;
uniform sampler2D uVideo;
uniform vec2 uTexel;        // of the simulation grid
uniform float uRelief;
uniform float uDeform;
uniform float uTurn;        // hue turned per frame, radians
uniform float uFresh;       // 1 on the first frame: start from the plain picture
uniform float uFx;          // the Effect slider: past 1, trails last longer
${CAM_UV}
${COLOR}

void main() {
  vec2 t = uTexel * 1.5;
  vec2 slope = vec2(texture(uSim, vUv - vec2(t.x, 0.0)).r - texture(uSim, vUv + vec2(t.x, 0.0)).r,
                    texture(uSim, vUv - vec2(0.0, t.y)).r - texture(uSim, vUv + vec2(0.0, t.y)).r) * uRelief;
  vec2 hh = texture(uSim, vUv).rg;
  // Ripples slope back and forth, so a push along the slope alone cancels out
  // over each wave. Real water carries what floats on it the way its waves
  // travel (Stokes drift): how fast the surface rises times its slope keeps
  // one sign under a passing wave. So trails stream away from where waves are
  // made, with a little of the to-and-fro on top.
  vec2 drift = (hh.x - hh.y) * slope * 60.0 * uDeform;
  float dl = length(drift);
  drift *= min(1.0, 0.003 * uDeform / max(dl, 1e-6));
  vec2 flow = drift + slope * 0.006 * uDeform;

  vec3 prev = hueTurn(texture(uPrev, vUv - flow).rgb, uTurn) * 0.997;
  // Smearing averages colours towards grey; a touch more saturation each frame
  // keeps the trails vivid.
  prev = clamp(mix(vec3(dot(prev, vec3(0.299, 0.587, 0.114))), prev, 1.004), 0.0, 1.0);
  vec2 c = camUv(vUv + slope * 0.05 * uDeform);
  vec3 cam = texture(uVideo, c).rgb * inCam(c);
  float body = smoothstep(0.4, 0.6, texture(uMask, vUv).r);
  // Fresh picture seeps back in everywhere, wiping old trails: over about a
  // second at Effect 1, three at Effect 2.
  float feed = max(uFresh, 0.02 / max(uFx * uFx, 1.0) + 0.45 * body);
  outColor = vec4(mix(prev, cam, feed), 1.0);
}`;

// Boils the pool down to one texel per sound zone. The target is cols x
// 2*rows: the bottom band is the water, the top band the body's movement.
// Sixteen-by-sixteen samples per zone is plenty for a mean, and keeps the loop
// bounds constant.
// Water band:
//   r = mean squared velocity, scaled  -> how hard the water moves here
//   g = mean squared height            -> with r, gives the ripple frequency
//   b = mean body coverage             -> the body silences what it covers
//   a = mean contour movement          -> splashes
// Movement band, over the contour only (where the mask has a slope):
// measured on the mask's calm copy (see MASK_FRAG):
//   r = mean |dm/dt|                   -> how much of the body moves
//   g = mean |dm/dt|^2 / |grad m|, x100 -> divided by r, how fast it moves:
//       a contour moving at v cells per frame changes the mask by v |grad m|
//       per frame, so the ratio is its speed, weighted towards the parts
//       that move most (and blind to the mask merely fading in or out)
//   b = mean |grad m|                  -> how much contour there is
export const REDUCE_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform sampler2D uSim;
uniform sampler2D uMask;
uniform vec2 uZones;
uniform vec2 uTexel;     // of the grid
uniform float uVelScale; // lifts tiny per-substep velocities clear of half-float underflow

void main() {
  vec2 zone = floor(gl_FragCoord.xy);
  bool moving = zone.y >= uZones.y;
  if (moving) zone.y -= uZones.y;
  vec2 size = 1.0 / uZones;
  vec2 base = zone * size;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      vec2 uv = base + (vec2(float(x), float(y)) + 0.5) / 16.0 * size;
      vec4 m = texture(uMask, uv);
      if (moving) {
        float gx = texture(uMask, uv + vec2(uTexel.x, 0.0)).b - texture(uMask, uv - vec2(uTexel.x, 0.0)).b;
        float gy = texture(uMask, uv + vec2(0.0, uTexel.y)).b - texture(uMask, uv - vec2(0.0, uTexel.y)).b;
        float grad = 0.5 * length(vec2(gx, gy));
        float dm = grad > 0.004 ? abs(m.a) : 0.0;
        acc += vec4(dm, dm * dm / max(grad, 0.004) * 100.0, grad, 0.0);
      } else {
        vec2 s = texture(uSim, uv).rg;
        float v = (s.x - s.y) * uVelScale;
        acc += vec4(v * v, s.x * s.x, m.r, abs(m.g));
      }
    }
  }
  outColor = acc / 256.0;
}`;

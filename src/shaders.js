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
${CAM_UV}

float rawAt(vec2 uv) {
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
  float prev = texture(uPrev, vUv).r;
  float base = mix(prev, prevBlur, clamp(uSoft, 0.0, 1.0));
  float eased = mix(base, m, uEase);
  outColor = vec4(eased, eased - prev, 0.0, 1.0);
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
// a reflecting wall; the edge of the pool is a closed edge too.
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

  // Soak up energy in a band around the rim so reflections do not pile up.
  vec2 e = min(vUv, 1.0 - vUv);
  float border = smoothstep(0.0, 0.035, min(e.x, e.y));
  next *= mix(0.94, 1.0, border);
  next *= 0.9998;

  // Inside the body there is no water.
  next *= openC;
  h *= openC;

  outColor = vec4(clamp(next, -4.0, 4.0), h, 0.0, 1.0);
}`;

export const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSim;
uniform sampler2D uMask;
uniform sampler2D uVideo;
uniform vec2 uTexel;
uniform float uRelief;    // vertical exaggeration of the height field
uniform float uRefract;
uniform int uMode;        // 0 = water only, 1 = camera through the water
uniform vec3 uDeep, uShallow, uSpec, uVoid, uRim;
${CAM_UV}

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

  vec3 n = normalize(vec3((hL - hR) * uRelief, (hD - hU) * uRelief, 0.12));

  vec3 lightDir = normalize(vec3(-0.45, 0.55, 0.70));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(n, halfDir), 0.0), 60.0);
  float sheen = pow(max(dot(n, halfDir), 0.0), 8.0) * 0.35;
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

  // Light focused by the curvature of the surface, standing in for caustics.
  float curv = (hL + hR + hD + hU - 4.0 * h) * uRelief;
  float caustic = clamp(-curv * 4.0, 0.0, 1.2);

  vec3 col;
  if (uMode == 1) {
    // Past the edges of the camera picture there is only dark water.
    vec2 cf = camUv(vUv), cb = camUv(vUv + n.xy * uRefract);
    vec3 margin = uDeep * 0.7;
    vec3 flat_ = mix(margin, texture(uVideo, cf).rgb, inCam(cf));
    vec3 bent = mix(margin, texture(uVideo, cb).rgb, inCam(cb));
    vec3 tint = mix(uDeep, uShallow, 0.5);
    col = mix(bent, bent * tint * 2.4, 0.45);
    col += uSpec * (spec * 0.9 + sheen * 0.4) + uShallow * caustic * 0.18;
    col = mix(col, flat_ * 0.9, step(0.5, texture(uMask, vUv).r));
  } else {
    // Rest height sits near the deep end so that crests, not the flat pool,
    // carry the light.
    float shade = clamp(h * 3.6 * uRelief + 0.14, 0.0, 1.0);
    col = mix(uDeep, uShallow, shade);
    col += uShallow * caustic * 0.45;
    col += uSpec * (spec + sheen * 0.5);
    col += uShallow * fresnel * 0.10;
    col = mix(col, uVoid, smoothstep(0.42, 0.58, texture(uMask, vUv).r));
  }

  // A thin bright rim traces the contour of the body.
  float mL = texture(uMask, vUv - vec2(t.x, 0.0)).r;
  float mR = texture(uMask, vUv + vec2(t.x, 0.0)).r;
  float mD = texture(uMask, vUv - vec2(0.0, t.y)).r;
  float mU = texture(uMask, vUv + vec2(0.0, t.y)).r;
  float grad = length(vec2(mR - mL, mU - mD));
  col += uRim * smoothstep(0.10, 0.60, grad) * 0.22;

  outColor = vec4(col, 1.0);
}`;

// Boils the pool down to one texel per sound zone (the target is cols x rows).
// Sixteen-by-sixteen samples per zone is plenty for a mean of squares, and keeps
// the loop bounds constant.
//   r = mean squared velocity, scaled  -> how hard the water moves here
//   g = mean squared height            -> with r, gives the ripple frequency
//   b = mean body coverage             -> the body silences what it covers
//   a = mean contour movement          -> splashes
export const REDUCE_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform sampler2D uSim;
uniform sampler2D uMask;
uniform vec2 uZones;
uniform float uVelScale; // lifts tiny per-substep velocities clear of half-float underflow

void main() {
  vec2 size = 1.0 / uZones;
  vec2 base = floor(gl_FragCoord.xy) * size;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      vec2 uv = base + (vec2(float(x), float(y)) + 0.5) / 16.0 * size;
      vec2 s = texture(uSim, uv).rg;
      vec2 m = texture(uMask, uv).rg;
      float v = (s.x - s.y) * uVelScale;
      acc += vec4(v * v, s.x * s.x, m.r, abs(m.g));
    }
  }
  outColor = acc / 256.0;
}`;

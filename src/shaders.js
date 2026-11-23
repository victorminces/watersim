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

// Shades the height field. Looks:
//   0 water only, person as void       4 neon contours
//   1 camera seen through the water    5 liquid trails (the picture smeared by the water)
//   2 rippled camera, colour fringes   6 thermal camera
//   3 oil slick                        7 caustic light
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
${CAM_UV}
${COLOR}

// The camera picture at uv, with a margin colour past its edges.
vec3 picture(vec2 uv, vec3 margin) {
  vec2 c = camUv(uv);
  return mix(margin, texture(uVideo, c).rgb, inCam(c));
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
  } else if (uMode == 2) {
    // Rippled camera: the water bends the picture, and bends each colour a
    // little differently, like a lens with too much dispersion.
    vec3 m = uDeep * 0.5;
    col = vec3(picture(vUv + bend, m).r, picture(vUv + bend * 1.45, m).g, picture(vUv + bend * 1.9, m).b);
    col += uSpec * (spec * 0.8 + sheen * 0.3);
    col = mix(col, picture(vUv, m), body * 0.7);
  } else if (uMode == 3) {
    // Oil slick: a thin film on the water, its colour set by its thickness,
    // which the waves stretch and squeeze. The picture shows dimly beneath.
    float film = h * 2.5 * uRelief + length(slope) * 6.0 + hue * 0.25;
    float sheet = clamp(0.2 + length(slope) * 10.0, 0.0, 1.0);
    col = picture(vUv + bend * 0.5, vec3(0.02)) * 0.35 + rainbow(film) * sheet * 0.85 + uSpec * spec;
    col = mix(col, picture(vUv, vec3(0.0)), body);
  } else if (uMode == 4) {
    // Neon contours: lines of equal height, each its own colour, glowing over a
    // faint, bent picture.
    float f = h * 14.0 * uRelief + 0.5;
    float d = abs(fract(f + 0.5) - 0.5);    // distance to the nearest contour
    float w = max(fwidth(f), 1e-4);
    float line = 1.0 - smoothstep(0.0, w * 1.3, d);
    float glow = 1.0 - smoothstep(0.0, w * 5.0, d);
    vec3 neon = rainbow(floor(f + 0.5) * 0.13 + hue * 0.3);
    col = picture(vUv + bend, vec3(0.0)) * 0.12 + neon * (line * 1.2 + glow * 0.35);
    col = mix(col, picture(vUv, vec3(0.0)) * 0.35, body);
  } else if (uMode == 5) {
    // Liquid trails: drawn by the feedback pass; just add the light.
    col = texture(uTrail, vUv).rgb + uSpec * (spec * 0.6 + sheen * 0.2);
  } else if (uMode == 6) {
    // Thermal camera: brightness read as heat on a rainbow scale, the picture
    // warped by the water and the body running hot.
    vec3 p = picture(vUv + bend, vec3(0.0));
    float lum = dot(p, vec3(0.299, 0.587, 0.114));
    col = rainbow(lum * 1.1 + h * 0.6 * uRelief + body * 0.35 + hue * 0.2) * (0.35 + 0.75 * lum + 0.2 * body);
    col += uSpec * spec * 0.6;
  } else if (uMode == 7) {
    // Caustic light: the waves focus light into bright threads on whatever is
    // below, the picture included, and each colour focuses in a slightly
    // different place.
    vec2 disp = normalize(slope + vec2(1e-6)) * uTexel * 4.0;
    vec3 light = clamp(-vec3(curvAt(vUv - disp, t), curvAt(vUv, t), curvAt(vUv + disp, t)) * uRelief * 24.0, 0.0, 3.0);
    vec3 tint = mix(mix(uShallow, vec3(1.0), 0.4), rainbow(hue * 0.4 + vUv.x * 0.6 + vUv.y * 0.3), 0.65);
    vec3 lit = 0.5 + tint * light * 2.2;
    col = picture(vUv + bend * 0.6, uDeep * 0.6) * lit + uSpec * spec * 0.5;
    col = mix(col, picture(vUv, uDeep * 0.6) * (0.55 + light * 0.8), body);
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
  vec3 rim = (uMode >= 2 && uMode != 7) ? rainbow(hue * 0.5 + vUv.y) : uRim;
  col += rim * smoothstep(0.10, 0.60, grad) * 0.22;

  outColor = vec4(col, 1.0);
}`;

// Liquid trails (look 5): a picture that persists from frame to frame, pushed
// along the slope of the water, slowly turning through the colours, and fed
// fresh camera picture — strongly where the body is, faintly everywhere else —
// so movement leaves smeared, rainbowing wakes.
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
  float feed = max(uFresh, 0.02 + 0.45 * body);
  outColor = vec4(mix(prev, cam, feed), 1.0);
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

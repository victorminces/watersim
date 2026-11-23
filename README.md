# Water Contour

Top-down surface waves, in the browser. The webcam finds a person's silhouette;
there is no water where the body is, and the water reacts to its contour.

**Live: <https://victorminces.github.io/watersim/>** — open it, click *Start camera*
and allow the webcam (or *Run without camera* for a stand-in figure).

## Run locally

Needs a local server (ES modules and camera access do not work from `file://`):

```powershell
python -m http.server 8123
```

Then open <http://localhost:8123/>. Click **Start camera**, or **Run without
camera** to drive the water with a procedural stand-in silhouette.

## Controls

`H` hides the panel · `F` fullscreen · `M` mutes · `C` calms the water · click or drag on
the water to drop a stone in it.

| Control | What it does |
| --- | --- |
| Solid obstacle | The silhouette is a wall: waves reflect off the contour and cannot cross it. |
| Motion ripples | A moving contour shoves the water, so the body radiates waves as it moves. |
| Look | Water only (body is an empty void) · Camera seen through the water · Rippled camera (the water bends the picture, each colour differently) · Oil slick (an iridescent film on the waves) · Neon contours (lines of equal height, each its own colour) · Liquid trails (the picture smeared along by the waves and drifting through colour) · Thermal camera (brightness as false-colour heat) · Caustic light (rainbow-fringed threads of focused light, over the picture too) · Diffraction (the ripples as a rainbow grating) · Sky reflection (each wave facet mirrors its own patch of sky) · Clear water (looking down through real water at the picture as the floor). From Oil slick on, each look is a colour effect laid over the rippled camera, so the picture keeps its own colours where the water is calm. Each look shows only the sliders that apply to it. |
| Deform | How hard the water bends the picture beneath it. |
| Effect | How strongly the look's colour is laid over the rippled camera: 0 is the plain rippled camera. |
| Color cycle | How fast the psychedelic looks drift through colour. |
| Grating | Diffraction: how ripple spacing maps to colour (nm of light per cell of spacing). |
| Light from | Diffraction and sky reflection: the direction the light (or sun) comes from. Color cycle circles it slowly. |
| Sky | Sky reflection: sunset, aurora, neon dusk or midday. |
| Sun height | Sky reflection: from a sun on the horizon (sunset colours) to high (daylight). |
| Clouds | Sky reflection: how much of the sunset or midday sky is cloud, from clear to overcast. |
| Depth | Clear water: how deep the water is (deeper is bluer). |
| Caustics | Clear water: strength of the focused sunlight. |
| Palette | Colour scheme, switchable live. |
| Wave speed | Propagation speed (c², capped at 0.45 for stability). |
| Wave life | How long waves survive before damping out. |
| Ripple push | How hard contour motion drives the water. |
| Relief | Vertical exaggeration — contrast of the shading. |
| Refraction | Bend of the camera image under the waves (the camera-through-water look). |
| Rain | Random droplets, so the pool is never dead still. |
| Detail | Fineness of the water grid: finer makes smaller waves relative to the screen, at more GPU cost. Changing it stills the water. |
| Mirror | Flip the camera horizontally — on for a mirror-facing screen, off for projection. |
| Framing | Fill the screen (crops what does not fit — on a tall phone, the sides of the picture), or show the whole picture with water-only margins. |
| Invert mask | Swap body and water. Set automatically on the first frames with someone in them (the top corners of the picture are taken to be background), unless you change it by hand. |
| Edge softness | How much the contour is smoothed each frame (0–1). |
| Mask easing | Temporal smoothing of the mask: low is calm but laggy, high is responsive but jittery. |
| Show mask preview | Thumbnail of what the segmenter sees. |
| Sound | Sound on or off. |
| Volume | Overall level. |
| Water | Level of the water wash. |
| Slush | How much the water surges and opens up on its peaks (the resonators surge with it). |
| Resonators | Level of the water made to sing. |
| Voices | How many resonators sing at once (1-4). |
| Clarity | Width of the resonators: low is water with a colour, high is a pure singing tone. |
| Pitch | What picks the resonators' notes: ripple size on the scale, ripple size gliding freely, or how fast the body moves, on the scale. |
| Scale | Scale to snap to: major or minor pentatonic, Hirajoshi, Dorian, Lydian. |

## Natural colour

Three looks take their colour from how real light meets water, steered by the
shape of the surface rather than painted on. Like the other colour looks they
are laid over the rippled camera: calm water shows the picture as it is, and
the colour comes with the waves.

- **Diffraction.** The ripples are read as a grating, like the grooves of a CD.
  A small pass computes, per cell, the curvature and the slope's structure
  tensor; averaged over a patch these give the ripples' spacing (for a regular
  ripple train, curvature² / slope² is exactly the squared wavenumber), their
  direction, and how orderly they are. Spacing × the angle to the light sets
  the wavelength of the first three diffraction orders (a fitted CIE spectrum
  turns those into colour); order sets the brightness, so only regular ripple
  trains shine, darkening the picture beneath them a little so the colours
  show over bright parts of it. Real ripples are about a thousand times too
  coarse to do this — here they are read as if they were fine enough.
- **Sky reflection.** Real water gets much of its colour from the sky it
  mirrors. Each facet reflects the direction its normal sends the view; flat
  water sees overhead, tilted facets the horizon, so crests catch a sunset's
  orange. The pool is seen from a point above its middle, so each part of the
  screen mirrors its own patch of sky. The sunset sky is cloudy: drifting
  clouds lit from below, gold nearest the sun, then orange, rose, magenta and
  violet on the far side, each cloud a little different, with deep blue
  between them, so every ripple catches its own colours. As in real water,
  looking straight down it mirrors little (the picture shows through, lit by
  the sky's colour) and more the more a facet tilts.
- **Clear water.** Water absorbs red first, then green; troughs are deeper than
  crests, so they are bluer. It bends blue slightly more than red, and focuses
  sunlight into caustics, each colour a little apart. Light scattered in the
  water gives it its own blue-green glow.

## Sound

Everything you hear is one water sound and what is done to it, steered by what
the water is doing, measured over a 16×8 grid of zones laid over the pool.

- **Water.** Brown noise — a low wash, not a hiss — swelling with the energy of
  the whole pool and lapping on two slow undulations.
- **Slush.** On the water's peaks (waves arriving anywhere, or a sudden shove of
  the body) the same wash surges and opens up.
- **Resonators.** The same water sound again, through narrow band-pass filters:
  the water itself made to sing, so it breathes with the wash — silent when the
  pool is still, loudest when it surges. They are steered by the pool's *ripple
  spectrum*: how much wave energy is moving at each ripple speed (RMS velocity
  over RMS height, per zone), smoothed over about a second and lifted into
  hearing range — about 0.7-4.5 Hz onto three octaves from A2 — so long slow
  swells sound low and quick fine ripples high. The strongest two or three bands
  sing, each from the side of the pool where its ripples are, and they change
  only as the character of the water changes. *Snap* puts them on the notes of
  the scale (a note already singing keeps its place until a rival is clearly
  stronger); *Glide* lets them sit on the spectrum's peaks and slide as those
  move. The body, a hole in the water, contributes nothing where it covers.
  *Movement speed* lets the body play the resonators instead. The movement
  itself is fed into them, so they sing while the body moves, as loud as the
  movement is large, and fall silent within a second of it stopping. How fast
  the contour moves picks the note: its speed in screens per second, measured
  on the GPU as the mask's change over its slope (a contour moving at *v*
  changes the mask by *v*·|∇m| per frame), weighted towards the parts that move
  most. About 0.08-0.65 screens per second maps onto the three octaves, so each
  doubling of speed is an octave up: a slow sway sings around A2, an arm swung
  briskly near the top. The flicker of a still body's edge is measured on a
  calmer copy of the mask, where back-and-forth noise cancels out, and gated by
  a floor that learns how much a body at rest seems to move.

A GPU pass reduces the pool to those zones every frame and the numbers are
read back asynchronously, so the sound never stalls the picture. An automatic
gain follows the busiest zone, so it responds the same whatever the wave
settings are, and calm water is silent. Nothing is modulated at random per
frame and the audio runs with large buffers, both to avoid crackle.

## How it works

- `src/segmenter.js` — MediaPipe Tasks Vision selfie segmenter, loaded from a
  CDN, giving a per-pixel person mask. The video never leaves the machine.
- `src/shaders.js` — fragment shaders: ease the mask and measure its
  per-frame change; splat point impulses; step a damped 2-D wave equation on a
  height field; shade the result; reduce the pool to sound zones.
- `src/audio.js` — the Web Audio engine (water, slush, resonators).
- The silhouette enters the physics twice. As an obstacle, each edge between
  two cells conducts by the product of both cells' openness, so the wall is
  graded yet symmetric — waves reflect off the body, and the scheme stays
  stable (a lopsided coupling grows a checkerboard along the contour). As a
  source, the frame-to-frame change in the mask is injected as displacement
  just outside the body.
- The edges of the screen are open: the outermost cells follow a one-way wave
  equation, so waves leave instead of bouncing back. Measured with a straight
  wavefront, a plain wall returns ~45% of it head-on; the open edge, nothing
  measurable head-on and next to nothing at 45°. (A damping "sponge" band was
  tried first and only added echo of its own.)
- A mask that is one label from edge to edge counts as nobody there, whichever
  label it is, so an empty room never turns the whole screen into body.
- 16 wave steps per animation frame, with the mask interpolated across them so
  the body moves continuously through each camera frame. A wall that jumped
  once per frame could only radiate at the grid scale (fizz, not ripples).
- Velocity viscosity mops up grid-scale noise and is capped by the wave speed
  (the checkerboard mode is bounded only while c² + 2·viscosity ≤ 0.5).
- Grid sized to the window aspect at a fixed budget (512×288 cells),
  ping-ponged `RGBA16F` targets.
- Debugging, from the console: `__water.read('sim' | 'mask', x, y, w, h)`
  returns raw texture values, `__water.zoneStats()` the sound grid,
  `__water.step(ms)` advances one frame by hand, and `__water.audio.rms()` meters
  the mix.

## Requirements

WebGL2 with `EXT_color_buffer_float` (any current desktop browser), a webcam,
and an internet connection the first time, to fetch the segmentation model.

On phones and tablets the grid is coarser (about 120 cells across the short
side, against ~265 on a laptop): the waves a moving body makes are a fixed
number of cells long, so on a small screen a fine grid makes them look like
fizz. The Detail slider trades this back. The panel starts tucked behind a
**Controls** button, and the camera is asked for its own mode closest to the
screen's shape, rather than being cropped to it by the browser. The
camera needs https, so use the live link. If the camera is refused, sends
nothing, or gets switched off (screen locked, another app), a notice says so,
and tapping it restarts the camera. If body detection on a phone's GPU returns
nothing but empty masks for a few seconds, it switches to the CPU by itself. On iPhone, the ring/silent switch mutes the
sound.

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

### On a phone, linked to this PC

```powershell
python tools/phonelink.py serve
```

serves the app over https to a phone on the same Wi-Fi and writes a QR code
for it (the path is printed). The certificate is self-made, so the phone warns
once: *Advanced → Proceed*. The page then reports back to the PC (console
output, errors, the device and its GPU, a heartbeat with the frame rate) and
takes commands from it, from this PC only:

```powershell
python tools/phonelink.py status
python tools/phonelink.py log
python tools/phonelink.py run "__water.segmenter.delegate"
python tools/phonelink.py snap
python tools/phonelink.py reload
```

`snap` saves a picture of the canvas; `reload` picks up edited files (nothing
is cached). Logs, pictures and the certificate stay in a temp folder. The
same app is also served at <http://localhost:8444/> for a browser on the PC.

## Controls

`H` hides the panel · `F` fullscreen · `M` mutes · `C` calms the water · click or drag on
the water to drop a stone in it.

The panel is in five sections, and it shows only the controls that do
something with the current settings: each look its own sliders, the sky
reflection those of its sky, Ripple push only while Motion ripples is on, the
sound's controls only while Sound is on, Scale only when the pitch snaps to
it, and the camera's framing, mask inversion and preview only with a camera.

Every slider starts with its default at the middle of its bar, and the bar is
bent (exponentially) so the stretch around the default gets most of its
travel: half the bar lies below the default, half above. Sliders are
continuous; only Voices moves in whole steps.

**Body** — how the silhouette touches the water.

| Control | What it does |
| --- | --- |
| Solid obstacle | The silhouette is a wall: waves reflect off the contour and cannot cross it. |
| Motion ripples | A moving contour shoves the water, so the body radiates waves as it moves. |
| Ripple push | How hard contour motion drives the water. |
| Ripple length | How long the body's movement is smoothed before it pushes the water (0-0.25 s). A wave is as long as its speed divided by how fast its source changes, so a source that jitters frame to frame rings fine ripples at any wave speed; smoothed, only the slower motion makes waves and they come out longer. With a low Wave speed, this is how to get long, slow waves. |

**Look**

| Control | What it does |
| --- | --- |
| Look | Water only (body is an empty void) · Camera seen through the water · Rippled camera (the water bends the picture, each colour differently) · Oil slick (an iridescent film on the waves) · Neon contours (lines of equal height, each its own colour) · Liquid trails (the picture smeared along by the waves and drifting through colour) · Thermal camera (brightness as false-colour heat) · Caustic light (rainbow-fringed threads of focused light, over the picture too) · Diffraction (the ripples as a rainbow grating) · Sky reflection (each wave facet mirrors its own patch of sky) · Clear water (looking down through real water at the picture as the floor). From Oil slick on, each look is a colour effect laid over the rippled camera, so the picture keeps its own colours where the water is calm. |
| Sky | Sky reflection: sunset, aurora, neon dusk or midday. |
| Palette | Water only, camera through the water, caustic light: the colour scheme. |
| Refraction | Camera through the water: how much the waves bend the picture. |
| Deform | How hard the water bends the picture beneath it. |
| Effect | How strongly the look's colour is laid over the rippled camera: 0 is the plain rippled camera. Past 1, Liquid trails last longer and Clear water is exaggerated (bluer depths, brighter caustics). |
| Color cycle | How fast the psychedelic looks drift through colour; in diffraction and sky reflection, how fast the light circles. |
| Grating | Diffraction: how ripple spacing maps to colour (nm of light per cell of spacing). |
| Light from | Diffraction and sky reflection: the direction the light (or sun) comes from. |
| Sun height | Sky reflection: from a sun on the horizon (sunset colours) to high (daylight). Not in the aurora's night sky. |
| Clouds | Sky reflection: how much of the sunset or midday sky is cloud, from clear to overcast. |
| Depth | Clear water: how deep the water is (deeper is bluer). |
| Caustics | Clear water: strength of the focused sunlight. |
| Relief | Vertical exaggeration: how steep the waves look, so how strongly they shade, bend and colour every look. |

**Water**

| Control | What it does |
| --- | --- |
| Wave speed | How fast waves travel: from about half the default speed to about double (c² 0.025-0.45, capped for stability). |
| Wave life | How long waves survive before damping out. |
| Rain | Random droplets, so the pool is never dead still. |
| Detail | Fineness of the water grid: finer makes smaller waves relative to the screen, at more GPU cost. Changing it stills the water. |

**Camera**

| Control | What it does |
| --- | --- |
| Mirror | Flip the camera horizontally — on for a mirror-facing screen, off for projection. |
| Framing | Fill the screen (crops what does not fit — on a tall phone, the sides of the picture), or show the whole picture with water-only margins. |
| Invert mask | Swap body and water. Set automatically on the first frames with someone in them (the top corners of the picture are taken to be background), unless you change it by hand. |
| Edge softness | How much the contour is smoothed each frame (0–1). |
| Mask easing | Temporal smoothing of the mask: low is calm but laggy, high is responsive but jittery. |
| Show mask preview | Thumbnail of what the segmenter sees. |

**Sound**

| Control | What it does |
| --- | --- |
| Sound | Sound on or off. |
| Volume | Overall level. |
| Water | Level of the water wash. |
| Slush | How much the water surges and opens up on its peaks (the resonators surge with it). |
| Resonators | Level of the water made to sing. |
| Voices | How many resonators sing at once (1-4). Following movement speed, the chord built on the speed's note: each voice adds every other scale note above it, each quieter. |
| Clarity | Width of the resonators: low is water with a colour, high is a pure singing tone. |
| Pitch | What picks the resonators' notes: ripple size on the scale, ripple size gliding freely, or how fast the body moves (against its own usual pace), on the scale. |
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
  most. The lowest note is a fixed, comfortably slow pace (0.1 screens per
  second); the highest is the body's own fast movement, the ~95th percentile
  of its speed learnt over roughly 30 seconds of moving, kept between 0.4 and
  0.8. Only the top adapts, because a phone at arm's length reads the same
  gesture as several times faster than a laptop's webcam across the room (on
  a fixed scale every movement sang at the top). Adapting the middle instead
  chased the player: slowing down to sing low, the middle followed within
  seconds, and the low notes took slower and slower movement. The note follows
  the speed over ~0.2 s, so a flick of the hand does not fling it to the top,
  and a note the lead has moved on from fades in ~0.3 s, so one voice is one
  note at a time. The flicker of a still body's edge is measured on a
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
  ping-ponged `RGBA16F` targets. The passes that step the water read their own
  grids through a nearest-cell sampler: on a Pixel's PowerVR GPU, linear
  filtering of half floats is up to 1.5% off even at a cell's centre.
- No early returns on per-cell conditions in the wave step: the same GPU's
  compiler mishandled one (the off-the-grid test) and dropped the neighbour
  above almost every cell, which made the pool gain energy and fill with short,
  even stripes within a quarter of a second.
- Debugging, from the console: `__water.read('sim' | 'mask', x, y, w, h)`
  returns raw texture values, `__water.zoneStats()` the sound grid,
  `__water.step(ms)` advances one frame by hand, and `__water.audio.rms()` meters
  the mix.

## Requirements

WebGL2 with `EXT_color_buffer_float` (any current desktop browser), a webcam,
and an internet connection the first time, to fetch the segmentation model.

Phones and tablets get the same grid budget as a laptop (~285 cells across
the short side). Waves cross a fixed number of cells per frame, so a coarser
grid (phones once had ~120 cells across) makes them cross the screen faster:
at 60 fps that was ~2.3x a laptop's pace. A Pixel runs the full grid at ~58
fps; Detail trades it down on slower phones. The panel starts tucked behind a
**Controls** button, and the camera is asked for its own mode closest to the
screen's shape, rather than being cropped to it by the browser. The
camera needs https, so use the live link. If the camera is refused, sends
nothing, or gets switched off (screen locked, another app), a notice says so,
and tapping it restarts the camera. If body detection on a phone's GPU returns
nothing but empty masks for a few seconds, it switches to the CPU by itself.

Body detection on a phone runs in a Web Worker (`src/segworker.js`) on frames
shrunk to 384 pixels: it takes ~70 ms a mask on a Pixel's CPU, and on the
page's own thread that held the water to it. Measured on a Pixel: the water and
drawing take ~3 ms a frame, so it runs at 60 fps, with ~11 new masks a second
that the mask easing glides between. (Before: 8 fps, with the full 2560×1280
camera frame segmented on the page.)

On phones the notes start an octave up, at A3 (220 Hz) rather than A2: a
phone's speaker hardly plays below ~200 Hz, so the bottom octave was sung but
not heard. On iPhone, the ring/silent switch mutes the sound.

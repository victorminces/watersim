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
| Look | Water only (body is an empty void), or the camera image seen through the refracting water. |
| Palette | Colour scheme, switchable live. |
| Wave speed | Propagation speed (c², capped at 0.45 for stability). |
| Wave life | How long waves survive before damping out. |
| Ripple push | How hard contour motion drives the water. |
| Relief | Vertical exaggeration — contrast of the shading. |
| Refraction | Bend of the camera image under the waves (second look only). |
| Rain | Random droplets, so the pool is never dead still. |
| Detail | Fineness of the water grid: finer makes smaller waves relative to the screen, at more GPU cost. Changing it stills the water. |
| Mirror | Flip the camera horizontally — on for a mirror-facing screen, off for projection. |
| Invert mask | Swap body and water, if segmentation comes back the wrong way round. |
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
| Pitch | Snap to the scale, or glide freely with the ripple spectrum. |
| Scale | Scale to snap to: major or minor pentatonic, Hirajoshi, Dorian, Lydian. |

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

On phones and tablets it uses a lighter grid (384×216 cells, 10 wave steps a
frame; the Detail slider trades fineness for speed) and starts with the panel
tucked behind a **Controls** button. The camera's natural picture is used and
framed to fill the screen without cutting off more than a fifth of it; past
that, water fills the margins instead of the picture being zoomed in. The
camera needs https, so use the live link. If the camera is refused, sends
nothing, or gets switched off (screen locked, another app), a notice says so,
and tapping it restarts the camera. On iPhone, the ring/silent switch mutes the
sound.

# Water Contour

Top-down surface waves, in the browser. The webcam finds a person's silhouette;
there is no water where the body is, and the water reacts to its contour.

## Run

Needs a local server (ES modules and camera access do not work from `file://`):

```powershell
python -m http.server 8123
```

Then open <http://localhost:8123/>. Click **Start camera**, or **Run without
camera** to drive the water with a procedural stand-in silhouette.

## Controls

`H` hides the panel · `F` fullscreen · `C` calms the water · click or drag on
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
| Mirror | Flip the camera horizontally — on for a mirror-facing screen, off for projection. |
| Invert mask | Swap body and water, if segmentation comes back the wrong way round. |
| Edge softness | How much the contour is smoothed each frame (0–1). |
| Mask easing | Temporal smoothing of the mask: low is calm but laggy, high is responsive but jittery. |
| Show mask preview | Thumbnail of what the segmenter sees. |

## How it works

- `src/segmenter.js` — MediaPipe Tasks Vision selfie segmenter, loaded from a
  CDN, giving a per-pixel person mask. The video never leaves the machine.
- `src/shaders.js` — four fragment shaders: ease the mask and measure its
  per-frame change; splat point impulses; step a damped 2-D wave equation on a
  height field; shade the result.
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
- Debugging: `__water.read('sim' | 'mask', x, y, w, h)` in the console returns
  raw texture values.

## Requirements

WebGL2 with `EXT_color_buffer_float` (any current desktop browser), a webcam,
and an internet connection the first time, to fetch the segmentation model.

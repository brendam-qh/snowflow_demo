# SNOWFLOW (Webcam version)

A real-time tech demo: a compute-driven river cut through a procedural snow
valley. WebGPU, Babylon.js, hand-written WGSL. Everything you see is generated
on the GPU at load time — there are no textures, no meshes, no HDRIs and no
animation data in this repository.

**▶ [riverwalk.qualityhealth.app](https://riverwalk.qualityhealth.app/)**

> Requires a WebGPU-capable desktop browser (Chrome/Edge 113+, Firefox 141+,
> Safari 26+) and a discrete or recent integrated GPU. There is no WebGL
> fallback by design — if `navigator.gpu` is missing the page says so and stops.

---

## Controls

| | |
|---|---|
| Click | capture the pointer |
| `W` `A` `S` `D` | move, relative to the camera |
| Mouse | look · **Wheel** zoom |
| `Shift` | sprint |
| **Right mouse (hold)** | snow-surf — carve across the field and throw a wake |
| `1` – `5` | the five spells (`2` is a held cast) |
| `F1` or `` ` `` | settings and performance overlay |
| **ⓘ button** (bottom-left) | controls reference for keyboard, mouse, and gestures |
| **Webcam** | head-look — turn your head to pan the view (`R` or click the preview to recenter) |
| **Right palm** | walk · lean to steer · raise to sprint · **thumb extended** to snow-surf · **tilt thumb** to steer the carve |
| **Left hand** | palm forward: water push · victory: water stream (hold) · thumb up: tower column · thumb down: ice spikes · closed fist (hold): vortex |

---

## Webcam tracking

With camera permission granted, the demo tracks your face and hands (MediaPipe
tasks-vision, models vendored in `public/models/` — nothing leaves the machine).
Turning your head pans the camera as an absolute, self-centering offset on top
of mouse look, and the avatar's head follows your gaze. Gestures drive
locomotion and spells; keyboard and mouse keep working throughout, and the
gesture layer only owns movement while a hand is actually tracked (hands out of
frame for ~250 ms and the character stops). Turn it off with "Webcam control"
in the F1 panel, or deny camera permission — the demo is unchanged.

`?track=mock` swaps the webcam for a scripted pose source (used by the
Playwright smoke test, `npm run test:e2e`; unit tests for the mapping logic run
with `npm test`).

The overlay exposes every art parameter as a live slider — sun angle, wind
bearing, subsurface radius, deformation depth, tonemap curve, exposure — plus a
frame-time graph with median / 95th / 1% low, draw calls, triangles and a
per-system CPU breakdown. Every system can be toggled off individually, and
there are debug views for normals, depth, cascade coverage, the deformation
buffer and the raw shadow map.

---

## What it does

### Terrain

A nested-ring geometry clipmap: 8 rings, 8.5 cm inner spacing, ~870 m radius,
333k triangles — **one static mesh, one draw call**. Vertices carry only
`(gridIndex, ringLevel)`; world placement, CDLOD morphing and displacement all
happen in the vertex shader, so there is no CPU rebuild and no per-frame upload.

The heightfield underneath it is layered gradient noise with analytic
derivatives, anisotropic about a single prevailing wind: broad transverse dune
ridges, a long low swell, medium drifts sheared along the wind for lee-face
asymmetry, and sparse rock outcrops. It bakes once into a 4096² RG32F texture
and is mirrored back to the CPU, so character grounding samples exactly the
surface that is drawn rather than a re-implementation of it.

### Snow shading

Multi-scale normals — baked macro slope, analytic sastrugi and ripples, three
tiled detail scales, triplanar on steep faces — over wrapped diffuse, a
back-scatter subsurface term with depth-dependent blue tint, GGX specular, SH
ambient with a solved snow bounce, and procedural view-dependent glints gated on
grazing angle. Compression, wetness and ice are surface state channels the
material reads rather than separate materials.

Shadows are three hand-rolled cascades with world-space PCSS — blocker search,
penumbra estimate, rotated Poisson filter — texel-snapped in world space and
stabilised against a rotation-invariant bounding sphere. Babylon's own cascade
generator can't be used here: the terrain has no CPU geometry matching what is
drawn, so every caster registers the vertex program it is actually rendered
with.

### Deformation

A persistent, additive terrain state buffer: two 2048² RGBA16F targets covering
80 m (3.9 cm texels), ping-ponged by a single full-screen pass per frame that
scrolls, relaxes and splats in one dispatch. Addressing is toroidal — a texel's
UV is `fract(worldXZ / size)` — so the window follows the player without ever
copying the buffer, and newly exposed texels are detected and zeroed by the same
pass.

Channels are depression depth, displaced mass, compression and ice. That second
channel is what separates a trail with raised berms from a flat footprint decal.
Refill is anisotropic diffusion (loose berms slump three times faster than a
packed trench floor) plus berm-into-depression slump, wind-driven infill from
upwind, and slow exponential decay: **~71% of trail depth survives a minute**,
visibly spreading and softening as it goes.

The displacement is real geometry in the beauty pass *and* in all three shadow
cascades through one shared include, so trails self-shadow and berms break the
silhouette. Feet, the surf wake and all five spells write through one `brush()`
call into the same buffer.

### The character

Fully procedural — no rig file, no animation clips, no authored mesh. An 18-bone
skeleton whose bind pose is a table of numbers, geometry lofted from that table
at load (cowl, torso, arms, trousers, boots, belt), and locomotion solved from
the motion state rather than played back.

Feet plant. A distance-driven stance/swing machine writes a foot's world
position exactly once, on touchdown, and holds it absolutely fixed while
two-bone IK reaches for it — a planted foot cannot slide because nothing in the
code is able to move it. Gait phase advances with ground travelled, so stride
length and ground speed are the same number by construction.

The garments are Verlet cloth on four panels with distance, bending and
shape-memory constraints, nine body collision capsules, and a hem that rides the
snow surface. Folds live in the rest shape rather than in a normal map. The
36×12 solve renders as a 72×32 surface through Catmull-Rom reconstruction in the
vertex shader, so tessellation and simulation cost are fully decoupled. Shell
fur at the hood rim and cuffs is a partial torus emitted 22 times and
alpha-tested against a hashed strand field.

One small texture carries everything to the GPU: rows 0–3 are bone matrices,
rows 4+ are simulated cloth nodes. One upload per frame, no allocation.

### Snow-surf

The wake is a **swept mesh, not a particle effect**. Its spine is the path the
board has taken, resampled every 30 cm into a 96×3 data texture; the mesh itself
is a static lattice of `(column, row, side)` and every vertex is placed in the
vertex shader, so a 19-metre wake and a 2-metre one cost the same buffer and the
same 4.6 KB upload.

The cross-section is a breaking wave integrated from a turning tangent — the
tangent sweeps from just below horizontal at the base to 284° at the tip, so one
`curl` parameter runs continuously from a low heaped bank to a lip that hangs
back across its own face. Amplitude and curl resolve per side from the carve, so
the outside of a turn takes nearly all the snow. Peak wall is 2.4 m at a
full-speed carve and collapses 0.88 s after it is laid, which makes wake length
`life × speed` with no second constant. Normals are differenced out of the same
`wakePoint` the geometry uses, so they cannot disagree with it.

Two spray populations come off the same spine — a dense slow curtain hugging the
crest and ballistic grains flung clear — emitted at *fractional* positions along
it, plus screen-space speed streaks and camera shake on a loaded edge.

### The five spells

One water material, one mesh, one draw, eight strands. Four of the five move a
coherent body of water and are structurally the same object: a swept surface
along a spine with a radius, a parallel-transported frame and a foam channel —
the same construction as the surf wake. A strand that is not in use is switched
off by zeroing its rows, so the draw count does not depend on how many spells
are up.

1. **Sweep** — a crescent of slush rises out of the ground and runs outward,
   ploughing a channel and throwing berms.
2. **Ribbon** — a held stream tracking the hand and camera aim, drawing
   precessing figure-eights and scoring thin curved lines into any snow it
   skims. Released, the head steers onto the aim and accelerates, so the water
   arcs onto the target with the bend it had at release still travelling out
   along the tail.
3. **Bloom** — a targeted eruption: a crater with a raised rim, a waisted column
   that rises and withdraws down its own axis, and four seconds of fallout
   curtain lit from below.
4. **Crystallise** — hexagonal prisms grown along a golden-angle spiral,
   alpha-blended *and* depth-writing, so you see the snow through the ice but
   never one prism through another. Facet normals come from screen-space
   derivatives, so every facet is exactly flat and every edge exactly hard.
5. **Vortex** — three helices of lifted snow winding around the player, with the
   airborne mass emitted along those same helices at their own tangential
   velocity. The only system here that writes a *negative* depression.

Refraction needs no scene copy and no second opaque pass: the sky LUT already
stores the solved snow bounce below the horizon, so one lookup along the
refracted ray is a physically-derived estimate of what is behind the water in
any direction. Three lookups at three indices of refraction give the chromatic
dispersion, and absorption over the path length gives the tint.

Four pooled dynamic lights are declared per frame, and every one of them runs
the identical `snowSubsurface` the sun runs — so a spell lights the snow
*through* a berm crest rather than putting a bright patch on the near face of
it. The snow, the robe, the wake, the airborne spray, the water and the ice all
read the same pool out of one include.

### Sky and atmosphere

A Nishita single-scattering integration with a multiple-scattering
approximation and an iteratively-solved snow bounce, baked into an
equirectangular LUT plus SH irradiance and mip-based specular. Analytic rather
than a captured HDRI because the whole look hangs on a sun 10–15° up: with a
model, the elevation slider correctly drags the horizon warmth, the zenith
gradient, the ambient tint and the direct sun colour along with it.

The far range is a heightfield raymarched on the skybox — no geometry, behind
everything by construction, with analytic normals, ridges occluding ridges, and
a second short march toward the sun for its own cast shadows. It is lit by the
snow field's own material logic and hazed by the same single atmosphere, so the
two meet at one colour instead of two.

### Post-processing

A camera-space depth prepass (linear view depth carried as a varying, plus a
specular mask) feeds the whole chain:

- **TAA** — Halton(2,3) jitter written straight into the projection and frozen
  for the frame, so the prepass and the beauty pass agree to the subpixel.
  Depth-based reprojection, variance clipping, and a five-tap Catmull-Rom
  history fetch.
- **Bloom** — three levels, thresholded in *exposed* units so only the sun disc,
  the glints and lit spray reach it. Karis-averaged on the prefilter.
- **Volumetric light shafts** — integrating sky visibility out of the prepass
  along the ray to the sun. They fade themselves out entirely at a high sun.
- **Depth of field** — deliberately slight, focal plane tracking the spring
  arm's own length, weighted by each tap's own circle of confusion.
- **Screen-space reflections** — on ice only, gated on the prepass mask, so the
  pass is a fetch and a branch on any frame where nobody has cast Crystallise.
- **AgX / ACES tonemapping**, contrast-adaptive sharpen, grain, vignette.

---

## Performance

Measured with WebGPU timestamp queries at 2560×1440 on Chrome / Windows 11 /
RTX 5070 Ti, with every system running:

| | |
|---|---|
| GPU frame | **3.22 ms** |
| — base scene (clipmap, snow, 3 cascades, sky, character, deformation, prepass) | 1.64 ms |
| — post chain | ~1.1 ms |
| — far range | ~1.2 ms |
| — character (skeleton, cloth, fur, spray) | < 0.02 ms |
| Draw calls | 15–19 |
| Triangles | ~353,000 |
| Headroom against a 90 FPS budget | **7.9 ms** |

Nothing allocates in the render loop. Every buffer is sized at construction,
every per-frame write goes into a pre-allocated typed array, and every material,
procedural texture and render pipeline is explicitly `isReady()`-gated and
exercised with real geometry behind the loading screen — so the first cast of a
spell does not compile a pipeline mid-frame.

VRAM is roughly 350 MB: a 4096² height texture, two 2048² deformation targets,
three 2048² shadow cascades, and the sky and detail LUTs.

---

## Running locally

```bash
npm install      # gated by .npmrc `before=` — see note below
npm run dev      # vite dev server on :5173
npm run build    # production build into dist/
npm run preview  # serve the production build
```

`.npmrc` pins `before=` so npm will not resolve any release published inside the
last 7 days (the repo-wide supply-chain rule — see the root README). It is a
fixed date, not a rolling window: bump it deliberately when you need newer
packages, and never automatically.

## Layout

```
src/
  main.js            entry point and frame orchestration
  core/              settings, input, camera rig, perf, loading, GPU helpers
  terrain/           heightfield, clipmap mesh, deformation state buffer
  render/            sky + IBL, shadow cascades, depth prepass
  character/         skeleton, procedural geometry, cloth solver, snow contact
  vfx/               pooled particles, the snow-surf wake
  spells/            the five spells, the shared water body, the light pool
  post/              the post-processing chain
  ui/                settings and performance overlay
  shaders/           all WGSL — lib/ holds the shared includes
```

## Assets and licences

There are no third-party assets. Every texture, environment map and piece of
geometry in the running demo is generated at load time on the GPU: the sky is an
atmosphere integral, the snow grain and terrain are noise, the character is
lofted from a table of numbers, and the fabric weave and fur strands are
evaluated in the fragment shader.

Runtime dependencies are `@babylonjs/core` and `@babylonjs/materials`
(Apache-2.0). The only build dependency is Vite (MIT), which does not ship in
the output.

## Credits

This is a fork of SNOWFLOW, copyright (c) 2026 Maksymilian
Dendura — the terrain clipmap, snow shading, character rig, spell system and
post chain are all upstream work. This fork adds the river: a baked
channel through the heightfield, a PIC/FLIP fluid solver on compute, and a
screen-space fluid rendering pass for the surface. See [DECISIONS.md](DECISIONS.md)
for what was changed and why.

This project is released under the [MIT licence](LICENSE), and retains the
upstream copyright notice.

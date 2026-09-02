# How I added webcam control and a river to SNOWFLOW

SNOWFLOW is Maksymilian Dendura's WebGPU demo: a character walking across a procedural snow field, carving it up and throwing spells at it, with nothing shipped as an asset. No textures, no meshes, no HDRIs, no animation data. It's all generated on the GPU at load time.

I cut a river through the valley and put a fluid solver in it, then added face and hand tracking so you can walk and cast without touching the keyboard. This is the technical writeup: what changed, in the order it happened, and what broke on the way.

## The river

The channel is baked once at boot, the same way the dune heightfield is. `riverness`, `riverWidth`, `riverDepth` and `riverFlowDir` feed the bake, which means changing them at runtime needs a re-bake, which I deferred. Re-baking on every slider drag would tank the load screen.

The default width went from 1.0 to 0.35. At 1.0 the original was a wide basin; at a third of that, the banks actually frame the water as a channel. I dropped the slider minimum from 0.4 to 0.15 so the new default wasn't pinned at the floor.

The first version of the surface shader rendered almost invisibly. A controlled A/B put it at three coarse cells out of 48 differing, a uniform +9 luma of grey. Three things were wrong at once. The sky-Fresnel cap of 0.78 saturated at the glancing spawn view and turned the water into a sky mirror. The deep tint was navy rather than teal. And the refracted-snow pull at 0.45 washed what teal remained against the already-teal wet bed underneath. Deepening the absorption to (4.6, 1.0, 0.42), repointing the tint green-dominant, dropping the Fresnel cap to 0.08 and cutting the refracted-snow mix to 0.12 got the water sampling (24, 52, 67) at depth. It looks like water now.

The PRD asked for smoothed-particle hydrodynamics (SPH) or a particle-in-cell / fluid-implicit-particle hybrid (PIC/FLIP), either being in spec. I went with PIC/FLIP. For a steady channel with open inflow and outflow and a character wading through it, it's more stable, less compressible and cleaner at the boundaries, and SPH's neighbour-search machinery buys nothing at this scale.

The PRD wanted `shader-f16` as a hard requirement. I made it optional. If the adapter doesn't have it, and Safari is the primary target so that's a real case, the solver falls back to f32 with a console warning. A missing extension shouldn't mean no water at all. Two names also had to change on the way in: `enable` and `cross` are reserved or built in, and WGSL won't let a function of mine use either.

The grid solve runs on a `ProceduralTexture`, ping-ponging two RGBA textures, which is exactly the pattern the existing deformation sim already used — no new infrastructure. The particles are the half that genuinely needs `StorageBuffer` and `@compute`, because a fragment pass has no `atomicAdd` and you can't express particle-to-grid scatter cleanly without one. That's the repo's first compute shader.

The particle renderer is still 16,000 camera-facing billboard quads rather than a proper screen-space fluid rendering (SSFR) pass, and the billboards currently render through the terrain, so the depth-stencil setup is wrong somewhere. It's gated behind `S.fluidMode === "full"` and off by default.

## A bug that was in the original

`heightBake.fragment.wgsl` declared `vary vUV: vec2f;`. That's a typo for `varying`, and Babylon's WebGPU Shading Language (WGSL) preprocessor only rewrites `varying`, so the bare `vary` reached the compiler untouched and the RG32F heightfield bake never ran. The CPU mirror stayed null, the character floated at y=0, and the terrain quietly lost its macro displacement.

The typo is in the upstream commit too. It never showed up there because the deploy picked a less strict WGSL parser.

## Hands instead of keys

The webcam layer is about a hundred lines of MediaPipe glue plus the mapping logic. I put it in this repo rather than bridging it from the sibling React app: that app is React and Three.js, this one is vanilla JavaScript and Babylon, and a postMessage bridge would have added latency and a second app to run for no reuse worth having.

Both models run in one loop at about 30 Hz, driven by a `setTimeout` rather than the render loop, so inference never sits inside a frame's budget. It watches its own cost with a smoothed average, and if a combined face-plus-hands pass ever goes over 25 ms it degrades to alternating: face on even passes, hands on odd. Both stay alive at half the rate instead of one of them eating the frame.

The dependency is pinned exactly, to `@mediapipe/tasks-vision@1.0.0-rc.20260727`. The repo's supply-chain gate refuses anything published after 2026-07-28, and that release candidate, published on the 27th, is the newest that clears it.

Head-look is an absolute offset applied where the camera rig composes its transform, not a projection change. True off-axis projection fights temporal anti-aliasing jitter, the post chain and the shadow passes. Composing an offset leaves every pass alone and self-centres for free: turn back to the screen and the view comes back with no drift. The offset is your head angle times a gain of 2.2, clamped to about 60 degrees and damped toward its target, measured against a neutral captured the first frame your face appears. `R` recaptures that neutral, and so does clicking the webcam preview. `getFlatForward` and `getFlatRight` compose that same offset, so W walks down the direction you're actually looking. I had it the other way at first, on the theory that head movement should never steer the character, but coupling them reads better: you lean into a turn and the character goes with you. The offset self-centres, so W comes back on its own.

Gestures write into the same `input` struct the keyboard writes to, immediately after `pollInput()`. One seam, one arbitration point. The gesture layer owns movement only while a hand is confidently tracked, and when the hands leave frame for 250 ms it zeroes exactly what it owns and releases any held spell. Stale input can't run the character off a dune.

The models are vendored into `public/models` rather than pulled from a content delivery network, so nothing about the tracking touches the network. They're also the first third-party assets in the repo, and the rendered world is still entirely procedural. The `.task` files are machine-learning models, not art.

## Gestures, wrong twice

The right hand does locomotion. An open palm walks. Rolling that palm steers, with nothing inside about 15 degrees and full deflection at 45, so a hand that isn't quite level doesn't drift you sideways. Raise the palm above the shoulder line, which the face landmarker's nose point puts across the frame, and the character sprints.

The right hand surfs when the thumb is out. That started as MediaPipe's `Thumb_Up` category and it kept dying mid-carve, because tilting the thumb about 15 degrees is enough for the recognizer to drop the label. I replaced it with a landmark check: the distance from the thumb's knuckle to its tip, 0.07 in normalised image coordinates. A curled thumb measures about 0.045, an extended one about 0.11. Direction-agnostic on purpose, so the tilt is free to mean something else, and it does — it steers the carve.

That worked, so I did the same thing to the five left-hand spells, and that was the wrong lesson. Pinch, swipe-right, palm-up: each one was a hand-written landmark heuristic, each one had a threshold to tune, and each one had to be taught to anyone who sat down. I put them back to the categories the recognizer already knows. Victory holds the water stream, thumb up throws the tower column, thumb down drops the ice spikes, a closed fist held for 100 ms opens the vortex. Only the water push still reads landmarks, because "palm toward the camera" isn't one of the categories.

Going back deleted a swipe-velocity tracker, a pinch detector, a palm-up detector and every constant they needed.

One bug fell out of the rework. Spells confirm on two consecutive sightings and then disarm, and the disarm was lasting exactly one frame: the code reset the pending spell to zero on firing, and the very next frame read that zero as "nothing in flight" and re-armed. Holding a pose cast every third frame, about twenty casts a second. The layer now stays disarmed until the hand leaves the pose. There's a test that holds a pose for two seconds and asserts one cast.

## Fixing the wave simulation in the river

The water push draws a crescent of slush whose base sits 13 cm under the ground, so the wall meets the trench it's cutting instead of floating on top of it. On open dunes it's the best-looking spell in the demo.

At the spawn it was invisible. The character stands on the bank about two metres above the waterline, and the crest was tracking the terrain down the bank and out along the lake bed, ending up a metre *below* the water surface. All you saw was the spray.

The base now falls with the ground at most a metre below the height it was cast from, and then holds. Nothing changes on flat or rising ground. It reads over the water now, though dimly: a translucent slush sheet against a dark lake will never pop the way it does against snow. Fixing that means more foam on the leading edge, which is a change to the material rather than the geometry.

## The camera was looking at the character sideways

The spawn used to be a hardcoded 50 m along the perpendicular. The bed meanders, so at the spawn's own cross-section the channel centre had wandered about 85 m off, and the first frame of the demo showed a thin wedge of river up in one corner. It now scans that perpendicular for the deepest point, walks outward until the ground rises above the waterline at -15, and drops the character three metres past the higher of the two shores, looking at the bed centre.

That fixed the composition and left the character facing the wrong way. The spawn code set `rig.yaw`. It never set `character.facing`, which stayed at zero, so you opened on a stranger standing side-on to the lens.

Setting both fixes it. While I was in there the arm came in from 6.2 m to 4.6, the pitch came down from 0.17 to 0.10, and the pivot dropped from the crown of the head to the chest at 1.45. It's an over-the-shoulder framing now instead of a drone shot.

## Testing something you can't look at

The mapping logic is pure functions over a landmark array, so it runs under `node --test` with no browser: 54 unit tests covering the steering curves, the confirm-and-re-arm gate, and every spell trigger.

Above that, `?track=mock` swaps the webcam for a scripted pose source. The script is a list of `[seconds, command, args]` that walks the character, steers, surfs, and then casts all five spells in one 14-second cycle, and Playwright asserts each one fired by reading a lifetime counter. `spellPressed` lives for exactly one frame, which makes it invisible to polling, so the counter exists for this test to have something to read.

Playwright runs headed by default. Headless Chromium's WebGPU adapter can create a device but can't present to a canvas, so the demo doesn't boot there at all. `E2E_HEADLESS=1` forces headless for continuous integration, where the test skips itself if boot fails rather than going red.

There's also a unit test that runs the mock script through the real gesture driver at a simulated 60 Hz and asserts all five spells fire. Without it, the end-to-end test would happily go green on a script that had stopped casting anything.

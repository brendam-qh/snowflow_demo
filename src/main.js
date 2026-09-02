/**
 * SNOWFLOW — entry point and frame orchestration.
 *
 * WebGPU only, by design. No WebGL path, no feature-detect branches: if the
 * adapter isn't there we say so once and stop.
 */

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// Side-effect import: installs `captureGPUFrameTime` / `getGPUFrameTimeCounter`
// onto the engine prototype, which is what makes the overlay's GPU row a real
// GPU number rather than the presentation cadence.
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery";
// Side-effect import: installs `createComputeContext` + the compute dispatch
// path onto the WebGPU engine. Without this, `new ComputeShader()` throws
// `engine.createComputeContext is not a function`. Same pattern as the
// timeQuery import above.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader.js";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange } from "./core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "./core/perf.js";
import { initInput, pollInput, endFrame, input } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { Character } from "./character/character.js";
import { SnowContact } from "./character/snowContact.js";
import { SprayField } from "./vfx/particles.js";
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { Overlay } from "./ui/overlay.js";
import { GestureHelp } from "./ui/gestureHelp.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { RiverSurface } from "./fluid/riverSurface.js";
import { ParticleSolver } from "./fluid/particleSolver.js";
import { ParticleRenderer } from "./fluid/particleRender.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";
import { initTracking } from "./tracking/tracker.js";
import { initMockTracking } from "./tracking/mockTracker.js";
import { initTrackingUi } from "./tracking/trackingUi.js";
import { applyTracking } from "./tracking/applyTracking.js";
import { spellStats } from "./tracking/gestures.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new Vector3();

async function boot() {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    if (!navigator.gpu) {
        loading.fail("WebGPU is not available in this browser.");
        return;
    }

    await loading.phase("creating device", 0.05);

    const engine = new WebGPUEngine(canvas, {
        antialias: false, // TAA handles edges; MSAA here would just cost bandwidth
        stencil: false,
        powerPreference: "high-performance",
        enableAllFeatures: true,
        setMaximumLimits: true,
    });

    try {
        await engine.initAsync();
    } catch (err) {
        console.error(err);
        loading.fail("WebGPU device initialisation failed.");
        return;
    }

    // The heightfield is R32F and is filtered in the vertex shader, which needs
    // this feature. Every desktop GPU that can run this demo has it.
    const filterable = engine.getCaps().textureFloatLinearFiltering;
    if (!filterable) {
        console.warn("[snowflow] float32-filterable unavailable; height will step");
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    installDrawCounter(engine);
    // WebGPU timestamp queries. The engine is created with `enableAllFeatures`,
    // so `timestamp-query` is on wherever the adapter has it; if it does not,
    // the counter simply stays at zero and the overlay shows a dash.
    engine.captureGPUFrameTime(true);
    registerShaders();

    await loading.phase("building scene", 0.12);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    scene.autoClear = true;
    // Do NOT clear depth between rendering groups. Babylon clears depth before
    // every group by default; here group 1 is the opaque scene and group 2 is
    // the alpha-blended water and spray, which must depth-test against it.
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    // No stock lights: every material here computes its own lighting.
    scene.ambientColor = new Color3(0, 0, 0);

    // Derived river-bank spawn geometry — flow direction drives the spawn foot
    // offset and the initial camera yaw, so a settings change re-grounds
    // correctly on reload. Only the trig is computed here; the actual bank-lip
    // position is scanned off the baked heightfield after `terrain.build()`,
    // because the bed meanders and a fixed perpendicular offset (the old
    // `BANK_OFFSET = 50`) landed the character mid-slope with the channel
    // wandering out of frame rather than the "water across the foreground,
    // opposite bank up top" framing the design calls for.
    const _flowAng = (S.riverFlowDir * Math.PI) / 180;
    // Perpendicular to flow, pointing to one bank.
    const _perpX = -Math.sin(_flowAng);
    const _perpZ = Math.cos(_flowAng);

    const rig = new CameraRig(scene, canvas);
    scene.activeCamera = rig.camera;
    // Yaw + pitch are finalised after the bed scan below; defaults stand until
    // then and only matter once the run loop starts calling `rig.update`.

    // ------------------------------------------------------------------ sky
    await loading.phase("integrating atmosphere", 0.2);
    const sky = new Sky(scene);
    sky.mesh.renderingGroupId = 0;
    await sky.solve();

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(scene);

    // The camera-space depth prepass. It is a custom render target, and the
    // scene renders those in registration order — so creating it here, after
    // the cascades and before anything that draws, is the whole of the
    // scheduling.
    const depthPass = new DepthPass(scene);

    // -------------------------------------------------------------- terrain
    await loading.phase("baking heightfield", 0.34);
    const terrain = new Terrain(scene, sky, shadows);
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    // -------------------------------------------------------------- river
    // MVP surface. Phase B will add the SPH solver underneath; the surface stays.
    await loading.phase("filling the channel", 0.55);
    const river = new RiverSurface(scene, sky);
    onChange(["showRiver", "showRiverSurface"], () =>
        river.setEnabled(S.showRiver && S.showRiverSurface)
    );

    await loading.phase("placing character", 0.62);

    // Spawn on the river's bank so the first frame puts the carve framing the
    // channel: water across the foreground, the opposite bank up top. The bed
    // meanders, so the character is not placed at a fixed perpendicular offset
    // — instead the baked heightfield is scanned along the perpendicular
    // through `along = 0` to find the deepest point (the bed centre), and the
    // spawn is dropped on the bank lip on whichever side has firmer ground.
    const character = new CharacterController(terrain);
    let spawnX = 0, spawnZ = 0, yaw = Math.atan2(-_perpX, -_perpZ);
    // Bed centre at along = 0, used for both spawn framing and the SPH grid AABB.
    let bedCenterX = 0, bedCenterZ = 0;
    if (S.showRiver) {
        // Scan across the channel at along = 0 (world point = across * perp)
        // to find the deepest point — the bed centre.
        let bedAcross = 0, bedDepth = Infinity;
        for (let across = -150; across <= 150; across += 2) {
            const wx = across * _perpX;
            const wz = across * _perpZ;
            const h = terrain.heightAt(wx, wz);
            if (h < bedDepth) { bedDepth = h; bedAcross = across; }
        }
        bedCenterX = bedAcross * _perpX;
        bedCenterZ = bedAcross * _perpZ;
        // Walk outward from the bed centre on each side until the ground rises
        // above the water surface (`waterY`). That crossing is the shoreline;
        // standing a few metres past it puts the character on the bank looking
        // down at the water rather than wading in it.
        const WATER_Y = -15;
        const shore = (sign) => {
            for (let r = 4; r <= 160; r += 2) {
                const across = bedAcross + sign * r;
                const h = terrain.heightAt(across * _perpX, across * _perpZ);
                if (h > WATER_Y) return { across, h };
            }
            return { across: bedAcross + sign * 60, h: -999 };
        };
        const sp = shore(+1), sm = shore(-1);
        // Pick the higher shoreline — the meander can beach one side and leave
        // a proper bank on the other.
        const shorePick = sp.h >= sm.h ? sp : sm;
        const charAcross = shorePick.across + (shorePick.across > bedAcross ? 3 : -3);
        spawnX = charAcross * _perpX;
        spawnZ = charAcross * _perpZ;
        // Look from the bank toward the bed centre (flat on XZ).
        const dirX = bedAcross * _perpX - spawnX;
        const dirZ = bedAcross * _perpZ - spawnZ;
        yaw = Math.atan2(dirX, dirZ);
    }
    character.position.set(spawnX, 0, spawnZ);
    character.position.y = terrain.heightAt(character.position.x, character.position.z);
    rig.yaw = yaw;
    // The figure faces where the camera looks, so the first frame is the
    // over-the-shoulder framing the rig holds for the rest of the session —
    // not a stranger standing side-on to the lens.
    character.facing = yaw;
    // Barely pitched: the water lies across the lower frame and the opposite
    // bank across the upper without the rig climbing over the figure's head.
    rig.pitch = 0.10;

    // ------------------------------------------------------------- fluid (M3)
    // The PIC/FLIP hybrid solver. Grid AABB centered on the bed centre, sized
    // to cover the channel window — ±200m along flow, ±100m across. The grid
    // solve uses the `riverChannel` analytic to identify the bed within this
    // box, so cells outside the channel are simply empty. Gated by
    // `S.fluidMode` — "off" = kinematic MVP surface only.
    let solver = null;
    let particleRender = null;
    if (S.fluidMode !== "off" && S.showRiver) {
        await loading.phase("building fluid solver", 0.7);
        const GRID_EXTENT = 200;
        solver = new ParticleSolver(scene, terrain, {
            origin: [bedCenterX - GRID_EXTENT, bedCenterZ - GRID_EXTENT],
            size: [GRID_EXTENT * 2, GRID_EXTENT * 2],
        });
        particleRender = new ParticleRenderer(scene, solver, depthPass, sky);
        // Through `setEnabled`, not `mesh.isVisible`: the particle mesh is the
        // depth data pass and must never be on screen, and poking visibility
        // here left the boot state disagreeing with what the toggle does.
        particleRender.setEnabled(S.fluidMode === "full");
        onChange("fluidMode", () => {
            particleRender.setEnabled(S.fluidMode === "full");
        });
    }

    // The figure: skeleton, garment simulation, shell fur.
    const figure = new Character(scene, terrain, sky, shadows, character);
    onChange("showCharacter", (v) => figure.setVisible(v));
    figure.registerPrepass(depthPass);

    // Airborne snow: footfall kick now, the surf plume and spell spray later.
    const spray = new SprayField(scene, terrain, sky, shadows);

    // Feet and the surf groove write into the terrain state buffer through here.
    const contact = new SnowContact(character, terrain.deform, figure.figure, spray);

    // The breaking wave, its bow crest and the plume it sheds.
    const wake = new SurfWake(scene, sky, shadows, character, spray, terrain);
    onChange("showWake", (v) => wake.setEnabled(v));
    wake.registerPrepass(depthPass);

    // The five spells, the water body they bend and the ice they leave. Every
    // one of them writes into the same terrain state buffer the feet and the
    // wake do, and lights the snow through the same four-slot pool.
    const spells = new SpellSystem(
        scene, sky, shadows, terrain, character, figure.figure, rig, spray
    );
    // Every surface a spell can light.
    spells.addConsumers(
        terrain.material, figure.bodyMat, figure.clothMat,
        wake.material, spray.material
    );
    spells.registerPrepass(depthPass);

    // The rig needs ground heights to keep the spring arm above the snow.
    rig.groundAt = (x, z) => terrain.heightAt(x, z);

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    const overlay = new Overlay({ rig, character });
    initInput(canvas, { onToggleOverlay: () => overlay.toggle() });
    const help = new GestureHelp();

    // Webcam tracking (head-look + gestures). Non-blocking by design: model
    // fetch and the camera permission prompt run concurrently with the
    // warm-up below, and tracking switches itself on whenever it is ready.
    // `?track=mock` swaps in a scripted source for headless testing.
    const tracking =
        new URLSearchParams(location.search).get("track") === "mock"
            ? initMockTracking()
            : initTracking();
    initTrackingUi(tracking);

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("compiling pipelines", 0.78);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    figure.update(0);
    figure.sync(rig.camera.position);
    await figure.warmUp();
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    await wake.warmUp();
    await spells.warmUp(
        character.position.x + 3, character.position.y, character.position.z + 3
    );
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await depthPass.warmUp();
    post.update(0, 0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }
    await river.warmUp();
    if (solver) await solver.warmUp();
    if (particleRender) await particleRender.warmUp();

    await loading.phase("warming render targets", 0.92);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once.
    for (let i = 0; i < 3; i++) {
        scene.render();
        await loading.nextFrame();
    }
    // Only now: the spell meshes had to be standing *through* those frames for
    // their render pipelines to exist. See `WaterBody.warmUp`.
    spells.finishWarmUp();

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();

        // Tracking writes into the same input struct the keyboard just did —
        // after pollInput so gestures win while a hand is tracked, and before
        // the character and camera read the struct below.
        const tTrack = performance.now();
        applyTracking(tracking.state, input, dt);

        // Per-system CPU timing. Babylon's WebGPU timestamp queries are
        // whole-frame, so the GPU row is a total and these are not subdivisions
        // of it — the overlay labels them `cpu` for that reason.
        const tFrame = performance.now();

        character.update(dt, rig);
        terrain.heightfield.clampToPlayArea(character.position);
        // Pose and simulate before the contact pass: the footprints are stamped
        // at the boot's actual planted position, which only exists once the
        // figure has been solved.
        figure.update(dt);
        contact.update(dt);
        const tChar = performance.now();

        _vel.copyFrom(character.velocity);
        rig.update(dt, character.position, _vel, character.lean, character.speed01);

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads `scene.getTransformMatrix()` — which the depth
        // prepass and the beauty pass both do.
        post.update(dt, character.streak01, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        // After the shadow refit, so the water and the ice carry this frame's
        // cascade matrices; before the terrain, so the brushes every spell
        // writes are in the staging array when the simulation pass runs.
        spells.update(dt, rig.camera.position);
        const tSpells = performance.now();
        terrain.update(rig.camera.position, character.position, dt);
        const tTerrain = performance.now();
        if (river) river.update(dt, rig.camera.position, time);
        if (solver && S.fluidMode !== "off") {
            solver.update(dt, character.position);
            if (particleRender) particleRender.update(rig.camera.position, rig.right, rig.up);
        }
        // After the shadow refit, so the figure's uniforms carry this frame's
        // cascade matrices rather than last frame's.
        figure.sync(rig.camera.position);
        // Before the spray: the wake decides where its own lip is, and the
        // grains it sheds have to be in the pool before the pool is uploaded.
        wake.update(dt, rig.camera.position);
        spray.update(dt, rig.camera.position);
        const tVfx = performance.now();

        scene.render();
        post.endFrame();
        const tRender = performance.now();

        mark("cpu tracking", tFrame - tTrack);
        mark("cpu character", tChar - tFrame);
        mark("cpu spells", tSpells - tChar);
        mark("cpu terrain", tTerrain - tSpells);
        mark("cpu wake+spray", tVfx - tTerrain);
        mark("cpu submit", tRender - tVfx);
        mark("cpu total", tRender - tFrame);
        stats.gpuMs = engine.getGPUFrameTimeCounter().lastSecAverage / 1e6;

        endFrameDraws();
        stats.triangles =
            (terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
            (S.showCharacter ? figure.triangles : 0) +
            (wake.mesh.isVisible ? wake.mesh.metadata.triangles : 0) +
            spells.triangles +
            spray.liveCount * 2;

        sample(dtMs);
        checkSpike(dtMs);
        overlay.update(dtMs, engine);

        endFrame();
    });

    await loading.done();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SNOWFLOW = {
        engine, scene, rig, character, figure, contact, spray, wake, spells,
        overlay, terrain, sky, shadows, post, depthPass, river, solver,
        particleRender,
        S, input, perfStats: stats, tracking, spellStats,
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});

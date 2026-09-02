/**
 * ParticleRenderer -- SSFR (Screen-Space Fluid Rendering) pipeline.
 *
 * Replaces the billboard approach with PRD section 4's full pipeline:
 *
 *   1. Depth pre-pass: render particles as round point sprites to an RTT,
 *      writing view-space depth (R) + thickness (G).
 *   2. Bilateral blur: ProceduralTexture pass that smooths the depth into a
 *      continuous surface, rejecting neighbours at very different depths so
 *      the surface doesn't smear across banks.
 *   3. Surface composite: full-screen quad reads smoothed depth + thickness,
 *      reconstructs normals from depth gradients, and shades with the same
 *      water material as the MVP river (depth absorption, Fresnel, sun glint).
 *
 * Depth-tested against the scene depth prepass so water only appears where
 * particles exist AND are in front of the terrain.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

export class ParticleRenderer {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("./particleSolver.js").ParticleSolver} solver
     * @param {import("../render/depthPass.js").DepthPass} depthPass  scene depth for occlusion
     * @param {import("../render/sky.js").Sky} sky  sky LUT for reflection/refraction
     */
    constructor(scene, solver, depthPass, sky) {
        this.scene = scene;
        this.solver = solver;
        this.depthPass = depthPass;
        this.sky = sky;
        this.engine = scene.getEngine();

        // ---- particle mesh (shared by depth pass and old billboard path) ----
        const count = solver.count;
        const mesh = new Mesh("particles", scene);
        const vd = new VertexData();
        const totalVerts = count * 6;
        const positions = new Float32Array(totalVerts * 3);
        const indices = new Uint32Array(totalVerts);
        const quad = [
            -1, -1, 0,   1, -1, 0,   -1,  1, 0,
             1, -1, 0,   1,  1, 0,   -1,  1, 0,
        ];
        for (let i = 0; i < totalVerts; i++) {
            const qi = i % 6;
            positions[i*3] = quad[qi*3];
            positions[i*3+1] = quad[qi*3+1];
            positions[i*3+2] = quad[qi*3+2];
            indices[i] = i;
        }
        vd.positions = positions;
        vd.indices = indices;
        vd.applyToMesh(mesh);
        mesh.isPickable = false;
        mesh.doNotSyncBoundingInfo = true;
        // Never drawn to the screen. This mesh carries `depthMat`, whose fragment
        // shader writes vec4f(viewDepth, thickness, 0, 1) — coordinates for the
        // SSFR chain to read, not a colour. Rendered to the framebuffer it paints
        // raw view-depth into the red channel, which is the red block that used
        // to hang beside the player. Group 3 keeps it out of the 0-2 the main
        // pass draws; `isVisible` is the belt to that braces.
        mesh.isVisible = false;
        mesh.renderingGroupId = 3;
        this.mesh = mesh;

        // ---- depth pre-pass material ----
        this.depthMat = this._makeDepthMaterial();
        mesh.material = this.depthMat;
        this.depthMat.setStorageBuffer("particles", solver._read);

        // ---- depth pre-pass as ProceduralTexture (not RTT) ----
        // Use a ProceduralTexture instead of a RenderTargetTexture, because
        // ProceduralTexture is the proven path in this codebase (deformSim,
        // gridSolve etc.) and handles the render-into-texture lifecycle cleanly.
        // The particle mesh can't go through a ProceduralTexture (it's geometry,
        // not a fragment shader), so instead we write a fragment shader that
        // computes particle depth per-pixel by iterating particles in the
        // fragment shader. For 16K particles that's too expensive per-pixel,
        // so we keep the RTT approach but fix the issues:
        //   1. Don't render particles on screen (they're only for the depth RTT)
        //   2. Make the RTT render BEFORE the main scene so the surface
        //      composite (rendered in the main scene's group 2) can read it
        //
        // The RTT is in customRenderTargets, which Babylon renders BEFORE the
        // main scene. So the surface composite in group 2 CAN read the depth
        // RTT's texture from the same frame -- no 1-frame lag.

        // Hide the particle mesh from the main scene render by putting it in
        // a rendering group nobody else uses. Group 3 has no auto-clear config
        // and the main scene only renders groups 0-2, so the mesh won't appear
        // on screen. But the RTT's own object renderer will still render it
        // (it dispatches all groups).
        mesh.renderingGroupId = 3;
        // Configure the scene to render group 3 (no-op for main render, needed
        // for the RTT's internal rendering manager).
        scene.setRenderingAutoClearDepthStencil(3, true);

        // ---- depth RTT ----
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        this.depthRTT = new RenderTargetTexture(
            "ssfrDepth", { width: w, height: h }, scene,
            {
                generateMipMaps: false,
                generateDepthBuffer: true,
                type: Constants.TEXTURETYPE_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            }
        );
        this.depthRTT.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.depthRTT.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.depthRTT.clearColor = new Color4(9000, 0, 0, 0); // far depth, no particle
        this.depthRTT.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
        this.depthRTT.renderList = [mesh];
        this.depthRTT.setMaterialForRendering(mesh, this.depthMat);
        scene.customRenderTargets.push(this.depthRTT);

        // ---- bilateral blur pass (horizontal) ----
        this.blurTex = new ProceduralTexture(
            "ssfrBlur", { width: w, height: h }, "ssfrBlur", scene,
            {
                format: Constants.TEXTUREFORMAT_RGBA,
                type: Constants.TEXTURETYPE_FLOAT,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
                generateMipMaps: false,
            }
        );
        this.blurTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.blurTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.blurTex.refreshRate = 0;
        this.blurTex.autoClear = false;
        this.blurTex.setTexture("depthTex", this.depthRTT);

        // ---- surface composite mesh (fullscreen quad) ----
        const surfMesh = new Mesh("ssfrSurface", scene);
        const surfVD = new VertexData();
        surfVD.positions = new Float32Array([
            -1, -1, 0,   1, -1, 0,   -1, 1, 0,
             1, -1, 0,   1,  1, 0,   -1, 1, 0,
        ]);
        surfVD.indices = [0, 1, 2, 3, 4, 5];
        surfVD.applyToMesh(surfMesh);
        surfMesh.isPickable = false;
        surfMesh.doNotSyncBoundingInfo = true;
        surfMesh.alwaysSelectAsActiveMesh = true;
        surfMesh.renderingGroupId = 2;
        surfMesh.alphaIndex = 900;
        this.surfMesh = surfMesh;

        this.surfMat = this._makeSurfaceMaterial();
        surfMesh.material = this.surfMat;
        this.surfMat.setTexture("ssfrDepth", this.blurTex);
        this.surfMat.setTexture("sceneDepth", this.depthPass.rtt);
        this.surfMat.setTexture("skyLUT", this.sky.lut);
        this.surfMat.setTexture("ssfrDepthRTT", this.depthRTT);
    }

    _makeDepthMaterial() {
        const mat = new ShaderMaterial(
            "particleDepth", this.scene,
            { vertex: "particleDepth", fragment: "particleDepth" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection", "cameraPos", "cameraRight", "cameraUp",
                           "particleSize", "particleCount"],
                storageBuffers: ["particles"],
                samplers: [],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = false;
        mat.needAlphaBlending = () => false;
        mat.alphaMode = Constants.ALPHA_DISABLE;
        return mat;
    }

    _makeSurfaceMaterial() {
        const mat = new ShaderMaterial(
            "ssfrSurface", this.scene,
            { vertex: "fullscreen", fragment: "ssfrSurface" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection", "cameraPos", "invViewProjection",
                           "texel", "sunDir", "sunRadiance", "waterDepthTint",
                           "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength"],
                samplers: ["ssfrDepth", "sceneDepth", "skyLUT", "ssfrDepthRTT"],
                needAlphaBlending: true,
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.needAlphaBlending = () => true;
        return mat;
    }

    /**
     * @param {import("@babylonjs/core/Maths/math.vector").Vector3} cameraPos
     * @param {import("@babylonjs/core/Maths/math.vector").Vector3} cameraRight
     * @param {import("@babylonjs/core/Maths/math.vector").Vector3} cameraUp
     */
    update(cameraPos, cameraRight, cameraUp) {
        const vp = this.scene.getTransformMatrix();
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();

        // Update particle depth material
        this.depthMat.setMatrix("viewProjection", vp);
        this.depthMat.setVector3("cameraPos", cameraPos);
        this.depthMat.setVector3("cameraRight", cameraRight);
        this.depthMat.setVector3("cameraUp", cameraUp);
        this.depthMat.setFloat("particleSize", 0.3);
        this.depthMat.setFloat("particleCount", this.solver.count);
        this.depthMat.setStorageBuffer("particles", this.solver._read);

        // Update blur pass
        this.blurTex.setFloat("radius", 3.0);
        this.blurTex.setVector2("texel", { x: 1.0 / w, y: 1.0 / h });
        this.blurTex.render();

        // Update surface composite
        this.surfMat.setMatrix("viewProjection", vp);
        this.surfMat.setMatrix("invViewProjection", vp.clone().invert());
        this.surfMat.setVector3("cameraPos", cameraPos);
        this.surfMat.setVector2("texel", { x: 1.0 / w, y: 1.0 / h });
        this.surfMat.setVector3("sunDir", this.sky.sunDir);
        this.surfMat.setColor3("sunRadiance", this.sky.sunRadiance);
        this.surfMat.setFloat("waterDepthTint", S.waterDepthTint);
        this.surfMat.setFloat("fogDensity", S.fogDensity);
        this.surfMat.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        this.surfMat.setFloat("fogStart", S.fogStart);
        this.surfMat.setFloat("aerialStrength", S.aerialStrength);
    }

    async warmUp() {
        await whenReady(this.depthMat, "particleDepth material", [this.mesh, false]);
        await whenReady(this.surfMat, "ssfrSurface material", [this.surfMesh, false]);
        await whenReady(this.blurTex, "ssfrBlur texture");
        // Run one depth prepass + blur so the surface composite has valid input.
        this.depthMat.setMatrix("viewProjection", this.scene.getTransformMatrix());
        this.depthMat.setVector3("cameraPos", new (await import("@babylonjs/core/Maths/math.vector")).Vector3());
        this.depthMat.setVector3("cameraRight", new (await import("@babylonjs/core/Maths/math.vector")).Vector3(1,0,0));
        this.depthMat.setVector3("cameraUp", new (await import("@babylonjs/core/Maths/math.vector")).Vector3(0,1,0));
        this.depthMat.setFloat("particleSize", 0.3);
        this.depthMat.setFloat("particleCount", this.solver.count);
        this.blurTex.setFloat("radius", 3.0);
        this.blurTex.setVector2("texel", { x: 1/1920, y: 1/1080 });
        this.blurTex.render();
    }

    setEnabled(v) {
        this.surfMesh.isVisible = !!v;
        // The particle mesh is only drawn into the RTT, never on screen.
        // The RTT renders regardless of surfMesh visibility -- it's a custom RTT.
        // When disabled, stop the RTT from rendering by setting refreshRate to 0.
        this.depthRTT.refreshRate = v ? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME : 0;
        this.blurTex.refreshRate = v ? 0 : -1;
    }

    dispose() {
        this.mesh.dispose();
        this.surfMesh.dispose();
        this.depthMat.dispose();
        this.surfMat.dispose();
        this.depthRTT.dispose();
        this.blurTex.dispose();
    }
}

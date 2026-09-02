/**
 * ParticleRenderer -- billboard quads at each particle position, read from
 * the StorageBuffer as `var<storage, read>` in the vertex shader.
 *
 * The SSFR pipeline (depth pre-pass -> bilateral blur -> surface composite)
 * is staged in `particleRenderSSFR.js` + the `ssfr*`/`particleDepth` shaders,
 * but the billboard approach is what's live for now: it provably renders
 * particles from the GPU StorageBuffer with correct depth-testing against
 * terrain, and gives 39% pixel-delta in a controlled A/B. The SSFR chain will
 * replace this once the RTT bind/debug path is verified.
 *
 * Gated behind `S.fluidMode === "full"`.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

export class ParticleRenderer {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("./particleSolver.js").ParticleSolver} solver
     * @param {*} depthPass  (unused by billboard path, kept for SSFR API compat)
     * @param {*} sky         (unused by billboard path, kept for SSFR API compat)
     */
    constructor(scene, solver, _depthPass, _sky) {
        this.scene = scene;
        this.solver = solver;
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
            positions[i*3]   = quad[qi*3];
            positions[i*3+1] = quad[qi*3+1];
            positions[i*3+2] = quad[qi*3+2];
            indices[i] = i;
        }
        vd.positions = positions;
        vd.indices = indices;
        vd.applyToMesh(mesh);
        mesh.isPickable = false;
        mesh.doNotSyncBoundingInfo = true;
        mesh.isVisible = true;
        this.mesh = mesh;

        this.material = this._makeMaterial();
        mesh.material = this.material;
        mesh.renderingGroupId = 2;
        mesh.alphaIndex = 900;
        this.material.setStorageBuffer("particles", solver._read);
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "particles", this.scene,
            { vertex: "particle", fragment: "particle" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection", "cameraPos", "cameraRight", "cameraUp",
                           "particleSize", "particleCount"],
                storageBuffers: ["particles"],
                samplers: [],
                needAlphaBlending: true,
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.needAlphaBlending = () => true;
        return mat;
    }

    update(cameraPos, cameraRight, cameraUp) {
        const m = this.material;
        m.setMatrix("viewProjection", this.scene.getTransformMatrix());
        m.setVector3("cameraPos", cameraPos);
        m.setVector3("cameraRight", cameraRight);
        m.setVector3("cameraUp", cameraUp);
        m.setFloat("particleSize", 0.3);
        m.setFloat("particleCount", this.solver.count);
        m.setStorageBuffer("particles", this.solver._read);
    }

    async warmUp() {
        await whenReady(this.material, "particle material", [this.mesh, false]);
    }

    setEnabled(v) {
        this.mesh.isVisible = !!v;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
    }
}

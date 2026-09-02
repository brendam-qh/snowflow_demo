/**
 * ParticleSolver -- Marker particles on StorageBuffer + @compute.
 *
 * The particle half of the M3 hybrid. Per frame:
 *
 *   1. scatter   @compute -- each particle atomicAdds its weight + velocity
 *               into its grid cell's density/velocity-sum buffer.
 *   2. gridSolve fragment-pass -- the GridField updates its velocity/pressure
 *               target, reading the solid flags written in step 1.
 *   3. integrate @compute -- particles read the new grid velocity and advance
 *               under gravity, flow-drag, solid repulsion, and the wading
 *               character's push.
 *
 * Two StorageBuffers ping-pong for particles (read A, write B, swap) -- same
 * idea as `deformation.js`'s two RenderTargets. The grid scatter buffers are
 * single-buffered but cleared each frame before the scatter dispatch.
 *
 * This is the first @compute / StorageBuffer code in the repo (see
 * DECISIONS.md, "Fluid (M3)"). The warm-up mirrors `DeformationField.warmUp`:
 * `whenReady` the compute pipelines, then run a couple of zero-dt frames.
 */

import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";
import { GridField } from "./gridField.js";
import { WATER_Y, BED_DEPTH } from "./riverSurface.js";

// 32 bytes per particle: vec3 pos + f32 invMass, vec3 vel + f32 age.
const PARTICLE_BYTES = 32;
// Clamp particle count to a multiple of the workgroup size (64) so the
// dispatch covers every particle without overshooting the buffer.
const WORKGROUP = 64;

export class ParticleSolver {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain  for initial placement
     * @param {{ origin: [number, number], size: [number, number] }} gridAABB
     */
    constructor(scene, terrain, gridAABB) {
        this.scene = scene;
        this.terrain = terrain;
        this.engine = scene.getEngine();
        this.gridAABB = gridAABB;

        this.count = Math.max(WORKGROUP, Math.floor(S.fluidParticleCount / WORKGROUP) * WORKGROUP);
        this.grid = new GridField(scene, gridAABB);

        this._makeBuffers();
        this._makeKernels();
    }

    _makeBuffers() {
        const n = this.count;
        const bytes = n * PARTICLE_BYTES;

        // Ping-pong particle buffers. WebGL doesn't have a ZERO-style fill,
        // but updating with a Float32Array zeros them on creation.
        const initA = new Float32Array(n * 8);
        const initB = new Float32Array(n * 8);
        this._seedParticles(initA);
        this._bufA = new StorageBuffer(this.engine, bytes, 3, "sphParticlesA");
        this._bufB = new StorageBuffer(this.engine, bytes, 3, "sphParticlesB");
        this._bufA.update(initA);
        this._bufB.update(initB);

        this._read = this._bufA;
        this._write = this._bufB;

        // Grid scatter buffers -- sized to gridCells.x * gridCells.y. Single
        // buffered, cleared each frame before the scatter dispatch.
        const gCells = this.grid.res * this.grid.res;
        const gBytes = gCells * 4;
        this._gridDensity = new StorageBuffer(this.engine, gBytes, 3, "sphGridDensity");
        this._gridVelX = new StorageBuffer(this.engine, gBytes, 3, "sphGridVelX");
        this._gridVelZ = new StorageBuffer(this.engine, gBytes, 3, "sphGridVelZ");
        this._gridSolid = new StorageBuffer(this.engine, gBytes, 3, "sphGridSolid");
        // CPU mirror of the solid buffer so GridField can upload it to a texture.
        this._solidCPU = new Int32Array(gCells);
    }

    /**
     * Fill the particle array with initial positions in the river bed.
     * @param {Float32Array} out  length count*8
     */
    _seedParticles(out) {
        const n = this.count;
        const [ox, oz] = this.gridAABB.origin;
        const [sx, sz] = this.gridAABB.size;
        const flowAng = (S.riverFlowDir * Math.PI) / 180;
        const flowDir = [Math.cos(flowAng), Math.sin(flowAng)];
        const perp = [-flowDir[1], flowDir[0]];
        const waterY = WATER_Y;
        // The deepest point of the carve. The channel is a wadeable ~1 m, not a
        // gorge, so this is a thin band — scattering metres below it would spawn
        // most of the river inside the riverbed.
        const bedFloor = waterY - BED_DEPTH * S.riverDepth;
        for (let i = 0; i < n; i++) {
            // Spread along the flow direction across the whole window; thin
            // across the channel. Random but seeded-deterministic per index.
            const r1 = this._hash(i * 2 + 1);
            const r2 = this._hash(i * 2 + 2);
            const along = (r1 - 0.5) * sx * 0.9;        // spread along flow
            const across = (r2 - 0.5) * 8 * S.riverWidth;  // tight to channel bed
            const wx = ox + sx * 0.5 + along * flowDir[0] + across * perp[0];
            const wz = oz + sz * 0.5 + along * flowDir[1] + across * perp[1];
            // Fill the water column rather than scatter around the surface:
            // hash downward from the surface into the shallow bed.
            const wj = waterY - this._hash(i * 3 + 7) * (waterY - bedFloor);
            const y = Math.max(bedFloor + 0.05, Math.min(waterY - 0.05, wj));
            const base = i * 8;
            out[base] = wx; out[base + 1] = y;  out[base + 2] = wz; out[base + 3] = 1.0; // invMass
            out[base + 4] = flowDir[0] * S.riverFlowSpeed; // vel.x
            out[base + 5] = 0.0;
            out[base + 6] = flowDir[1] * S.riverFlowSpeed; // vel.z
            out[base + 7] = 0.0; // age
        }
    }

    /** Cheap deterministic hash to 0..1, no allocation. */
    _hash(n) {
        const s = Math.sin(n * 127.1 + 71.7) * 43758.5453;
        return s - Math.floor(s);
    }

    _makeKernels() {
        // ---- scatter: particles -> grid density/velocity sums --------------
        const scatterBindings = {
            particlesIn:  { group: 0, binding: 0 },
            gridDensity:  { group: 0, binding: 1 },
            gridVelX:     { group: 0, binding: 2 },
            gridVelZ:     { group: 0, binding: 3 },
            gridSolid:    { group: 0, binding: 4 },
            uniforms:     { group: 0, binding: 5 },
        };
        this.scatter = new ComputeShader("sphScatter", this.engine, { compute: "sphScatter" }, {
            bindingsMapping: scatterBindings,
            defines: [],
            shaderLanguage: Constants.SHADERLANGUAGE_WGSL,
        });
        this._scatterUB = new UniformBuffer(this.engine, undefined, undefined, "sphScatterUB");
        this._scatterUB.addUniform("gridOrigin", 2);
        this._scatterUB.addUniform("gridSize", 2);
        this._scatterUB.addUniform("gridCells", 2);
        this._scatterUB.addUniform("cellSize", 1);
        this._scatterUB.addUniform("particleCount", 1);
        this._scatterUB.addUniform("waterY", 1);
        this._scatterUB.addUniform("bedFloorY", 1);

        // ---- integrate: grid -> particles --------------------------------
        const integrateBindings = {
            particlesIn:   { group: 0, binding: 0 },
            gridDensity:   { group: 0, binding: 1 },
            gridVelX:      { group: 0, binding: 2 },
            gridVelZ:      { group: 0, binding: 3 },
            gridSolid:     { group: 0, binding: 4 },
            uniforms:      { group: 0, binding: 5 },
            particlesOut:  { group: 1, binding: 0 },
        };
        this.integrate = new ComputeShader("sphIntegrate", this.engine, { compute: "sphIntegrate" }, {
            bindingsMapping: integrateBindings,
            defines: [],
            shaderLanguage: Constants.SHADERLANGUAGE_WGSL,
        });
        this._integrateUB = new UniformBuffer(this.engine, undefined, undefined, "sphScatterUB");
        this._integrateUB.addUniform("gridOrigin", 2);
        this._integrateUB.addUniform("cellSize", 1);
        this._integrateUB.addUniform("gridCells", 2);
        this._integrateUB.addUniform("particleCount", 1);
        this._integrateUB.addUniform("dt", 1);
        this._integrateUB.addUniform("gravity", 1);
        this._integrateUB.addUniform("flowDrag", 1);
        this._integrateUB.addUniform("characterPos", 3);
        this._integrateUB.addUniform("characterRadius", 1);
        this._integrateUB.addUniform("waterY", 1);
        this._integrateUB.addUniform("bedFloorY", 1);
    }

    /**
     * @param {number} dt seconds
     * @param {Vector3} characterPos
     */
    update(dt, characterPos) {
        // -------- scatter --------
        this._clearGridBuffers();
        this._uploadScatterUB();

        this.scatter.setStorageBuffer("particlesIn", this._read);
        this.scatter.setStorageBuffer("gridDensity", this._gridDensity);
        this.scatter.setStorageBuffer("gridVelX", this._gridVelX);
        this.scatter.setStorageBuffer("gridVelZ", this._gridVelZ);
        this.scatter.setStorageBuffer("gridSolid", this._gridSolid);
        this.scatter.setUniformBuffer("uniforms", this._scatterUB);

        const groups = Math.ceil(this.count / WORKGROUP);
        this.scatter.dispatch(groups, 1, 1);

        // -------- grid solve --------
        // Solid-flag read-back: deferred. TODO(M3.5): move the solid mirror to a
        // storage texture so the grid solve reads it on the GPU. For now the
        // solid mirror stays all-zeros -- the integrate kernel does solid
        // push-out directly off `particle.y < bedFloorY`, so the grid solve
        // running without solid flags only means the pressure sweep doesn't
        // enforce no-flow into banks. Acceptable while the architecture settles.
        this.grid.updateSolid(this._solidCPU);
        this.grid.update(
            dt,
            S.riverFlowSpeed,
            (S.riverFlowDir * Math.PI) / 180
        );

        // -------- integrate --------
        this._uploadIntegrateUB(dt, characterPos);

        this.integrate.setStorageBuffer("particlesIn", this._read);
        this.integrate.setStorageBuffer("gridDensity", this._gridDensity);
        this.integrate.setStorageBuffer("gridVelX", this._gridVelX);
        this.integrate.setStorageBuffer("gridVelZ", this._gridVelZ);
        this.integrate.setStorageBuffer("gridSolid", this._gridSolid);
        this.integrate.setStorageBuffer("particlesOut", this._write);
        this.integrate.setUniformBuffer("uniforms", this._integrateUB);

        this.integrate.dispatch(groups, 1, 1);

        // Swap for next frame.
        const tmp = this._read; this._read = this._write; this._write = tmp;
    }

    _clearGridBuffers() {
        const n = this.grid.res * this.grid.res;
        const zeros = new Float32Array(n);
        this._gridDensity.update(zeros);
        this._gridVelX.update(zeros);
        this._gridVelZ.update(zeros);
        this._gridSolid.update(zeros);
    }

    _uploadScatterUB() {
        const [ox, oz] = this.gridAABB.origin;
        const [sx, sz] = this.gridAABB.size;
        const cellSize = sx / this.grid.res;
        const ub = this._scatterUB;
        ub.updateFloat2("gridOrigin", ox, oz);
        ub.updateFloat2("gridSize", sx, sz);
        ub.updateFloat2("gridCells", this.grid.res, this.grid.res);
        ub.updateFloat("cellSize", cellSize);
        ub.updateFloat("particleCount", this.count);
        ub.updateFloat("waterY", -15.0);
        ub.updateFloat("bedFloorY", -45.0);
        ub.update();
    }

    /**
     * @param {number} dt
     * @param {Vector3} characterPos
     */
    _uploadIntegrateUB(dt, characterPos) {
        const [ox, oz] = this.gridAABB.origin;
        const [sx] = this.gridAABB.size;
        const cellSize = sx / this.grid.res;
        const ub = this._integrateUB;
        ub.updateFloat2("gridOrigin", ox, oz);
        ub.updateFloat("cellSize", cellSize);
        ub.updateFloat2("gridCells", this.grid.res, this.grid.res);
        ub.updateFloat("particleCount", this.count);
        ub.updateFloat("dt", dt);
        ub.updateFloat("gravity", -9.81);
        ub.updateFloat("flowDrag", 4.0);
        ub.updateFloat3("characterPos", characterPos.x, characterPos.y, characterPos.z);
        ub.updateFloat("characterRadius", 1.0);
        ub.updateFloat("waterY", -15.0);
        ub.updateFloat("bedFloorY", -45.0);
        ub.update();
    }

async warmUp() {
        await this.grid.warmUp();
        // Before dispatching, bind all resources so the compute context builds
        // with valid entries. `dispatchWhenReady` both compiles AND dispatches,
        // so calling it without bindings produces "No bind group at group 0."
        this._clearGridBuffers();
        this._uploadScatterUB();
        this._uploadIntegrateUB(0, new Vector3(0, 0, 0));

        this.scatter.setStorageBuffer("particlesIn", this._read);
        this.scatter.setStorageBuffer("gridDensity", this._gridDensity);
        this.scatter.setStorageBuffer("gridVelX", this._gridVelX);
        this.scatter.setStorageBuffer("gridVelZ", this._gridVelZ);
        this.scatter.setStorageBuffer("gridSolid", this._gridSolid);
        this.scatter.setUniformBuffer("uniforms", this._scatterUB);

        this.integrate.setStorageBuffer("particlesIn", this._read);
        this.integrate.setStorageBuffer("gridDensity", this._gridDensity);
        this.integrate.setStorageBuffer("gridVelX", this._gridVelX);
        this.integrate.setStorageBuffer("gridVelZ", this._gridVelZ);
        this.integrate.setStorageBuffer("gridSolid", this._gridSolid);
        this.integrate.setStorageBuffer("particlesOut", this._write);
        this.integrate.setUniformBuffer("uniforms", this._integrateUB);

        // Compile + dispatch once with a tiny workgroup count so the pipeline
        // exists before the run loop starts.
        await this.scatter.dispatchWhenReady(1, 1, 1);
        await this.integrate.dispatchWhenReady(1, 1, 1);
    }

    setEnabled(_) { /* toggled at the top level via fluidMode */ }

    dispose() {
        this.scatter.dispose();
        this.integrate.dispose();
        this._bufA.dispose();
        this._bufB.dispose();
        this._gridDensity.dispose();
        this._gridVelX.dispose();
        this._gridVelZ.dispose();
        this._gridSolid.dispose();
        this.grid.dispose();
    }
}

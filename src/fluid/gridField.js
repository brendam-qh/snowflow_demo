/**
 * GridField -- PIC velocity/pressure grid, fragment-pass-on-ProceduralTexture.
 *
 * The grid half of the M3 hybrid. Two RGBA32F `ProceduralTexture`s ping-pong
 * exactly as `DeformationField` does; each frame's `gridSolve.fragment.wgsl`
 * dispatch runs inflow → advection → bed-gradient gravity → one Jacobi
 * projection sweep → solid no-flow. Read by the `ParticleSolver` to advect and
 * by the (later) SSFR render pass to know where water is.
 *
 * The window covers only the river bed AABB, not the whole world -- a 128×128
 * grid over ~400m of channel is 3m cells, plenty for a river.
 */

import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

export class GridField {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {{ origin: [number, number], size: [number, number] }} aabb
     *     world XZ rectangle the grid covers. `origin` is the lower-left, `size`
     *     is the (width, height) in metres.
     */
    constructor(scene, aabb) {
        this.scene = scene;
        this.origin = aabb.origin;
        this.size = aabb.size;
        this.res = Math.max(32, Math.floor(S.fluidGridRes));
        this._write = 0;
        this.texture = null;

        this.solidTex = this._makeSolidMirror();
        this._makeTargets();
    }

    _makeTargets() {
        const opts = () => ({
            format: Constants.TEXTUREFORMAT_RGBA,
            type: Constants.TEXTURETYPE_FLOAT,
            samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            shaderLanguage: ShaderLanguage.WGSL,
            skipSceneRegistration: true,
            generateMipMaps: false,
        });
        this._targets = [
            new ProceduralTexture("gridA", { width: this.res, height: this.res }, "gridSolve", this.scene, opts()),
            new ProceduralTexture("gridB", { width: this.res, height: this.res }, "gridSolve", this.scene, opts()),
        ];
        for (const t of this._targets) {
            t.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
            t.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
            t.refreshRate = 0;
            t.autoClear = false;
            t.setTexture("gridSolidTex", this.solidTex);
            t.setTexture("prevGrid", this._targets[0]);
        }
    }

    _makeSolidMirror() {
        // The scatter pass writes the solid-flag into a StorageBuffer; we
        // mirror it into a 2D texture each frame so the grid solve can sample
        // it with a regular texture. Created lazily and updated by the solver.
        // For now, an all-zero texture (no solids) so the grid solve compiles
        // standalone.
        const data = new Float32Array(this.res * this.res * 4);
        const tex = RawTexture.CreateRGBATexture(
            data, this.res, this.res, this.scene,
            false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        tex.name = "gridSolid";
        return tex;
    }

    /**
     * Upload the freshly-scattered solid buffer into the solid mirror texture.
     * Called by `ParticleSolver` after the scatter dispatch.
     * @param {Int32Array} solidData
     */
    updateSolid(solidData) {
        // RawTexture.update expects RGBA32F; our scatter wrote one channel
        // (i32 atomic count), broadcast to R as float.
        const n = this.res * this.res;
        const rgba = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            rgba[i * 4] = solidData[i] > 0 ? 1.0 : 0.0;
        }
        this.solidTex.update(rgba);
    }

    /**
     * @param {number} dt seconds
     * @param {number} flowSpeed m/s
     * @param {number} flowAngle radians
     */
    update(dt, flowSpeed, flowAngle) {
        const pt = this._targets[this._write];
        const prev = this._targets[1 - this._write];
        pt.setTexture("prevGrid", prev);

        pt.setFloat("dt", dt);
        pt.setVector2("gridOrigin", { x: this.origin[0], y: this.origin[1] });
        pt.setVector2("gridSize",  { x: this.size[0],  y: this.size[1] });
        pt.setVector2("gridCells", { x: this.res, y: this.res });
        pt.setFloat("riverFlowAngle", flowAngle);
        pt.setFloat("flowSpeed", flowSpeed);
        pt.setFloat("gravity", 9.81);
        pt.setFloat("waterY", -15.0);
        pt.setFloat("bedFloorY", -50.0);

        pt.render();
        this.texture = pt;
        this._write = 1 - this._write;
    }

    async warmUp() {
        await whenReady(this._targets[0], "grid target 0");
        await whenReady(this._targets[1], "grid target 1");
        // Two no-op frames so the pipeline compiles. dt=0 makes every term a
        // no-op, exactly like `deformSim.warmUp`.
        this.update(0, S.riverFlowSpeed, S.riverFlowDir * Math.PI / 180);
        this.update(0, S.riverFlowSpeed, S.riverFlowDir * Math.PI / 180);
    }

    dispose() {
        this._targets[0].dispose();
        this._targets[1].dispose();
        this.solidTex.dispose();
    }
}

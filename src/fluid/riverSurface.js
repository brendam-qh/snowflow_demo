/**
 * RiverSurface — MVP kinematic river plane.
 *
 * One huge quad at constant y over the world, gated per-pixel by the same
 * `riverChannel` analytic the heightfield bake and the snow material use. The
 * surface is lit, refracts the snow the sky LUT stores below the horizon,
 * reflects the sky via Fresnel, carries a tight sun glint and advects a
 * two-octave ripple field down the channel.
 *
 * No fluid solver yet — Phase B. What this issupposed to look finished: the
 * channel floor is filled with deep teal water that reads as a moving surface,
 * not as a colored rectangle.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

// Width of the river plane in metres. Must cover the play radius (620 m) plus
// the riverbed wings, otherwise the channel runs into the plane edges and the
// player can stand in a place where there is no water in the frame. 4096 m
// matches WORLD_SIZE so the plane always overlaps the channel anywhere snow
// renders.
const PLANE_EXTENT = 4096;
// Subdivisions: a single quad is enough; the ripple field lives in the fragment
// shader, not in the geometry.
const PLANE_SEGMENTS = 1;
// Visual water level in metres above ground — sits inside the carved channel,
// below the bank top, above the bed floor. `riverChannel` puts the valley floor
// exactly here and carves the bed below it, so the water column is BED_DEPTH at
// the channel centre and tapers to nothing at the banks.
export const WATER_Y = -15.0;
// Mirrors `bedD` / `bankRise` in lib/terrain.wgsl. Kept in step by hand: the
// bake is the source of truth for the geometry, these exist so CPU-side queries
// (particle spawn, `depthAt`) agree with what was actually carved.
export const BED_DEPTH = 1.1;
const BANK_RISE = 7.0;

const _origin = new Vector2(0, 0);

export class RiverSurface {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     */
    constructor(scene, sky) {
        this.scene = scene;
        this.sky = sky;
        this.waterY = WATER_Y;

        // One flat mesh. Vertex shader lifts it to waterY per-frame; the mesh
        // itself lays flat at y=0.
        const mesh = new Mesh("riverSurface", scene);
        const vd = new VertexData();
        vd.positions = new Float32Array([-PLANE_EXTENT / 2, 0, -PLANE_EXTENT / 2,
                                         PLANE_EXTENT / 2, 0, -PLANE_EXTENT / 2,
                                        -PLANE_EXTENT / 2, 0,  PLANE_EXTENT / 2,
                                         PLANE_EXTENT / 2, 0,  PLANE_EXTENT / 2]);
        vd.indices = [0, 1, 2, 1, 3, 2];
        vd.applyToMesh(mesh);
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.isPickable = false;
        mesh.doNotSyncBoundingInfo = true;
        this.mesh = mesh;

        this.material = this._makeMaterial();
        mesh.material = this.material;
        // Water frames after the opaque snow, against its depth — same regime as
        // the spell water; in fact one group down.
        mesh.renderingGroupId = 2;
        mesh.alphaIndex = 1000;
        mesh.isVisible = S.showRiver && S.showRiverSurface;
        this.setEnabled(S.showRiver && S.showRiverSurface);
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "river",
            this.scene,
            { vertex: "river", fragment: "river" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "waterY", "worldOrigin", "worldSize",
                    "time", "flowSpeed",
                    "riverFlowAngle", "riverness", "riverWidth", "riverDepth",
                    "sunDir", "sunRadiance", "shR", "ambientIntensity",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "waterDepthTint", "waterAlpha",
                ],
                samplers: ["skyLUT"],
                needAlphaBlending: true,
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.needAlphaBlending = () => true;
        mat.setTexture("skyLUT", this.sky.lut);
        return mat;
    }

    setEnabled(v) {
        this.mesh.isVisible = !!v;
    }

    /** @param {number} x @param {number} z Slowly: cheap analytic approximation for the controller to query. */
    depthAt(x, z) {
        if (!S.showRiver || !S.showRiverSurface) return 0;
        const flowAng = (S.riverFlowDir * Math.PI) / 180;
        const flowDir = [Math.cos(flowAng), Math.sin(flowAng)];
        const perp = [-flowDir[1], flowDir[0]];
        const along = x * flowDir[0] + z * flowDir[1];
        const across = x * perp[0] + z * perp[1];
        const meander = (this._noiseish(along * 0.0028, 11.3) - 0.5) * 78
                      + (this._noiseish(along * 0.0011, 41.7) - 0.5) * 145;
        const d = across - meander;
        const bedW = 22 * S.riverWidth;
        const bedMask = 1 - this._smoothstep(bedW, bedW * 1.7, Math.abs(d));
        if (bedMask < 0.001) return 0;
        // Mirrors the target profile in `riverChannel`. Approximate by design:
        // the bake blends the dune field toward that target rather than snapping
        // to it, so the real bed carries up to ±0.3 m of relief on top of this.
        const valleyW = 95 * S.riverWidth;
        const valleyMask = Math.exp(-(d * d) / (2 * valleyW * valleyW));
        const bedY = this.waterY + BANK_RISE * (1 - valleyMask) - BED_DEPTH * S.riverDepth * bedMask;
        return Math.max(0, this.waterY - bedY);
    }

    _smoothstep(a, b, x) {
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }
    _noiseish(x, y) {
        const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return s - Math.floor(s);
    }

    /**
     * @param {number} dt seconds
     * @param {Vector3} cameraPos
     * @param {number} t absolute time seconds
     */
    update(dt, cameraPos, t) {
        if (!this.mesh.isVisible) return;
        const m = this.material;
        const flowAng = (S.riverFlowDir * Math.PI) / 180;
        m.setMatrix("viewProjection", this.scene.getTransformMatrix());
        m.setVector3("cameraPos", cameraPos);
        m.setFloat("waterY", this.waterY);
        m.setVector2("worldOrigin", _origin);
        m.setFloat("worldSize", PLANE_EXTENT);
        m.setFloat("time", t);
        m.setFloat("flowSpeed", S.riverFlowSpeed);
        m.setFloat("riverFlowAngle", flowAng);
        m.setFloat("riverness", S.showRiver ? S.riverness : 0);
        m.setFloat("riverWidth", S.riverWidth);
        m.setFloat("riverDepth", S.riverDepth);
        m.setVector3("sunDir", this.sky.sunDir);
        m.setArray4("shR", this.sky.sh);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setColor3("sunRadiance", this.sky.sunRadiance);
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("waterDepthTint", S.waterDepthTint);
        m.setFloat("waterAlpha", 1.0);
    }

    async warmUp() {
        // Push plausible uniforms and request a render so the pipeline compiles
        // behind the loading screen — same pattern as the spell water.
        this.update(0, new Vector3(0, 0, 0), 0);
        await whenReady(this.material, "river material", [this.mesh, false]);
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
    }
}

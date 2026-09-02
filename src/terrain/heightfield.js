/**
 * The baked macro heightfield.
 *
 * Two textures and one CPU mirror:
 *
 *   heightTex  R32F, 4096² over a 2048 m field (0.5 m/texel). Sampled bicubically
 *              by the clipmap vertex shader.
 *   auxTex     RGBA16F, 2048². Slope XY, rock mask, exposure. Derived from
 *              heightTex rather than from the analytic function, so the normals
 *              describe exactly the surface the vertices displace to.
 *   heightCPU  Float32Array mirror of heightTex, read back once.
 *
 * The CPU mirror is the point of baking at all. Character grounding, footfall
 * placement and spell impact points all need heights, and re-implementing the
 * noise in JavaScript would mean f32 GPU maths against f64 JS maths — the two
 * would disagree by centimetres and the character would visibly float or sink.
 * Reading back the exact bake makes disagreement structurally impossible.
 */

import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { S } from "../core/settings.js";
import { bakeOnce } from "../core/gpuUtil.js";

export const WORLD_SIZE = 2048; // metres across the whole field
export const HEIGHT_RES = 4096; // 0.5 m per texel
export const AUX_RES = 2048;

/** Half-extent the player is kept inside, leaving margin for the far rings. */
export const PLAY_RADIUS = 620;

export class Heightfield {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.origin = new Vector2(-WORLD_SIZE / 2, -WORLD_SIZE / 2);
        this.size = WORLD_SIZE;
        this.texelWorld = WORLD_SIZE / HEIGHT_RES;

        /** @type {Float32Array|null} */
        this.heightCPU = null;
        this.cpuRes = 0;
        /** Measured relief, filled in by `_readback`. */
        this.minHeight = 0;
        this.maxHeight = 0;

        this.heightTex = new ProceduralTexture(
            "heightTex",
            { width: HEIGHT_RES, height: HEIGHT_RES },
            "heightBake",
            scene,
            {
                generateMipMaps: false,
                type: Constants.TEXTURETYPE_FLOAT,
                // Two channels, not four: the bake writes height in R and the
                // rock mask in G, and nothing reads B or A. At 4096² the two
                // unused channels would be 134 MB of VRAM holding zeroes.
                format: Constants.TEXTUREFORMAT_RG,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
            }
        );
        this.heightTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.heightTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.heightTex.refreshRate = 0;

        this.auxTex = new ProceduralTexture(
            "auxTex",
            { width: AUX_RES, height: AUX_RES },
            "auxBake",
            scene,
            {
                generateMipMaps: false,
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
            }
        );
        this.auxTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.auxTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.auxTex.refreshRate = 0;
    }

    /** Run both bakes and mirror the height to the CPU. */
    async bake() {
        const windAngle = (S.windDirection * Math.PI) / 180;
        const riverFlowAngle = (S.riverFlowDir * Math.PI) / 180;
        const riverness = S.showRiver ? S.riverness : 0;

        this.heightTex.setVector2("worldOrigin", this.origin);
        this.heightTex.setFloat("worldSize", this.size);
        this.heightTex.setFloat("windAngle", windAngle);
        this.heightTex.setFloat("heightAmp", S.macroHeightScale);
        this.heightTex.setFloat("riverFlowAngle", riverFlowAngle);
        this.heightTex.setFloat("riverness", riverness);
        this.heightTex.setFloat("riverWidth", S.riverWidth);
        this.heightTex.setFloat("riverDepth", S.riverDepth);
        await bakeOnce(this.heightTex, "heightBake");

        // The aux bake differentiates the height bake, so it has to run after.
        this.auxTex.setTexture("heightTex", this.heightTex);
        this.auxTex.setFloat("texelWorld", this.texelWorld);
        this.auxTex.setFloat("invHeightRes", 1 / HEIGHT_RES);
        await bakeOnce(this.auxTex, "auxBake");

        await this._readback();
    }

    async _readback() {
        const raw = await this.heightTex.readPixels(0, 0);
        if (!raw) {
            console.warn("[heightfield] readback failed; grounding will be flat");
            return;
        }
        const src = /** @type {Float32Array} */ (raw);

        // Derived rather than assumed. `readPixels` may hand back the texture's
        // own channel count or a widened RGBA copy depending on the backend, and
        // getting this wrong does not throw — it silently shears the grounding
        // field, which then shows up as the character sinking into slopes.
        const stride = Math.max(1, Math.round(src.length / (HEIGHT_RES * HEIGHT_RES)));

        // Keep only R, at half resolution: 1 m spacing is ample for grounding
        // and avoids holding 67 MB resident forever.
        //
        // Averaged as a 2x2 box rather than point-sampled. Point-sampling texel
        // 2x puts the sample at world (x + 0.25) while `heightAt` reconstructs
        // as though it sat at (x + 0.5), and a quarter-texel shift on a steep
        // dune face sinks the character into the surface. The box filter lands
        // the sample exactly on the centre `heightAt` assumes.
        const res = HEIGHT_RES / 2;
        const dst = new Float32Array(res * res);
        for (let y = 0; y < res; y++) {
            const r0 = y * 2 * HEIGHT_RES;
            const r1 = (y * 2 + 1) * HEIGHT_RES;
            for (let x = 0; x < res; x++) {
                const c0 = x * 2;
                const c1 = c0 + 1;
                dst[y * res + x] =
                    (src[(r0 + c0) * stride] + src[(r0 + c1) * stride] +
                     src[(r1 + c0) * stride] + src[(r1 + c1) * stride]) * 0.25;
            }
        }

        this.heightCPU = dst;
        this.cpuRes = res;
        this.cpuTexel = this.size / res;

        // Actual relief, for anything that needs to bound the world vertically —
        // the shadow cascades size their light volume from it. Measured rather
        // than assumed, because the bake's amplitude is a tunable and a bound
        // that is quietly wrong clips geometry out of the depth map.
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < dst.length; i++) {
            const v = dst[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        this.minHeight = lo;
        this.maxHeight = hi;
    }

    /**
     * Bicubic B-spline height lookup, matching the vertex shader's
     * reconstruction so the ground the character stands on is the ground that
     * is drawn.
     * @param {number} x @param {number} z
     */
    heightAt(x, z) {
        const h = this.heightCPU;
        if (!h) return 0;
        const res = this.cpuRes;

        const fx = ((x - this.origin.x) / this.size) * res - 0.5;
        const fz = ((z - this.origin.y) / this.size) * res - 0.5;

        const ix = Math.floor(fx);
        const iz = Math.floor(fz);
        const tx = fx - ix;
        const tz = fz - iz;

        // Cubic B-spline weights.
        const wx = _w;
        const wz = _w2;
        bsplineWeights(tx, wx);
        bsplineWeights(tz, wz);

        let sum = 0;
        for (let j = 0; j < 4; j++) {
            const zz = clampi(iz - 1 + j, 0, res - 1);
            const row = zz * res;
            let rowSum = 0;
            for (let i = 0; i < 4; i++) {
                const xx = clampi(ix - 1 + i, 0, res - 1);
                rowSum += h[row + xx] * wx[i];
            }
            sum += rowSum * wz[j];
        }
        return sum;
    }

    /**
     * Surface normal from the same reconstruction, by central difference.
     * @param {number} x @param {number} z @param {Vector3} out
     */
    normalAt(x, z, out) {
        const e = this.cpuTexel || 1;
        const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
        const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
        out.set(-hx / (2 * e), 1, -hz / (2 * e));
        out.normalize();
        return out;
    }

    /** Clamp a world position to the playable area, in place. */
    clampToPlayArea(v) {
        const r = PLAY_RADIUS;
        const d = Math.hypot(v.x, v.z);
        if (d > r) {
            const k = r / d;
            v.x *= k;
            v.z *= k;
        }
    }

    dispose() {
        this.heightTex.dispose();
        this.auxTex.dispose();
        this.heightCPU = null;
    }
}

const _w = new Float32Array(4);
const _w2 = new Float32Array(4);

function bsplineWeights(t, out) {
    const t2 = t * t;
    const t3 = t2 * t;
    out[0] = (1 - 3 * t + 3 * t2 - t3) / 6;
    out[1] = (4 - 6 * t2 + 3 * t3) / 6;
    out[2] = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
    out[3] = t3 / 6;
}

function clampi(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

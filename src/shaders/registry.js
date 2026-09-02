/**
 * Registers every WGSL source into Babylon's shader store.
 *
 * Shared libraries go in as `#include<...>` fragments so the height bake and the
 * runtime snow material compile literally the same text — the terrain would pull
 * apart at the seams if they ever drifted. Whole shaders go in under the names
 * Babylon expects: `<name>VertexShader` and `<name>PixelShader`.
 *
 * Import this once, before any material is constructed.
 */

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

import noiseLib from "./lib/noise.wgsl?raw";
import terrainLib from "./lib/terrain.wgsl?raw";
import shadingLib from "./lib/shading.wgsl?raw";
import shadowLookupLib from "./lib/shadowLookup.wgsl?raw";
import atmosphereLib from "./lib/atmosphere.wgsl?raw";
import clipmapLib from "./lib/clipmap.wgsl?raw";
import deformLib from "./lib/deform.wgsl?raw";
import charSkinLib from "./lib/charSkin.wgsl?raw";
import wakeLib from "./lib/wake.wgsl?raw";
import spellLightsLib from "./lib/spellLights.wgsl?raw";
import waterLib from "./lib/water.wgsl?raw";
import crystalLib from "./lib/crystal.wgsl?raw";
import postCommonLib from "./lib/postCommon.wgsl?raw";
import ridgeLib from "./lib/ridge.wgsl?raw";

import heightBakeFrag from "./heightBake.fragment.wgsl?raw";
import auxBakeFrag from "./auxBake.fragment.wgsl?raw";
import detailBakeFrag from "./detailBake.fragment.wgsl?raw";
import skyBakeFrag from "./skyBake.fragment.wgsl?raw";
import deformSimFrag from "./deformSim.fragment.wgsl?raw";

import snowVert from "./snow.vertex.wgsl?raw";
import snowFrag from "./snow.fragment.wgsl?raw";
import depthVert from "./terrainDepth.vertex.wgsl?raw";
import depthFrag from "./terrainDepth.fragment.wgsl?raw";
import skyVert from "./sky.vertex.wgsl?raw";
import skyFrag from "./sky.fragment.wgsl?raw";

import charVert from "./char.vertex.wgsl?raw";
import charFrag from "./char.fragment.wgsl?raw";
import clothVert from "./cloth.vertex.wgsl?raw";
import charDepthVert from "./charDepth.vertex.wgsl?raw";
import clothDepthVert from "./clothDepth.vertex.wgsl?raw";
import furVert from "./fur.vertex.wgsl?raw";
import furFrag from "./fur.fragment.wgsl?raw";
import sprayVert from "./spray.vertex.wgsl?raw";
import sprayFrag from "./spray.fragment.wgsl?raw";
import wakeVert from "./wake.vertex.wgsl?raw";
import wakeFrag from "./wake.fragment.wgsl?raw";
import wakeDepthVert from "./wakeDepth.vertex.wgsl?raw";
import wakeDepthFrag from "./wakeDepth.fragment.wgsl?raw";
import waterVert from "./water.vertex.wgsl?raw";
import waterFrag from "./water.fragment.wgsl?raw";
import riverVert from "./river.vertex.wgsl?raw";
import riverFrag from "./river.fragment.wgsl?raw";
import sphScatterCompute from "./sphScatter.compute.wgsl?raw";
import sphIntegrateCompute from "./sphIntegrate.compute.wgsl?raw";
import gridSolveFrag from "./gridSolve.fragment.wgsl?raw";
import particleVert from "./particle.vertex.wgsl?raw";
import particleFrag from "./particle.fragment.wgsl?raw";
import particleDepthVert from "./particleDepth.vertex.wgsl?raw";
import particleDepthFrag from "./particleDepth.fragment.wgsl?raw";
import ssfrBlurFrag from "./ssfrBlur.fragment.wgsl?raw";
import ssfrSurfaceFrag from "./ssfrSurface.fragment.wgsl?raw";
import fullscreenVert from "./fullscreen.vertex.wgsl?raw";
import crystalVert from "./crystal.vertex.wgsl?raw";
import crystalFrag from "./crystal.fragment.wgsl?raw";
import crystalDepthVert from "./crystalDepth.vertex.wgsl?raw";

import prepassFrag from "./prepass.fragment.wgsl?raw";
import terrainPrepassVert from "./terrainPrepass.vertex.wgsl?raw";
import charPrepassVert from "./charPrepass.vertex.wgsl?raw";
import clothPrepassVert from "./clothPrepass.vertex.wgsl?raw";
import wakePrepassVert from "./wakePrepass.vertex.wgsl?raw";
import wakePrepassFrag from "./wakePrepass.fragment.wgsl?raw";
import crystalPrepassVert from "./crystalPrepass.vertex.wgsl?raw";


const INCLUDES = {
    snowNoise: noiseLib,
    snowTerrain: terrainLib,
    snowShading: shadingLib,
    snowShadowLookup: shadowLookupLib,
    snowAtmosphere: atmosphereLib,
    snowClipmap: clipmapLib,
    snowDeform: deformLib,
    snowCharSkin: charSkinLib,
    snowWake: wakeLib,
    snowSpellLights: spellLightsLib,
    snowWater: waterLib,
    snowCrystal: crystalLib,
    snowPostCommon: postCommonLib,
    snowRidge: ridgeLib,
};

const SHADERS = {
    heightBakePixelShader: heightBakeFrag,
    auxBakePixelShader: auxBakeFrag,
    detailBakePixelShader: detailBakeFrag,
    skyBakePixelShader: skyBakeFrag,
    deformSimPixelShader: deformSimFrag,

    snowVertexShader: snowVert,
    snowPixelShader: snowFrag,

    terrainDepthVertexShader: depthVert,
    terrainDepthPixelShader: depthFrag,

    skyVertexShader: skyVert,
    skyPixelShader: skyFrag,

    charVertexShader: charVert,
    charPixelShader: charFrag,
    clothVertexShader: clothVert,
    charDepthVertexShader: charDepthVert,
    clothDepthVertexShader: clothDepthVert,
    furVertexShader: furVert,
    furPixelShader: furFrag,
    sprayVertexShader: sprayVert,
    sprayPixelShader: sprayFrag,
    wakeVertexShader: wakeVert,
    wakePixelShader: wakeFrag,
    wakeDepthVertexShader: wakeDepthVert,
    wakeDepthPixelShader: wakeDepthFrag,

    waterVertexShader: waterVert,
    waterPixelShader: waterFrag,
    riverVertexShader: riverVert,
    riverPixelShader: riverFrag,

    // First webGPU-compute shaders in the repo. Registered under the names
    // Babylon's ComputeShader expects: `<name>ComputeShader` in ShadersStoreWGSL.
    sphScatterComputeShader: sphScatterCompute,
    sphIntegrateComputeShader: sphIntegrateCompute,
    gridSolvePixelShader: gridSolveFrag,
    particleVertexShader: particleVert,
    particlePixelShader: particleFrag,
    particleDepthVertexShader: particleDepthVert,
    particleDepthPixelShader: particleDepthFrag,
    ssfrBlurPixelShader: ssfrBlurFrag,
    ssfrSurfacePixelShader: ssfrSurfaceFrag,
    fullscreenVertexShader: fullscreenVert,
    crystalVertexShader: crystalVert,
    crystalPixelShader: crystalFrag,
    crystalDepthVertexShader: crystalDepthVert,

    // The camera-space depth prepass. One fragment stage shared by everything
    // that has nothing to discard; the wake carries its own because it does.
    prepassPixelShader: prepassFrag,
    terrainPrepassVertexShader: terrainPrepassVert,
    charPrepassVertexShader: charPrepassVert,
    clothPrepassVertexShader: clothPrepassVert,
    wakePrepassVertexShader: wakePrepassVert,
    wakePrepassPixelShader: wakePrepassFrag,
    crystalPrepassVertexShader: crystalPrepassVert,
};

let registered = false;

export function registerShaders() {
    if (registered) return;
    registered = true;

    for (const name in INCLUDES) {
        ShaderStore.IncludesShadersStoreWGSL[name] = INCLUDES[name];
    }
    for (const name in SHADERS) {
        ShaderStore.ShadersStoreWGSL[name] = SHADERS[name];
    }

    if (typeof window !== "undefined") window.ShaderStore = ShaderStore;
}

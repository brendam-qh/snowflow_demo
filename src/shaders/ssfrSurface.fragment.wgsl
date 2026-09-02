// SSFR surface composite -- replaces the billboard renderer with a screen-space
// water surface. Reads the smoothed particle depth + thickness, reconstructs
// normals from depth gradients, and shades with the same water material as the
// MVP river surface: depth absorption, sky Fresnel, sun glint, tonemapped teal.
//
// Rendered as a full-screen quad over the scene, depth-tested against the
// terrain depth buffer so the water only appears where particles exist AND
// are in front of the terrain.

#include<snowNoise>
#include<snowShading>
#include<snowAtmosphere>

// DEBUG: read depthRTT directly (bypass blur) to verify the RTT has data.
var ssfrDepthRTT: texture_2d<f32>;
var ssfrDepthRTTSampler: sampler;

var ssfrDepth: texture_2d<f32>;
var ssfrDepthSampler: sampler;

var sceneDepth: texture_2d<f32>;
var sceneDepthSampler: sampler;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform cameraPos: vec3f;
uniform viewProjection: mat4x4f;
uniform invViewProjection: mat4x4f;
uniform texel: vec2f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform waterDepthTint: f32;
uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

const WATER_ABSORB: vec3f = vec3f(4.6, 1.0, 0.42);
const INV_PI: f32 = 0.31830988618;

fn worldFromDepth(uv: vec2f, depth: f32) -> vec3f {
    let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    let inv = uniforms.invViewProjection * ndc;
    let viewDir = inv.xyz;
    let world = uniforms.cameraPos + normalize(viewDir) * depth;
    return world;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;

    // DEBUG: read depthRTT directly to check if it has particle data.
    let direct = textureSampleLevel(ssfrDepthRTT, ssfrDepthRTTSampler, uv, 0.0);
    var outColor = vec4f(0.0, 0.0, 0.0, 0.0);

    if (direct.a >= 0.5) {
        outColor = vec4f(1.0, 0.2, 0.2, 0.8);
    }

    fragmentOutputs.color = outColor;
}

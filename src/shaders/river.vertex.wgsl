// -----------------------------------------------------------------------------
// River surface — MVP kinematic water plane.
//
// One giant quad covering the whole playable field, at a fixed y (waterY). The
// fragment shader runs the same `riverChannel` analytic the bake used, gates per
// pixel on the bed mask, and shades surface + depth absorption + sky reflection.
// Time is fed from the run loop so the ripple field advects down the channel; no
// particle simulation yet, that's Phase B proper.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowTerrain>
#include<snowShading>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vUV: vec2f;
varying vViewDist: f32;

attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform waterY: f32;
uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform time: f32;
uniform flowSpeed: f32;

// River shape — shared with terrain + snow material via snowTerrain.
uniform riverFlowAngle: f32;
uniform riverness: f32;
uniform riverWidth: f32;
uniform riverDepth: f32;

// Sun + sky (same as every other lit surface here).
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;
uniform ambientIntensity: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

// Tuning — see `S.river*`.
uniform waterDepthTint: f32;
uniform waterAlpha: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    // The plane is laid flat in the XZ plane at y=0; lift it to waterY here so
    // every vertex shares the same surface. The clipmap centre follows the
    // player but the river plane stays at a fixed world position, sized to cover
    // the whole field — there is nothing to follow.
    let world = vec3f(vertexInputs.position.x, uniforms.waterY, vertexInputs.position.z);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
    vertexOutputs.vWorld = world;
    vertexOutputs.vUV = vertexInputs.position.xz;
    vertexOutputs.vViewDist = length(uniforms.cameraPos - world);
}

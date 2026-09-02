// Particle depth pre-pass vertex -- renders each particle as a camera-facing
// point sprite, writing view-space depth (R) and thickness (G) into an RTT.

struct Particle {
    pos: vec3f,
    invMass: f32,
    vel: vec3f,
    age: f32,
};

var<storage, read> particles: array<Particle>;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform cameraRight: vec3f;
uniform cameraUp: vec3f;
uniform particleSize: f32;
uniform particleCount: f32;

attribute position: vec3f;

varying vViewDepth: f32;
varying vThickness: f32;
varying vCornerDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let particleIdx = input.vertexIndex / 6u;
    let corner = input.position.xy;
    let p = particles[particleIdx];
    let world = p.pos + (uniforms.cameraRight.xyz * corner.x + uniforms.cameraUp.xyz * corner.y) * uniforms.particleSize;

    let clip = uniforms.viewProjection * vec4f(world, 1.0);
    vertexOutputs.position = clip;
    vertexOutputs.vViewDepth = clip.w;
    vertexOutputs.vThickness = uniforms.particleSize * 2.0;
    vertexOutputs.vCornerDist = length(corner);
}

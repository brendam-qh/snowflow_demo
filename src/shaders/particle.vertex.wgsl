// Particle billboard vertex -- reads particle position from a storage buffer
// shared with the compute kernels. Each instance renders one camera-facing
// quad; `instanceIndex` maps to the particle index in the buffer.

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

attribute position: vec3f;   // unit quad corner in XY, z = 0

varying vWorld: vec3f;
varying vAlpha: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let particleIdx = input.vertexIndex / 6u;
    let corner = input.position.xy;
    let p = particles[particleIdx];
    let world = p.pos + (uniforms.cameraRight.xyz * corner.x + uniforms.cameraUp.xyz * corner.y) * uniforms.particleSize;

    vertexOutputs.vWorld = world;
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);

    // All submerged particles render at full alpha. Splashes above the surface
    // fade out over 2m.
    let surfaceY = -15.0;
    let underwater = surfaceY - p.pos.y;
    let alpha = select(0.0, clamp(underwater * 0.5 + 0.3, 0.0, 1.0), underwater > 0.0);
    vertexOutputs.vAlpha = alpha;
}

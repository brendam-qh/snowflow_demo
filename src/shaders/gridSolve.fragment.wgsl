// -----------------------------------------------------------------------------
// gridSolve -- PIC/FLIP grid solve, fragment-pass-on-ProceduralTexture.
//
// One RGBA32F target, ping-ponged between two `ProceduralTexture`s exactly as
// `deformSim` does. The grid window covers only the channel bed AABB -- far
// smaller than the terrain heightfield -- so this is cheap.
//
// Channels of the ping-pong target:
//   R  velocity.x  (metres/sec)
//   G  velocity.z
//   B  pressure    -- solved out each step so water doesn't compress
//   A  density     -- how many particles ended up in this cell (for the render
//                    pass and for the next-frame velocity normalisation)
//
// Each dispatch does, in order:
//   1. inflow boundary  -- cells on the upstream edge get the channel's
//                         steady flow velocity written in.
//   2. advection        -- semi-Lagrangian back-trace: sample the previous
//                         frame's velocity where this cell came from.
//   3. external force   -- gravity-tangent along the bed gradient (so the
//                         river flows downhill), computed from the bed analytic.
//   4. projection       -- one Jacobi sweep toward incompressibility. Six sweeps
//                         would be more converged than one, but at river scale
//                         the bed gradient dominates and one sweep is enough
//                         to kill the worst compression artefacts.
//   5. solid no-flow    -- cells flagged `solid` by the scatter pass get their
//                         inward velocity components zeroed.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowTerrain>

varying vUV: vec2f;

var prevGrid: texture_2d<f32>;
var prevGridSampler: sampler;

var gridSolidTex: texture_2d<f32>;   // 2D mirror of the scatter pass's solid
var gridSolidTexSampler: sampler;    // flag, so this pass can sample it.

uniform gridOrigin: vec2f;
uniform gridSize:   vec2f;     // world extent (metres)
uniform gridCells:  vec2f;     // texel counts (== texture dims)
uniform dt: f32;

uniform riverFlowAngle: f32;
uniform flowSpeed: f32;        // target channel speed (m/s)
uniform gravity: f32;
uniform waterY: f32;
uniform bedFloorY: f32;

fn cellWorld(uv: vec2f) -> vec2f {
    return uniforms.gridOrigin + uv * uniforms.gridSize;
}

fn texelOf(world: vec2f) -> vec2f {
    return (world - uniforms.gridOrigin) / uniforms.gridSize * uniforms.gridCells;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let world = cellWorld(uv);
    let pp = textureSampleLevel(prevGrid, prevGridSampler, uv, 0.0);
    var velX = pp.r;
    var velZ = pp.g;
    var pressure = pp.b;
    var density = pp.a;

    // -------------------------------------------------------- inflow boundary
    // Upstream edge is the half-edge in the negative flow direction. The river
    // keeps itself full: water enters the grid here at the steady channel
    // speed and travels along the flow axis.
    let flowDir = vec2f(cos(uniforms.riverFlowAngle), sin(uniforms.riverFlowAngle));
    let perp = vec2f(-flowDir.y, flowDir.x);
    let along = dot(world - uniforms.gridOrigin, flowDir);
    let widthAlong = dot(uniforms.gridSize, flowDir);
    if (along < uniforms.gridSize.x * 0.08) {
        velX = flowDir.x * uniforms.flowSpeed;
        velZ = flowDir.y * uniforms.flowSpeed;
        density = max(density, 1.0);
    }

    // ------------------------------------------------------------- advection
    // Semi-Lagrangian back-trace: this cell's velocity is whatever was at
    // (world - vel*dt) last frame.
    let back = world - vec2f(velX, velZ) * uniforms.dt;
    let uvBack = (back - uniforms.gridOrigin) / uniforms.gridSize;
    let adv = textureSampleLevel(prevGrid, prevGridSampler, uvBack, 0.0);
    velX = mix(velX, adv.r, 0.8);
    velZ = mix(velZ, adv.g, 0.8);

    // ------------------------------------------------- bed-gradient gravity
    // The force on the water is gravity projected onto the bed's tangent.
    // `riverChannel` gives us the bed shape analytically; its gradient is the
    // signed slope of the bed along the flow + perpendicular.
    let riv = riverChannel(world, uniforms.riverFlowAngle, 1.0, 1.0, 1.0);
    // `riv.x` is already the absolute bed elevation, so this is a straight read.
    // It used to be negated, which flipped it positive and left the `bedH <
    // waterY` test below permanently false — the bed-slope gravity never ran.
    let bedH = riv.x;  // bed-floor height, metres
    // Finite-difference the bed gradient.
    let e = max(uniforms.gridSize.x / uniforms.gridCells.x * 0.5, 0.5);
    let rivXp = riverChannel(world + vec2f(e, 0.0), uniforms.riverFlowAngle, 1.0, 1.0, 1.0);
    let rivXm = riverChannel(world - vec2f(e, 0.0), uniforms.riverFlowAngle, 1.0, 1.0, 1.0);
    let rivZp = riverChannel(world + vec2f(0.0, e), uniforms.riverFlowAngle, 1.0, 1.0, 1.0);
    let rivZm = riverChannel(world - vec2f(0.0, e), uniforms.riverFlowAngle, 1.0, 1.0, 1.0);
    let gradX = -(rivXp.x - rivXm.x) / (2.0 * e);
    let gradZ = -(rivZp.x - rivZm.x) / (2.0 * e);
    // Only apply where the bed is below the water surface (i.e. there's water
    // here to flow). Above the surface this is dry ground.
    if (bedH < uniforms.waterY) {
        velX += uniforms.gravity * gradX * uniforms.dt;
        velZ += uniforms.gravity * gradZ * uniforms.dt;
    }

    // ------------------------------------------------------- projection sweep
    // One Jacobi step toward div(v)=0. The divergence here is between this
    // cell and its four neighbours, with a Neumann boundary at solid cells.
    let tex = vec2f(uniforms.gridCells);
    let du = textureSampleLevel(prevGrid, prevGridSampler, uv + vec2f(1.0, 0.0) / tex, 0.0);
    let dd = textureSampleLevel(prevGrid, prevGridSampler, uv - vec2f(1.0, 0.0) / tex, 0.0);
    let dr = textureSampleLevel(prevGrid, prevGridSampler, uv + vec2f(0.0, 1.0) / tex, 0.0);
    let dl = textureSampleLevel(prevGrid, prevGridSampler, uv - vec2f(0.0, 1.0) / tex, 0.0);
    let div = (du.r - dd.r + dr.g - dl.g) * 0.5;
    // Pressure relax toward the divergence-cancelling value.
    let neighP = (du.b + dd.b + dr.b + dl.b) * 0.25;
    pressure = mix(pressure, neighP - div * 0.5, 0.5);
    // Velocity correction: subtract the pressure gradient.
    velX -= (du.b - dd.b) * 0.5;
    velZ -= (dr.b - dl.b) * 0.5;

    // ----------------------------------------------------- solid no-flow
    let solid = textureSampleLevel(gridSolidTex, gridSolidTexSampler, uv, 0.0).r;
    if (solid > 0.5) {
        velX = 0.0;
        velZ = 0.0;
    }

    fragmentOutputs.color = vec4f(velX, velZ, pressure, density);
}

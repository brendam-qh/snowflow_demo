// -----------------------------------------------------------------------------
// SPH scatter -- particle -> grid density/velocity bucket sums.
//
// First @compute kernel in the repo. Each thread takes one marker particle,
// hashes it into the grid by floor(worldXZ / cell), and atomicAdds its weight
// into the grid's density bucket and weighted-velocity bucket.
//
// WebGPU atomicAdd only works on i32/u32 -- not f32. The grid buffers are
// declared as `array<atomic<i32>>` and contributions are scaled by `SCALE`
// (fixed-point). The integrate kernel reads the i32 values and divides back
// to float.
// -----------------------------------------------------------------------------

#include<snowNoise>

struct Particle {
    pos: vec3f,
    invMass: f32,
    vel: vec3f,
    age: f32,
};

// Fixed-point scale: 1024 = 10 bits of fraction. Density weights are 0..1, so
// a cell with ~30 particles peaks at ~30720 -- well within i32 range.
const SCALE: i32 = 1024;

@group(0) @binding(0) var<storage, read>          particlesIn:  array<Particle>;
@group(0) @binding(1) var<storage, read_write>    gridDensity:   array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write>    gridVelX:      array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write>    gridVelZ:      array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write>    gridSolid:     array<atomic<i32>>;

struct ScatterUniforms {
    gridOrigin: vec2f,
    gridSize: vec2f,
    gridCells: vec2u,
    cellSize: f32,
    particleCount: u32,
    waterY: f32,
    bedFloorY: f32,
};
@group(0) @binding(5) var<uniform> uniforms: ScatterUniforms;

fn cellIndex(world: vec2f) -> vec2u {
    let f = floor((world - uniforms.gridOrigin) / uniforms.cellSize);
    return vec2u(u32(f.x), u32(f.y));
}

fn inBounds(c: vec2u) -> bool {
    return c.x < uniforms.gridCells.x && c.y < uniforms.gridCells.y;
}

fn linearIndex(c: vec2u) -> u32 {
    return c.y * uniforms.gridCells.x + c.x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid_v: vec3u) {
    let gid = gid_v.x;
    if (gid >= uniforms.particleCount) { return; }
    let p = particlesIn[gid];
    let c = cellIndex(p.pos.xz);
    if (!inBounds(c)) { return; }
    let idx = linearIndex(c);

    // A simple cubic-spline-ish weight: 1.0 at the cell centre, falling to 0
    // at distance `cellSize`. One-bucket splat keeps the atomicAdd count at
    // a single op per particle, which matters -- atomic contention is the
    // bottleneck on Apple TBDR for a scatter pass.
    let cc = uniforms.gridOrigin + vec2f(f32(c.x) + 0.5, f32(c.y) + 0.5) * uniforms.cellSize;
    let d = distance(p.pos.xz, cc);
    let w = max(0.0, 1.0 - d / uniforms.cellSize);

    atomicAdd(&gridDensity[idx], i32(w * f32(SCALE)));
    atomicAdd(&gridVelX[idx],    i32(p.vel.x * w * f32(SCALE)));
    atomicAdd(&gridVelZ[idx],    i32(p.vel.z * w * f32(SCALE)));

    // If the particle is below the bed floor (inside terrain), flag the cell
    // solid so the solve pass doesn't flow into it; the integrate kernel
    // does the actual position push-out.
    if (p.pos.y < uniforms.bedFloorY) {
        atomicAdd(&gridSolid[idx], 1);
    }
}

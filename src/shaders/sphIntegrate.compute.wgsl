// -----------------------------------------------------------------------------
// SPH integrate -- read scattered grid, apply advection + gravity + repulsion.
//
// Second @compute pass, run after the grid solve has finished. Each thread
// takes one marker particle, looks up the cell it currently lives in, reads
// the (now-normalised) grid velocity, and does explicit Euler:
//
//   vel += dt * ( gravity + cellFlow * drag - solidRepulsion )
//   pos += dt * vel
//
// The grid velocity is sampled tri-linearly across the 4 neighbouring cells so
// a particle near a cell boundary doesn't snap. Solid cells push a *repulsion*
// -- not a hard clamp -- so a particle shoved against the bank slides along it
// rather than sticking.
//
// Ping-pong: reads `particlesIn`, writes `particlesOut`. The JS orchestrator
// swaps the two buffers after dispatch.
// -----------------------------------------------------------------------------

struct Particle {
    pos: vec3f,
    invMass: f32,
    vel: vec3f,
    age: f32,
};

@group(0) @binding(0) var<storage, read>  particlesIn:   array<Particle>;
@group(0) @binding(1) var<storage, read>  gridDensity:   array<i32>;
@group(0) @binding(2) var<storage, read>  gridVelX:      array<i32>;
@group(0) @binding(3) var<storage, read>  gridVelZ:      array<i32>;
@group(0) @binding(4) var<storage, read>  gridSolid:     array<i32>;

@group(1) @binding(0) var<storage, read_write> particlesOut: array<Particle>;

// Must match the scatter kernel's SCALE -- fixed-point to f32 conversion.
const SCALE: f32 = 1024.0;

struct IntegrateUniforms {
    gridOrigin: vec2f,
    cellSize: f32,
    gridCells: vec2u,
    particleCount: u32,
    dt: f32,
    gravity: f32,
    flowDrag: f32,
    characterPos: vec3f,
    characterRadius: f32,
    waterY: f32,
    bedFloorY: f32,
};
@group(0) @binding(5) var<uniform> uniforms: IntegrateUniforms;

fn linearIndex(c: vec2u) -> u32 {
    return c.y * uniforms.gridCells.x + c.x;
}

/// Compute the four cell indices + OOB flag for bilinear sampling.
/// Returns the four linear indices in a vec4u (00, 01, 10, 11) and sets
/// `valid` to false if any neighbour is outside the grid.
fn sampleIndices(c0: vec2u, c1: vec2u) -> vec4u {
    return vec4u(
        linearIndex(c0),
        linearIndex(vec2u(c0.x, c1.y)),
        linearIndex(vec2u(c1.x, c0.y)),
        linearIndex(c1),
    );
}

fn inWindow(c0: vec2u, c1: vec2u) -> bool {
    return c0.x < uniforms.gridCells.x && c0.y < uniforms.gridCells.y &&
           c1.x < uniforms.gridCells.x && c1.y < uniforms.gridCells.y;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid_v: vec3u) {
    let gid = gid_v.x;
    if (gid >= uniforms.particleCount) { return; }
    let p = particlesIn[gid];

    // Cell centre indices around the particle's current position.
    let f = (p.pos.xz - uniforms.gridOrigin) / uniforms.cellSize - 0.5;
    let c0 = vec2u(u32(max(0.0, floor(f.x))), u32(max(0.0, floor(f.y))));
    let c1 = vec2u(c0.x + 1u, c0.y + 1u);
    let ft = vec2f(f.x - floor(f.x), f.y - floor(f.y));

    let ix = sampleIndices(c0, c1);
    var dens = 0.0; var vxN = 0.0; var vzN = 0.0; var sol = 0.0;
    if (inWindow(c0, c1)) {
        let v00d = f32(gridDensity[ix.x]); let v01d = f32(gridDensity[ix.y]);
        let v10d = f32(gridDensity[ix.z]); let v11d = f32(gridDensity[ix.w]);
        dens = mix(mix(v00d, v10d, ft.x), mix(v01d, v11d, ft.x), ft.y) / SCALE;

        let v00x = f32(gridVelX[ix.x]); let v01x = f32(gridVelX[ix.y]);
        let v10x = f32(gridVelX[ix.z]); let v11x = f32(gridVelX[ix.w]);
        vxN = mix(mix(v00x, v10x, ft.x), mix(v01x, v11x, ft.x), ft.y) / SCALE;

        let v00z = f32(gridVelZ[ix.x]); let v01z = f32(gridVelZ[ix.y]);
        let v10z = f32(gridVelZ[ix.z]); let v11z = f32(gridVelZ[ix.w]);
        vzN = mix(mix(v00z, v10z, ft.x), mix(v01z, v11z, ft.x), ft.y) / SCALE;

        let v00s = f32(gridSolid[ix.x]); let v01s = f32(gridSolid[ix.y]);
        let v10s = f32(gridSolid[ix.z]); let v11s = f32(gridSolid[ix.w]);
        sol = mix(mix(v00s, v10s, ft.x), mix(v01s, v11s, ft.x), ft.y);
    }

    var vel = p.vel;
    var pos = p.pos;

    // Grid velocity if this cell has particles in it; otherwise just keep the
    // particle's own velocity. Guarding against zero-density prevents NaN.
    let cellVx = select(vel.x, vxN / dens, dens > 1e-4);
    let cellVz = select(vel.z, vzN / dens, dens > 1e-4);

    // Flow drag: particles chase the grid field. Rates tuned in settings.
    vel.x += (cellVx - vel.x) * uniforms.flowDrag * uniforms.dt;
    vel.z += (cellVz - vel.z) * uniforms.flowDrag * uniforms.dt;

    // Gravity, only when the particle is in water (below the surface).
    if (pos.y < uniforms.waterY) {
        vel.y += uniforms.gravity * uniforms.dt;
    } else {
        // Out of water -- slow the particle down (air drag) and let gravity
        // take over. Keeps splash particles from orbiting forever.
        vel.x *= 1.0 - 0.5 * uniforms.dt;
        vel.z *= 1.0 - 0.5 * uniforms.dt;
        vel.y += uniforms.gravity * uniforms.dt;
    }

    // Solid repulsion: if the sampled `solid` flag is high, push the particle
    // away from the cell centre in XZ so it slides along the bank rather than
    // sinking into terrain.
    if (sol > 0.5) {
        let cc = uniforms.gridOrigin + (vec2f(f32(c0.x) + 0.5, f32(c0.y) + 0.5) * uniforms.cellSize);
        let away = normalize(pos.xz - cc) * 1.5;
        vel.x += away.x;
        vel.z += away.y;
    }

    // Character repulsion: the wading body pushes water outward in XZ. Soft
    // falloff so it's a shove, not a hard wall.
    let toChar = pos - uniforms.characterPos;
    let dChar = length(toChar);
    if (dChar < uniforms.characterRadius * 1.5 && pos.y < uniforms.characterPos.y + 1.5) {
        let push = (1.0 - dChar / (uniforms.characterRadius * 1.5)) * 4.0;
        vel.x += (toChar.x / max(dChar, 0.01)) * push * uniforms.dt * 10.0;
        vel.z += (toChar.z / max(dChar, 0.01)) * push * uniforms.dt * 10.0;
        vel.y += push * uniforms.dt * 2.0;
    }

    // Integrate.
    pos += vel * uniforms.dt;

    // Clamp to the bed floor: never let a particle fall through terrain.
    if (pos.y < uniforms.bedFloorY) {
        pos.y = uniforms.bedFloorY;
        if (vel.y < 0.0) { vel.y = 0.0; }
    }

    // Age: smokers die after a while to keep the pool from growing forever.
    // Replaced by a recycler on the CPU side (out-of-bounds XZ re-spawns
    // upstream) -- this is only a soft kill for stray splashes.
    var age = p.age + uniforms.dt;
    if (pos.y > uniforms.waterY + 2.0) { age += uniforms.dt * 3.0; }

    particlesOut[gid] = Particle(pos, p.invMass, vel, age);
}

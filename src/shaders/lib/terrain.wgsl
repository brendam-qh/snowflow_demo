// -----------------------------------------------------------------------------
// snowTerrain — the landform.
//
// Split into two halves that live in different places at runtime:
//
//   terrainMacro()  broad dunes + medium drifts. Tens of metres down to about a
//                   metre. Baked once into a texture at load, because the CPU
//                   needs the same data for character grounding and reading back
//                   a bake is the only way to guarantee the two agree exactly.
//
//   terrainFine()   sastrugi ridges and wind ripples, decimetre and below.
//                   Evaluated live in the vertex and fragment shaders with exact
//                   analytic derivatives — far too fine to bake at any sane
//                   texture resolution, and cheap enough not to bother.
//
// Everything is anisotropic about a single prevailing wind direction, which is
// most of what separates a real snow field from a bumpy one: real fields are
// *carved*, and the carving has a direction. Broad forms run transverse
// to the wind (dune ridges), fine forms run parallel to it (sastrugi streaks).
// -----------------------------------------------------------------------------

/// Build the combined rotate-and-anisotropically-scale matrix for a noise layer.
/// `sx` stretches along the wind, `sy` across it; `scale` is the wavelength.
/// A layer's derivative maps back to world space with `dHdq * M`.
fn windMat(angle: f32, sx: f32, sy: f32, scale: f32) -> mat2x2f {
    let c = cos(angle);
    let s = sin(angle);
    let r = mat2x2f(c, -s, s, c);
    let d = mat2x2f(sx / scale, 0.0, 0.0, sy / scale);
    return d * r;
}

// ------------------------------------------------------------------- macro

/// Broad + medium landform. Returns metres.
/// `w` is the wind bearing in radians, `amp` a global height multiplier.
fn terrainMacro(p: vec2f, w: f32, amp: f32) -> f32 {
    // --- broad dunes -------------------------------------------------------
    // Compressed along the wind, so ridge lines run across it. Derivative
    // damping keeps crests smooth and lets detail pool in the troughs.
    let m1 = windMat(w, 2.1, 1.0, 58.0);
    let broad = fbmDamped(m1 * p, 5, 2.03, 0.5, 0.9);
    var h = broad.x * 15.5;

    // A second, much larger and gentler swell so the field never reads as one
    // repeating dune wavelength. This is what gives the horizon its long roll.
    let m0 = windMat(w, 1.35, 1.0, 210.0);
    let swell = fbmDamped(m0 * p, 3, 2.11, 0.55, 0.3);
    h += swell.x * 26.0;

    // --- medium drifts and wind lobes --------------------------------------
    // The domain is sheared along the wind by the broad height, which steepens
    // lee faces and flattens windward ones — dune asymmetry, near enough.
    let m2 = windMat(w, 1.55, 1.0, 13.5);
    var q2 = m2 * p;
    q2.x += broad.x * 2.4;
    let med = fbmDamped(q2, 4, 2.07, 0.48, 1.7);

    // Drifts pile up where the broad form is concave (troughs and lee pockets)
    // and get scoured off exposed crests.
    let shelter = clamp(0.5 - broad.x * 0.75, 0.15, 1.0);
    h += med.x * 2.9 * shelter;

    return h * amp;
}

/// Analytic macro derivative. Only the bake uses this — at runtime the value is
/// read from the baked aux texture. Kept here so the two can be diffed.
fn terrainMacroD(p: vec2f, w: f32, amp: f32) -> vec2f {
    let e = 0.35;
    let hx = terrainMacro(p + vec2f(e, 0.0), w, amp) - terrainMacro(p - vec2f(e, 0.0), w, amp);
    let hz = terrainMacro(p + vec2f(0.0, e), w, amp) - terrainMacro(p - vec2f(0.0, e), w, amp);
    return vec2f(hx, hz) / (2.0 * e);
}

// --------------------------------------------------------------------- river

/// The river channel — a meandering carved valley plus a narrow flat-bed trench,
/// subtracted from the macro heightfield at bake time.
///
/// `flowAngle` (radians) sets the river's prevailing bearing; two noise octaves
/// offset its centreline perpendicular to that bearing so it meanders on the
/// same scale as the dune field and the two read as one landform. Two scales
/// shape the cut:
///
///   valleyW/valleyD  a wide smooth U-bowl a hundred metres across, what you
///                    actually walk down into;
///   bedW/bedD        a narrower inner flat-floor trench where the water sits,
///                    so the channel floor is genuinely flat and the river
///                    is a river and not a ditch.
///
/// `cutAmt` is 0..1 — 0 returns zero and the river vanishes. `widthK`/`depthK`
/// scale both widths/depths together so the river widens and shallows as one.
///
/// Returns vec3f:
///   x  TARGET BED ELEVATION in metres, absolute — the height the channel wants
///      the ground to be, measured against the water plane. Callers blend the
///      macro heightfield toward it weighted by `z`; they do not add it.
///   y  BED MASK (0..1) — the narrow inner trench where the river actually
///      sits; the snow material tints this wet and the MVP water surface
///      renders across it. Not the wider valley, which is just shadowed
///      banks.
///   z  CHANNEL MASK (0..1) — valley + bed combined, for ambient darkening,
///      sastrugi suppression and SSS gating. Wider than `y`, which is why
///      the two are returned separately: the wet-stone tint wants the
///      narrow strip, every other adjustment wants the whole cut.
fn riverChannel(p: vec2f, flowAngle: f32, cutAmt: f32, widthK: f32, depthK: f32) -> vec3f {
    if (cutAmt <= 0.001) { return vec3f(0.0, 0.0, 0.0); }

    // The world height of the water plane. Must stay in step with `WATER_Y` in
    // fluid/riverSurface.js — the channel is shaped around it, so if the two
    // drift the river either drains to dry bed or floods its banks.
    let waterLevel = -15.0;

    let flowDir = vec2f(cos(flowAngle), sin(flowAngle));
    let perp = vec2f(-flowDir.y, flowDir.x);
    let along = dot(p, flowDir);
    let across = dot(p, perp);

    // Two-octave meander. Each term is `(noise - 0.5)` so that the channel
    // centreline is centred on across = 0 — which puts the river on the player
    // spawn at along = 0 and lets the walking-around view always face it.
    let meander = (noise2(vec2f(along * 0.0028, 11.3)) - 0.5) * 78.0
                + (noise2(vec2f(along * 0.0011, 41.7)) - 0.5) * 145.0;
    let d = across - meander;

    let valleyW = 95.0 * widthK;
    let bedW = 22.0 * widthK;
    // Water depth at the channel centre, in metres. The character is ~1.8 m tall
    // (HIP_HEIGHT 0.95, head at 1.655), so 1.1 m is waist-deep at the deepest
    // point and shelves to nothing at the banks: wadeable end to end.
    let bedD = 1.1 * depthK;
    // How far the valley rim climbs above the water. Only shapes the basin the
    // river sits in; the dune field still dominates out here.
    let bankRise = 7.0;

    let valleyMask = exp(-(d * d) / (2.0 * valleyW * valleyW));
    let bedMask = 1.0 - smoothstep(bedW, bedW * 1.7, abs(d));

    // `x` is an ABSOLUTE target elevation, not a delta to add to the dunes.
    //
    // It has to be, because the water is a plane at a fixed world height: if the
    // channel only subtracted from the dune field, the bed would inherit every
    // metre of dune relief and the water depth would swing from dry to metres
    // deep along the river's length. Subtracting enough to guarantee water
    // everywhere is what made it a chasm. Pinning the bed relative to the water
    // plane instead makes `bedD` mean exactly what it says.
    //
    // Centre of the bed sits bedD under the water; the bed edge comes up through
    // the waterline; the valley rim climbs to bankRise above it. The caller
    // blends toward this by `z` rather than replacing outright, so the bed keeps
    // some of the dune relief underneath — see heightBake.
    // `bedTarget`, not `target` — the latter is a WGSL reserved keyword and the
    // shader fails to parse. Same trap as `enable` / `cross` in DECISIONS.md.
    let bedTarget = waterLevel + bankRise * (1.0 - valleyMask) - bedD * bedMask;
    let bedOut = bedMask * cutAmt;
    // Full valleyMask, not 0.55 of it. As a blend weight this has to reach the
    // bed edge at nearly 1 and ease off over the valley's whole width, or the
    // ground steps from pinned bed to unshaped dune in the few metres the bed
    // mask takes to fall — a wall at the water's edge you cannot walk down.
    let chanOut = max(valleyMask, bedMask) * cutAmt;
    return vec3f(bedTarget, bedOut, chanOut);
}

// -------------------------------------------------------------------- rocks

/// Sparse exposed rock. Jittered grid, one outcrop per cell, most of them
/// culled so the field stays "just snow and the player".
/// Returns vec2f(height contribution, rock mask 0..1).
fn rockField(p: vec2f, w: f32) -> vec2f {
    let cell = 165.0;
    let gi = floor(p / cell);

    var hSum = 0.0;
    var mask = 0.0;

    // 3x3 neighbourhood so blobs straddle cell borders cleanly.
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let id = gi + vec2f(f32(dx), f32(dy));
            let r = hash22(id);
            let r2 = hash22(id + 71.3);

            // Cull most cells: outcrops are meant to be sparse.
            if (r2.x > 0.34) { continue; }

            let centre = (id + 0.15 + r * 0.7) * cell;
            let radius = 7.0 + r2.y * 11.0;
            let d = length(p - centre);
            if (d > radius * 1.6) { continue; }

            // Smooth dome, then broken up by ridged noise so it reads as rock
            // rather than as a lump. The noise rides the dome so it never
            // detaches from the silhouette.
            let t = clamp(1.0 - d / radius, 0.0, 1.0);
            let dome = t * t * (3.0 - 2.0 * t);
            let mr = windMat(w, 1.0, 1.0, 5.5);
            let rough = ridgedd(mr * (p - centre), 3, 2.17, 0.55).x;
            let hgt = (3.5 + r2.y * 6.0);

            hSum += dome * hgt * (0.62 + 0.55 * rough);
            mask = max(mask, dome * dome);
        }
    }
    return vec2f(hSum, mask);
}

// --------------------------------------------------------------------- fine

/// Local departure of the wind from its prevailing bearing, in radians, and the
/// local anisotropy of the sastrugi.
///
/// One global bearing gives every ridge in the field the same direction and the
/// same aspect ratio, and the result reads as corduroy — a woven texture laid
/// over the landform rather than snow carved by weather. Real sastrugi does not
/// do that: the wind veers as it crosses a dune, so the field breaks into patches
/// that run at slightly different angles and are streakier in some places than
/// others. Two slow noise fields, at ~120 m and ~80 m, are enough to destroy the
/// uniformity completely while leaving the prevailing direction obvious.
///
/// Both fine layers below read this, and so does the *filtered* twin further
/// down, which must produce the same surface — one is the vertex displacement and
/// the other is the fragment normal.
///
/// The layer derivatives ignore the chain-rule term from the veer varying with
/// position. The veer field's wavelength is fifty times the sastrugi's, so that
/// term is a couple of percent of a normal — well under what the detail maps
/// perturb it by anyway.
fn windLocal(p: vec2f) -> vec2f {
    let veer = noise2(p * 0.0083 + vec2f(31.7, 12.3)) * 0.42;
    let stretch = 2.3 + 2.4 * (noise2(p * 0.0126 + vec2f(7.1, 41.9)) * 0.5 + 0.5);
    return vec2f(veer, stretch);
}

/// Sastrugi + ripples. Returns vec3f(height in metres, dH/dx, dH/dz).
///
/// `exposure` (0..1) comes from the baked curvature channel: wind scours crests
/// into hard sastrugi and leaves hollows smooth, so the two fine layers are
/// cross-faded by it rather than applied uniformly.
fn terrainFine(p: vec2f, w: f32, exposure: f32, amp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    let wl = windLocal(p);

    // --- sastrugi ----------------------------------------------------------
    // Compressed *across* the wind, so the ridges streak along it. Ridged noise
    // gives the hard scalloped crest and soft trough that sastrugi actually has.
    let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
    let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
    let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
    let sasAmp = 0.125 * amp * mix(0.45, 1.0, exposure) * scour;
    h += (sas.x - 0.35) * sasAmp;
    d += (sas.yz * m3) * sasAmp;

    // --- wind ripples ------------------------------------------------------
    // Fine transverse corrugation, strongest in the sheltered flats where
    // sastrugi is weak. Half a wavelength of asymmetry via a soft abs.
    //
    // Veered by half of what the sastrugi is: ripples form in the boundary layer
    // and follow the local flow more closely than the metre-scale forms do, but
    // giving them the same veer makes the two layers move together and the field
    // goes back to reading as one woven sheet.
    let m4 = windMat(w + wl.x * 0.5, 2.9, 1.0, 0.42);
    let rip = noised(m4 * p);
    let ripAmp = 0.024 * amp * mix(1.0, 0.45, exposure);
    h += rip.x * ripAmp;
    d += (rip.yz * m4) * ripAmp;

    // --- grain -------------------------------------------------------------
    // Sub-centimetre. Too small to displace geometry usefully, but it keeps the
    // normal field alive right under the camera.
    let m5 = windMat(w, 1.0, 1.0, 0.115);
    let gr = noised(m5 * p);
    let grAmp = 0.0075 * amp;
    h += gr.x * grAmp;
    d += (gr.yz * m5) * grAmp;

    return vec3f(h, d);
}

/// Footprint-filtered fine layer, for the fragment shader.
///
/// Each layer fades out once its wavelength drops near the size of a pixel.
/// Without this the sastrugi turns into a crawling moiré carpet across the
/// mid-distance the moment the camera moves — and unlike geometry aliasing, TAA
/// cannot rescue normal-map aliasing, because the signal is already wrong before
/// it is sampled. Fading is not a quality compromise here; it *is* the filter.
///
/// `fp` is the world-space size of one pixel, from fwidth() on world position.
fn terrainFineFiltered(p: vec2f, w: f32, exposure: f32, amp: f32, fp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    // Sastrugi: wavelength ~2.3 m. Real sastrugi stands 10-30 cm proud with a
    // hard scalloped crest — it is a landform in its own right, not a texture,
    // and underscaling it is what leaves a snow field looking like poured icing.
    // Same local veer and anisotropy the vertex stage used. See `windLocal`.
    let wl = windLocal(p);

    let fadeS = 1.0 - smoothstep(0.35, 1.6, fp);
    if (fadeS > 0.001) {
        let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
        let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
        // Modulated by a slow field so the field has scoured patches and smooth
        // patches rather than one uniform corduroy everywhere — which is what
        // makes it read as woven fabric instead of as snow.
        // `scour`, not `patch` — the latter is a reserved keyword in WGSL.
        let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
        let a = 0.125 * amp * mix(0.45, 1.0, exposure) * scour * fadeS;
        h += (sas.x - 0.35) * a;
        d += (sas.yz * m3) * a;
    }

    // Ripples: wavelength ~0.42 m.
    let fadeR = 1.0 - smoothstep(0.06, 0.3, fp);
    if (fadeR > 0.001) {
        let m4 = windMat(w + wl.x * 0.5, 2.9, 1.0, 0.42);
        let rip = noised(m4 * p);
        let a = 0.024 * amp * mix(1.0, 0.45, exposure) * fadeR;
        h += rip.x * a;
        d += (rip.yz * m4) * a;
    }

    // Grain: wavelength ~0.115 m.
    let fadeG = 1.0 - smoothstep(0.016, 0.08, fp);
    if (fadeG > 0.001) {
        let m5 = windMat(w, 1.0, 1.0, 0.115);
        let gr = noised(m5 * p);
        let a = 0.0075 * amp * fadeG;
        h += gr.x * a;
        d += (gr.yz * m5) * a;
    }

    return vec3f(h, d);
}

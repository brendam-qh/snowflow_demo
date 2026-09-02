// -----------------------------------------------------------------------------
// River — fragment. MVP.
//
// Per-pixel gate: only render where the analytic `riverChannel` says we are in
// the bed. Outside the bed there is no water. Inside it, the colour is built
// from the same four things the spell water uses:
//
//   depth absorption     red dies fast, then green; blue survives. The path
//                         length comes from bedMask — 0 at the bank edge, 1 at
//                         the centre, the visual proxy for "how deep is this
//                         pixel" without sampling the heightfield.
//   sky reflection        Fresnel-gated against the sky LUT, mirror-bright at
//                         grazing angles. The reflection dominates the
//                         silhouette, which is what makes water read as water.
//   sun glint            Tight GGX lobe on the ripple normals — the streak of
//                         light that runs across a moving surface.
//   refraction            Behind the surface is shadowed snow the sky LUT already
//                         stores below the horizon, so a single dispersed
//                         lookup gives a weighted estimate of what is under the
//                         water without a second opaque pass.
//
// The ripple field advects down the channel: noise's first coordinate carries
// a time term proportional to `flowSpeed`, so the surface *travels* even though
// the mesh never moves.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowTerrain>
#include<snowShading>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vUV: vec2f;
varying vViewDist: f32;

uniform cameraPos: vec3f;
uniform waterY: f32;
uniform time: f32;
uniform flowSpeed: f32;

uniform riverFlowAngle: f32;
uniform riverness: f32;
uniform riverWidth: f32;
uniform riverDepth: f32;

uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;
uniform ambientIntensity: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

uniform waterDepthTint: f32;
uniform waterAlpha: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

// Pushed up from the spell-water (3.40, 0.72, 0.34): the MVP river plane is
// viewed at glancing angles in the default spawn shot, so a lot of sky is
// pulled in via Fresnel anyway — the body needs to absorb hard enough that
// the deep teal still reads under that wash.
const WATER_ABSORB: vec3f = vec3f(4.6, 1.0, 0.42);
const INV_PI: f32 = 0.31830988618;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;

    // Only render where the bed says water sits. bedMask runs 0..1 from bank
    // edge to channel centre; below the floor the pixel is discarded so the
    // river plane never paints the snow.
    let river = riverChannel(world.xz, uniforms.riverFlowAngle, uniforms.riverness,
                              uniforms.riverWidth, uniforms.riverDepth);
    let bedMask = river.y;
    if (bedMask < 0.001) { discard; }

    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;
    let t = uniforms.time * uniforms.flowSpeed * 0.6;

    // ----------------------------------------------------------------- normals
    // Two noise octaves advecting down the channel. The coordinate is rotated
    // into the flow frame so the ripples *stretch* along the river rather than
    // rattle side-to-side, which is what flowing water actually does.
    let flowDir = vec2f(cos(uniforms.riverFlowAngle), sin(uniforms.riverFlowAngle));
    let perp = vec2f(-flowDir.y, flowDir.x);
    let along = dot(world.xz, flowDir);
    let across = dot(world.xz, perp);
    var N = vec3f(0.0, 1.0, 0.0);

    let footprint = max(length(dpdx(world.xz)), length(dpdy(world.xz)));

    let fade1 = 1.0 - smoothstep(0.04, 0.32, footprint);
    if (fade1 > 0.002) {
        let n1 = noised(vec2f(along * 0.85 + t * 1.2, across * 2.4));
        let n2 = noised(vec2f(along * 2.6 - t * 0.7, across * 4.9 + 17.3));
        let amp = 0.07 * fade1;
        N = normalize(vec3f(
            -(n1.y + n2.y) * amp,
            1.0,
            -(n1.z + n2.z) * amp
        ));
    }
    let fade2 = 1.0 - smoothstep(0.012, 0.08, footprint);
    if (fade2 > 0.002) {
        let n3 = noised(vec2f(along * 6.5 + t * 2.6, across * 14.0 - 3.7));
        N = normalize(N + vec3f(-n3.y * 0.022 * fade2, 0.0, -n3.z * 0.022 * fade2));
    }
    let geoN = N;
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);

    // -------------------------------------------------------- depth & tint
    // path is the visual proxy for "how much water the eye rowed through to
    // see this pixel": 0 at the retreating bank edge, full deep at the
    // channel's belly. It's tuned by `waterDepthTint` — same knob as the spell
    // water, so the consistency is built in.
    // Deepened absorption path: at glancing view angles sky-Fresnel otherwise
    // wipes the river out into a flat sky-mirror, so the teal body has to read
    // *very* strongly at anything past the bank edge. 5.0 puts the bed centre
    // fully into the deep-navy regime (transmit_R ~1e-8) while the shallow
    // ramp still keeps the warm bank transition.
    let path = clamp(bedMask * 5.0 * uniforms.waterDepthTint, 0.01, 6.0);
    let transmit = exp(-WATER_ABSORB * path);
    // Base colour is what you see through clear water at depth — a teal-to-
    // deep-navy ramp, saturated enough to read against the snow. The transmit
    // term brings some red back at the shallow shallows so the bank edge goes
    // warm rather than a hard cut.
    let shallowTint = vec3f(0.28, 0.68, 0.55);
    let deepTint = vec3f(0.018, 0.115, 0.075);
    var tintedBlue = mix(deepTint, shallowTint, transmit);

    // Push saturation back up after tonemap by keeping the body green-blue
    // dominant: the refracted snow pull was washing teal out against a white
    // riverbed, leaving only a faint grayer-than-bed wedge.
    tintedBlue = pow(tintedBlue, vec3f(0.85));

    // ----------------------------------------------------- refraction
    // Same dispersed-sky trick as the spell water: the sky LUT already stores
    // the snow bounce below the horizon, so refraction is a single lookup of
    // "what light arrives along the refracted ray", in three channels at three
    // indices, with the absorbed fraction added back as the riverbed tint.
    let rr = refract(-V, N, 1.0 / 1.3300);
    let rg = refract(-V, N, 1.0 / 1.3330);
    let rb = refract(-V, N, 1.0 / 1.3400);
    let mirror = reflect(-V, N);
    let dr = select(mirror, rr, dot(rr, rr) > 0.5);
    let dg = select(mirror, rg, dot(rg, rg) > 0.5);
    let db = select(mirror, rb, dot(rb, rb) > 0.5);
    let behind = vec3f(
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dr), 1.7).r,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dg), 1.7).g,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(db), 1.7).b
    );
    // The dispersed-snow blend goes in much smaller now: snow beneath the bed is
    // itself wet-teal-tinted by the snow shader, so a 45% pull toward it left
    // water and riverbed nearly the same colour. 22% keeps the body teal.
    var color = mix(tintedBlue, behind * transmit, 0.12);

    // ---------------------------------------------------------- ambient
    // Sky fill on the surface from the SH ramp, weakly so reflection stays
    // the dominant cool read.
    color += shIrradiance(N, uniforms.shR) * INV_PI * uniforms.ambientIntensity * 0.18 * transmit;

    // ---------------------------------------------------------- reflection
    // Fresnel against the sky LUT, capped at 0.48 — well under the spell-water
    // value (0.72). At the glancing view angles this MVP river is seen from in
    // the spawn shot, raw Schlick saturates to ~0.80 and turns the surface into
    // a mirror: the river reads as a brighter patch of sky rather than deep
    // water. Tucking the cap under 0.5 keeps enough body teal on the surface to
    // register as water; the sun glint below still cuts a bright streak
    // through it for that "wet" read.
    let F = min(fresnelSchlick(NdotV, vec3f(0.02)), vec3f(0.08));
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(mirror), 0.7).rgb;
    color = mix(color, skyRefl, F);

    // ---------------------------------------------------------- sun glint
    // Narrow GGX lobe. Tighter and brighter than before — this streak is what
    // seals "river" once the sky-mirror is dimmed above; without a strong
    // coherent glint the capped reflection reads as plastic.
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let rough = 0.030;
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.02));
        color += uniforms.sunRadiance * D * Vis * Fs * NdotL * 1.2;
    }

    // -------------------------------------------- bank edge soft blend
    // Alpha ramps with bedMask so the water retires softly into the bank
    // rather than ending in a hard line. Bumped the alpha floor so the surface
    // actually covers the wet riverbed beneath rather than ghosting through it
    // (0.86 was leaving the dim river-bed reading instead of the water body).
    let edgeSoft = smoothstep(0.0, 0.35, bedMask);
    let alpha = edgeSoft * uniforms.waterAlpha * mix(0.93, 0.99, 1.0 - NdotV);
    if (alpha < 0.004) { discard; }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, uniforms.sunRadiance,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}

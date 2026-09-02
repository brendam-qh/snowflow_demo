// Bakes the macro landform (broad dunes + medium drifts + rock outcrops +
// the river valley) into a single-channel float texture covering the whole
// playable field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for character grounding, footfall placement and spell hit points, and
// reading back a GPU bake is the only way to guarantee the two never disagree.
// Re-implementing the noise in JS would drift the moment f32 and f64 rounding
// diverged, and the character would float or sink by centimetres.

#include<snowNoise>
#include<snowTerrain>

varying vUV: vec2f;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform windAngle: f32;
uniform heightAmp: f32;

// River shape — see `riverChannel` in snowTerrain. Baked so the CPU mirror
// the character grounds against includes the valley, exactly the way rock
// outcrops do.
uniform riverFlowAngle: f32;
uniform riverness: f32;
uniform riverWidth: f32;
uniform riverDepth: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let p = uniforms.worldOrigin + input.vUV * uniforms.worldSize;

    var h = terrainMacro(p, uniforms.windAngle, uniforms.heightAmp);

    // The river: blend the dune field toward the channel's target elevation.
    //
    // Not a subtraction. The water is a plane at a fixed height, so the bed has
    // to be positioned against that plane, not against whatever the dunes happen
    // to be doing — otherwise depth swings from dry to metres deep as the dune
    // field rolls underneath, and the only way to guarantee water everywhere is
    // to cut a trench deep enough to swallow the character.
    //
    // The blend weight alone decides how much dune survives, which is what keeps
    // the author's original point about the bed not being a notch: it is 1 only
    // in the bed itself, and falls away across the valley so the banks stay dune
    // terrain rather than a moulded trough.
    let river = riverChannel(p, uniforms.riverFlowAngle, uniforms.riverness,
                              uniforms.riverWidth, uniforms.riverDepth);
    h = mix(h, river.x, river.z);

    // Rock displaces snow upward; snow then re-accumulates on the flatter faces,
    // which the snow material resolves from the mask in the aux bake.
    let rock = rockField(p, uniforms.windAngle);
    h += rock.x;

    fragmentOutputs.color = vec4f(h, rock.y, 0.0, 1.0);
}

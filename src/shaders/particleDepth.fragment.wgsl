// Particle depth pre-pass fragment -- round point sprites writing depth+thickness.

varying vViewDepth: f32;
varying vThickness: f32;
varying vCornerDist: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Round point sprites: discard corners outside the unit disc.
    if (input.vCornerDist <= 1.0) {
        fragmentOutputs.color = vec4f(input.vViewDepth, input.vThickness, 0.0, 1.0);
    } else {
        fragmentOutputs.color = vec4f(9000.0, 0.0, 0.0, 0.0);
    }
}

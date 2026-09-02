varying vWorld: vec3f;
varying vAlpha: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(0.2, 0.5, 0.7, input.vAlpha * 0.85);
}

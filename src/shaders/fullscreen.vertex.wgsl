// Fullscreen quad vertex -- for SSFR surface composite. Pass-through only.
attribute position: vec3f;
varying vUV: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.vUV = input.position.xy * 0.5 + 0.5;
    vertexOutputs.position = vec4f(input.position, 1.0);
}

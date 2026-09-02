// SSFR bilateral blur -- smooths the particle depth texture into a continuous
// surface. Bilateral: weights neighbours by both spatial distance AND depth
// similarity, so particles at different depths don't smear across each other.
// Two passes (horizontal then vertical) for separable efficiency.

varying vUV: vec2f;

var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

uniform texel: vec2f;   // 1/width, 1/height
uniform radius: f32;   // blur radius in texels (typically 3-5)

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let center = textureSampleLevel(depthTex, depthTexSampler, uv, 0.0);
    let centerDepth = center.r;

    // No particle here -- pass through empty.
    if (center.a < 0.5) {
        fragmentOutputs.color = center;
    } else {
        var sumDepth = 0.0;
        var sumThickness = 0.0;
        var weight = 0.0;

        let r = i32(uniforms.radius);
        for (var i = -r; i <= r; i++) {
            let offset = uniforms.texel * f32(i);
            let sample = textureSampleLevel(depthTex, depthTexSampler, uv + vec2f(offset.x, 0.0), 0.0);
            let sd = sample.r;

            // Skip empty samples.
            if (sample.a < 0.5) { continue; }

            // Spatial weight (Gaussian).
            let spatial = exp(-f32(i * i) / (2.0 * uniforms.radius * uniforms.radius));
            // Depth weight: close depths get full weight, far depths get rejected.
            // This is what makes the blur "bilateral" -- it respects depth edges.
            let depthDiff = abs(sd - centerDepth);
            let depthWeight = exp(-depthDiff * depthDiff / (2.0 * 4.0 * 4.0));

            let w = spatial * depthWeight;
            sumDepth += sd * w;
            sumThickness += sample.g * w;
            weight += w;
        }

        if (weight > 0.001) {
            fragmentOutputs.color = vec4f(sumDepth / weight, sumThickness / weight, 0.0, 1.0);
        } else {
            fragmentOutputs.color = center;
        }
    }
}

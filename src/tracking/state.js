/**
 * The tracking state struct. Written by a tracker (live webcam or mock),
 * read by headLook.js / gestures.js / trackingUi.js. Hands are two pooled
 * slots addressed by `handCount` — the per-inference write must not allocate
 * (it runs inside the page's rAF budget).
 */
export function createTrackingState() {
    return {
        /** MediaPipe facial transformation matrix, column-major 4x4. */
        faceMatrix: new Float32Array(16),
        faceOk: false,
        /** performance.now() of the last inference that saw a face. */
        faceTs: -1e9,
        /** Nose-tip y in image coords (y down) — the sprint shoulder line. */
        faceNoseY: 0.5,
        /** Pooled hand slots; only the first `handCount` are valid. */
        hands: [
            { gesture: "", score: 0, handedness: "", landmarks: null },
            { gesture: "", score: 0, handedness: "", landmarks: null },
        ],
        handCount: 0,
        /** performance.now() of the last inference pass (hands freshness). */
        ts: -1e9,
        /** Last combined face+hands inference cost, for the status line. */
        inferMs: 0,
    };
}

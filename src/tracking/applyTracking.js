/**
 * The single seam between tracking and the rest of the demo: called once per
 * frame immediately after pollInput(), before character/camera updates. Both
 * halves read S.trackingEnabled themselves and stand down cleanly when off.
 */
import { updateHeadLook } from "./headLook.js";
import { applyGestures } from "./gestures.js";

export function applyTracking(state, inp, dt, nowMs = performance.now()) {
    updateHeadLook(state, inp, dt, nowMs);
    applyGestures(state, inp, nowMs);
}

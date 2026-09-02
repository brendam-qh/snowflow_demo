/**
 * Head-look: MediaPipe face orientation -> absolute camera yaw/pitch offsets.
 *
 * The offsets are absolute and self-centering: turn your head, the view pans;
 * return to neutral, the view returns. No drift, no winding — the rig's own
 * yaw/pitch stay mouse-owned and the offsets are applied at composition time
 * in camera.js.
 *
 * Sign conventions: YAW_SIGN / PITCH_SIGN are the single place to flip if
 * manual QA finds the view panning the wrong way. The unit tests pin the
 * convention as written (raw face yaw + -> offset - with YAW_SIGN = -1).
 */

import { S } from "../core/settings.js";

export const YAW_SIGN = -1;
export const PITCH_SIGN = 1;

const DEADZONE = 0.01; // rad — below this, jitter is not worth rendering
const MAX_OFFSET = 1.05; // rad (~60 deg)
const DAMP_RATE = 12; // framerate-independent smoothing toward the target
const LOST_HOLD_MS = 250; // hold the last offset this long after face loss
const RECAPTURE_MS = 1000; // beyond this, reacquire captures a fresh neutral
const RECENTER_RATE = 5; // loss -> ease to zero at this rate

let neutralYaw = 0;
let neutralPitch = 0;
let haveNeutral = false;
let smYaw = 0;
let smPitch = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const damp = (cur, target, rate, dt) =>
    target + (cur - target) * Math.exp(-rate * Math.min(dt, 1 / 30));

/**
 * Yaw/pitch from a MediaPipe facial transformation matrix (column-major 4x4).
 * Convention R = Ry(yaw) * Rx(pitch): column 2 is (sy*cp, -sp, cy*cp), so
 * yaw = atan2(m[8], m[10]) and pitch = asin(-m[9]).
 */
export function extractYawPitch(m) {
    return {
        yaw: Math.atan2(m[8], m[10]),
        pitch: Math.asin(clamp(-m[9], -1, 1)),
    };
}

/**
 * Build a column-major Ry(yaw) * Rx(pitch) matrix. Test/mock support — the
 * live path never calls this; it exists so tests and mockTracker.js construct
 * matrices that extractYawPitch reads back identically.
 */
export function makeFaceMatrix(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Ry:  [cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1]
    // Rx:  [1,0,0,0, 0,cp,sp,0, 0,-sp,cp,0, 0,0,0,1]
    return new Float32Array([
        cy, 0, -sy, 0,
        sy * sp, cp, cy * sp, 0,
        sy * cp, -sp, cy * cp, 0,
        0, 0, 0, 1,
    ]);
}

/** Re-capture the neutral pose on the next good face frame (R key / PiP click). */
export function recenterHeadLook() {
    haveNeutral = false;
}

/** Test hook: module state is process-global, so tests reset between cases. */
export function resetHeadLookForTest() {
    haveNeutral = false;
    smYaw = 0;
    smPitch = 0;
    neutralYaw = 0;
    neutralPitch = 0;
}

/**
 * Per-frame update, called from applyTracking. Writes input.headYawOffset /
 * headPitchOffset. `nowMs` is injectable for tests; tracking.faceTs is the
 * performance.now() timestamp of the last inference that saw a face.
 */
export function updateHeadLook(tracking, inp, dt, nowMs) {
    if (!S.trackingEnabled) {
        inp.headYawOffset = 0;
        inp.headPitchOffset = 0;
        return;
    }

    const fresh = tracking.faceOk && nowMs - tracking.faceTs <= LOST_HOLD_MS;
    if (fresh) {
        const raw = extractYawPitch(tracking.faceMatrix);
        if (!haveNeutral) {
            neutralYaw = raw.yaw;
            neutralPitch = raw.pitch;
            haveNeutral = true;
            // A (re)capture means "this pose is centre now" — snap the
            // smoothed offsets with it. On reacquire after a long loss the
            // offsets have already eased to ~0, so the snap is invisible;
            // on an explicit recenter it is exactly the expected response.
            smYaw = 0;
            smPitch = 0;
        }
        let ty = (raw.yaw - neutralYaw) * YAW_SIGN * S.trackingHeadGain;
        let tp = (raw.pitch - neutralPitch) * PITCH_SIGN * S.trackingHeadGain;
        if (Math.abs(ty) < DEADZONE) ty = 0;
        if (Math.abs(tp) < DEADZONE) tp = 0;
        ty = clamp(ty, -MAX_OFFSET, MAX_OFFSET);
        tp = clamp(tp, -MAX_OFFSET, MAX_OFFSET);
        smYaw = damp(smYaw, ty, DAMP_RATE, dt);
        smPitch = damp(smPitch, tp, DAMP_RATE, dt);
    } else {
        // Face lost: ease to zero so the view recenters gently, never snaps.
        smYaw = damp(smYaw, 0, RECENTER_RATE, dt);
        smPitch = damp(smPitch, 0, RECENTER_RATE, dt);
        // Gone long enough that the user's pose has probably moved on:
        // re-capture neutral on reacquire rather than snapping the view to a
        // stale reference pose.
        if (nowMs - tracking.faceTs > RECAPTURE_MS) haveNeutral = false;
    }

    inp.headYawOffset = smYaw;
    inp.headPitchOffset = smPitch;
}

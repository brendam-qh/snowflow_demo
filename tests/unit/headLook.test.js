import { test } from "node:test";
import assert from "node:assert/strict";
import {
    extractYawPitch, makeFaceMatrix, updateHeadLook,
    recenterHeadLook, resetHeadLookForTest,
} from "../../src/tracking/headLook.js";
import { input } from "../../src/core/input.js";
import { S } from "../../src/core/settings.js";

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

function trackingWith(yaw, pitch, ts) {
    return { faceMatrix: makeFaceMatrix(yaw, pitch), faceOk: true, faceTs: ts };
}

test("extractYawPitch: identity is zero", () => {
    const { yaw, pitch } = extractYawPitch(makeFaceMatrix(0, 0));
    close(yaw, 0); close(pitch, 0);
});

test("extractYawPitch: round-trips yaw and pitch", () => {
    const { yaw, pitch } = extractYawPitch(makeFaceMatrix(0.3, -0.2));
    close(yaw, 0.3); close(pitch, -0.2);
});

test("first good frame captures neutral; same pose yields zero offset", () => {
    resetHeadLookForTest();
    S.trackingEnabled = true; S.trackingHeadGain = 2.2;
    const t = trackingWith(0.1, 0.05, 1000);
    updateHeadLook(t, input, 1 / 60, 1000);
    close(input.headYawOffset, 0); close(input.headPitchOffset, 0);
});

test("turning the head produces a gained, signed offset", () => {
    resetHeadLookForTest();
    updateHeadLook(trackingWith(0, 0, 1000), input, 1 / 60, 1000); // neutral
    for (let i = 1; i <= 120; i++) {
        updateHeadLook(trackingWith(0.2, 0, 1000 + i * 16), input, 1 / 60, 1000 + i * 16);
    }
    // converged: offset ~= 0.2 * YAW_SIGN * gain (sign pinned by YAW_SIGN = -1)
    close(input.headYawOffset, -0.44, 0.02);
});

test("offsets clamp at +/-1.05 rad", () => {
    resetHeadLookForTest();
    updateHeadLook(trackingWith(0, 0, 1000), input, 1 / 60, 1000);
    for (let i = 1; i <= 240; i++) {
        updateHeadLook(trackingWith(1.5, 0, 1000 + i * 16), input, 1 / 60, 1000 + i * 16);
    }
    assert.ok(Math.abs(input.headYawOffset) <= 1.05 + 1e-6);
});

test("face loss eases offsets to zero instead of snapping", () => {
    resetHeadLookForTest();
    updateHeadLook(trackingWith(0, 0, 1000), input, 1 / 60, 1000);
    for (let i = 1; i <= 120; i++) {
        updateHeadLook(trackingWith(0.2, 0, 1000 + i * 16), input, 1 / 60, 1000 + i * 16);
    }
    assert.ok(Math.abs(input.headYawOffset) > 0.3);
    const lost = { faceOk: false, faceTs: -1e9, faceMatrix: new Float32Array(16) };
    const t0 = 1000 + 120 * 16 + 300; // past the 250 ms hold
    updateHeadLook(lost, input, 1 / 60, t0);
    const during = Math.abs(input.headYawOffset);
    assert.ok(during > 0.01, "still easing, not snapped");
    for (let i = 1; i <= 240; i++) updateHeadLook(lost, input, 1 / 60, t0 + i * 16);
    assert.ok(Math.abs(input.headYawOffset) < 0.01, "settled to zero");
});

test("reacquire after a long loss re-captures neutral", () => {
    resetHeadLookForTest();
    S.trackingEnabled = true;
    updateHeadLook(trackingWith(0, 0, 1000), input, 1 / 60, 1000); // neutral
    for (let i = 1; i <= 120; i++) {
        updateHeadLook(trackingWith(0.2, 0, 1000 + i * 16), input, 1 / 60, 1000 + i * 16);
    }
    assert.ok(Math.abs(input.headYawOffset) > 0.3);
    // > 1 s of loss: the stale neutral is discarded, easing continues.
    const lost = { faceOk: false, faceTs: 2920, faceMatrix: new Float32Array(16) };
    updateHeadLook(lost, input, 1 / 60, 2920 + 1200);
    // Reacquire at a different pose -> it becomes the new neutral -> ~0 offset.
    updateHeadLook(trackingWith(0.35, 0, 5000), input, 1 / 60, 5000);
    close(input.headYawOffset, 0, 0.05);
});

test("recenter re-captures neutral on the next good frame", () => {
    resetHeadLookForTest();
    updateHeadLook(trackingWith(0, 0, 1000), input, 1 / 60, 1000);
    for (let i = 1; i <= 120; i++) {
        updateHeadLook(trackingWith(0.2, 0, 1000 + i * 16), input, 1 / 60, 1000 + i * 16);
    }
    recenterHeadLook();
    const t1 = 1000 + 121 * 16;
    updateHeadLook(trackingWith(0.2, 0, t1), input, 1 / 60, t1);
    close(input.headYawOffset, 0);
});

test("disabled tracking forces offsets to zero", () => {
    resetHeadLookForTest();
    S.trackingEnabled = false;
    updateHeadLook(trackingWith(0.3, 0, 1000), input, 1 / 60, 1000);
    close(input.headYawOffset, 0);
    S.trackingEnabled = true;
});

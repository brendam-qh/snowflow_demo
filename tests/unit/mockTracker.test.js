import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrackingState } from "../../src/tracking/state.js";
import {
    MockClock, syntheticHand, DEFAULT_SCRIPT,
} from "../../src/tracking/mockTracker.js";
import {
    palmForward, thumbExtended,
    applyGestures, resetGesturesForTest, spellStats,
} from "../../src/tracking/gestures.js";
import { input, endFrame } from "../../src/core/input.js";
import { S } from "../../src/core/settings.js";

test("createTrackingState has the agreed shape", () => {
    const s = createTrackingState();
    assert.ok(s.faceMatrix instanceof Float32Array);
    assert.equal(s.faceMatrix.length, 16);
    assert.equal(s.faceOk, false);
    assert.equal(s.handCount, 0);
    assert.equal(s.hands.length, 2); // pooled slots, never reallocated
});

test("MockClock advances the script against an injected clock", () => {
    const state = createTrackingState();
    const clock = new MockClock(state, [
        [0.0, "face", { yaw: 0, pitch: 0 }],
        [1.0, "face", { yaw: 0.25, pitch: 0 }],
        [2.0, "hand", { handedness: "Right", gesture: "Open_Palm", roll: 0 }],
        [3.0, "hands-off", {}],
    ]);
    clock.tick(500);
    assert.equal(state.faceOk, true);
    assert.equal(state.handCount, 0);
    clock.tick(2100);
    assert.equal(state.handCount, 1);
    assert.equal(state.hands[0].gesture, "Open_Palm");
    assert.equal(state.hands[0].landmarks.length, 21);
    clock.tick(3100);
    assert.equal(state.handCount, 0);
});

test("MockClock loops so the script survives the boot sequence", () => {
    const state = createTrackingState();
    const clock = new MockClock(state, [
        [0.0, "face", { yaw: 0, pitch: 0 }],
        [1.0, "hand", { handedness: "Right", gesture: "Open_Palm", roll: 0 }],
    ]);
    // period = 1.0 + 2 = 3 s; 7.2 s in -> t = 1.2 -> the hand is back
    clock.tick(7200);
    assert.equal(state.handCount, 1);
    assert.equal(state.hands[0].gesture, "Open_Palm");
});

// ---- the synthetic poses have to satisfy the real detectors ------------
// The mock exists to drive gestures.js; if the palm-forward pose drifts out
// of the detector's window the e2e goes green on a script that no longer
// casts anything.
test("the palmForward pose reads as palm-forward to the detector", () => {
    const fwd = syntheticHand({ handedness: "Left", pose: "palmForward" }).landmarks;
    assert.equal(palmForward(fwd), true);
    // A hand with no pose is neutral: it must not trip the one landmark spell.
    assert.equal(palmForward(syntheticHand({ handedness: "Left" }).landmarks), false);
});

test("syntheticHand curls the thumb for Closed_Fist, extends it otherwise", () => {
    assert.equal(thumbExtended(syntheticHand({ handedness: "Right" }).landmarks), true);
    assert.equal(
        thumbExtended(syntheticHand({ handedness: "Left", gesture: "Closed_Fist" }).landmarks),
        false
    );
    assert.equal(
        thumbExtended(syntheticHand({ handedness: "Right", thumbState: "curled" }).landmarks),
        false
    );
});

test("the whole hand hangs off the wrist", () => {
    const h = syntheticHand({ handedness: "Left", wristX: 0.8 }).landmarks;
    assert.equal(h[0].x, 0.8);
    assert.equal(h[2].x, 0.8); // thumb MCP follows the wrist
    assert.equal(h[9].x, 0.8); // palm follows the wrist
});

test("hand events carry the gesture category the spell layer reads", () => {
    const state = createTrackingState();
    const clock = new MockClock(state, [
        [0.0, "hand", { handedness: "Left", gesture: "Victory" }],
        [1.0, "hand", { handedness: "Left", gesture: "Thumb_Down" }],
    ]);
    clock.tick(100);
    assert.equal(state.hands[0].gesture, "Victory");
    assert.equal(state.hands[0].handedness, "Left");
    clock.tick(1100);
    assert.equal(state.hands[0].gesture, "Thumb_Down");
});

// ---- the default script has to actually cast every spell ---------------
/**
 * Run DEFAULT_SCRIPT through the real gesture driver for one full cycle at a
 * fixed 60 Hz of virtual time. MockClock stamps freshness from the wall clock
 * (the domain a live tracker reports in), so the loop re-stamps with the
 * virtual clock — otherwise the hold and velocity gates in applyGestures
 * would see a cycle that took a few microseconds.
 */
function runDefaultScript() {
    resetGesturesForTest();
    S.trackingEnabled = true;
    S.trackingGestureScore = 0.6;
    S.trackingSteerGain = 1;
    S.trackingMirror = true;
    input.moveX = 0; input.moveZ = 0; input.moving = false;
    input.sprint = false; input.surf = false;
    input.thumbSteer = 0; input.spellHeld2 = false;

    const state = createTrackingState();
    const clock = new MockClock(state, DEFAULT_SCRIPT);
    const seen = { moving: false, surf: false, steered: false, held2: false };
    for (let t = 0; t <= clock.period * 1000; t += 1000 / 60) {
        endFrame();
        clock.tick(t);
        state.ts = t;
        state.faceTs = t;
        applyGestures(state, input, t);
        if (input.moving) seen.moving = true;
        if (input.surf) seen.surf = true;
        if (input.thumbSteer > 0) seen.steered = true;
        if (input.spellHeld2) seen.held2 = true;
    }
    return seen;
}

test("the default script casts all five spells in one cycle", () => {
    runDefaultScript();
    for (let n = 1; n <= 5; n++) {
        assert.ok(spellStats[n] > 0, `spell ${n} never fired`);
    }
});

test("the default script walks, surfs and steers the carve", () => {
    const seen = runDefaultScript();
    assert.equal(seen.moving, true); // Open_Palm walk
    assert.equal(seen.surf, true); // thumb extended
    assert.equal(seen.steered, true); // thumbRoll = 0.3 past the deadzone
    assert.equal(seen.held2, true); // pinch holds spell 2
});

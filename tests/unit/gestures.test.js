import { test } from "node:test";
import assert from "node:assert/strict";
import {
    palmRoll, thumbAngle, thumbExtended, palmForward,
    mapGestures, applyGestures, resetGesturesForTest,
} from "../../src/tracking/gestures.js";
import { input, endFrame } from "../../src/core/input.js";
import { S } from "../../src/core/settings.js";

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/**
 * Synthetic 21-point hand. Palm roll drives middle MCP (9) off the wrist (0);
 * thumb roll drives the thumb tip (4) off the thumb MCP (2). Both lean values
 * are SCREEN-space: positive = leans to the user's right in the mirrored
 * preview, which the raw image flips.
 *
 * `thumbState`:
 *   "extended" (default for non-fist gestures) — thumb tip is offset from
 *     the MCP by 0.12 (a clearly extended thumb), at the requested roll.
 *   "curled" — thumb tip is parked at the MCP (length ~ 0), simulating a
 *     Closed_Fist where the thumb has folded across the palm.
 */
function hand(gesture, {
    roll = 0, thumbRoll = 0,
    thumbState = gesture === "Closed_Fist" ? "curled" : "extended",
    wristY = 0.55, handedness = "Right", score = 0.9
} = {}) {
    const landmarks = [];
    for (let i = 0; i < 21; i++) landmarks.push({ x: 0.5, y: 0.7, z: 0 });
    landmarks[0] = { x: 0.5, y: wristY, z: 0 };
    landmarks[9] = {
        x: 0.5 - Math.sin(roll) * 0.18,
        y: wristY - Math.cos(roll) * 0.18,
        z: 0,
    };
    landmarks[2] = { x: 0.5, y: wristY - 0.05, z: 0 };
    if (thumbState === "curled") {
        landmarks[4] = { x: 0.5, y: wristY - 0.05, z: 0 }; // tip parked at MCP
    } else {
        landmarks[4] = {
            x: 0.5 - Math.sin(thumbRoll) * 0.12,
            y: wristY - 0.05 - Math.cos(thumbRoll) * 0.12,
            z: 0,
        };
    }
    return { gesture, score, handedness, landmarks };
}

function state(hands, ts = 1000) {
    return { hands: [hands[0] ?? null, hands[1] ?? null], handCount: hands.length, ts, faceNoseY: 0.4 };
}

function setup() {
    resetGesturesForTest();
    S.trackingEnabled = true;
    S.trackingSteerGain = 1;
    S.trackingGestureScore = 0.6;
    S.trackingMirror = true;
    endFrame();
    input.moveX = 0; input.moveZ = 0; input.moving = false;
    input.sprint = false; input.spellHeld2 = false;
    input.surf = false; input.thumbSteer = 0;
}

test("palmRoll: straight up is zero, screen-right lean is positive (mirrored)", () => {
    close(palmRoll(hand("Open_Palm", { roll: 0 }).landmarks, true), 0);
    assert.ok(palmRoll(hand("Open_Palm", { roll: 0.5 }).landmarks, true) > 0.4);
    assert.ok(palmRoll(hand("Open_Palm", { roll: 0.5 }).landmarks, false) < -0.4);
});

test("open palm walks; roll steers within deadzone..full deflection", () => {
    setup();
    let d = mapGestures(state([hand("Open_Palm", { roll: 0 })]));
    close(d.moveZ, 1); close(d.moveX, 0);
    d = mapGestures(state([hand("Open_Palm", { roll: 0.1 })])); // inside 15deg deadzone
    close(d.moveX, 0);
    d = mapGestures(state([hand("Open_Palm", { roll: 0.785 })])); // 45deg = full
    close(d.moveX, 1);
    d = mapGestures(state([hand("Open_Palm", { roll: -0.785 })]));
    close(d.moveX, -1);
});

test("palm raised above the shoulder line sprints", () => {
    setup();
    const d = mapGestures(state([hand("Open_Palm", { wristY: 0.55 })])); // shoulder = 0.4 + 0.3
    assert.equal(d.sprint, true); // wrist 0.55 < 0.70
    const d2 = mapGestures(state([hand("Open_Palm", { wristY: 0.8 })]));
    assert.equal(d2.sprint, false);
});

test("non-Open_Palm right hand leaves movement to the keyboard; only Open_Palm drives it", () => {
    setup();
    // Open_Palm: gesture owns movement, pushes forward.
    applyGestures(state([hand("Open_Palm")], 1000), input, 1000);
    assert.equal(input.moving, true);
    close(input.moveZ, 1);
    // Closed_Fist: gesture stops driving movement. In the test there is no
    // pollInput() between calls, so the previous value (1) persists. In the
    // real frame loop pollInput() overwrites with the current keyboard state
    // every frame, so the character stops the moment the user lets go of W.
    applyGestures(state([hand("Closed_Fist")], 1016), input, 1016);
    close(input.moveZ, 1);
    // Thumbs_Up: same — no movement override.
    applyGestures(state([hand("Thumb_Up")], 1032), input, 1032);
    close(input.moveZ, 1);
    // hands lost -> owned fields zeroed once, on the active->inactive edge.
    applyGestures(state([], 2000), input, 2000); // stale (> 250 ms)
    close(input.moveZ, 0);
    // ...afterwards the layer stands down and keyboard values are left alone.
    input.moveZ = 0.5; // pretend pollInput wrote this
    applyGestures(state([], 2016), input, 2016);
    close(input.moveZ, 0.5);
});

test("low-confidence gestures are ignored", () => {
    setup();
    const weak = hand("Open_Palm", { score: 0.4 });
    const d = mapGestures(state([weak]));
    close(d.moveZ, 0);
});

// -------------------------------------------------------------- thumb angle
test("thumbAngle: straight up is zero, screen-right lean is positive (mirrored)", () => {
    close(thumbAngle(hand("Thumb_Up", { thumbRoll: 0 }).landmarks, true), 0);
    assert.ok(thumbAngle(hand("Thumb_Up", { thumbRoll: 0.5 }).landmarks, true) > 0.4);
    assert.ok(thumbAngle(hand("Thumb_Up", { thumbRoll: 0.5 }).landmarks, false) < -0.4);
});

test("thumbAngle: low-confidence gestures are ignored", () => {
    setup();
    const weak = hand("Thumb_Up", { thumbRoll: 0.5, score: 0.4 });
    // mapGestures doesn't return thumbSteer for weak gestures.
    const d = mapGestures(state([weak]));
    close(d.thumbSteer, 0);
    close(d.surf, false);
});

// ----------------------------------------------------------------- snow-surf
test("right Thumb_Up sets surf = true (no hold required)", () => {
    setup();
    const thumb = hand("Thumb_Up");
    applyGestures(state([thumb], 1000), input, 1000);
    assert.equal(input.surf, true);
    applyGestures(state([thumb], 1016), input, 1016); // consecutive frame
    assert.equal(input.surf, true);
});

test("right Thumb_Up released drops surf back to false", () => {
    setup();
    const thumb = hand("Thumb_Up");
    const palm = hand("Open_Palm");
    applyGestures(state([thumb], 1000), input, 1000);
    assert.equal(input.surf, true);
    applyGestures(state([palm], 1016), input, 1016);
    assert.equal(input.surf, false);
});

test("right Thumb_Up then hand-lost drops surf to false", () => {
    setup();
    const thumb = hand("Thumb_Up");
    applyGestures(state([thumb], 1000), input, 1000);
    assert.equal(input.surf, true);
    applyGestures(state([], 2000), input, 2000); // hands lost (>250ms stale)
    assert.equal(input.surf, false);
});

test("left hand Thumb_Up does not set surf (right hand only; left is for spells)", () => {
    setup();
    const thumb = hand("Thumb_Up", { handedness: "Left" });
    applyGestures(state([thumb], 1000), input, 1000);
    applyGestures(state([thumb], 1033), input, 1033);
    assert.equal(input.surf, false);
});

// ---------------------------------------------------------- thumb steering
test("right Thumb_Up with vertical thumb does not bias movement", () => {
    setup();
    const thumb = hand("Thumb_Up", { thumbRoll: 0 });
    applyGestures(state([thumb], 1000), input, 1000);
    close(input.thumbSteer, 0);
});

test("right Thumb_Up with tilted thumb sets a non-zero thumbSteer", () => {
    setup();
    const thumb = hand("Thumb_Up", { thumbRoll: 0.785 }); // 45deg: full deflection
    applyGestures(state([thumb], 1000), input, 1000);
    // Screen-right lean (mirrored) -> positive thumbSteer.
    assert.ok(input.thumbSteer > 0.9);
});

test("right Thumb_Up's thumbSteer adds to inp.moveX (combined with keyboard)", () => {
    setup();
    // Simulate keyboard writing moveX (pollInput is not part of the test loop).
    input.moveX = 0.4; // e.g. user holding D
    const thumb = hand("Thumb_Up", { thumbRoll: 0.785 });
    applyGestures(state([thumb], 1000), input, 1000);
    // The combined moveX is keyboard + thumb, clamped to [-1, 1].
    assert.ok(input.moveX > 0.9, `expected combined moveX close to 1, got ${input.moveX}`);
});

// ----------------------------------------- bug fix: surf no longer needs
//                                                   the strict MediaPipe
//                                                   Thumb_Up category
test("thumbExtended: extended thumb at any angle is detected", () => {
    close(thumbExtended(hand("Thumb_Up", { thumbRoll: 0 }).landmarks), true);
    close(thumbExtended(hand("Thumb_Up", { thumbRoll: 0.785 }).landmarks), true);
    close(thumbExtended(hand("Thumb_Up", { thumbRoll: -0.785 }).landmarks), true);
    close(thumbExtended(hand("Thumb_Up", { thumbRoll: 1.57 }).landmarks), true); // horizontal
});

test("thumbExtended: curled thumb is not extended", () => {
    close(thumbExtended(hand("Closed_Fist", { thumbState: "curled" }).landmarks), false);
});

test("right thumb extended (any non-Open_Palm gesture) activates surf, not just Thumb_Up", () => {
    setup();
    // The previous build gated surf on `gesture === "Thumb_Up"`, which means
    // it failed the moment the user tilted the thumb far enough for the
    // recognizer to drop the category. The fix is to detect "thumb is
    // extended" from the landmarks directly, ignoring the categorical
    // gesture. We use a non-Open_Palm, non-Thumb_Up category name to prove
    // we're not relying on it.
    const h = hand("None", { thumbRoll: 0 });
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.surf, true);
});

test("right thumb extended with a leftward tilt (the original bug) now activates surf", () => {
    setup();
    // This is the case the user reported as "doesn't recognize thumb left":
    // a Thumb_Up gesture with the thumb tilted well past the recognizer's
    // window. With the new detector it just works.
    const h = hand("Thumb_Up", { thumbRoll: -0.785 });
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.surf, true);
    assert.ok(input.thumbSteer < -0.9, `expected negative thumbSteer, got ${input.thumbSteer}`);
});

test("Open_Palm with extended thumb does NOT activate surf (walk wins)", () => {
    setup();
    // Even though the thumb is extended in the synthetic Open_Palm, the
    // Open_Palm walk path wins — the gesture layer doesn't double-up.
    const h = hand("Open_Palm");
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.surf, false);
    assert.equal(input.thumbSteer, 0);
});

test("right Closed_Fist (curled thumb) does not activate surf — keyboard wins", () => {
    setup();
    const h = hand("Closed_Fist");
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.surf, false);
    assert.equal(input.thumbSteer, 0);
});

// ===================================================================
//                        left-hand spell triggers
// ===================================================================
//
// Spell 1 water push   : palm facing forward (toward camera), edge
// Spell 2 water stream : Victory, held
// Spell 3 tower column : Thumb_Up, edge
// Spell 4 ice spikes   : Thumb_Down, edge
// Spell 5 vortex       : Closed_Fist held >= 100 ms
//
// Four of the five are MediaPipe categories, so the tests set `gesture` and
// the landmarks only have to be plausible. The water push is the exception:
// it reads landmarks, so its pose is laid down by hand.

/** A left hand reporting a category, with landmarks that trigger nothing. */
function leftGesture(gesture, score = 0.95) {
    const landmarks = [];
    for (let i = 0; i < 21; i++) landmarks.push({ x: 0.5, y: 0.7, z: 0 });
    landmarks[0] = { x: 0.5, y: 0.55, z: 0 };
    landmarks[2] = { x: 0.5, y: 0.50, z: 0 };
    landmarks[4] = { x: 0.5, y: 0.38, z: 0 };
    return { gesture, score, handedness: "Left", landmarks };
}

/** Hand held with palm facing the camera — the "water push" pose. */
function palmForwardLeft() {
    const landmarks = [];
    for (let i = 0; i < 21; i++) landmarks.push({ x: 0.5, y: 0.7, z: 0 });
    landmarks[0] = { x: 0.5, y: 0.55, z: 0 };
    // Fingertips above the wrist AND extending toward the camera (positive z).
    for (const i of [8, 12, 16, 20]) landmarks[i] = { x: 0.5, y: 0.30, z: 0.07 };
    // MCPs above the wrist, also positive z.
    for (const i of [5, 9, 13, 17]) landmarks[i] = { x: 0.5, y: 0.40, z: 0.05 };
    return { gesture: "None", score: 0.95, handedness: "Left", landmarks };
}

/** A left hand in no particular pose — the neutral that re-arms the layer. */
function openLeft() {
    const landmarks = [];
    for (let i = 0; i < 21; i++) landmarks.push({ x: 0.5, y: 0.7, z: 0 });
    landmarks[0] = { x: 0.5, y: 0.55, z: 0 };
    landmarks[8] = { x: 0.45, y: 0.30, z: 0 };
    landmarks[4] = { x: 0.55, y: 0.45, z: 0 };
    return { gesture: "None", score: 0.95, handedness: "Left", landmarks };
}

// ---- pure detector -----------------------------------------------------
test("palmForward: fingertips above wrist AND extending toward camera", () => {
    assert.equal(palmForward(palmForwardLeft().landmarks), true);
    assert.equal(palmForward(openLeft().landmarks), false);
    // Fingers up but co-planar with the wrist in z is a raised hand, not a
    // palm pushed at the lens.
    const flat = openLeft();
    for (const i of [8, 12, 16, 20]) flat.landmarks[i] = { x: 0.5, y: 0.30, z: 0.005 };
    assert.equal(palmForward(flat.landmarks), false);
});

// ---- spell 1 water push (palmForward, edge) --------------------------
test("left palmForward fires spell 1 after 2 consecutive sightings", () => {
    setup();
    const h = palmForwardLeft();
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.spellPressed, 0); // first sighting: pending
    applyGestures(state([h], 1033), input, 1033);
    assert.equal(input.spellPressed, 1); // water push
    endFrame();
    applyGestures(state([h], 1066), input, 1066);
    assert.equal(input.spellPressed, 0); // held: does not re-fire
});

test("a held spell pose casts once, not once every few frames", () => {
    setup();
    const h = palmForwardLeft();
    let casts = 0;
    // Two seconds of holding the pose at 60 Hz.
    for (let i = 0; i < 120; i++) {
        endFrame();
        const t = 1000 + i * 16.7;
        applyGestures(state([h], t), input, t);
        if (input.spellPressed === 1) casts++;
    }
    assert.equal(casts, 1);
});

test("an edge spell requires returning to neutral before re-firing", () => {
    setup();
    const fwd = palmForwardLeft();
    applyGestures(state([fwd], 1000), input, 1000);
    applyGestures(state([fwd], 1033), input, 1033);
    assert.equal(input.spellPressed, 1);
    endFrame();
    // A direct switch to another spell pose must not fire (re-arm gate).
    applyGestures(state([leftGesture("Thumb_Up")], 1066), input, 1066);
    applyGestures(state([leftGesture("Thumb_Up")], 1099), input, 1099);
    assert.equal(input.spellPressed, 0);
    // Returning to a neutral (non-spell) pose re-arms.
    applyGestures(state([openLeft()], 1132), input, 1132);
    applyGestures(state([leftGesture("Thumb_Up")], 1165), input, 1165);
    applyGestures(state([leftGesture("Thumb_Up")], 1198), input, 1198);
    assert.equal(input.spellPressed, 3); // tower column
    endFrame();
});

// ---- spell 2 water stream (Victory, held) -----------------------------
test("left Victory fires spell 2 once on the edge; releases when it drops", () => {
    setup();
    const v = leftGesture("Victory");
    applyGestures(state([v], 1000), input, 1000);
    assert.equal(input.spellPressed, 2);
    assert.equal(input.spellHeld2, true);
    endFrame();
    applyGestures(state([v], 1033), input, 1033); // still up
    assert.equal(input.spellPressed, 0);
    assert.equal(input.spellHeld2, true);
    applyGestures(state([openLeft()], 1066), input, 1066); // released
    assert.equal(input.spellHeld2, false);
});

test("right-hand Victory is not a spell — the left hand owns spells", () => {
    setup();
    const v = leftGesture("Victory");
    v.handedness = "Right";
    applyGestures(state([v], 1000), input, 1000);
    assert.equal(input.spellPressed, 0);
    assert.equal(input.spellHeld2, false);
});

// ---- spell 3 tower column (Thumb_Up, edge) ----------------------------
test("left Thumb_Up fires spell 3 after 2 consecutive sightings", () => {
    setup();
    const h = leftGesture("Thumb_Up");
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.spellPressed, 0);
    applyGestures(state([h], 1033), input, 1033);
    assert.equal(input.spellPressed, 3);
    endFrame();
});

test("left Thumb_Up does not activate surf — surf is the right hand only", () => {
    setup();
    const h = leftGesture("Thumb_Up");
    applyGestures(state([h], 1000), input, 1000);
    applyGestures(state([h], 1033), input, 1033);
    assert.equal(input.surf, false);
});

// ---- spell 4 ice spikes (Thumb_Down, edge) ----------------------------
test("left Thumb_Down fires spell 4 after 2 consecutive sightings", () => {
    setup();
    const h = leftGesture("Thumb_Down");
    applyGestures(state([h], 1000), input, 1000);
    assert.equal(input.spellPressed, 0);
    applyGestures(state([h], 1033), input, 1033);
    assert.equal(input.spellPressed, 4);
    endFrame();
});

test("a low-confidence category is ignored", () => {
    setup();
    const h = leftGesture("Thumb_Down", 0.2);
    applyGestures(state([h], 1000), input, 1000);
    applyGestures(state([h], 1033), input, 1033);
    assert.equal(input.spellPressed, 0);
});

// ---- spell 5 vortex (Closed_Fist held >= 100ms) ------------------------
test("left Closed_Fist held for 100ms fires spell 5", () => {
    setup();
    const fist = leftGesture("Closed_Fist");
    applyGestures(state([fist], 1000), input, 1000);
    assert.equal(input.spellPressed, 0); // 0ms: pending
    applyGestures(state([fist], 1060), input, 1060);
    assert.equal(input.spellPressed, 0); // 60ms: still under 100
    applyGestures(state([fist], 1105), input, 1105);
    assert.equal(input.spellPressed, 5); // 105ms: vortex
    endFrame();
});

test("left Closed_Fist brief tap (< 100ms) does not fire vortex", () => {
    setup();
    const fist = leftGesture("Closed_Fist");
    applyGestures(state([fist], 1000), input, 1000);
    applyGestures(state([fist], 1050), input, 1050);
    // Released before 100ms — no spell.
    applyGestures(state([openLeft()], 1080), input, 1080);
    assert.equal(input.spellPressed, 0);
});

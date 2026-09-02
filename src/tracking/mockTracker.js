/**
 * Scripted tracking source for `?track=mock` — drives the same state struct
 * as the live tracker so the whole pipeline (mapping, camera, character,
 * spells) is exercisable headless, in Playwright or by hand. The script is a
 * list of [seconds, command, args]; face commands carry yaw/pitch intent and
 * build a real matrix via headLook's helper, and hand commands carry a
 * MediaPipe gesture category plus 21 synthesised landmarks, which is what the
 * gesture layer reads.
 */

import { createTrackingState } from "./state.js";
import { makeFaceMatrix } from "./headLook.js";

/**
 * Default e2e script: look right, centre, walk, steer, surf (thumb extended),
 * release, then one cast of every left-hand spell. Surf-active interval is
 * t=7..8 s; the spell run is t=9..12 s, one pose per spell with a hands-off
 * frame between them so the re-arm gate sees a neutral before the next pose.
 *
 *    9.0  palm forward  spell 1  water push    (edge: 2 consecutive sightings)
 *    9.6  Victory       spell 2  water stream  (fires on the edge, then held)
 *   10.2  Thumb_Up      spell 3  tower column  (edge)
 *   10.8  Thumb_Down    spell 4  ice spikes    (edge)
 *   11.4  Closed_Fist   spell 5  vortex        (held >= 100 ms)
 */
export const DEFAULT_SCRIPT = [
    [0.0, "face", { yaw: 0, pitch: 0 }],
    [1.0, "face", { yaw: 0.25, pitch: 0.1 }],
    [3.0, "face", { yaw: 0, pitch: 0 }],
    [3.5, "hand", { handedness: "Right", gesture: "Open_Palm", roll: 0 }],
    [5.0, "hand", { handedness: "Right", gesture: "Open_Palm", roll: 0.6 }],
    [7.0, "hand", {
        handedness: "Right", gesture: "None",
        thumbRoll: 0.3, thumbState: "extended",
    }],
    [8.0, "hands-off", {}],
    // Spell 1 (water push): the one pose that is read off landmarks rather
    // than a category, held long enough for the two-sighting edge to confirm.
    [9.0, "hand", { handedness: "Left", pose: "palmForward" }],
    [9.4, "hands-off", {}],
    // Spell 2 (water stream): Victory holds inp.spellHeld2 while it is up.
    [9.6, "hand", { handedness: "Left", gesture: "Victory" }],
    [10.0, "hands-off", {}],
    // Spell 3 (tower column).
    [10.2, "hand", { handedness: "Left", gesture: "Thumb_Up" }],
    [10.6, "hands-off", {}],
    // Spell 4 (ice spikes).
    [10.8, "hand", { handedness: "Left", gesture: "Thumb_Down" }],
    [11.2, "hands-off", {}],
    // Spell 5 (vortex): a closed fist held past the 100 ms hold gate.
    [11.4, "hand", { handedness: "Left", gesture: "Closed_Fist" }],
    [11.8, "hands-off", {}],
];

/**
 * Build a synthetic 21-point hand.
 *
 * Args:
 *   handedness, gesture      — written through.
 *   roll, thumbRoll          — palm roll and thumb tilt, radians.
 *   wristX, wristY           — where the wrist sits in image coords.
 *   pose                     — landmark pattern, for the one spell that is
 *                              read off landmarks rather than off a category:
 *                                "palmForward" — open hand toward the camera
 *                              Every other spell is a MediaPipe category, so
 *                              its script line sets `gesture` instead.
 *   thumbState               — "extended", or "curled" for a thumb folded
 *                              across the palm. Defaults to "curled" for
 *                              Closed_Fist and "extended" otherwise, matching
 *                              what the recognizer sees on a real hand.
 *
 * The whole hand hangs off the wrist, so a hand placed anywhere in frame
 * carries its thumb and palm with it.
 */
export function syntheticHand({
    handedness, gesture = "None",
    roll = 0, thumbRoll = 0, score = 0.95,
    wristX: wx = 0.5, wristY: wy = 0.55,
    pose = null, thumbState = gesture === "Closed_Fist" ? "curled" : "extended",
} = {}) {
    const landmarks = [];
    for (let i = 0; i < 21; i++) landmarks.push({ x: wx, y: wy + 0.15, z: 0 });
    landmarks[0] = { x: wx, y: wy, z: 0 };
    landmarks[9] = {
        x: wx - Math.sin(roll) * 0.18,
        y: wy - Math.cos(roll) * 0.18,
        z: 0,
    };

    if (pose === "palmForward") {
        // Fingertips above the wrist in y, well forward in z.
        for (const i of [8, 12, 16, 20]) landmarks[i] = { x: wx, y: wy - 0.25, z: 0.07 };
        for (const i of [5, 9, 13, 17]) landmarks[i] = { x: wx, y: wy - 0.15, z: 0.05 };
    }

    // Thumb MCP always sits just above the wrist; tip depends on thumbState.
    landmarks[2] = { x: wx, y: wy - 0.05, z: 0 };
    if (thumbState === "curled") {
        landmarks[4] = { x: wx, y: wy - 0.05, z: 0 }; // tip parked at the MCP
    } else {
        landmarks[4] = {
            x: wx - Math.sin(thumbRoll) * 0.12,
            y: wy - 0.05 - Math.cos(thumbRoll) * 0.12,
            z: 0,
        };
    }

    return { gesture, score, handedness, landmarks };
}

/** Clock-injectable core, so unit tests don't need rAF. */
export class MockClock {
    constructor(state, script = DEFAULT_SCRIPT) {
        this.state = state;
        this.script = script;
        this.cursor = 0;
        this.lastT = -1;
        // The script loops: snowflow's boot takes seconds, so a one-shot
        // script would be over before the first frame. Events are
        // absolute-state commands, so replaying a cycle just re-asserts state.
        this.period = script.length ? script[script.length - 1][0] + 2 : 2;
    }

    /** Apply every event scheduled at or before the (looping) script time. */
    tick(nowMs) {
        const t = (nowMs / 1000) % this.period;
        if (t < this.lastT) this.cursor = 0; // wrapped: replay the cycle
        this.lastT = t;
        while (this.cursor < this.script.length && this.script[this.cursor][0] <= t) {
            this.apply(this.script[this.cursor]);
            this.cursor++;
        }
        // Events change content; ticks keep it warm. A live tracker reports
        // the current pose every inference, so freshness stamps track the
        // tick — in the performance.now() domain headLook/gestures compare
        // against, not the script clock.
        const stamp = performance.now();
        if (this.state.faceOk) this.state.faceTs = stamp;
        if (this.state.handCount > 0) this.state.ts = stamp;
    }

    apply(event) {
        const [, cmd, args] = event;
        const s = this.state;
        if (cmd === "face") {
            s.faceMatrix.set(makeFaceMatrix(args.yaw, args.pitch));
            s.faceOk = true;
            s.faceNoseY = 0.4;
        } else if (cmd === "hand") {
            this.setHand(syntheticHand({
                handedness: args.handedness,
                gesture: args.gesture ?? "None",
                roll: args.roll ?? 0,
                thumbRoll: args.thumbRoll ?? 0,
                wristX: args.wristX,
                wristY: args.wristY,
                pose: args.pose,
                thumbState: args.thumbState,
            }));
        } else if (cmd === "hands-off") {
            s.handCount = 0;
        }
    }

    /** Write a synthetic hand into the pooled slot, as one inference would. */
    setHand(h) {
        const slot = this.state.hands[0];
        slot.gesture = h.gesture;
        slot.score = h.score;
        slot.handedness = h.handedness;
        slot.landmarks = h.landmarks;
        this.state.handCount = 1;
    }
}

export function initMockTracking(script = DEFAULT_SCRIPT) {
    const state = createTrackingState();
    const clock = new MockClock(state, script);
    const t0 = performance.now();
    const loop = () => {
        clock.tick(performance.now() - t0);
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return { state, video: null, live: false, status: "mock" };
}

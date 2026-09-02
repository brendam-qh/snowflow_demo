/**
 * Gesture control: MediaPipe GestureRecognizer results -> the shared input
 * struct. The right hand drives movement and surf; the left hand drives
 * spells. Locomotion is "what is the gesture currently asking for?" plus
 * "what is the keyboard currently asking for?" — see the per-frame comment in
 * `applyGestures` for how they compose.
 *
 *   right Open_Palm       walk (moveZ = 1); palm roll steers (moveX)
 *   right palm raised     sprint (wrist above the shoulder line of the face box)
 *   right thumb extended  snow-surf; thumb tilt adds to moveX as a steering bias
 *   right (other)         no movement override; keyboard WASD wins
 *   left  palm forward    spell 1, water push
 *   left  Victory         spell 2, water stream (held)
 *   left  Thumb_Up        spell 3, tower column
 *   left  Thumb_Down      spell 4, ice spikes
 *   left  Closed_Fist     spell 5, vortex (held >= 100 ms)
 *
 * The surf trigger is "thumb is extended in any direction" — not the
 * MediaPipe `Thumb_Up` category. The category is too strict: tilt the thumb
 * ~15° and the recognizer drops the label, killing surf mid-carve. The
 * landmark-based check is direction-agnostic, so the same gesture steers
 * the carve to the left, the right, or anywhere else without dropping.
 *
 * Spells edge-trigger like a keydown: two consecutive sightings to confirm,
 * one frame of spellPressed, and the hand must return to a non-spell pose
 * before another spell can fire — a held pose is never a burst of casts.
 *
 * Handedness is anatomical (MediaPipe reports the person's hand, not the
 * image side), so roles survive preview mirroring. `mirror` only flips the
 * steering axes, matching the mirrored PiP the user watches.
 */

import { S } from "../core/settings.js";

const LOST_MS = 250; // hands unseen this long -> gesture layer stands down
const ROLL_DEAD = 0.26; // rad (~15 deg) of lean that still means "straight"
const ROLL_FULL = 0.785; // rad (~45 deg) of lean for full deflection
const SHOULDER_DROP = 0.3; // face-nose y + this = shoulder line (image coords, y down)
const THUMB_DEAD = 0.26; // rad (~15 deg) of thumb tilt that still means "straight"
const THUMB_FULL = 0.785; // rad (~45 deg) of thumb tilt for full steering
const THUMB_EXT_MIN = 0.07; // thumb MCP→tip length that counts as "extended"

// ---- left-hand spells --------------------------------------------------
// Four of the five are a MediaPipe gesture category. The recognizer already
// knows Victory, Thumb_Up, Thumb_Down and Closed_Fist, and a category the user
// hits first try beats a landmark heuristic they have to be taught. Only the
// water push reads landmarks, because "palm toward the camera" is not one of
// the categories.
const SPELL_BY_GESTURE = {
    Victory: 2,    // water stream — held for as long as the pose holds
    Thumb_Up: 3,   // tower column — edge
    Thumb_Down: 4, // ice spikes   — edge
};
const TIP_LANDMARKS = [8, 12, 16, 20]; // index, middle, ring, pinky tips
const PALM_Y_DROP = 0.05; // tips must be this much above the wrist in y
const PALM_FORWARD_Z = 0.04; // tips must be this much further forward in z
const VORTEX_HOLD_MS = 100; // Closed_Fist held this long fires vortex

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Angle of the wrist->middle-MCP vector away from straight-up, in SCREEN
 * space: 0 = fingers up, + = leaning right as the user sees it. Landmarks are
 * raw camera space (x right, y down); the preview the user watches is
 * mirrored, so screen-x is raw x flipped when `mirror` is on.
 */
export function palmRoll(landmarks, mirror) {
    const dx = landmarks[9].x - landmarks[0].x;
    const dy = landmarks[9].y - landmarks[0].y;
    return Math.atan2(mirror ? -dx : dx, -dy);
}

/**
 * Angle of the thumb in SCREEN space: 0 = thumb straight up (Thumb_Up neutral),
 * + = tilted to the user's right in the mirrored preview. Computed from the
 * thumb MCP (landmark 2) to the thumb tip (landmark 4) — the direction the
 * thumb is actually pointing. Same mirroring convention as `palmRoll`.
 */
export function thumbAngle(landmarks, mirror) {
    const dx = landmarks[4].x - landmarks[2].x;
    const dy = landmarks[4].y - landmarks[2].y;
    return Math.atan2(mirror ? -dx : dx, -dy);
}

/**
 * True when the thumb is meaningfully extended from the hand. Distance from
 * the thumb MCP (landmark 2) to the thumb tip (landmark 4), in normalised
 * image coords. A curled thumb (Closed_Fist, thumb tucked across the palm)
 * has length ~ 0.04–0.05; an extended thumb (up, sideways, anywhere) has
 * length ~ 0.10–0.12. 0.07 is the gap. Direction-agnostic on purpose — the
 * tilt is computed separately by `thumbAngle` and feeds the steering axis.
 */
export function thumbExtended(landmarks) {
    const dx = landmarks[4].x - landmarks[2].x;
    const dy = landmarks[4].y - landmarks[2].y;
    return Math.hypot(dx, dy) >= THUMB_EXT_MIN;
}

/**
 * Hand is held with the palm facing the camera — "open hand, palm forward".
 * Heuristic: the average of the four fingertips is above the wrist in image
 * y AND extends notably further toward the camera (z) than the wrist. The
 * forward-in-z signal is what separates a palm pushed at the lens from a hand
 * that merely happens to be up, where the fingertips stay roughly co-planar
 * with the wrist.
 */
export function palmForward(landmarks) {
    const wrist = landmarks[0];
    const tips = TIP_LANDMARKS.map(i => landmarks[i]);
    const avgY = (tips[0].y + tips[1].y + tips[2].y + tips[3].y) / 4;
    const avgZ = (tips[0].z + tips[1].z + tips[2].z + tips[3].z) / 4;
    return avgY < wrist.y - PALM_Y_DROP && (avgZ - wrist.z) > PALM_FORWARD_Z;
}

function findHand(state, handedness, minScore) {
    for (let i = 0; i < state.handCount; i++) {
        const h = state.hands[i];
        if (h && h.handedness === handedness && h.score >= minScore) return h;
    }
    return null;
}

/**
 * Pure per-frame desire from the current hands. Returns zeros when nothing
 * qualifying is visible — the driver decides what standing down means.
 *
 * `thumbSteer` is the thumb-tilt-as-steer value for a Thumb_Up gesture; the
 * driver adds it to whatever movement authority currently has moveX (the
 * keyboard, or the Open_Palm walk).
 */
export function mapGestures(state, opts = S) {
    const out = {
        moveX: 0, moveZ: 0, sprint: false,
        spellGesture: "",
        surf: false, thumbSteer: 0,
    };
    const right = findHand(state, "Right", opts.trackingGestureScore);
    const left = findHand(state, "Left", opts.trackingGestureScore);

    if (right && right.gesture === "Open_Palm") {
        out.moveZ = 1;
        const roll = palmRoll(right.landmarks, opts.trackingMirror);
        const mag = clamp(
            (Math.abs(roll) - ROLL_DEAD) / (ROLL_FULL - ROLL_DEAD), 0, 1
        );
        out.moveX = Math.sign(roll) * mag * opts.trackingSteerGain;
        out.moveX = clamp(out.moveX, -1, 1);
        // Raised palm = sprint: wrist above the shoulder line under the face.
        out.sprint = right.landmarks[0].y < state.faceNoseY + SHOULDER_DROP;
    } else if (right && thumbExtended(right.landmarks)) {
        // Thumb extended (any direction) → snow-surf. The tilt becomes a
        // steering bias that the driver adds to moveX. The keyboard (or the
        // previous Open_Palm value) remains the movement authority. Note
        // that this fires for any non-Open_Palm pose, not just the strict
        // MediaPipe `Thumb_Up` category, so tilting the thumb past the
        // recognizer's window doesn't kill surf mid-carve.
        out.surf = true;
        const angle = thumbAngle(right.landmarks, opts.trackingMirror);
        const mag = clamp(
            (Math.abs(angle) - THUMB_DEAD) / (THUMB_FULL - THUMB_DEAD), 0, 1
        );
        out.thumbSteer = Math.sign(angle) * mag * opts.trackingSteerGain;
    }
    // Other right-hand poses (Closed_Fist, etc.) leave movement to the keyboard.

    // Spells are decided in applyGestures per-frame; mapGestures just exposes
    // the per-hand derived facts the rest of the pipeline reads.
    out.leftHand = left;
    return out;
}

// ------------------------------------------------------------- driver state
// Module-level singletons, matching the rest of snowflow's systems. Tests
// reset through resetGesturesForTest().
let active = false; // gesture layer currently owns the movement fields

// Edge-triggered spell state (palm forward = 1, Thumb_Up = 3, Thumb_Down = 4).
let pendingSpell = 0; // 0 = none, else the spell waiting for confirmation
let pendingCount = 0;
let armed = true; // a spell may fire (hand has returned to neutral since)

// Held spell state (Victory = 2).
let streamHeld = false;

// Hold-fist spell state (vortex = 5).
let vortexHoldStart = 0; // nowMs when the left Closed_Fist first appeared

/**
 * Lifetime casts per spell number — spellPressed exists for exactly one frame,
 * which makes it unobservable to e2e polling; this counter is the observable
 * record. One increment per cast: free. Exposed on SNOWFLOW by main.js.
 */
export const spellStats = new Array(6).fill(0);

/** Test hook. */
export function resetGesturesForTest() {
    active = false;
    pendingSpell = 0;
    pendingCount = 0;
    armed = true;
    streamHeld = false;
    vortexHoldStart = 0;
    spellStats.fill(0);
}

/**
 * Per-frame, after pollInput(). Movement and surf compose with the keyboard:
 *
 *   1. pollInput() has already written moveX/moveZ from WASD into `inp`.
 *   2. If the right hand is Open_Palm, the gesture takes over movement:
 *      palm roll becomes moveX, moveZ is set to 1. The keyboard values are
 *      discarded for this frame.
 *   3. If the right hand is anything else, the gesture does NOT touch
 *      moveX/moveZ — the keyboard values persist. The character walks with
 *      WASD even while doing the Thumb_Up surf or any other pose.
 *   4. The thumb steering is additive: it is added to the surviving moveX
 *      (WASD A/D, or the previous Open_Palm value if the user just switched
 *      gestures), clamped to [-1, 1].
 *   5. The surf flag is the union of: the gesture's current want.surf, and
 *      the right-mouse binding (which is what the character reads).
 *
 * On the active->inactive edge (hands lost, tracking disabled) the layer
 * zeroes exactly what it owns so a stale hand can't keep the character
 * walking. After the edge, the keyboard is the only authority.
 */
export function applyGestures(tracking, inp, nowMs) {
    const fresh = tracking.handCount > 0 && nowMs - tracking.ts <= LOST_MS;

    if (!S.trackingEnabled || !fresh) {
        if (active) {
            inp.moveX = 0;
            inp.moveZ = 0;
            inp.moving = false;
            inp.sprint = false;
            inp.surf = false;
            inp.thumbSteer = 0;
            inp.spellHeld2 = false;
            streamHeld = false;
            vortexHoldStart = 0;
            pendingSpell = 0;
            pendingCount = 0;
            armed = true;
            active = false;
        }
        return;
    }
    active = true;

    const want = mapGestures(tracking);

    // Movement: only Open_Palm writes moveX/moveZ. Any other right-hand pose
    // leaves the keyboard values in place, so the user can WASD-walk while
    // surfing or stopping.
    const right = findHand(tracking, "Right", S.trackingGestureScore);
    if (right && right.gesture === "Open_Palm") {
        inp.moveX = want.moveX;
        inp.moveZ = want.moveZ;
        inp.moving = want.moveX * want.moveX + want.moveZ * want.moveZ > 0.001;
        inp.sprint = want.sprint;
    } else {
        // Keyboard wins. `moving` reflects whatever is currently in the
        // fields, so the walk/render pipeline sees the truth.
        inp.moving = inp.moveX * inp.moveX + inp.moveZ * inp.moveZ > 0.001;
    }

    // Thumb steering is always additive on top of the current moveX. The raw
    // gesture value is also exposed on `inp.thumbSteer` so tests, UI, and
    // downstream consumers (e.g. a wake that wants the tilt independently
    // from the character turn) can read the intent without re-deriving it.
    inp.thumbSteer = want.thumbSteer;
    if (want.thumbSteer) {
        inp.moveX = clamp(inp.moveX + want.thumbSteer, -1, 1);
    }

    // Surf: the gesture's current want. The active->inactive edge above
    // also writes false, so a stale hand cannot keep surf alive.
    inp.surf = want.surf;

    // Spells: the left hand. Priority is vortex > stream > the edge poses,
    // which is the order they can be told apart in — a Closed_Fist and a
    // Victory are unambiguous categories, so they answer first, and the edge
    // poses are what is left.
    const left = findHand(tracking, "Left", S.trackingGestureScore);

    // --- vortex: Closed_Fist held for 100 ms (spell 5) ----------------
    if (left && left.gesture === "Closed_Fist") {
        if (vortexHoldStart === 0) vortexHoldStart = nowMs;
        if (nowMs - vortexHoldStart >= VORTEX_HOLD_MS) {
            fireSpell(inp, 5);
            vortexHoldStart = 0;
            return;
        }
    } else {
        vortexHoldStart = 0;
    }

    // --- water stream: Victory, held (spell 2) ------------------------
    // The cast starts on the edge and `spellHeld2` keeps the ribbon alive for
    // as long as the fingers stay up, which is the one spell the keyboard also
    // treats as a hold.
    if (left && left.gesture === "Victory") {
        if (!streamHeld) {
            fireSpell(inp, 2);
            streamHeld = true;
        }
        inp.spellHeld2 = true;
        return;
    }
    if (streamHeld) {
        streamHeld = false;
        inp.spellHeld2 = false;
    }

    // --- edge-triggered: palm forward (1), Thumb_Up (3), Thumb_Down (4)
    // Two consecutive sightings confirm — one stray frame of a category the
    // recognizer wasn't sure about should not cast. After a cast the layer
    // disarms until the hand leaves the pose entirely, so holding a thumb up
    // is one tower, not twenty.
    const target = left
        ? (SPELL_BY_GESTURE[left.gesture] ?? (palmForward(left.landmarks) ? 1 : 0))
        : 0;

    if (!target) {
        // Neutral pose, or no hand: nothing pending, and the next spell pose
        // is free to fire.
        pendingSpell = 0;
        pendingCount = 0;
        armed = true;
        return;
    }
    if (!armed) return; // still holding the pose that just cast

    if (pendingSpell === target) pendingCount++;
    else { pendingSpell = target; pendingCount = 1; }
    if (pendingCount >= 2) {
        fireSpell(inp, target);
        pendingSpell = 0;
        pendingCount = 0;
        armed = false;
    }
}

/** Set the one-frame spellPressed, bump the lifetime counter. */
function fireSpell(inp, n) {
    inp.spellPressed = n;
    spellStats[n]++;
}

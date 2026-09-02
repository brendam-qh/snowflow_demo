/**
 * Live webcam tracker. Owns the camera stream, the MediaPipe FaceLandmarker
 * and GestureRecognizer (one shared <video>, never attached to the DOM), and
 * an inference loop decoupled from rendering: it runs at most one inference
 * per interval and writes results into the shared state struct. The render
 * loop never waits on it.
 *
 * initTracking() is deliberately non-blocking: model fetch and the camera
 * permission prompt resolve whenever they resolve — the demo boots normally
 * and tracking switches on when ready. Permission denied or a missing camera
 * downgrades to status "unavailable" and the demo is pure keyboard/mouse.
 *
 * Package pin: @mediapipe/tasks-vision@1.0.0-rc.20260727 — the newest release
 * that passes this repo's .npmrc supply-chain gate (before=2026-07-28).
 */

import { FilesetResolver, FaceLandmarker, GestureRecognizer } from "@mediapipe/tasks-vision";
import { createTrackingState } from "./state.js";
import { recenterHeadLook } from "./headLook.js";

const WASM_BASE = "/models/wasm";
const FACE_MODEL = "/models/face_landmarker.task";
const GESTURE_MODEL = "/models/gesture_recognizer.task";

const INFER_MS = 33; // ~30 Hz target
const DEGRADE_MS = 25; // combined inference slower than this -> alternate models

export function initTracking() {
    const state = createTrackingState();
    const src = { state, video: null, live: true, status: "loading" };

    start(src).catch((err) => {
        console.warn("[tracking] unavailable:", err);
        src.status = "unavailable";
    });

    // Recenter is reachable without the mouse (hands may be busy performing).
    window.addEventListener("keydown", (e) => {
        if (e.code === "KeyR") recenterHeadLook();
    });

    return src;
}

async function start(src) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
    });
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    src.video = video;

    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    let face;
    let gest;
    try {
        const opts = (model) => ({
            baseOptions: { modelAssetPath: model, delegate: "GPU" },
            runningMode: "VIDEO",
        });
        face = await FaceLandmarker.createFromOptions(fileset, {
            ...opts(FACE_MODEL), numFaces: 1, outputFacialTransformationMatrixes: true,
        });
        gest = await GestureRecognizer.createFromOptions(fileset, {
            ...opts(GESTURE_MODEL), numHands: 2,
        });
    } catch (err) {
        // GPU delegate failed (driver quirks, VM, ...): retry on CPU/WASM
        // rather than losing tracking entirely.
        console.warn("[tracking] GPU delegate failed, falling back to CPU", err);
        const opts = (model) => ({
            baseOptions: { modelAssetPath: model, delegate: "CPU" },
            runningMode: "VIDEO",
        });
        face = await FaceLandmarker.createFromOptions(fileset, {
            ...opts(FACE_MODEL), numFaces: 1, outputFacialTransformationMatrixes: true,
        });
        gest = await GestureRecognizer.createFromOptions(fileset, {
            ...opts(GESTURE_MODEL), numHands: 2,
        });
    }

    src.status = "tracking";

    let alternate = false; // degraded mode: face on even passes, hands on odd
    let pass = 0;
    const loop = () => {
        if (video.readyState >= 2) {
            const t0 = performance.now();
            const doFace = !alternate || pass % 2 === 0;
            const doHands = !alternate || pass % 2 === 1;
            let fr = null;
            let gr = null;
            if (doFace) fr = face.detectForVideo(video, t0);
            if (doHands) gr = gest.recognizeForVideo(video, t0);
            const cost = performance.now() - t0;
            src.state.inferMs = src.state.inferMs * 0.9 + cost * 0.1;
            if (!alternate && src.state.inferMs > DEGRADE_MS) alternate = true;
            writeResults(src.state, fr, gr, t0);
            pass++;
        }
        setTimeout(loop, INFER_MS);
    };
    loop();
}

/** fr / gr are null on skipped passes in degraded mode. */
function writeResults(state, fr, gr, now) {
    if (fr) {
        const fm = fr.facialTransformationMatrixes;
        if (fm && fm.length > 0) {
            state.faceOk = true;
            state.faceTs = now;
            state.faceMatrix.set(fm[0].data);
            const fl = fr.faceLandmarks && fr.faceLandmarks[0];
            if (fl) state.faceNoseY = fl[1].y; // nose tip
        } else {
            state.faceOk = false;
        }
    }
    if (gr) {
        state.ts = now;
        const n = Math.min(gr.gestures ? gr.gestures.length : 0, 2);
        state.handCount = 0;
        for (let i = 0; i < n; i++) {
            if (!gr.gestures[i] || gr.gestures[i].length === 0) continue;
            const slot = state.hands[state.handCount++];
            slot.gesture = gr.gestures[i][0].categoryName;
            slot.score = gr.gestures[i][0].score;
            slot.handedness = gr.handedness[i][0].categoryName; // "Left"|"Right"
            slot.landmarks = gr.landmarks[i];
        }
    }
}

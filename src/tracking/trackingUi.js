/**
 * Webcam picture-in-picture: mirrored camera feed with hand landmarks, the
 * recognised gestures, and a one-line status. Hidden entirely when tracking
 * is disabled or unavailable — keyboard/mouse users never see it. Clicking
 * the preview recenters head-look (R does the same from the keyboard).
 *
 * Drawing is 2D canvas, self-throttled to ~15 Hz: it is a status readout,
 * not a mirror you watch.
 */

import { S } from "../core/settings.js";
import { recenterHeadLook } from "./headLook.js";

const DRAW_MS = 66;
const FEED_H = 160; // status strip takes the bottom 40 px of the 240x200 canvas

export function initTrackingUi(src) {
    const cv = document.getElementById("trackpip");
    if (!cv) return;
    cv.addEventListener("click", () => recenterHeadLook());
    let last = 0;

    const draw = () => {
        requestAnimationFrame(draw);
        const now = performance.now();
        if (now - last < DRAW_MS) return;
        last = now;
        const show = S.trackingEnabled && src.status !== "unavailable";
        cv.classList.toggle("show", show);
        if (!show) return;

        const ctx = cv.getContext("2d");
        const w = cv.width;
        ctx.clearRect(0, 0, w, cv.height);

        // Mirrored feed — matches what the user expects from a webcam.
        if (src.video && src.video.readyState >= 2) {
            ctx.save();
            ctx.translate(w, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(src.video, 0, 0, w, FEED_H);
            ctx.restore();
        }

        // Hand landmarks, in the same mirrored space.
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.fillStyle = "#8fc4e8";
        const st = src.state;
        for (let i = 0; i < st.handCount; i++) {
            const hand = st.hands[i];
            if (!hand.landmarks) continue;
            for (const p of hand.landmarks) {
                ctx.fillRect(p.x * w - 1, p.y * FEED_H - 1, 2, 2);
            }
        }
        ctx.restore();

        // Status strip.
        ctx.fillStyle = "rgba(8,12,19,0.8)";
        ctx.fillRect(0, FEED_H, w, cv.height - FEED_H);
        ctx.fillStyle = "#dbe6f2";
        ctx.font = "10px ui-monospace, monospace";
        const names = [];
        for (let i = 0; i < st.handCount; i++) {
            names.push(`${st.hands[i].handedness}:${st.hands[i].gesture}`);
        }
        ctx.fillText(`${src.status} · ${st.inferMs.toFixed(0)} ms`, 8, FEED_H + 14);
        ctx.fillText(names.join("  ") || (st.faceOk ? "face" : "—"), 8, FEED_H + 28);
    };
    requestAnimationFrame(draw);
}

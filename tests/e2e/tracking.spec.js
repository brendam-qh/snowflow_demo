import { test, expect } from "@playwright/test";

test("mock tracking drives camera and character", async ({ page }) => {
    await page.goto("/?track=mock");

    const hasGpu = await page.evaluate(() => !!navigator.gpu);
    test.skip(!hasGpu, "WebGPU unavailable in this environment");

    // Boot completes -> SNOWFLOW is exposed. A boot failure (e.g. headless
    // SwiftShader can create a device but not present to a canvas) shows the
    // failure screen instead — skip there rather than fail red.
    const boot = await Promise.race([
        page.waitForFunction(() => !!globalThis.SNOWFLOW, null, { timeout: 120_000 })
            .then(() => "ok"),
        page.waitForFunction(
            () => document.getElementById("nogpu")?.classList.contains("show"),
            null,
            { timeout: 120_000 }
        ).then(() => "failed"),
    ]);
    test.skip(boot !== "ok", "WebGPU present but the demo could not boot here");

    // Mock script: head turns at t=1s. Offsets must leave zero.
    await page.waitForFunction(
        () => Math.abs(globalThis.SNOWFLOW.input.headYawOffset) > 0.05,
        null,
        { timeout: 30_000 }
    );

    // t=3.5s: open palm -> the character walks.
    await page.waitForFunction(
        () => globalThis.SNOWFLOW.input.moving === true,
        null,
        { timeout: 30_000 }
    );
    await page.screenshot({ path: "shots/tracking-mock.png" });

    // t=7-8s: an extended thumb (any direction, not just the Thumb_Up
    // category) activates snow-surf. The gesture layer doesn't override
    // movement — the keyboard wins whenever the right hand isn't an
    // Open_Palm walk — so surf rides on its own flag.
    await page.waitForFunction(
        () => globalThis.SNOWFLOW.input.surf === true,
        null,
        { timeout: 30_000 }
    );
    // The mock script's thumbRoll=0.3 puts the thumb just past the deadzone,
    // so input.thumbSteer should be a small positive value too.
    await page.waitForFunction(
        () => globalThis.SNOWFLOW.input.thumbSteer > 0,
        null,
        { timeout: 30_000 }
    );
    // ...and the flag drops once the hand leaves (hands-off at t=8s).
    await page.waitForFunction(
        () => globalThis.SNOWFLOW.input.surf === false,
        null,
        { timeout: 30_000 }
    );

    // t=9-12s (looping): the left hand runs the whole spell set, one pose
    // per spell with a hands-off frame between them. Each has its own trigger
    // shape — two consecutive sightings for the edge spells, an edge-then-hold
    // for the stream, a 100 ms hold for the fist — so this is the assertion
    // that the mock still reaches every trigger in gestures.js.
    //
    // spellPressed lives for exactly one frame, which makes it unobservable
    // to polling; the lifetime spellStats counter is the observable record.
    const SPELLS = [
        [1, "water push (palm forward)"],
        [2, "water stream (victory, held)"],
        [3, "tower column (thumb up)"],
        [4, "ice spikes (thumb down)"],
        [5, "vortex (closed fist, held)"],
    ];
    for (const [n, name] of SPELLS) {
        await test.step(`spell ${n} — ${name}`, async () => {
            await page.waitForFunction(
                (i) => globalThis.SNOWFLOW.spellStats[i] > 0,
                n,
                { timeout: 30_000 }
            );
        });
    }
});

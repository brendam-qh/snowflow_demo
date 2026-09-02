// Capture a screenshot of the running demo at one or more milestones.
//
// Usage:
//   node scripts/capture.mjs [shots...]
//   shots default to: "milestone-2"
//   Each shot is a name; the file lands at shots/<name>.png.
//
// Launches Playwright Chromium with WebGPU forced on, waits for the boot
// screen to clear (the `#boot` element gains the `gone` class), waits a
// little longer for the first real frames, then captures.
//
// Any console error or page error is printed and exits non-zero so the
// build stays honest about shader / pipeline failures.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = process.env.PORT || 5174;
const OUT = "shots";
mkdirSync(OUT, { recursive: true });

const shots = process.argv.slice(2);
if (shots.length === 0) shots.push("milestone-2");

const browser = await chromium.launch({
    headless: true,
    args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-gl=angle",
        "--use-angle=metal",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
    ],
});

const errors = [];
const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
});
const page = await ctx.newPage();
page.on("console", (m) => {
    if (m.type() === "error") {
        errors.push(`[console] ${m.text()}`);
        console.error("console:", m.text());
    }
});
page.on("pageerror", (e) => {
    errors.push(`[pageerror] ${e.message}`);
    console.error("pageerror:", e);
});

const url = `http://localhost:${PORT}/`;
console.log("navigating to", url);
await page.goto(url, { waitUntil: "domcontentloaded" });

// Wait for the boot screen to vanish — the app clears `#boot.gone` once
// the first warm-up renders finish. If this never happens the app failed.
try {
    await page.waitForSelector("#boot.gone", { timeout: 45000 });
    console.log("boot screen cleared");
} catch {
    console.error("boot screen did not clear; capturing whatever is there");
}

// Give the render loop a few seconds to settle (TAA history, sky re-solve).
await page.waitForTimeout(3500);

for (const name of shots) {
    const path = `${OUT}/${name}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log("saved", path);
}

await browser.close();

if (errors.length) {
    console.error(`\n${errors.length} error(s) captured:`);
    for (const e of errors) console.error(" " + e);
    process.exit(1);
}

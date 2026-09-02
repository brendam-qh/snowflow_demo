import { defineConfig } from "@playwright/test";

// Headless Chromium's WebGPU adapter (SwiftShader) cannot present to a canvas
// — the demo boots only in a headed browser on a real GPU. Force headless
// with E2E_HEADLESS=1 for CI; the test then skips itself if boot fails.
const headless = process.env.E2E_HEADLESS === "1";

export default defineConfig({
    testDir: "./tests/e2e",
    timeout: 180_000, // the boot bakes real GPU work; give it room
    use: {
        baseURL: "http://localhost:5199",
        headless,
        launchOptions: {
            args: ["--enable-unsafe-webgpu"],
        },
    },
    webServer: {
        command: "npm run dev -- --port 5199 --strictPort",
        url: "http://localhost:5199",
        reuseExistingServer: false,
        timeout: 60_000,
    },
});


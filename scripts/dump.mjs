// Diagnostic capture: dump key state via SNOWFLOW global, plus a screenshot.
import { chromium } from "playwright";
import { writeFile, mkdirSync } from "node:fs";

const PORT = process.env.PORT || 5174;
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch({
    headless: true,
    args: [
        "--enable-unsafe-webgpu", "--enable-features=Vulkan",
        "--use-gl=angle", "--use-angle=metal",
        "--ignore-gpu-blocklist", "--enable-gpu-rasterization",
    ],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#boot.gone", { timeout: 45000 });
await page.waitForTimeout(3500);

// Probe heights at a grid across the play area to confirm the valley carves.
const diag = await page.evaluate(async () => {
    const S = globalThis.SNOWFLOW;
    if (!S) return { ok: false, reason: "SNOWFLOW missing" };
    const t = S.terrain;
    const out = {
        ok: true,
        riverness: S.S.riverness,
        riverFlowDir: S.S.riverFlowDir,
        playRadius: 620,
        origin: [t.heightfield.origin.x, t.heightfield.origin.y],
        minH: t.heightfield.minHeight,
        maxH: t.heightfield.maxHeight,
        grid: [],
    };
    // Sample along the river flow direction and perpendicular to it.
    const cx = 0, cz = 0;
    const flow = S.S.riverFlowDir * Math.PI / 180;
    const dirx = Math.cos(flow), dirz = Math.sin(flow);
    const perpx = -dirz, perpz = dirx;
    for (let i = -8; i <= 8; i++) {
        const d = i * 25;
        const row = [];
        for (let j = -8; j <= 8; j++) {
            const c = j * 25;
            const x = cx + dirx * d + perpx * c;
            const z = cz + dirz * d + perpz * c;
            const h = t.heightAt(x, z);
            row.push(Math.round(h * 10) / 10);
        }
        out.grid.push(row);
    }
    return out;
});

const HEIGHT_PROFILE = `
valley profile (rows along flow dir, cols across; metres):
${diag.grid ? diag.grid.map(r => r.map(h => (h >= 0 ? " " : "") + h.toFixed(1).padStart(5)).join(" ")).join("\n") : "(no grid)"}

riverness=${diag.riverness} flowDir=${diag.riverFlowDir}
minH=${diag.minH} maxH=${diag.maxH}
`;

console.log(HEIGHT_PROFILE);
await writeFile("shots/valley-profile.txt", HEIGHT_PROFILE, "utf8");

await page.screenshot({ path: "shots/milestone-2-valley.png" });
console.log("saved shots/milestone-2-valley.png");

await browser.close();
if (errors.length) { console.error("errors: " + errors.join("\n")); process.exit(1); }

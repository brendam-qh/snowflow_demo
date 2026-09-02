import { chromium, webkit } from "playwright";
const EXEC = "/Users/brendamiao/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const USE = process.env.ENGINE === "webkit" ? webkit : chromium;
const b = await USE.launch({
    headless: true,
    executablePath: EXEC,
    args: ["--enable-unsafe-webgpu","--enable-features=Vulkan","--use-gl=angle","--use-angle=metal","--ignore-gpu-blocklist","--enable-gpu-rasterization","--headless=new"]
});
const p = await (await b.newContext({viewport:{width:1920,height:1080}})).newPage();
p.on("console", m => console.log(`[${m.type()}] ${m.text()}`));
p.on("pageerror", e => console.log("[pageerror]", e.message));
await p.addInitScript(() => {
  // Wrap the GPUDevice.createShaderModule to capture the submitted WGSL.
  window.__wgslSources = [];
  const _wrap = () => {
    if (!window.GPUDevice) return false;
    if (window.GPUDevice.__wrapped) return true;
    const orig = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function(desc) {
      try { window.__wgslSources.push(desc?.code || ""); } catch {}
      return orig.call(this, desc);
    };
    window.GPUDevice.__wrapped = true;
    return true;
  };
  // Init immediately + re-check after a tick (GPUDevice is exposed early).
  _wrap();
  setTimeout(_wrap, 0);
});
await p.goto("http://localhost:5174/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(e => {console.log("goto err", e.message);});
await p.waitForSelector("#boot.gone", { timeout: 20000 }).catch(()=>console.log("boot NOT cleared"));
await p.waitForTimeout(3000);
const s = await p.evaluate(() => {
  const SNOWFLOW = window.SNOWFLOW;
  if (!SNOWFLOW) return "no SNOWFLOW";
  return JSON.stringify({
    heightCPU: !!SNOWFLOW.terrain.heightfield.heightCPU,
    res: SNOWFLOW.terrain.heightfield.cpuRes,
    min: SNOWFLOW.terrain.heightfield.minHeight,
    max: SNOWFLOW.terrain.heightfield.maxHeight,
    charY: SNOWFLOW.character.position.y,
    camY: SNOWFLOW.rig.camera.position.y,
    wgslCount: (window.__wgslSources || []).length,
  });
});
console.log("STATE:", s);
// Save the *failed* shader (search for "vary vUV" in submitted sources)
const wlist = await p.evaluate(() => (window.__wgslSources || []).map((s,i)=>({i,len:s.length})));
console.log("submitted shaders:", wlist.length);
for (const w of wlist) if (w.len > 1500) console.log(` [#${w.i}] len=${w.len}`);
// Save the one with `vary vUV` and the one with most lines
const failedAndLargest = await p.evaluate(() => {
  const arr = window.__wgslSources || [];
  let failIdx = -1, bigIdx = 0, bigSize = 0;
  for (let i=0;i<arr.length;i++){
    if (arr[i].includes("\nvary vUV:")) failIdx = i;
    if (arr[i].length > bigSize){ bigSize = arr[i].length; bigIdx = i; }
  }
  return {
    failIdx, failSrc: failIdx>=0 ? arr[failIdx] : "",
    bigIdx, bigSrc: bigIdx>=0 ? arr[bigIdx] : "",
  };
});
import("node:fs").then(fs => {
  if (failedAndLargest.failIdx >= 0) {
    fs.writeFileSync("/tmp/wgsl_failed.wgsl", failedAndLargest.failSrc);
    console.log(`saved fail [#${failedAndLargest.failIdx}] (${failedAndLargest.failSrc.length}b)`);
  }
  fs.writeFileSync("/tmp/wgsl_largest.wgsl", failedAndLargest.bigSrc);
  console.log(`saved largest [#${failedAndLargest.bigIdx}] (${failedAndLargest.bigSrc.length}b)`);
});
await b.close();

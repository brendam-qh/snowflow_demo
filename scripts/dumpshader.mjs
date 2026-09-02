import { chromium } from "playwright";
const b = await chromium.launch({headless:true,args:["--enable-unsafe-webgpu","--enable-features=Vulkan","--use-gl=angle","--use-angle=metal","--ignore-gpu-blocklist"]});
const p = await (await b.newContext({viewport:{width:1280,height:720}})).newPage();
p.on("console", m => console.log(`[${m.type()}] ${m.text()}`));
await p.goto("http://localhost:5174/", {waitUntil:"domcontentloaded"});
await p.waitForFunction(() => window.ShaderStore && window.ShaderStore.ShadersStoreWGSL?.heightBakePixelShader, null, {timeout:15000});
const src = await p.evaluate(() => {
  const sn = window.ShaderStore?.IncludesShadersStoreWGSL || {};
  const ss = window.ShaderStore?.ShadersStoreWGSL || {};
  // Apply #include<name> substitution the way Babylon's ShaderStore does.
  const stripComments = s => s.replace(/\/\/[^\n]*\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  let raw = ss["heightBakePixelShader"] || "";
  raw = raw.replace( /#include<(\w+)>/g, (m, name) => sn[name] || "" );
  return raw;
});
const {writeFileSync} = await import("node:fs");
writeFileSync("/tmp/heightBake_final.wgsl", src);
console.log("saved /tmp/heightBake_final.wgsl", src.length, "bytes lines:", src.split("\n").length);
await b.close();

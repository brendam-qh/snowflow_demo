// Save the SSFR renderer, restore the billboard renderer
import { readFileSync, writeFileSync } from "node:fs";
let f = readFileSync("src/fluid/particleRender.js", "utf8");
fs.writeFileSync("src/fluid/particleRenderSSFR.js", f);

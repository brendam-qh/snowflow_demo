// Read the first screenshot and report colour/luminance statistics so the
// model can reason about the frame without actually seeing it.
import { readFile } from "node:fs/promises";
import zlib from "node:zlib";

const SHOT = process.argv[2] || "shots/milestone-2-valley.png";

const raw = await readFile(SHOT);
const pngBytes = raw.buffer;

// Minimal PNG decoder (unfilter + zlib inflate). Handles only the colour
// types this script produces (8-bit RGB or RGBA).
function decodePNG(buf) {
    let p = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let idat = [];
    while (p < buf.byteLength) {
        const len = (new DataView(buf, p, 4)).getUint32(0);
        const type = String.fromCharCode(...new Uint8Array(buf, p + 4, 4));
        const chunk = buf.slice(p + 8, p + 8 + len);
        if (type === "IHDR") {
            const v = new DataView(chunk);
            width = v.getUint32(0);
            height = v.getUint32(4);
            bitDepth = v.getUint8(8);
            colorType = v.getUint8(9);
        } else if (type === "IDAT") {
            idat.push(new Uint8Array(chunk));
        } else if (type === "IEND") {
            break;
        }
        p += 8 + len + 4;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    const bpp = channels;
    const stride = width * bpp + 1;
    const out = new Uint8Array(width * height * bpp);
    let prev = new Uint8Array(stride);
    let r = 0;
    for (let y = 0; y < height; y++) {
        const start = r;
        const filter = raw[r];
        r++;
        const row = raw.subarray(r, r + width * bpp);
        r += width * bpp;
        const rec = new Uint8Array(width * bpp);
        for (let x = 0; x < width * bpp; x++) {
            const A = x >= bpp ? rec[x - bpp] : 0;
            const B = prev[x];
            const C = x >= bpp ? prev[x - bpp] : 0;
            const v = row[x];
            const f = filter;
            let out = v;
            if (f === 1) out = (v + A) & 0xff;
            else if (f === 2) out = (v + B) & 0xff;
            else if (f === 3) out = (v + ((A + B) >> 1)) & 0xff;
            else if (f === 4) {
                const p_ = A + B - C;
                const pa = Math.abs(p_ - A), pb = Math.abs(p_ - B), pc = Math.abs(p_ - C);
                let pred = pa <= pb && pa <= pc ? A : pb <= pc ? B : C;
                out = (v + pred) & 0xff;
            }
            rec[x] = out;
        }
        out.set(rec, y * width * bpp);
        prev = rec;
    }
    return { width, height, channels, data: out };
}

const { width, height, channels, data } = decodePNG(pngBytes);

// Per-region statistics: split into a 6x4 grid, report mean luminance
// and mean (R,G,B) so I can tell sky/river/terrain apart by their colours.
const NGX = 6, NGY = 4;
let report = `frame ${width}x${height} channels=${channels}\ngrid ${NGX}x${NGY}, cells report mean RGB and luma (Rec.709):\n`;
for (let gy = 0; gy < NGY; gy++) {
    let line = "";
    for (let gx = 0; gx < NGX; gx++) {
        let rr = 0, gg = 0, bb = 0, n = 0;
        const x0 = Math.floor(gx * width / NGX), x1 = Math.floor((gx + 1) * width / NGX);
        const y0 = Math.floor(gy * height / NGY), y1 = Math.floor((gy + 1) * height / NGY);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * width + x) * channels;
                rr += data[i]; gg += data[i + 1]; bb += data[i + 2]; n++;
            }
        }
        rr /= n; gg /= n; bb /= n;
        const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        line += `(${Math.round(rr)},${Math.round(gg)},${Math.round(bb)})~${Math.round(l)} `;
    }
    report += line + "\n";
}
console.log(report);

// Also sample a vertical luminance profile (centre column) across 20 bands
// so the valley-darkening, river glints and sky band show.
let vp = "vertical luminance (628x1080) centre column, 20 bands:\n";
for (let i = 0; i < 20; i++) {
    let sum = 0, n = 0;
    const y0 = Math.floor(i * height / 20), y1 = Math.floor((i + 1) * height / 20);
    for (let y = y0; y < y1; y++) for (let x = width / 2 - 5; x < width / 2 + 5; x++) {
        const idx = (y * width + Math.floor(x)) * channels;
        sum += 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
        n++;
    }
    vp += `${Math.round(sum / n)} `;
}
console.log(vp);

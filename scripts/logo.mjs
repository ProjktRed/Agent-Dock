// Agent Dock logo: three agent modules docked on a shared base.
// Single source for the SVG (UI, assets/logo.svg) and the PNG raster (window, tray, exe icon).
import { deflateSync } from "node:zlib";
import { LOGO } from "./logo-shapes.mjs";

export { LOGO, logoSvg } from "./logo-shapes.mjs";

/** Coverage of a rounded rectangle at pixel (px, py), anti-aliased via a signed distance field. */
function coverage(s, px, py, scale) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const qx = Math.abs(px - cx) - (s.w / 2 - s.r);
  const qy = Math.abs(py - cy) - (s.h / 2 - s.r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r;
  return Math.max(0, Math.min(1, 0.5 - d * scale));
}

/** RGBA pixels of the logo; `dot` adds a status dot (RGB) in the lower-right corner. */
export function logoPixels(size, { background = true, dot = null } = {}) {
  const scale = size / 32;
  const layers = [...(background ? [LOGO.background] : []), ...LOGO.layers];
  if (dot) layers.push({ x: 21, y: 21, w: 10, h: 10, r: 5, color: dot });
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) / scale;
      const gy = (y + 0.5) / scale;
      let r = 0, g = 0, b = 0, a = 0;
      for (const layer of layers) {
        const c = coverage(layer, gx, gy, scale);
        if (!c) continue;
        // "over" compositing
        const na = c + a * (1 - c);
        r = (layer.color[0] * c + r * a * (1 - c)) / na;
        g = (layer.color[1] * c + g * a * (1 - c)) / na;
        b = (layer.color[2] * c + b * a * (1 - c)) / na;
        a = na;
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function logoPng(size, options = {}) {
  const pixels = logoPixels(size, options);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

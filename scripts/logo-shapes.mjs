// Agent Dock logo geometry (no Node imports, safe for the renderer).
// Three agent modules, each with a status light, seated in a dock cradle. 32×32 grid.
const NAVY = [21, 33, 49];
const DOCK = [227, 234, 243];

export const LOGO = {
  background: { x: 0, y: 0, w: 32, h: 32, r: 7.5, color: NAVY },
  layers: [
    // cradle: base and two side posts
    { x: 4, y: 22.5, w: 24, h: 4, r: 2, color: DOCK },
    { x: 4, y: 16.5, w: 3.2, h: 10, r: 1.6, color: DOCK },
    { x: 24.8, y: 16.5, w: 3.2, h: 10, r: 1.6, color: DOCK },
    // agent modules (implementation blue, QA lavender, assessment mint)
    { x: 8.6, y: 11, w: 4.4, h: 10.2, r: 2.2, color: [130, 169, 232] },
    { x: 13.8, y: 7.5, w: 4.4, h: 13.7, r: 2.2, color: [173, 154, 218] },
    { x: 19, y: 11, w: 4.4, h: 10.2, r: 2.2, color: [112, 199, 165] },
    // status lights
    { x: 9.8, y: 12.6, w: 2, h: 2, r: 1, color: NAVY },
    { x: 15, y: 9.1, w: 2, h: 2, r: 1, color: NAVY },
    { x: 20.2, y: 12.6, w: 2, h: 2, r: 1, color: NAVY },
  ],
};

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const rect = (s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${hex(s.color)}"/>`;

export function logoSvg({ background = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${background ? rect(LOGO.background) : ""}${LOGO.layers.map(rect).join("")}</svg>`;
}

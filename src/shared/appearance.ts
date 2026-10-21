import type { Settings, UiStyle } from "./types";

// Interface styles (Settings › General › Appearance). Each style has its own five accents, the first one
// the default, and remembers the accent picked for it: general.accent for Neumorphic (the original look,
// so older settings files keep theirs), general.styleAccents for the others.

export const UI_STYLES: UiStyle[] = ["neumorphic", "standard", "cyberpunk"];

export const STYLE_ACCENTS: Record<UiStyle, [name: string, hex: string][]> = {
  neumorphic: [
    ["Pastel blue", "#82A9E8"],
    ["Lavender", "#AD9ADA"],
    ["Mint", "#70C7A5"],
    ["Amber", "#DAB777"],
    ["Rose", "#D98291"],
  ],
  standard: [
    ["Blue", "#5B9DFF"],
    ["Violet", "#A78BFA"],
    ["Green", "#4ADE80"],
    ["Amber", "#FBBF24"],
    ["Rose", "#FB7185"],
  ],
  cyberpunk: [
    ["Cyan", "#00E5FF"],
    ["Magenta", "#FF2BD6"],
    ["Acid", "#C6FF00"],
    ["Amber", "#FFB000"],
    ["Red", "#FF3864"],
  ],
};

/** Window background per style and shade, so the window does not flash another color before the page paints. */
export const STYLE_BACKGROUNDS: Record<UiStyle, Record<Settings["general"]["theme"], string>> = {
  neumorphic: { dark: "#152131", darker: "#101a27" },
  standard: { dark: "#17191e", darker: "#0f1114" },
  cyberpunk: { dark: "#0a0614", darker: "#05030b" },
};

const HEX = /^#[0-9a-f]{6}$/i;
const validAccent = (v: unknown, fallback: string) => (typeof v === "string" && HEX.test(v) ? v.toUpperCase() : fallback);

/** The style, shade and accents of a saved general section; anything missing or invalid becomes its default. */
export function normalizeAppearance(general: Partial<Settings["general"]>): Pick<Settings["general"], "style" | "theme" | "accent" | "styleAccents"> {
  const saved = (general.styleAccents ?? {}) as Partial<Record<UiStyle, unknown>>;
  return {
    style: UI_STYLES.includes(general.style as UiStyle) ? (general.style as UiStyle) : "neumorphic",
    theme: general.theme === "darker" ? "darker" : "dark",
    accent: validAccent(general.accent, STYLE_ACCENTS.neumorphic[0][1]),
    styleAccents: {
      standard: validAccent(saved.standard, STYLE_ACCENTS.standard[0][1]),
      cyberpunk: validAccent(saved.cyberpunk, STYLE_ACCENTS.cyberpunk[0][1]),
    },
  };
}

/** The accent remembered for a style. */
export function styleAccent(general: Pick<Settings["general"], "accent" | "styleAccents">, style: UiStyle): string {
  return style === "neumorphic" ? general.accent : general.styleAccents?.[style] ?? STYLE_ACCENTS[style][0][1];
}

/** The general section with a new accent for one style; the others keep theirs. */
export function withStyleAccent(general: Settings["general"], style: UiStyle, hex: string): Settings["general"] {
  return style === "neumorphic" ? { ...general, accent: hex } : { ...general, styleAccents: { ...general.styleAccents, [style]: hex } };
}

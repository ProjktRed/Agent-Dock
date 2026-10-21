import { describe, expect, it } from "vitest";
import { normalizeAppearance, STYLE_ACCENTS, styleAccent, withStyleAccent } from "../src/shared/appearance";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { Settings } from "../src/shared/types";

describe("interface style settings", () => {
  it("defaults match the first accent of each style", () => {
    expect(normalizeAppearance(DEFAULT_SETTINGS.general)).toEqual({ style: "neumorphic", theme: "dark", accent: "#82A9E8", styleAccents: { standard: "#5B9DFF", cyberpunk: "#00E5FF" } });
    expect(DEFAULT_SETTINGS.general.styleAccents).toEqual({ standard: STYLE_ACCENTS.standard[0][1], cyberpunk: STYLE_ACCENTS.cyberpunk[0][1] });
  });

  it("an older settings file keeps its theme and accent as the Neumorphic look", () => {
    const old = { theme: "darker", accent: "#70C7A5" } as Partial<Settings["general"]>;
    expect(normalizeAppearance(old)).toEqual({ style: "neumorphic", theme: "darker", accent: "#70C7A5", styleAccents: { standard: "#5B9DFF", cyberpunk: "#00E5FF" } });
  });

  it("keeps valid choices and replaces invalid ones with the defaults", () => {
    expect(normalizeAppearance({ style: "cyberpunk", theme: "dark", accent: "#ad9ada", styleAccents: { standard: "#fbbf24", cyberpunk: "#FF2BD6" } })).toEqual({ style: "cyberpunk", theme: "dark", accent: "#AD9ADA", styleAccents: { standard: "#FBBF24", cyberpunk: "#FF2BD6" } });
    const bad = { style: "glass", theme: "light", accent: "red", styleAccents: { standard: 5, cyberpunk: "#12345" } } as unknown as Partial<Settings["general"]>;
    expect(normalizeAppearance(bad)).toEqual({ style: "neumorphic", theme: "dark", accent: "#82A9E8", styleAccents: { standard: "#5B9DFF", cyberpunk: "#00E5FF" } });
    expect(normalizeAppearance({ styleAccents: null } as unknown as Partial<Settings["general"]>).styleAccents).toEqual({ standard: "#5B9DFF", cyberpunk: "#00E5FF" });
  });

  it("each style remembers its own accent", () => {
    let g = structuredClone(DEFAULT_SETTINGS.general);
    g = withStyleAccent(g, "cyberpunk", "#C6FF00");
    g = withStyleAccent(g, "neumorphic", "#D98291");
    expect([styleAccent(g, "neumorphic"), styleAccent(g, "standard"), styleAccent(g, "cyberpunk")]).toEqual(["#D98291", "#5B9DFF", "#C6FF00"]);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { appUrl, resolveAppPath } from "../src/main/lib/app-protocol";

describe("app:// protocol", () => {
  const root = path.resolve("/app/out/renderer");
  it("serves files inside the renderer folder", () => {
    expect(appUrl({ ui: "standard", theme: "dark" })).toBe("app://agent-dock/index.html?ui=standard&theme=dark");
    expect(resolveAppPath(root, "app://agent-dock/index.html?ui=x")).toBe(path.join(root, "index.html"));
    expect(resolveAppPath(root, "app://agent-dock/")).toBe(path.join(root, "index.html"));
    expect(resolveAppPath(root, "app://agent-dock/assets/inter%20latin.woff2")).toBe(path.join(root, "assets", "inter latin.woff2"));
  });

  it("never resolves outside it, and refuses other hosts, schemes and malformed paths", () => {
    // The URL parser folds ../ (encoded or not) into the root; a backslash is a separator on Windows.
    for (const hostile of ["app://agent-dock/../main/index.js", "app://agent-dock/%2e%2e/%2e%2e/secret", "app://agent-dock/..%5C..%5Csecret", "app://agent-dock/assets/..%2F..%2F..%2Fsecret"]) {
      const file = resolveAppPath(root, hostile);
      expect(file === null || file.startsWith(root + path.sep), `${hostile} -> ${file}`).toBe(true);
    }
    for (const bad of ["app://other/index.html", "file:///app/out/renderer/index.html", "app://agent-dock/%E0%A4%A", "not a url", "app://agent-dock/a%00b"]) {
      expect(resolveAppPath(root, bad), bad).toBeNull();
    }
  });
});

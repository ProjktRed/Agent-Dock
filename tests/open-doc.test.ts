import { describe, expect, it } from "vitest";
import { openDoc } from "../src/renderer/src/lib/open-doc";

describe("Settings › Help guide links", () => {
  const run = async (openPath: (target: string) => Promise<string>) => {
    const opened: string[] = [];
    await openDoc(openPath, "C:\\app\\docs\\user-guide.md", "https://github.com/x/docs/user-guide.md", (url) => opened.push(url));
    return opened;
  };

  it("uses the bundled guide when it opens", async () => {
    expect(await run(async () => "")).toEqual([]);
  });

  it("falls back to GitHub when Windows has no app for .md, the file is missing or the path is refused", async () => {
    expect(await run(async () => "There is no application associated with the given file name extension.")).toEqual(["https://github.com/x/docs/user-guide.md"]);
    expect(await run(async () => { throw new Error("This path cannot be opened from Agent Dock."); })).toEqual(["https://github.com/x/docs/user-guide.md"]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { openDashboard } from "../src/open-dashboard.mjs";

test("Windows dashboard launch opens the local URL without a visible shell", () => {
  let launch;
  let unrefCalled = false;
  const child = {
    on: () => child,
    unref: () => { unrefCalled = true; },
  };
  openDashboard("http://127.0.0.1:4180", {
    platform: "win32",
    spawnProcess: (command, args, options) => {
      launch = { command, args, options };
      return child;
    },
  });

  assert.deepEqual(launch, {
    command: "explorer.exe",
    args: ["http://127.0.0.1:4180"],
    options: { detached: true, windowsHide: true, stdio: "ignore" },
  });
  assert.equal(unrefCalled, true);
});

// Defensive review (0.38.1): the sign-in token was on explorer.exe's / xdg-open's command line.
test("a signed-in dashboard link goes through a private launch page, never a command line", async (t) => {
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-launch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let launch;
  const child = { on: () => child, unref: () => {} };
  const page = openDashboard("http://127.0.0.1:4180/#token=SECRET_TOKEN", { platform: "linux", launchDir: dir, spawnProcess: (command, args) => { launch = { command, args }; return child; } });
  assert.equal(launch.command, "xdg-open");
  assert.deepEqual(launch.args, [page]);
  assert.doesNotMatch(launch.args.join(" "), /SECRET_TOKEN/);
  assert.match(await readFile(page, "utf8"), /location\.replace\("http:\/\/127\.0\.0\.1:4180\/#token=SECRET_TOKEN"\)/);
  if (process.platform !== "win32") assert.equal((await stat(page)).mode & 0o777, 0o600);
});

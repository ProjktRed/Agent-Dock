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

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cmdLine, resolveProgram } from "../src/main/lib/cmd-line";
import { gitCommonDir, ownerFixCommand } from "../src/main/lib/git";
import { renameWithRetry } from "../src/main/lib/json-file";
import { managedProjectFolder } from "../src/main/projects";
import { DEFAULT_SETTINGS, TOOL_CONFIG_PATHS, upgradeSafety } from "../src/shared/defaults";

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const SID = "S-1-5-21-1000-2000-3000-1001";

describe("tool lookup", () => {
  it.runIf(process.platform === "win32")("resolves programs from PATH only, not from the current folder", async () => {
    const dir = tmp("tool-lookup-");
    const before = process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path.join(dir, "git.exe"));
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      await import("../src/main/lib/tool-lookup");
      expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe("1");
      expect(execFileSync("cmd.exe", ["/d", "/s", "/c", "git --version"], { cwd: dir, encoding: "utf8" })).toMatch(/git version/);
    } finally {
      if (before === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath; else process.env.NoDefaultCurrentDirectoryInExePath = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared .git folder owner fix", () => {
  const repo = (root: string, name: string) => {
    const dir = path.join(root, name, ".git");
    mkdirSync(path.join(dir, "objects"), { recursive: true });
    writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
    return dir;
  };

  it("accepts only a local repository folder with HEAD and objects", () => {
    const root = tmp("gitdir-check-");
    try {
      expect(gitCommonDir(path.join(root, "x"))).toBeNull();
      const real = repo(root, "real");
      expect(gitCommonDir(path.dirname(real))).toBe(real);
      const pointing = (name: string, target: string) => {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, ".git"), `gitdir: ${target}\n`);
        return path.join(root, name);
      };
      mkdirSync(path.join(root, "empty"));
      expect(gitCommonDir(pointing("to-empty", path.join(root, "empty")))).toBeNull();
      expect(gitCommonDir(pointing("to-share", "\\\\server\\share\\repo.git"))).toBeNull();
      expect(gitCommonDir(pointing("to-real", real))).toBe(real);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quotes the folder as a PowerShell literal and gives no command for names it cannot carry", () => {
    const problem = (dir: string, sid = SID) => ({ dir, owner: "o", user: "u", sid });
    expect(ownerFixCommand(problem("C:\\Users\\Ann O'Neil\\repo\\.git"))).toBe(`icacls 'C:\\Users\\Ann O''Neil\\repo\\.git' /setowner '*${SID}' /T /C`);
    expect(ownerFixCommand(problem("C:\\a\u2019b\\.git"))).toBe(`icacls 'C:\\a\u2019\u2019b\\.git' /setowner '*${SID}' /T /C`);
    for (const dir of ["C:\\a$b\\.git", "C:\\a`b\\.git", "C:\\a;b\\.git", "C:\\a\nb\\.git"]) expect(ownerFixCommand(problem(dir))).toBeNull();
    expect(ownerFixCommand(problem("C:\\repo\\.git", "S-1-5' x"))).toBeNull();
  });
});

describe("cmd.exe command lines", () => {
  it("quotes and escapes every argument, twice for a batch file", () => {
    expect(cmdLine("C:\\bin\\tool.exe", ["a&b", "50%"])).toBe('^"C:\\bin\\tool.exe^" ^"a^&b^" ^"50^%^"');
    expect(cmdLine("C:\\bin\\tool.cmd", ["a&b"])).toBe('^"C:\\bin\\tool.cmd^" ^^^"a^^^&b^^^"');
    expect(() => cmdLine("tool", ["a&b"])).toThrow(/cannot pass/i);
    expect(() => cmdLine("C:\\bin\\tool.exe", ["a\r\nb"])).toThrow(/line break/);
  });

  it.runIf(process.platform === "win32")("passes arguments through cmd.exe unchanged", () => {
    const root = tmp("cmd-line-");
    try {
      const script = path.join(root, "print.js");
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      writeFileSync(path.join(root, "print.cmd"), `@"${process.execPath}" "%~dp0print.js" %*\r\n`);
      const args = ["a&b", "x y", "100%", "!v!", "p|q", "& echo MARKER", 'k="v"'];
      for (const [program, extra] of [[process.execPath, [script]], [path.join(root, "print.cmd"), []]] as const) {
        const out = spawnSync(cmdLine(program, [...extra, ...args]), { shell: true, encoding: "utf8" });
        expect(JSON.parse(out.stdout)).toEqual(args);
      }
      expect(resolveProgram("print", { PATH: root, PATHEXT: ".EXE;.CMD" }).toLowerCase()).toBe(path.join(root, "print.cmd").toLowerCase());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("project state removal", () => {
  it("deletes only a project folder strictly inside the app's state root", () => {
    const root = path.resolve("C:\\dock\\projects");
    expect(managedProjectFolder(root, path.join(root, "p1", "state"))).toBe(path.join(root, "p1"));
    expect(managedProjectFolder(root, path.join(root, "state"))).toBeNull();
    expect(managedProjectFolder(root, path.resolve("C:\\dock\\projects-other\\p1\\state"))).toBeNull();
    expect(managedProjectFolder(root, path.resolve("C:\\dock\\projects\\..\\x\\state"))).toBeNull();
    expect(managedProjectFolder(root, path.resolve("D:\\elsewhere\\state"))).toBeNull();
  });
});

describe("default protected paths", () => {
  it("protect tool configuration folders, added once to older settings without removing anything", () => {
    expect(DEFAULT_SETTINGS.safety.protectedPaths).toEqual(expect.arrayContaining([".git/", ...TOOL_CONFIG_PATHS]));
    const older = upgradeSafety({ protectedPaths: [".env*", "mine/", ".vscode/"] });
    expect(older.protectedPaths).toEqual([".env*", "mine/", ".vscode/", ...TOOL_CONFIG_PATHS.filter((p) => p !== ".vscode/")]);
    expect(upgradeSafety({ protectedPaths: ["mine/"], toolConfigPathsAdded: true }).protectedPaths).toEqual(["mine/"]);
    expect(upgradeSafety(undefined)).toEqual(DEFAULT_SETTINGS.safety);
  });
});

describe("atomic JSON writes", () => {
  it("retry a locked target for about five seconds", async () => {
    let calls = 0;
    const locked = Object.assign(new Error("locked"), { code: "EPERM" });
    await renameWithRetry("a", "b", { budgetMs: 40, renameImpl: async () => { if (++calls < 3) throw locked; } });
    expect(calls).toBe(3);
    const started = Date.now();
    await expect(renameWithRetry("a", "b", { budgetMs: 100, renameImpl: async () => { throw locked; } })).rejects.toThrow("locked");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

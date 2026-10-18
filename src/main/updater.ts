import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BuildInfo, Settings, UpdateStatus } from "@shared/types";
import { run } from "./lib/git";
import { LOG_FORMAT, parseLog, parseLsRemote } from "./updater-parse";
import { checkRelease, downloadRelease, extractRelease, launchSwap, type ReleaseInfo } from "./release-channel";
import { RELEASE_PUBLIC_KEY } from "./release-key";

// The update workspace sits next to the installed app: <root>\App\AgentDock.exe → <root>\Updates.
export const STAGING = path.join(path.dirname(path.dirname(process.execPath)), "Updates");
const REPO = path.join(STAGING, "repo");
const MAX_LOG = 400;


/**
 * Self-update from a git source. Works with a local repository path today and a GitHub URL later.
 * Only committed history is used: the build happens in a clean clone, never in the developer's working tree.
 */
export class Updater {
  status: UpdateStatus;
  private building = false;
  private muted = false;
  private release: ReleaseInfo | null = null;

  constructor(
    private readonly packaged: boolean,
    private readonly installed: BuildInfo | null,
    private readonly emit: (status: UpdateStatus) => void,
    private readonly resolveNode: () => Promise<string | null>,
    /** A portable copy (portable.json) with updates off: never checks, builds or swaps. */
    private readonly portableNoUpdates = false,
    /** The installed version (package.json); the signed release channel only installs newer ones. */
    private readonly appVersion = "0.0.0",
    private readonly releaseKey = RELEASE_PUBLIC_KEY,
  ) {
    this.status = { state: portableNoUpdates ? "portable" : installed && packaged ? "idle" : "dev", installed, source: installed?.source ?? "", branch: installed?.branch ?? "", latest: null, commits: [], checkedAt: null, error: null, log: [] };
  }

  static async readBuildInfo(appPath: string): Promise<BuildInfo | null> {
    try {
      return JSON.parse(await readFile(path.join(appPath, "build-info.json"), "utf8")) as BuildInfo;
    } catch {
      return null;
    }
  }

  /** Surface a swap that failed after the previous app instance exited (written by release-local.mjs). */
  async readLastSwap(): Promise<void> {
    if (!this.packaged || !this.installed) return;
    try {
      const last = JSON.parse(await readFile(path.join(STAGING, "last-swap.json"), "utf8")) as { ok: boolean; error?: string; at: string };
      if (!last.ok && last.at > this.installed.builtAt) this.set({ state: "error", error: `The last update could not be installed: ${last.error}` });
    } catch {
      // no previous swap
    }
  }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    if (!this.muted) this.emit(this.status);
  }

  private append(text: string) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return;
    this.set({ log: [...this.status.log, ...lines].slice(-MAX_LOG) });
  }

  private target(settings: Settings) {
    return {
      source: settings.updates.source.trim() || this.installed?.source || "",
      branch: settings.updates.branch.trim() || this.installed?.branch || "master",
    };
  }

  /** True while a build or swap is in progress; background checks are skipped then. */
  get busy(): boolean {
    return this.building || this.status.state === "checking" || this.status.state === "building" || this.status.state === "ready";
  }

  /**
   * Quiet checks (timer, window focus) never replace the shown status with an error: when the
   * source cannot be reached (offline), the previous status stays and the next check tries again.
   */
  async check(settings: Settings, { quiet = false } = {}): Promise<UpdateStatus> {
    if (!quiet) return this.probe(settings, false);
    // Quiet: intermediate states are not shown; only the outcome is, and an error keeps the previous status.
    const previous = this.status;
    this.muted = true;
    try {
      await this.probe(settings, true);
    } finally {
      this.muted = false;
    }
    if (this.status.state === "error") this.status = previous;
    this.emit(this.status);
    return this.status;
  }

  private async probe(settings: Settings, quiet: boolean): Promise<UpdateStatus> {
    const { source, branch } = this.target(settings);
    if (this.portableNoUpdates) return this.status;
    if (!this.packaged || !this.installed) {
      this.set({ state: "dev", source, branch, error: null });
      return this.status;
    }
    if (settings.updates.channel === "release") return this.probeRelease(settings, quiet);
    if (!source) {
      this.set({ state: "error", error: "No update source configured." });
      return this.status;
    }
    // A quiet check keeps the current status (and any update notice) visible while it runs.
    if (!quiet) this.set({ state: "checking", source, branch, error: null });
    const remote = await run("git", ["ls-remote", source, `refs/heads/${branch}`], { timeoutMs: 60_000 });
    const latest = remote.code === 0 ? parseLsRemote(remote.stdout, branch) : null;
    if (!latest) {
      this.set({ state: "error", checkedAt: new Date().toISOString(), error: remote.code === 0 ? `Branch “${branch}” not found in ${source}` : `Could not read ${source}: ${remote.stderr.trim().split(/\r?\n/).pop()}` });
      return this.status;
    }
    if (latest === this.installed.commit) {
      this.set({ state: "up-to-date", latest: { commit: latest, subject: this.installed.subject }, commits: [], checkedAt: new Date().toISOString() });
      return this.status;
    }
    // Fetch into the staging clone to list what changed (cheap for a local source).
    const commits = await this.listCommits(source, branch, latest);
    const version = await this.versionAt(latest);
    this.set({ state: "available", latest: { commit: latest, subject: commits[0]?.subject ?? "", version }, commits, checkedAt: new Date().toISOString() });
    return this.status;
  }

  private async listCommits(source: string, branch: string, latest: string): Promise<UpdateStatus["commits"]> {
    mkdirSync(STAGING, { recursive: true });
    if (!existsSync(path.join(REPO, ".git"))) {
      const clone = await run("git", ["clone", "--no-checkout", source, REPO], { timeoutMs: 10 * 60_000 });
      if (clone.code !== 0) return [];
    } else {
      await run("git", ["remote", "set-url", "origin", source], { cwd: REPO });
    }
    await run("git", ["fetch", "--force", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: REPO, timeoutMs: 10 * 60_000 });
    const known = await run("git", ["cat-file", "-e", `${this.installed!.commit}^{commit}`], { cwd: REPO });
    const range = known.code === 0 ? `${this.installed!.commit}..${latest}` : `-20 ${latest}`;
    const logResult = await run("git", ["log", LOG_FORMAT, ...range.split(" ")], { cwd: REPO });
    return logResult.code === 0 ? parseLog(logResult.stdout) : [];
  }

  /** Signed release channel: the newest GitHub Release, verified against the built-in release key. */
  private async probeRelease(settings: Settings, quiet: boolean): Promise<UpdateStatus> {
    const repo = settings.updates.releaseRepo?.trim() || "ProjktRed/Agent-Dock";
    if (!quiet) this.set({ state: "checking", source: `github.com/${repo} (signed releases)`, branch: "", error: null });
    try {
      this.release = await checkRelease(repo, this.appVersion, this.releaseKey);
    } catch (error) {
      this.release = null;
      this.set({ state: "error", checkedAt: new Date().toISOString(), error: (error as Error).message });
      return this.status;
    }
    if (!this.release) {
      this.set({ state: "up-to-date", latest: { commit: this.installed!.commit, subject: this.installed!.subject }, commits: [], checkedAt: new Date().toISOString() });
      return this.status;
    }
    const m = this.release.manifest;
    this.set({ state: "available", latest: { commit: m.commit, subject: `Signed release ${m.version}`, version: m.version }, commits: [{ hash: m.commit, subject: this.release.notes.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? `Release ${m.version}`, date: m.builtAt, body: this.release.notes.slice(0, 4000) }], checkedAt: new Date().toISOString() });
    return this.status;
  }

  /** Download, verify, extract and hand off to the new app's swap; no Node.js or git needed. */
  private async applyRelease(onReadyToQuit: () => void): Promise<void> {
    const info = this.release!;
    this.building = true;
    this.set({ state: "building", log: [], error: null });
    try {
      const dir = path.join(STAGING, "release");
      this.append(`Downloading ${info.manifest.file} (${Math.round(info.manifest.size / 1048576)} MB)…`);
      const zip = await downloadRelease(info, dir);
      this.append(`Signature and SHA-256 verified (${info.manifest.sha256.slice(0, 16)}…).`);
      const unpacked = await extractRelease(zip, path.join(dir, info.manifest.version));
      this.append(`Extracted to ${unpacked}.`);
      this.set({ state: "ready" });
      const fd = openSync(path.join(STAGING, "swap.log"), "a");
      try { launchSwap({ unpacked, installDir: path.dirname(process.execPath), waitPid: process.pid, resultFile: path.join(STAGING, "last-swap.json"), logFd: fd }); }
      finally { closeSync(fd); }
      onReadyToQuit();
    } catch (error) {
      this.set({ state: "error", error: (error as Error).message });
      throw error;
    } finally {
      this.building = false;
    }
  }

  /** package.json version at a commit already fetched into the staging clone. */
  private async versionAt(commit: string): Promise<string | null> {
    const shown = await run("git", ["show", `${commit}:package.json`], { cwd: REPO });
    if (shown.code !== 0) return null;
    try {
      return JSON.parse(shown.stdout).version ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Build the new version in the staging clone (the app keeps running), then hand off to the
   * swap stage, which waits for this process to exit, replaces the files and relaunches.
   */
  async apply(settings: Settings, onReadyToQuit: () => void): Promise<void> {
    if (!this.packaged || !this.installed) throw new Error("Updates apply to the installed app only.");
    if (this.building) throw new Error("An update is already being built.");
    if (this.status.state !== "available" || !this.status.latest) throw new Error("No update available. Check for updates first.");
    if (settings.updates.channel === "release") {
      if (!this.release) throw new Error("No verified release. Check for updates first.");
      return this.applyRelease(onReadyToQuit);
    }
    const node = await this.resolveNode();
    if (!node) throw new Error("Building an update needs Node.js and npm on PATH.");
    const { source, branch } = this.target(settings);
    const commit = this.status.latest.commit;
    this.building = true;
    this.set({ state: "building", log: [], error: null });
    try {
      // Check out the target commit first, then run that commit's own release script.
      for (const args of [
        ["fetch", "--force", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        ["checkout", "--force", "--detach", commit],
        ["clean", "-ffdx", "-e", "node_modules"],
      ]) {
        this.append(`$ git ${args.join(" ")}`);
        const r = await run("git", args, { cwd: REPO, timeoutMs: 10 * 60_000 });
        if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
      }
      const script = path.join(REPO, "scripts", "release-local.mjs");
      if (!existsSync(script)) throw new Error("The new version has no scripts/release-local.mjs; it cannot be built automatically.");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, [script, "--stage", "build", "--skip-checkout", "--source", source, "--branch", branch, "--staging", STAGING], { cwd: REPO, windowsHide: true });
        child.stdout.on("data", (d) => this.append(String(d)));
        child.stderr.on("data", (d) => this.append(String(d)));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code}). See the log.`))));
      });
      this.set({ state: "ready" });
      const installDir = path.dirname(process.execPath);
      const logFile = path.join(STAGING, "swap.log");
      const fd = openSync(logFile, "a");
      try {
        spawn(node, [script, "--stage", "swap", "--from", path.join(STAGING, "dist", "win-unpacked"), "--install-dir", installDir, "--wait-pid", String(process.pid), "--relaunch"], {
          cwd: STAGING,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", fd, fd],
        }).unref();
      } finally {
        closeSync(fd);
      }
      onReadyToQuit();
    } catch (error) {
      this.set({ state: "error", error: (error as Error).message });
      throw error;
    } finally {
      this.building = false;
    }
  }
}

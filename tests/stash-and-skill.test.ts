import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliConnection, Project } from "@shared/types";
import { deriveBoard, orderWithFirst } from "@shared/task-board";
import { dropStash, isAgentDockStash, listStashes, parseStashList, popStash, stashChanges } from "../src/main/lib/stash";
import { buildSkillPrompt, cleanSkillText, generateProjectSkill, projectSkillDelivery, projectSkillName, readProjectSkill, saveProjectSkill, skillTextProblem } from "../src/main/project-skill";
import { buildEngineArgs } from "../src/main/lib/engine-args";
import { DEFAULT_SETTINGS } from "@shared/defaults";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async (prefix: string) => { const d = await mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repo() {
  const dir = await tmp("stash-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  await writeFile(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

describe("Overview stash and pop", () => {
  it("stashes tracked and untracked changes, leaves the state folder, and pops them back", async () => {
    const dir = await repo();
    const state = path.join(dir, ".agent-dock-state");
    await mkdir(state);
    await writeFile(path.join(state, "live.json"), "{}");
    await writeFile(path.join(dir, "a.txt"), "two\n");
    await writeFile(path.join(dir, "new.txt"), "new\n");
    const { message } = await stashChanges(dir, state, new Date("2026-10-27T06:30:00Z"));
    expect(message).toBe("Agent Dock: stashed by you 2026-10-27 06:30 UTC");
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(path.join(dir, "new.txt"))).toBe(false);
    expect(existsSync(path.join(state, "live.json"))).toBe(true);
    const [entry] = await listStashes(dir);
    expect(entry).toMatchObject({ ref: "stash@{0}", message: expect.stringContaining(message), agentDock: true });
    await expect(stashChanges(dir, state)).rejects.toThrow(/no uncommitted changes/);

    const popped = await popStash(dir, state, entry.sha);
    expect(popped.conflicts).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("two\n");
    expect(await readFile(path.join(dir, "new.txt"), "utf8")).toBe("new\n");
    expect(await listStashes(dir)).toEqual([]);
  });

  it("pops by commit, not by index, and refuses on uncommitted changes or a stash that is gone", async () => {
    const dir = await repo();
    await writeFile(path.join(dir, "a.txt"), "first\n");
    git(dir, "stash", "push", "-m", "first");
    await writeFile(path.join(dir, "a.txt"), "second\n");
    git(dir, "stash", "push", "-m", "second");
    const first = (await listStashes(dir)).find((s) => s.message.endsWith("first"))!;
    expect(first.ref).toBe("stash@{1}");
    await writeFile(path.join(dir, "dirty.txt"), "x");
    await expect(popStash(dir, dir, first.sha)).rejects.toThrow(/uncommitted changes/);
    await rm(path.join(dir, "dirty.txt"));
    expect((await popStash(dir, dir, first.sha)).conflicts).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("first\n");
    expect((await listStashes(dir)).map((s) => s.message.replace(/^On \w+: /, ""))).toEqual(["second"]);
    await expect(popStash(dir, dir, first.sha)).rejects.toThrow(/gone/);
  });

  it("deletes a stash by commit and leaves the others", async () => {
    const dir = await repo();
    for (const text of ["keep", "drop"]) { await writeFile(path.join(dir, "a.txt"), `${text}\n`); git(dir, "stash", "push", "-m", text); }
    const [dropped, kept] = await listStashes(dir);
    expect(dropped.message).toMatch(/drop$/);
    await dropStash(dir, dropped.sha);
    expect((await listStashes(dir)).map((s) => s.sha)).toEqual([kept.sha]);
    await expect(dropStash(dir, dropped.sha)).rejects.toThrow(/gone/);
  });

  it("reads the list and tells Agent Dock's stashes from others", () => {
    const list = parseStashList("stash@{0}\x1fabc\x1fOn main: Agent Dock: deferred t1 - Set aside by you\x1f2026-10-26T02:19:53-06:00\nstash@{1}\x1fdef\x1fWIP on main: 1234 msg\x1f\n");
    expect(list).toEqual([
      { ref: "stash@{0}", sha: "abc", message: "On main: Agent Dock: deferred t1 - Set aside by you", at: "2026-10-26T02:19:53-06:00", agentDock: true },
      { ref: "stash@{1}", sha: "def", message: "WIP on main: 1234 msg", at: null, agentDock: false },
    ]);
    expect(isAgentDockStash("Agent Dock: stashed by you")).toBe(true);
    expect(isAgentDockStash("my Agent Dock: notes")).toBe(false);
  });
});

describe("Do next and set-aside tasks on the Task board", () => {
  const items = [
    { id: "aaaaaaaaaaaa", phase: { number: 1, title: "One" }, title: "First", depth: 0, completed: false, ordinal: 0, ambiguous: false },
    { id: "bbbbbbbbbbbb", phase: { number: 1, title: "One" }, title: "Second", depth: 0, completed: false, ordinal: 0, ambiguous: false },
    { id: "cccccccccccc", phase: { number: 2, title: "Two" }, title: "Third", depth: 0, completed: false, ordinal: 0, ambiguous: false },
  ];
  it("lists every set-aside task with its plan items, stash and whether it can run next", () => {
    const board = deriveBoard({
      items, order: [], revision: 3, groupByPhase: true,
      deferred: [
        { id: "t-third", name: "Third task", reason: "Set aside by you", planItems: ["Third"], at: "2026-10-26T00:00:00Z", stash: { message: "Agent Dock: deferred t-third" } },
        { id: "t-rust", reason: "Set aside by you", stash: null },
      ],
      rerunnable: new Set(["t-rust"]),
    });
    expect(board.deferred).toEqual([
      { id: "t-third", name: "Third task", reason: "Set aside by you", at: "2026-10-26T00:00:00Z", stash: "Agent Dock: deferred t-third", planItemIds: ["cccccccccccc"], rerunnable: false },
      { id: "t-rust", name: "t-rust", reason: "Set aside by you", at: null, stash: null, planItemIds: [], rerunnable: true },
    ]);
    expect(board.items.find((i) => i.id === "cccccccccccc")!.activity).toEqual([{ kind: "deferred", taskId: "t-third", name: "Third task", detail: "Set aside by you" }]);
  });

  it("puts an item first of the whole order, across phases, keeping the rest in order", () => {
    const board = deriveBoard({ items, order: ["bbbbbbbbbbbb", "aaaaaaaaaaaa", "cccccccccccc"], revision: 0, groupByPhase: true });
    expect(orderWithFirst(board, "cccccccccccc")).toEqual(["cccccccccccc", "bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect(orderWithFirst(board, "bbbbbbbbbbbb")).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa", "cccccccccccc"]);
  });
});

const SKILL = "---\nname: whatever\ndescription: GCB is a Tauri app; use for any change in it.\n---\n\n# GCB\n## Commands\n- `pnpm test`\n";

describe("project skill", () => {
  it("names the skill after the project and asks for a read-only, project-specific file", () => {
    expect(projectSkillName("GCB")).toBe("project-gcb");
    expect(projectSkillName("Café Tools 2!")).toBe("project-cafe-tools-2");
    expect(projectSkillName("???")).toBe("project-workspace");
    const prompt = buildSkillPrompt("GCB", null);
    expect(prompt).toContain("name: project-gcb");
    expect(prompt).toContain("Do not edit, create or delete any file.");
    expect(buildSkillPrompt("GCB", "Files (1):\na.ts")).toContain("Workspace summary:\nFiles (1):\na.ts");
  });

  it("strips fences and chatter, sets the name, and says what is missing", () => {
    const cleaned = cleanSkillText(`Here it is:\n\`\`\`markdown\n${SKILL}\`\`\`\nDone.`, "GCB");
    expect(cleaned.startsWith("---\nname: project-gcb\ndescription: GCB is a Tauri app")).toBe(true);
    expect(skillTextProblem(cleaned)).toBeNull();
    expect(skillTextProblem("# GCB\n- x")).toMatch(/front matter/);
    expect(skillTextProblem("---\nname: a\n---\nbody")).toMatch(/description/);
    expect(skillTextProblem("---\nname: a\ndescription: b\n---\n")).toMatch(/no instructions/);
  });

  it("retries once with the problem, then gives the cleaned skill", async () => {
    const answers = ["I could not decide.", SKILL];
    const prompts: string[] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      prompts.push(JSON.parse(init.body).messages[0].content);
      const content = answers.shift() ?? "";
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content };
    };
    const dir = await tmp("skill-ws-");
    await writeFile(path.join(dir, "package.json"), '{"scripts":{"test":"vitest"}}');
    const text = await generateProjectSkill(dir, "GCB", { connection: { id: "l", kind: "ollama", name: "Local", location: "http://127.0.0.1:11434" } as CliConnection, model: "m", apiKey: null }, new AbortController().signal, fetchImpl);
    expect(text).toContain("name: project-gcb");
    expect(prompts[0]).toContain('package.json:\n{"scripts":{"test":"vitest"}}');
    expect(prompts[1]).toContain("Your previous answer could not be used: The skill needs a front matter block");
  });

  it("saves in the state folder, delivers only when on, and removes", async () => {
    const state = await tmp("skill-state-");
    expect(await readProjectSkill(state, true)).toMatchObject({ text: null, enabled: false });
    await expect(saveProjectSkill(state, "no front matter")).rejects.toThrow(/front matter/);
    await saveProjectSkill(state, cleanSkillText(SKILL, "GCB"));
    expect((await readProjectSkill(state, true)).enabled).toBe(true);
    expect(await projectSkillDelivery(state, false)).toBeNull();
    expect(await projectSkillDelivery(state, true)).toEqual({ name: "project-gcb", instructions: "# GCB\n## Commands\n- `pnpm test`" });
    await saveProjectSkill(state, null);
    expect(await projectSkillDelivery(state, true)).toBeNull();
  });

  it("makes the engine read the skills file when the project skill is on", () => {
    const project = { id: "p", name: "GCB", path: "C:\\w", stateDir: "C:\\s", repoUrl: null, objective: "o", description: "", createdAt: "", archived: false, roleOverrides: {}, workflowOverrides: {} } as Project;
    const settings = structuredClone(DEFAULT_SETTINGS);
    const args = (p: Project) => buildEngineArgs({ project: p, agents: [], clis: [], settings, roles: [], protectedRoots: [] }).args;
    expect(args(project)).not.toContain("--skills-file");
    expect(args({ ...project, projectSkill: true })).toContain("--skills-file");
  });
});

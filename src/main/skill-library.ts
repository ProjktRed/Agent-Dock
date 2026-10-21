import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryPreview, LibrarySkillPreview, SkillFinding } from "@shared/types";
import { parseSkillFile } from "./skills";

/** Libraries offered in Settings › Skills; any other GitHub repository imports behind a warning. */
export const TRUSTED_LIBRARIES = [
  { owner: "anthropics", repo: "skills", label: "Anthropic skills", url: "https://github.com/anthropics/skills/tree/main/skills" },
  { owner: "openai", repo: "skills", label: "OpenAI skills", url: "https://github.com/openai/skills/tree/main/skills/.curated" },
];

// Only text is imported. Scripts and binaries are listed as skipped: Agent Dock never runs skill files.
const TEXT_FILE = /\.(md|txt|json|ya?ml|csv)$|(^|\/)(LICENSE|NOTICE|COPYING)[^/]*$/i;
// MAX_SKILLS: shown and downloaded at once; larger libraries are listed first. MAX_REVIEW: chosen from a list.
const MAX_SKILLS = 25, MAX_REVIEW = 60, MAX_REVIEW_BYTES = 20_000_000, MAX_FILES_PER_SKILL = 60, MAX_FILE_BYTES = 200_000, MAX_SKILL_BYTES = 1_000_000;

export interface GitHubSource { owner: string; repo: string; ref: string | null; path: string }

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** github.com/<owner>/<repo>[/tree|blob/<ref>[/<path>]]; refs containing "/" are not supported. */
export function parseGitHubUrl(input: string): GitHubSource {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Enter a GitHub URL, e.g. https://github.com/anthropics/skills/tree/main/skills/pdf"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("Only https://github.com URLs can be imported.");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repo, kind, ref, ...rest] = parts;
  const name = /^[\w.-]{1,100}$/;
  if (!owner || !repo || !name.test(owner) || !name.test(repo.replace(/\.git$/, ""))) throw new Error("The URL must name a GitHub owner and repository.");
  if (kind && !["tree", "blob"].includes(kind)) throw new Error("Use a repository, folder (tree) or SKILL.md (blob) URL.");
  if (kind && (!ref || !/^[\w.-]{1,100}$/.test(ref))) throw new Error("The branch, tag or commit in the URL is not supported.");
  let folder = rest.join("/");
  if (kind === "blob") {
    if (!/(^|\/)SKILL\.md$/.test(folder)) throw new Error("A file URL must point at a SKILL.md.");
    folder = folder.replace(/\/?SKILL\.md$/, "");
  }
  if (folder.split("/").some((p) => p === ".." || p === "")) folder = folder.split("/").filter((p) => p && p !== "..").join("/");
  return { owner, repo: repo.replace(/\.git$/, ""), ref: ref ?? null, path: folder };
}

const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const RISKS: [RegExp, string][] = [
  [/\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python|node)\b/i, "Downloads a script and runs it directly."],
  [/\b(invoke-expression|iex)\s*[(\s]/i, "Runs PowerShell code built at run time (Invoke-Expression)."],
  [/ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules)/i, "Tells the agent to ignore its other instructions."],
  [/(^|[\s"'`/\\])(\.env\b|id_rsa|id_ed25519|\.aws\/credentials|\.ssh\/|\.npmrc|\.netrc)/i, "Mentions secret or credential files."],
  [/\b(disable|bypass|turn off|skip)\s+(the\s+)?(guard|sandbox|hooks?|permission|safety|protect)/i, "Asks to disable a safety mechanism."],
  [/--dangerously|--no-verify|\bpush\s+(-f|--force)\b|rm\s+-rf\s+[/~]/i, "Uses a destructive or safety-skipping command option."],
  [/[A-Za-z0-9+/]{240,}={0,2}/, "Contains a long encoded (base64-like) block."],
  [/\b(send|upload|post|exfiltrate)\b[^\n]{0,60}\b(to|into)\b[^\n]{0,40}https?:\/\//i, "Sends data to a web address."],
];

/** Hidden or direction-changing characters block an import; risky instructions are warnings to review. */
export function scanSkillFiles(files: { path: string; text: string }[], trusted: boolean): SkillFinding[] {
  const findings: SkillFinding[] = [];
  if (!trusted) findings.push({ level: "warn", file: "", message: "Not from a trusted library. Read every file before importing." });
  for (const file of files) {
    const text = file.text.replace(/^﻿/, "");
    if (HIDDEN.test(text)) findings.push({ level: "block", file: file.path, message: "Contains hidden or text-direction characters that can disguise instructions." });
    for (const [pattern, message] of RISKS) if (pattern.test(text)) findings.push({ level: "warn", file: file.path, message });
  }
  return findings;
}

interface Pending { preview: LibraryPreview; contents: Map<string, { path: string; text: string }[]>; created: number }
const pending = new Map<string, Pending>();

async function getJson(fetchImpl: Fetch, url: string) {
  const res = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Agent-Dock" } });
  if (res.status === 404) throw new Error("Repository, branch or folder not found (private repositories are not supported).");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub's rate limit was reached. Try again in an hour.");
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
  return res.json();
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

/**
 * Resolves the URL to one commit, downloads the text files of every skill under it, and scans them. Nothing is written.
 * A library with more than 25 skills is listed first (browse: names only, no downloads); review then passes the chosen
 * folders as `only`, with the preview URL so the same commit is used.
 */
export async function previewLibraryImport(input: string, fetchImpl: Fetch = fetch as unknown as Fetch, only?: string[]): Promise<LibraryPreview> {
  const source = parseGitHubUrl(input);
  const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const ref = source.ref ?? (await getJson(fetchImpl, api)).default_branch;
  const commit: string = (await getJson(fetchImpl, `${api}/commits/${encodeURIComponent(ref)}`)).sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub did not return a commit for that branch.");
  const tree = await getJson(fetchImpl, `${api}/git/trees/${commit}?recursive=1`);
  if (tree.truncated) throw new Error("This repository is too large to browse. Use a URL to a specific skill folder.");
  const blobs: { path: string; size: number }[] = tree.tree.filter((e: any) => e.type === "blob").map((e: any) => ({ path: e.path, size: e.size }));
  const prefix = source.path ? source.path + "/" : "";
  const skillDirs = blobs.map((b) => b.path).filter((p) => (p === prefix + "SKILL.md" || p.startsWith(prefix)) && /(^|\/)SKILL\.md$/.test(p))
    .map((p) => p.replace(/\/?SKILL\.md$/, "")).sort();
  if (!skillDirs.length) throw new Error("No SKILL.md found at that location.");
  const trusted = TRUSTED_LIBRARIES.some((l) => l.owner === source.owner.toLowerCase() && l.repo === source.repo.toLowerCase());
  const url = `https://github.com/${source.owner}/${source.repo}/tree/${commit}/${source.path}`;
  if (!only && skillDirs.length > MAX_SKILLS) {
    return { token: "", owner: source.owner, repo: source.repo, commit, url, trusted, browse: true,
      skills: skillDirs.map((dir) => ({ name: path.posix.basename(dir || source.repo), description: "", path: dir, files: [], skipped: [], findings: [] })) };
  }
  if (only) {
    if (!only.length || only.length > MAX_REVIEW) throw new Error(`Choose 1 to ${MAX_REVIEW} skills to review.`);
    const unknown = only.filter((dir) => !skillDirs.includes(dir));
    if (unknown.length) throw new Error(`Not a skill folder in this library: ${unknown.join(", ")}`);
  }
  const reviewDirs = only ? skillDirs.filter((dir) => only.includes(dir)) : skillDirs;
  const contents = new Map<string, { path: string; text: string }[]>();
  const skills: LibrarySkillPreview[] = [];
  let downloaded = 0;
  for (const dir of reviewDirs) {
    const inner = (p: string) => dir ? p.startsWith(dir + "/") : true;
    // Nested skills belong to their own folder.
    const own = blobs.filter((b) => inner(b.path) && !skillDirs.some((d) => d !== dir && d.startsWith(dir ? dir + "/" : "") && b.path.startsWith(d + "/")));
    const rel = (p: string) => dir ? p.slice(dir.length + 1) : p;
    const skipped: { path: string; reason: string }[] = [];
    let total = 0;
    const wanted = own.filter((b) => {
      if (!TEXT_FILE.test(b.path)) { skipped.push({ path: rel(b.path), reason: "not a text file (scripts and binaries are not imported)" }); return false; }
      if (b.size > MAX_FILE_BYTES) { skipped.push({ path: rel(b.path), reason: "larger than 200 KB" }); return false; }
      if (total + b.size > MAX_SKILL_BYTES) { skipped.push({ path: rel(b.path), reason: "skill is over 1 MB" }); return false; }
      total += b.size; return true;
    }).slice(0, MAX_FILES_PER_SKILL);
    downloaded += wanted.reduce((sum, b) => sum + b.size, 0);
    if (downloaded > MAX_REVIEW_BYTES) throw new Error("The chosen skills are over 20 MB together; choose fewer.");
    const files = await inBatches(wanted, 6, async (b) => {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}/${b.path.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok) throw new Error(`Could not download ${b.path} (${res.status}).`);
      return { path: rel(b.path), text: await res.text() };
    });
    const skillFile = files.find((f) => f.path === "SKILL.md");
    if (!skillFile) continue;
    const parsed = parseSkillFile(skillFile.text);
    const name = parsed.name ?? path.posix.basename(dir || source.repo);
    // A name made only of dots (and spaces) would name a parent folder.
    if (!/^[\w .:-]{1,80}$/.test(name) || /^[. ]+$/.test(name)) { skills.push({ name: name.slice(0, 80), description: parsed.description, path: dir, files: [], skipped, findings: [{ level: "block", file: "SKILL.md", message: "The skill name has unsupported characters." }] }); continue; }
    contents.set(name, files);
    skills.push({ name, description: parsed.description, path: dir, files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.text) })), skipped, findings: scanSkillFiles(files, trusted) });
  }
  const token = randomUUID();
  const preview: LibraryPreview = { token, owner: source.owner, repo: source.repo, commit, url, trusted, browse: false, skills };
  for (const [key, value] of pending) if (Date.now() - value.created > 30 * 60_000) pending.delete(key);
  pending.set(token, { preview, contents, created: Date.now() });
  return preview;
}

/** Writes the reviewed files exactly as previewed; returns the folders to add to the imported skills. */
export async function installLibraryImport(token: string, names: string[], libraryRoot: string): Promise<string[]> {
  const entry = pending.get(token);
  if (!entry) throw new Error("This preview expired. Preview the import again.");
  const dirs: string[] = [];
  for (const name of names) {
    const skill = entry.preview.skills.find((s) => s.name === name);
    const files = entry.contents.get(name);
    if (!skill || !files) throw new Error(`Skill “${name}” is not in this preview.`);
    if (skill.findings.some((f) => f.level === "block")) throw new Error(`Skill “${name}” has a blocking finding and cannot be imported.`);
    const folder = path.join(libraryRoot, `${entry.preview.owner}__${entry.preview.repo}`, name.replace(/[^\w.-]+/g, "-"));
    // Only ever replace a skill folder inside the library: two levels below its root.
    const inside = path.relative(path.resolve(libraryRoot), path.resolve(folder)).split(path.sep);
    if (inside.length !== 2 || inside.some((part) => !part || /^\.+$/.test(part)) || path.isAbsolute(inside.join(path.sep))) throw new Error(`Skill “${name}” has a name that cannot be used as a folder name.`);
    const staging = `${folder}.${randomUUID()}.tmp`;
    try {
      for (const file of files) {
        const target = path.resolve(staging, file.path);
        if (!target.startsWith(path.resolve(staging) + path.sep)) throw new Error(`Unsafe file path in ${name}: ${file.path}`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.text);
      }
      await writeFile(path.join(staging, "agent-dock-source.json"), JSON.stringify({ url: entry.preview.url, owner: entry.preview.owner, repo: entry.preview.repo, path: skill.path, commit: entry.preview.commit, importedAt: new Date().toISOString(), files: skill.files, skipped: skill.skipped, findings: skill.findings }, null, 2));
      await rm(folder, { recursive: true, force: true });
      await rename(staging, folder);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    dirs.push(folder);
  }
  pending.delete(token);
  return dirs;
}

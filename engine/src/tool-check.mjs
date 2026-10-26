import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Missing tools: before Implementation starts, the task's check command is read (and the npm scripts it runs)
 * for the toolchains it needs. A tool not found on PATH stops the task before any agent runs, and the app
 * suggests installing it; the engine waits and continues by itself once the tool appears (PATH is reread from
 * the registry on Windows, so a fresh install counts without restarting anything).
 *
 * Install commands are the official package-manager ones; winget ids only where the publisher's id is known.
 */
const RUST = { name: "Rust (cargo)", win32: "winget install --id Rustlang.Rustup -e --source winget", linux: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh", url: "https://rustup.rs", note: "On Windows Rust also needs the Visual Studio C++ build tools; rustup offers to install them." };
const PYTHON = { name: "Python", win32: "winget install --id Python.Python.3.12 -e --source winget", linux: "sudo apt install python3 python3-pip", url: "https://www.python.org/downloads/" };
const JAVA = { name: "Java (JDK)", win32: "winget install --id EclipseAdoptium.Temurin.21.JDK -e --source winget", linux: "sudo apt install default-jdk", url: "https://adoptium.net" };
export const TOOLS = {
  cargo: RUST, rustc: RUST,
  go: { name: "Go", win32: "winget install --id GoLang.Go -e --source winget", linux: "sudo apt install golang-go", url: "https://go.dev/dl/" },
  python: PYTHON, python3: PYTHON, pip: PYTHON, pip3: PYTHON,
  dotnet: { name: ".NET SDK", win32: "winget install --id Microsoft.DotNet.SDK.8 -e --source winget", linux: null, url: "https://dotnet.microsoft.com/download" },
  java: JAVA, javac: JAVA,
  mvn: { name: "Maven", win32: null, linux: "sudo apt install maven", url: "https://maven.apache.org/install.html" },
  gradle: { name: "Gradle", win32: null, linux: null, url: "https://gradle.org/install/" },
  deno: { name: "Deno", win32: "winget install --id DenoLand.Deno -e --source winget", linux: "curl -fsSL https://deno.land/install.sh | sh", url: "https://deno.com" },
  bun: { name: "Bun", win32: "winget install --id Oven-sh.Bun -e --source winget", linux: "curl -fsSL https://bun.sh/install | bash", url: "https://bun.sh" },
  pnpm: { name: "pnpm", win32: "npm install -g pnpm", linux: "npm install -g pnpm", url: "https://pnpm.io/installation" },
  yarn: { name: "Yarn", win32: "npm install -g yarn", linux: "npm install -g yarn", url: "https://yarnpkg.com/getting-started/install" },
  cmake: { name: "CMake", win32: "winget install --id Kitware.CMake -e --source winget", linux: "sudo apt install cmake", url: "https://cmake.org/download/" },
  make: { name: "make", win32: null, linux: "sudo apt install build-essential", url: "https://www.gnu.org/software/make/" },
};

/** The programs a script starts: the first word of each step (after &&, ||, ;, |). */
function programs(script) {
  return String(script).split(/&&|\|\||[;|\r\n]/).map((step) => step.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "")).filter(Boolean);
}

/** The check command, with the npm scripts it runs expanded (two levels: a script that runs another). */
export async function checkScripts(workspace, command) {
  const pkg = await readFile(path.join(workspace, "package.json"), "utf8").then(JSON.parse, () => null);
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const out = [String(command ?? "")];
  const expand = (text, depth) => {
    for (const m of String(text).matchAll(/\bnpm(?:\.cmd)?\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|start))\b/g)) {
      const name = m[1] ?? m[2];
      for (const key of [`pre${name}`, name, `post${name}`]) if (typeof scripts[key] === "string") { out.push(scripts[key]); if (depth < 2) expand(scripts[key], depth + 1); }
    }
  };
  expand(command, 1);
  return out;
}

const exists = (file) => stat(file).then((s) => s.isFile(), () => false);
async function onPath(tool, envPath, platform) {
  const exts = platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of String(envPath ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) if (await exists(path.join(dir.replace(/^"|"$/g, ""), tool + ext))) return true;
  }
  return false;
}

const regPath = (key) => new Promise((resolve) => execFile("reg", ["query", key, "/v", "Path"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
  const m = !error && /\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout);
  resolve(m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : "");
}));

/**
 * Windows: PATH as a newly opened terminal would see it (machine, then user), plus anything this process added.
 * An installer updates the registry, not running processes; this lets the run see the new tool.
 */
export async function freshPath(current = process.env.PATH ?? "") {
  if (process.platform !== "win32") return current;
  const [machine, user] = await Promise.all([regPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), regPath("HKCU\\Environment")]);
  const seen = new Set(), out = [];
  for (const dir of [...machine.split(";"), ...user.split(";"), ...current.split(";")]) {
    const key = dir.trim().toLowerCase().replace(/[\\/]+$/, "");
    if (key && !seen.has(key)) { seen.add(key); out.push(dir.trim()); }
  }
  return out.join(";");
}

/** Toolchains the check needs that are not installed: [{tool, name, install, url, note}]. Refreshes process.env.PATH. */
export async function missingTools({ workspace, command, platform = process.platform, refresh = freshPath }) {
  const wanted = [...new Set((await checkScripts(workspace, command)).flatMap(programs))].filter((p) => Object.hasOwn(TOOLS, p));
  if (!wanted.length) return [];
  let missing = [];
  for (const tool of wanted) if (!(await onPath(tool, process.env.PATH, platform))) missing.push(tool);
  if (missing.length) {
    process.env.PATH = await refresh(process.env.PATH ?? "");
    const still = [];
    for (const tool of missing) if (!(await onPath(tool, process.env.PATH, platform))) still.push(tool);
    missing = still;
  }
  const byName = new Map();
  for (const tool of missing) {
    const t = TOOLS[tool];
    if (!byName.has(t.name)) byName.set(t.name, { tool, name: t.name, install: (platform === "win32" ? t.win32 : t.linux) ?? null, url: t.url, note: platform === "win32" ? t.note ?? null : null });
  }
  return [...byName.values()];
}

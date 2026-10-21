import { existsSync } from "node:fs";
import path from "node:path";

// Command lines for cmd.exe: a `shell: true` spawn on Windows, or `cmd /d /s /c "<line>"` with
// windowsVerbatimArguments. Same rules as engine/src/cmd-line.mjs. Every argument is quoted (Windows
// argv rules) and every character cmd.exe treats specially is escaped with ^, so cmd passes the text on
// unchanged. A batch file (.cmd, .bat) parses its arguments a second time, so they are escaped twice.
// When the program is a bare name, cmd may pick an .exe or a .cmd from PATH: arguments with a quote or
// & | < > ^ % ! are refused then, since neither escaping fits both.
const SPECIAL = /([()\][%!^"`<>&|;, *?])/g;
const UNSAFE_FOR_ANY = /["&|<>^%!]/;

const quote = (text: string) => `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
const escape = (text: string) => quote(text).replace(SPECIAL, "^$1");

/** The cmd.exe command line that runs `command` with exactly `args`; throws for what cannot be passed safely. */
export function cmdLine(command: string, args: string[] = []): string {
  const program = String(command);
  if (!program || /["\r\n\0]/.test(program)) throw new Error(`Cannot start ${JSON.stringify(program)} through cmd.exe: the name contains a quote or line break.`);
  const name = path.win32.basename(program);
  const batch = /\.(?:cmd|bat)$/i.test(name);
  const bare = !/\.[^.]+$/.test(name);
  const parts = [escape(program)];
  for (const value of args) {
    const text = String(value);
    if (/[\r\n\0]/.test(text)) throw new Error(`Cannot pass an argument with a line break to ${program} through cmd.exe.`);
    if (bare && UNSAFE_FOR_ANY.test(text)) throw new Error(`Cannot pass ${JSON.stringify(text)} to ${program} through cmd.exe safely. Set the full path of the program (.exe or .cmd), or avoid the characters " & | < > ^ % !.`);
    parts.push(batch ? escape(text).replace(SPECIAL, "^$1") : escape(text));
  }
  return parts.join(" ");
}

/**
 * Windows: a bare program name resolved the way cmd.exe does (each PATH folder, each PATHEXT extension;
 * never the current folder), so cmdLine knows whether it starts a program or a batch file. Anything
 * else, or a name not found, is returned unchanged.
 */
export function resolveProgram(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32" || /[\/:]/.test(command) || /\.[^.]+$/.test(command)) return command;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, "$1"), command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

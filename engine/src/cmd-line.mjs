import path from "node:path";

// Command lines for cmd.exe (`cmd /d /s /c "<line>"`; src/main/lib/cmd-line.ts is the same for the app).
// Every argument is quoted (Windows argv rules) and every character cmd.exe treats specially is escaped
// with ^, so cmd passes the text on unchanged. A batch file (.cmd, .bat) parses its arguments a second
// time, so they are escaped twice. When the program is a bare name, cmd may pick an .exe or a .cmd from
// PATH: arguments with a quote or & | < > ^ % ! are refused then, since neither escaping fits both.
const SPECIAL = /([()\][%!^"`<>&|;, *?])/g;
const UNSAFE_FOR_ANY = /["&|<>^%!]/;

const quote = (text) => `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
const escape = (text) => quote(text).replace(SPECIAL, "^$1");

/** The cmd.exe command line that runs `command` with exactly `args`; throws for what cannot be passed safely. */
export function cmdLine(command, args = []) {
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

const isCmd = (command) => /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(String(command));

/**
 * spawn() command, arguments and options for a launcher. `cmd /d /s /c <program> ...` (codex.cmd from
 * npm) becomes one escaped command line passed to cmd.exe verbatim; anything else is unchanged.
 */
export function launchSpec(command, args) {
  if (!isCmd(command) || args.length < 4 || args[0] !== "/d" || args[1] !== "/s" || args[2] !== "/c") return { command, args, options: {} };
  return { command, args: ["/d", "/s", "/c", `"${cmdLine(args[3], args.slice(4))}"`], options: { windowsVerbatimArguments: true } };
}

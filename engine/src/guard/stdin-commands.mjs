import path from "node:path";
import { realpathSync, statSync } from "node:fs";

/**
 * Codex's write_stdin types into a command that is still running, and Codex never sends it to the hook (kadono
 * 0.40.0 probe): `bash` alone, allowed because it names nothing protected, would then run whatever is typed into
 * it unchecked. So a command that starts a shell or interpreter reading its code from input is refused outright;
 * with a script (`bash -c …`, `node file.js`, `powershell -Command …`) it is checked as usual. Input from a pipe
 * comes from the command text itself, which the guard sees, so a program after `|` is fine, unless the program
 * before it passes its own input on (`cat | sh`). Codex now runs without terminals, so a running command's input is
 * closed (install-protection.mjs, kadono 0.40.1 probe); this stays as a second layer.
 */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "busybox", "nu", "elvish", "xonsh"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "py", "pypy", "pypy3", "node", "nodejs", "deno", "bun", "perl", "ruby", "irb", "php", "lua", "luajit", "tclsh", "wish", "expect", "r", "julia", "ghci", "jshell", "scala", "groovysh", "osascript", "wsl", "wsl.exe"]);
// Programs whose input decides what runs, with or without arguments.
const ALWAYS = new Set(["xargs", "parallel", "su", "script", "ssh", "telnet", "nc", "ncat", "socat", "gdb", "lldb", "ftp", "sftp"]);
// Words before the program that keep its input: `env A=1 bash`, `sudo bash`, `nohup sh`, `time python`, `npx bash`.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "coproc", "select"]);
const WRAPPERS = new Set(["env", "sudo", "doas", "nohup", "exec", "command", "builtin", "time", "nice", "ionice", "stdbuf", "setsid", "chroot", "call", "npx", "pnpx", "bunx", "uvx"]);
const TWO_WORD_WRAPPERS = new Set(["npm exec", "pnpm exec", "pnpm dlx", "yarn exec", "yarn dlx", "bun x", "pipx run", "uv run"]);
// Programs that pass their own input on to the next one in a pipe (`tee log | sh`, `head -n 5 | bash`): always, or
// unless they name a file to read; the scripted ones take their script first (`sed 's/a/b/' | sh`).
const PASS_INPUT = new Set(["tee", "tr", "pv", "buffer", "mbuffer"]);
const FILTERS = new Set(["cat", "tac", "head", "tail", "rev", "dd", "base64", "xxd", "od", "sort", "uniq", "cut", "iconv", "fold", "fmt", "nl", "expand", "unexpand", "paste"]);
const SCRIPTED_FILTERS = new Set(["sed", "awk", "gawk", "mawk", "grep", "egrep", "fgrep", "jq"]);

const words = (segment) => segment.trim().split(/\s+/).map((w) => w.replace(/^["'`]+|["'`]+$/g, "")).filter(Boolean);
const program = (word) => path.basename(word.replaceAll("\\", "/")).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");

// Paths that are the command's own input (`bash /dev/stdin`, `node /proc/self/fd/0`).
const STDIN_PATH = /^(?:\/dev\/(?:stdin|tty|fd\/0)|\/proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/fd\/0)$/;
/** A script path that is, or links to, the command's own input (a workspace link to /dev/stdin too). */
let baseDir = process.cwd(); // The command's folder, for the call being checked (set by readsCodeFromInput).
/** An existing file in the command's folder (`sh configure`, `python tool`). */
function isFile(file) { try { return statSync(path.resolve(baseDir, file)).isFile(); } catch { return false; } }
function inputPath(file) {
  if (STDIN_PATH.test(file)) return true;
  try {
    const target = realpathSync(path.resolve(baseDir, file));
    return STDIN_PATH.test(target) || /^\/(?:dev\/(?:pts|tty)|proc\/)/.test(target) || /^pipe:|^socket:/.test(target);
  } catch { return false; }
}

/** A segment's own program with its arguments, past assignments and wrappers (and their options). */
function invocation(segment) {
  const list = words(segment);
  let i = 0, wrapped = false;
  while (i < list.length) {
    const w = list[i], name = program(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (wrapped && w.startsWith("-"))) {
      // `sudo -s`, `sudo -i`: a shell of its own.
      if (wrapped && /^-(s|i)$/.test(w)) return ["sh"];
      i++; continue;
    }
    // Shell reserved words before the program (`if true; then bash; fi`, `while x; do sh; done`, `! bash`).
    if (KEYWORDS.has(w)) { i++; continue; }
    if (WRAPPERS.has(name)) { wrapped = true; i++; continue; }
    if (TWO_WORD_WRAPPERS.has(`${name} ${(list[i + 1] ?? "").toLowerCase()}`)) { wrapped = true; i += 2; continue; }
    if (name === "timeout") { wrapped = true; i += 2; continue; }
    break;
  }
  // A wrapper's option may take a value (`env -u FOO bash`, `sudo -u nobody bash`, `nice -n 5 bash`): when an option
  // comes right before the program, every later word is tried as the program too (kadono 0.40.1 review).
  if (wrapped && list[i - 1]?.startsWith("-")) for (let j = i + 1; j < list.length; j++) if (needsInput(list.slice(j))) return list.slice(j);
  return list.slice(i);
}

// Asking for the version or help prints it and exits (`node --version`, `python -V`).
const INFO_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "-?", "/?", "-version", "-help"]);

function needsInput([first, ...args]) {
  if (!first) return false;
  if (args.length && args.every((a) => INFO_FLAGS.has(a) || INFO_FLAGS.has(a.toLowerCase()))) return false;
  const name = program(first);
  if (ALWAYS.has(name)) return true;
  // A database shell runs a query or file given on its command line and exits (`sqlite3 app.db "select 1"`,
  // `psql -c …`, `mysql -e …`); otherwise it reads them from input (kadono 0.40.1 probe).
  if (name === "sqlite3") return positionals(args, SQLITE_VALUES).length < 2 || args.includes("-interactive");
  if (name === "psql") return !args.some((a, i) => /^(-c|--command)$/.test(a) || /^--command=./.test(a) || (/^(-f|--file)$/.test(a) && args[i + 1] && args[i + 1] !== "-") || /^-l$|^--list$/.test(a));
  if (name === "mysql" || name === "mariadb") return !args.some((a) => /^(-e|--execute)$/.test(a) || /^--execute=./.test(a));
  if (name === "source" || name === ".") return args.some((a) => a === "-" || inputPath(a));
  if (name === "cmd") return !args.some((a) => /^\/c$/i.test(a)) || args.some((a) => /^\/k$/i.test(a));
  if (name === "powershell" || name === "pwsh") {
    if (args.some((a) => /^-noexit$/i.test(a) || /^-noe$/i.test(a))) return true;
    const at = args.findIndex((a) => /^-(c|command|encodedcommand|ec|e|f|file)$/i.test(a));
    if (at >= 0) return !args[at + 1] || args[at + 1] === "-";
    // Otherwise the first word that is no option and no option's value is the command text.
    return positional(args, POWERSHELL_VALUES) === null;
  }
  const kind = SHELLS.has(name) ? "shell" : INTERPRETERS.has(name) ? "interpreter" : null;
  if (!kind) return false;
  // Interactive or stdin flags keep it reading input even with a script; a shell's combined options too (`bash -is`).
  const cluster = (a) => /^-[A-Za-z]{2,}$/.test(a);
  if (args.some((a) => a === "-" || a === "-s" || a === "-i" || a === "--interactive" || a === "repl" || (kind === "shell" && cluster(a) && /[si]/.test(a)))) return true;
  const base = name.replace(/\d+(\.\d+)?$/, ""), code = kind === "shell" ? ["-c"] : CODE_FLAGS[base] ?? ["-e"];
  // Code on the command line, in combined options too (`bash -lc`, `sh -ec`, `node -pe`, `perl -lne`, `python -Bc`).
  const at = args.findIndex((a) => code.includes(a) || (cluster(a) && (kind === "shell" ? a.includes("c") : code.some((f) => /^-[A-Za-z]$/.test(f) && a.endsWith(f[1])))));
  // A shell's script is checked as a command of its own (`sh -c bash`, `bash -c "cat | sh"`).
  if (at >= 0) return kind === "shell" ? readsCodeFromInput(args.slice(at + 1).join(" "), baseDir) !== null : false;
  // bun and deno take subcommands (`bun install`, `deno test`); deno alone and their REPLs read input, and `bun x`
  // runs a program.
  if (base === "bun" || base === "deno") {
    const sub = positional(args, VALUE_OPTIONS[base] ?? new Set());
    if (sub === "x") return needsInput(args.slice(args.indexOf("x") + 1));
    return sub === null ? base === "deno" : false;
  }
  // A script file: the first word that is no option and no option's value, and looks like a file (`node -r fs`,
  // `python -W ignore` and `bash -O extglob` don't name one; kadono 0.40.1 review).
  const script = positional(args, VALUE_OPTIONS[kind === "shell" ? "shell" : base] ?? new Set());
  return script === null || inputPath(script) || !(/[\\/]|\.\w+$/.test(script) || isFile(script));
}

/** Whether a program before `|` passes its own input on to the next one (`cat | sh`, `cat - | sh`). */
function passesInput([first, ...args]) {
  if (!first) return false;
  const name = program(first), files = positionals(args, new Set());
  if (args.some((a) => a === "-" || inputPath(a))) return true;
  if (PASS_INPUT.has(name)) return true;
  // Only a word that looks like a file counts (`head -n 5` reads its input).
  const named = files.filter((f) => /[\\/]|\.\w+$/.test(f) || isFile(f));
  if (FILTERS.has(name)) return named.length === 0;
  if (SCRIPTED_FILTERS.has(name)) return files.length <= 1 || named.length === 0;
  return false;
}

// Options whose next word is their value, not a script.
const POWERSHELL_VALUES = new Set(["-executionpolicy", "-ex", "-ep", "-windowstyle", "-w", "-configurationname", "-version", "-v", "-inputformat", "-if", "-outputformat", "-of", "-o", "-workingdirectory", "-wd", "-psconsolefile", "-custompipename", "-settingsfile", "-configurationfile"]);
const VALUE_OPTIONS = {
  shell: new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]),
  node: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--title", "--input-type"]),
  nodejs: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--title", "--input-type"]),
  bun: new Set(["-r", "--preload", "--cwd", "--env-file"]),
  python: new Set(["-W", "-X", "-Q"]), py: new Set(["-W", "-X", "-Q"]), pypy: new Set(["-W", "-X"]),
  perl: new Set(["-I", "-M", "-m"]), ruby: new Set(["-I", "-r", "-C", "-E"]), php: new Set(["-c", "-d", "-z"]),
};
// Options whose value is the code itself.
const CODE_FLAGS = {
  node: ["-e", "--eval", "-p", "--print", "--test", "--run"], nodejs: ["-e", "--eval", "-p", "--print", "--test", "--run"], bun: ["-e", "--eval", "-p", "--print", "run"], deno: ["eval", "run"],
  python: ["-c", "-m"], py: ["-c", "-m"], pypy: ["-c", "-m"], perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], lua: ["-e"], luajit: ["-e"],
};
const SQLITE_VALUES = new Set(["-cmd", "-init", "-separator", "-newline", "-nullvalue", "-vfs", "-maxsize", "-mmap", "-lookaside", "-pagecache", "-heap"]);
function positional(args, valueOptions) {
  return positionals(args, valueOptions)[0] ?? null;
}
/** The words that are no option and no option's value. */
function positionals(args, valueOptions) {
  // PowerShell options ignore case; Unix ones don't (`-O` is not `-o`).
  const caseless = valueOptions === POWERSHELL_VALUES, found = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueOptions.has(caseless ? a.toLowerCase() : a)) { i++; continue; }
    if (a.startsWith("-") || a.startsWith("+")) continue;
    found.push(a);
  }
  return found;
}

/** The program in a shell script that would read its code from input, or null. */
export function readsCodeFromInput(script, cwd = process.cwd()) {
  baseDir = cwd;
  const text = String(script ?? "");
  // This is no shell parser, so it errs towards refusing (kadono 0.40.1 review): separators are found with quotes and
  // escapes in mind (`rg "node|python"` is one command), then each command is read with its quotes removed
  // (`/proc/thread-self/fd/'0'`); a program after a pipe reads the pipe. Quoting this reader can't follow (an
  // unclosed quote, `$'…'`, a substitution inside double quotes) gets no pipe exemption, and also the blunt reading:
  // every quote and backslash removed, separators wherever they then fall.
  const { parts, ambiguous } = split(text);
  return check(parts, !ambiguous) ?? (ambiguous ? check(split(text.replace(/["'`\\]/g, " ")).parts, false) : null);
}

const SEPARATOR = /^(\|\||&&|\||;|&|\r?\n|\$\(|\(|\)|`)/;
/** Commands and separators, outside quotes; `ambiguous` when the quoting is more than this reader follows. */
function split(text) {
  const parts = [];
  let current = "", quote = null, ambiguous = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { current += c; if (c === "'") quote = null; continue; }
    if (quote === '"') {
      if (c === "\\") { current += c + (text[i + 1] ?? ""); i++; continue; }
      if (c === "`" || text.startsWith("$(", i)) ambiguous = true;
      current += c; if (c === '"') quote = null; continue;
    }
    if (c === "\\") { current += c + (text[i + 1] ?? ""); i++; continue; }
    if (text.startsWith("$'", i)) ambiguous = true;
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    const sep = SEPARATOR.exec(text.slice(i));
    if (sep) { parts.push(current, sep[0]); current = ""; i += sep[0].length - 1; continue; }
    current += c;
  }
  parts.push(current);
  return { parts, ambiguous: ambiguous || quote !== null };
}

function check(parts, pipesExempt) {
  let piped = false, passes = false;
  // Commands and separators alternate: odd places are separators.
  for (const [index, part] of parts.entries()) {
    if (index % 2) { piped = pipesExempt && part === "|" && !passes; passes = false; continue; }
    if (!part.trim()) continue;
    // Quotes removed; backslashes kept (Windows paths) and removed (`\0` is `0` to a shell): either reading counts.
    const unquoted = part.replace(/["']/g, "");
    for (const reading of new Set([unquoted, unquoted.replace(/\\/g, "")])) {
      const call = invocation(reading.replace(/^[\s{]+|[\s}]+$/g, ""));
      if (!piped && needsInput(call)) return program(call[0]);
      passes ||= passesInput(call);
    }
    piped = false;
  }
  return null;
}

export const stdinCommandReason = (name) => `Commands that read their code from input (here ${name}) are refused: Codex could type into a running command without the guard seeing it. Run a script instead (for example \`${name} -c "…"\` or a file).`;

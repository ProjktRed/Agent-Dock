// Imported first by the main process, before anything starts a program.
// Windows: a bare program name (git, codex, claude, powershell) is resolved from PATH only, never from
// the current folder (cmd.exe and other launchers otherwise look there first). Child processes inherit it.
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

export {};

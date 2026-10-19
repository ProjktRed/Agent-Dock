export const EXE_NAME: string;
export const SHORTCUT_NAME: string;
export function isUninstaller(name: string): boolean;
export function swap(input: { from: string; installDir: string; waitPid?: number | string; relaunch?: boolean; shortcuts?: boolean; version?: string }): Promise<void>;
export function uninstallVersionScript(installDir: string, version: string | undefined): string | null;
export function swapStage(input: { from: string; installDir: string; waitPid?: number | string; relaunch?: boolean; result?: string | null; version?: string }): Promise<void>;

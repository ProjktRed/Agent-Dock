export const EXE_NAME: string;
export const SHORTCUT_NAME: string;
export function isUninstaller(name: string): boolean;
export function swap(input: { from: string; installDir: string; waitPid?: number | string; relaunch?: boolean; shortcuts?: boolean }): Promise<void>;
export function swapStage(input: { from: string; installDir: string; waitPid?: number | string; relaunch?: boolean; result?: string | null }): Promise<void>;

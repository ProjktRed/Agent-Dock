export interface FileIndex { files: { path: string; sha256: string; size: number }[] }
export function buildIndex(dir: string): Promise<FileIndex>;
export function changedFiles(next: FileIndex, previous: FileIndex): string[];
export const PATCH_DIR: string;
/** Copies each changed file into out, or a binary patch against previousDir when that is much smaller. */
export function collectChanged(changed: string[], dir: string, out: string, previousDir?: string): { copied: number; patched: number; bytes: number };

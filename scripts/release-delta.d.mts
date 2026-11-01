export interface FileIndex { files: { path: string; sha256: string; size: number }[] }
export function buildIndex(dir: string): Promise<FileIndex>;
export function changedFiles(next: FileIndex, previous: FileIndex): string[];
export const PATCH_DIR: string;
/** Copies each changed file into out, or a binary patch against previousDir when that is much smaller. */
export function collectChanged(changed: string[], dir: string, out: string, previousDir?: string): { copied: number; patched: number; bytes: number };
/** Linux: a binary patch of the previous AppImage into the new one, written only when under half its size. */
export function appImagePatch(previous: string, file: string, out: string): { written: boolean; bytes: number };

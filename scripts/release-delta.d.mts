export interface FileIndex { files: { path: string; sha256: string; size: number }[] }
export function buildIndex(dir: string): Promise<FileIndex>;
export function changedFiles(next: FileIndex, previous: FileIndex): string[];

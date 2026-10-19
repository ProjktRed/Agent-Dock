export const PRODUCT: string;
export const PLATFORM: string;
export function sha256File(file: string): Promise<string>;
export const PLATFORMS: Record<"win-x64" | "linux-x64", { ext: string; manifest: string }>;
export function buildManifest(input: { zip: string; version: string; commit: string; platform?: "win-x64" | "linux-x64"; now?: Date }): Promise<string>;
export function signManifest(manifestText: string, privateKeyPem: string): string;
export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string };

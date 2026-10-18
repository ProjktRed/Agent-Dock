export const PRODUCT: string;
export const PLATFORM: string;
export function sha256File(file: string): Promise<string>;
export function buildManifest(input: { zip: string; version: string; commit: string; now?: Date }): Promise<string>;
export function signManifest(manifestText: string, privateKeyPem: string): string;
export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string };

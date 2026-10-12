import { nativeImage, type NativeImage } from "electron";
import { logoPng } from "../../scripts/logo.mjs";

/** The Agent Dock logo as a native image; `dot` adds a status dot (attention, running) for the tray. */
export function appIcon(size = 32, dot: [number, number, number] | null = null): NativeImage {
  return nativeImage.createFromBuffer(logoPng(size, { dot }));
}

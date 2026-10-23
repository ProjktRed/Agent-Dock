import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { buildInfoPlugin, engineManifestPlugin } from "./scripts/build-info";

const shared = { "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: { plugins: [buildInfoPlugin(__dirname), engineManifestPlugin(__dirname), externalizeDepsPlugin()], resolve: { alias: shared } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  // electron-vite 5 no longer minifies the renderer by default.
  renderer: { plugins: [react()], resolve: { alias: shared }, build: { minify: "esbuild" } },
});

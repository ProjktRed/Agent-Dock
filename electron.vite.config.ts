import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { buildInfoPlugin } from "./scripts/build-info";

const shared = { "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: { plugins: [buildInfoPlugin(__dirname), externalizeDepsPlugin()], resolve: { alias: shared } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  renderer: { plugins: [react()], resolve: { alias: shared } },
});

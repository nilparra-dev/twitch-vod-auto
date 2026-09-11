import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The replay player is the only frontend entry. `npm run build` emits it into
// <repo>/dist/player, which the npm package and the `watch` command serve.
// `vite preview` serves that same directory for a static local player.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/player",
    emptyOutDir: true,
    sourcemap: false,
    // Keep even small font subsets as files, compatible with font-src 'self'.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: fileURLToPath(new URL("./replay.html", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});

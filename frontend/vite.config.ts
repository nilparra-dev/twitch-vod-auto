import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// FastAPI serves the built SPA from the same origin as the API. During
// development, Vite proxies API and SSE requests to Uvicorn.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: mode === "player" ? "../dist/player" : "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Keep even small font subsets as files, compatible with font-src 'self'.
    assetsInlineLimit: 0,
    rollupOptions: {
      input:
        mode === "player"
          ? { replay: fileURLToPath(new URL("./replay.html", import.meta.url)) }
          : {
              dashboard: fileURLToPath(new URL("./index.html", import.meta.url)),
              replay: fileURLToPath(new URL("./replay.html", import.meta.url)),
            },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
}));

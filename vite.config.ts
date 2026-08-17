import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Backend `tsc` output also lands under ./dist (mirroring src/'s
  // structure, e.g. dist/server/index.js) — nest the frontend build in its
  // own subdirectory so neither build's `emptyOutDir` step clobbers the
  // other's output.
  build: {
    outDir: "dist/client",
  },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env["PORT"] ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
});

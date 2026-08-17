import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Compiles src/widget/widgetSource.ts into a single, dependency-free
 * public/widget.js — the standalone script embedded on third-party
 * business websites (served by src/api/routes/widget.ts at GET
 * /widget.js). Deliberately a separate Vite config/entry point from the
 * dashboard's vite.config.ts:
 *  - IIFE format, so it runs immediately as a plain <script> tag with no
 *    module loader and no host-page dependency on ES module support.
 *  - No React/plugins — the widget is vanilla TS/DOM by design (see
 *    widgetSource.ts's file header) and must not accidentally pull in the
 *    dashboard's dependencies or JSX handling.
 */
export default defineConfig({
  // outDir below is intentionally also "public" (where the compiled
  // bundle must land for src/api/routes/widget.ts to serve it) — that
  // would otherwise collide with Vite's separate "copy publicDir into
  // outDir" feature, which this build doesn't use at all. Disabling
  // publicDir avoids the warning and the redundant self-copy.
  publicDir: false,
  build: {
    outDir: "public",
    // public/ already holds real, unrelated PWA assets (icons/,
    // manifest.webmanifest, sw-advanced.js) produced by the main `vite
    // build` — must not be wiped when only the widget is rebuilt.
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: true,
    lib: {
      entry: resolve(currentDir, "src/widget/widgetSource.ts"),
      name: "AiBookingWidget",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
  },
});

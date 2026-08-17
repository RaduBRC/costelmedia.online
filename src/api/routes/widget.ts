/**
 * GET /widget.js — serves the compiled, standalone embeddable widget
 * bundle (built from src/widget/widgetSource.ts via `npm run build:widget`
 * into public/widget.js).
 *
 * CORS is wide open since this is loaded by arbitrary third-party business
 * websites embedding the snippet — there's no allowlist to check a
 * `<script src>` load against. Caching uses `res.sendFile`'s built-in
 * ETag/Last-Modified conditional-request support (the well-established
 * tool for exactly this job) rather than hand-rolled cache logic, with a
 * moderate max-age so widget updates reach embedded sites within a few
 * minutes without every business needing to touch their embed code.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const widgetRouter: express.Router = express.Router();

const currentDir = dirname(fileURLToPath(import.meta.url));
// Same relative depth (api/routes/) whether running compiled
// (dist/api/routes/widget.js) or, in tests, directly against source
// (src/api/routes/widget.ts) — three levels up reaches the project root
// either way, where public/widget.js lives.
const WIDGET_FILE_PATH = join(currentDir, "..", "..", "..", "public", "widget.js");

widgetRouter.get("/widget.js", (_req: Request, res: Response, next: NextFunction) => {
  if (!existsSync(WIDGET_FILE_PATH)) {
    res.status(503).json({ error: "Widget bundle not built yet. Run `npm run build:widget`." });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("application/javascript");

  res.sendFile(WIDGET_FILE_PATH, { maxAge: "5m" }, (error: unknown) => {
    if (error) {
      next(error);
    }
  });
});

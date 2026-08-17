/**
 * POST /api/v1/widget/chat — the public-facing endpoint the embeddable
 * widget (public/widget.js, built from src/widget/widgetSource.ts) talks
 * to from an arbitrary third-party website.
 *
 * No auth: an anonymous site visitor has no Supabase session and can't
 * hold a secret (view-source reveals everything embedded client-side), so
 * `tenantId` here plays the same role a Stripe *publishable* key does —
 * public by design, safe to embed, and on its own only sufficient to have
 * a scheduling conversation with that one tenant's agent. Every actually
 * sensitive operation (booking a real appointment) still goes through the
 * exact same guardrails/tool-calling pipeline every other channel uses
 * (see src/agent/groqAgent.ts) — this route doesn't bypass any of that,
 * it's just one more front door into it.
 *
 * CORS is deliberately wide open (`*`) and handled here, ahead of
 * src/server/app.ts's stricter ALLOWED_ORIGINS-scoped middleware — we
 * can't know in advance which business websites will embed the widget,
 * so there's no allowlist to check it against. That's fine: nothing this
 * route does is privileged by origin, only by the (public) tenantId and
 * the phone number the visitor themselves provides.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { MAX_CHAT_INPUT_LENGTH } from "../../agent/guardrails.js";
import { processClientMessage } from "../../agent/groqAgent.js";
import { getTenantById } from "../../db/supabase.js";
import { threatShieldRateLimiter, widgetRateLimiter } from "../middleware/security.js";
import { threatSentinel } from "../../security/threatSentinelMiddleware.js";

export const widgetChatRouter: express.Router = express.Router();

function isValidPhoneNumber(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
}

function widgetCors(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}

widgetChatRouter.options("/chat", widgetCors, (_req: Request, res: Response) => {
  res.sendStatus(204);
});

widgetChatRouter.post(
  "/chat",
  widgetCors,
  express.json({ limit: "10kb" }),
  widgetRateLimiter,
  threatShieldRateLimiter,
  threatSentinel({ channel: "widget" }),
  async (
    req: Request<unknown, unknown, { tenantId?: string; phoneNumber?: string; message?: string }>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { tenantId, phoneNumber, message } = req.body;

      if (!tenantId || typeof tenantId !== "string") {
        res.status(400).json({ error: "tenantId is required." });
        return;
      }
      if (!isValidPhoneNumber(phoneNumber)) {
        res.status(400).json({ error: "phoneNumber must be a valid phone number in E.164 format (e.g. +15551234567)." });
        return;
      }
      if (!message || typeof message !== "string" || !message.trim()) {
        res.status(400).json({ error: "message is required." });
        return;
      }
      if (message.length > MAX_CHAT_INPUT_LENGTH) {
        res.status(400).json({ error: `message must be ${MAX_CHAT_INPUT_LENGTH} characters or fewer.` });
        return;
      }

      const tenant = await getTenantById(tenantId);
      if (!tenant || !tenant.isActive) {
        // Same response either way — a visitor probing tenantIds shouldn't
        // learn "that one exists but is deactivated" vs. "doesn't exist".
        res.status(404).json({ error: "Unknown tenant." });
        return;
      }

      const result = await processClientMessage(tenantId, phoneNumber, message, "ai_chat");
      // Deliberately minimal response — the public widget only needs the
      // reply text, not tone-assessment internals or which tools fired.
      res.json({ reply: result.reply });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Inbound multi-channel (SMS/WhatsApp) webhook ingestion: Twilio posts
 * here, we verify the request really came from Twilio, resolve which
 * tenant it's for, run it through the Groq agent, and reply inline via
 * TwiML — no separate outbound REST call needed for the synchronous reply.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { MAX_CHAT_INPUT_LENGTH } from "../agent/guardrails.js";
import { processClientMessage } from "../agent/groqAgent.js";
import { resolveTwilioCredentials } from "../channels/twilioService.js";
import { escapeXml, extractStringFields, stripChannelPrefix, verifyTwilioSignature } from "../channels/twilioSignature.js";
import { getTenantTwilioRoutingByPhoneNumber } from "../db/supabase.js";
import { requireApiKey } from "./middleware/auth.js";
import { chatRateLimiter, threatShieldRateLimiter, webhookRateLimiter } from "./middleware/security.js";
import { evaluateThreat, GENERIC_BLOCKED_REPLY } from "../security/threatSentinel.js";
import { threatSentinel } from "../security/threatSentinelMiddleware.js";

export const webhooksRouter: express.Router = express.Router();

function buildTwiMlReply(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

webhooksRouter.post(
  "/twilio",
  express.urlencoded({ extended: false }),
  webhookRateLimiter,
  chatRateLimiter,
  threatShieldRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fields = extractStringFields(req.body as unknown, ["To", "From", "Body"]);
      if (!fields) {
        res.status(400).json({ error: "Twilio webhook payload must include To, From, and Body." });
        return;
      }

      const toNumber = stripChannelPrefix(fields["To"] ?? "");
      const fromNumber = stripChannelPrefix(fields["From"] ?? "");
      const messageBody = fields["Body"] ?? "";

      const routing = await getTenantTwilioRoutingByPhoneNumber(toNumber);
      if (!routing) {
        // Don't leak whether a number exists in more detail than this —
        // just a plain 404, and nothing gets processed.
        res.status(404).json({ error: "No tenant is configured for this number." });
        return;
      }

      const credentials = await resolveTwilioCredentials(routing.tenantId);
      if (!verifyTwilioSignature(req, credentials.authToken)) {
        res.status(403).json({ error: "Twilio signature verification failed." });
        return;
      }

      // Threat Sentinel runs here (not as prior middleware, unlike the
      // JSON-body routes) because it needs the tenant this message
      // resolved to, which itself needs a verified Twilio signature —
      // both only available once we're this far into the handler.
      const threat = await evaluateThreat({
        message: messageBody,
        ipAddress: req.ip ?? "unknown",
        tenantId: routing.tenantId,
        channel: "sms_whatsapp",
      });
      if (threat.blocked) {
        console.warn(`Threat Sentinel blocked an SMS/WhatsApp message from ${req.ip ?? "unknown"} (category=${threat.category}, score=${threat.score}).`);
        res.set("Content-Type", "text/xml");
        res.status(200).send(buildTwiMlReply(GENERIC_BLOCKED_REPLY));
        return;
      }

      const result = await processClientMessage(routing.tenantId, fromNumber, messageBody, "ai_chat");

      res.set("Content-Type", "text/xml");
      res.status(200).send(buildTwiMlReply(result.reply));
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Generic inbound channel for non-Twilio integrations (a custom chat
 * widget, another provider, etc.) that don't carry their own request
 * signature scheme — authenticated via API key instead. Demonstrates
 * requireApiKey against a real route rather than leaving it unused: the
 * Twilio route above has its own native signature verification, so this
 * is genuinely where API-key auth is the right mechanism.
 */
webhooksRouter.post(
  "/generic",
  express.json(),
  webhookRateLimiter,
  chatRateLimiter,
  requireApiKey,
  threatShieldRateLimiter,
  threatSentinel({
    channel: "generic_webhook",
    onBlocked: (_req, res) => {
      res.json({
        reply: GENERIC_BLOCKED_REPLY,
        toneAssessment: { urgency: 1, formality: 3, sentiment: "neutral", toneNote: "" },
        actionsTaken: [],
      });
    },
  }),
  async (req: Request<unknown, unknown, { clientPhone?: string; message?: string }>, res: Response, next: NextFunction) => {
    try {
      const { clientPhone, message } = req.body;
      if (!req.tenantId || !clientPhone || !message) {
        res.status(400).json({ error: "Body must include clientPhone and message." });
        return;
      }
      if (message.length > MAX_CHAT_INPUT_LENGTH) {
        res.status(400).json({ error: `message must be ${MAX_CHAT_INPUT_LENGTH} characters or fewer.` });
        return;
      }
      const result = await processClientMessage(req.tenantId, clientPhone, message, "ai_chat");
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

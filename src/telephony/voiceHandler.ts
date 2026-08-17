/**
 * POST /api/v1/voice/incoming — Twilio's Voice webhook. Verifies the
 * request the same way the SMS webhook does (src/api/webhooks.ts), then
 * replies with TwiML that opens a bidirectional media stream to
 * voiceStreamServer.ts (`<Connect><Stream>`, not `<Start><Stream>` — only
 * `<Connect>` supports sending audio *back* to the caller, which the
 * agent's spoken replies need).
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { resolveTwilioCredentials } from "../channels/twilioService.js";
import { escapeXml, extractStringFields, stripChannelPrefix, verifyTwilioSignature } from "../channels/twilioSignature.js";
import { getTenantTwilioRoutingByPhoneNumber } from "../db/supabase.js";
import { chatRateLimiter, webhookRateLimiter } from "../api/middleware/security.js";

export const voiceRouter: express.Router = express.Router();

function buildStreamUrl(req: Request): string {
  const override = process.env["PUBLIC_WEBHOOK_BASE_URL"];
  const host = override ? override.replace(/^https?:\/\//, "").replace(/\/$/, "") : (req.get("host") ?? "");
  const isSecure = override ? override.startsWith("https") : req.protocol === "https";
  return `${isSecure ? "wss" : "ws"}://${host}/api/v1/voice/stream`;
}

function buildConnectStreamTwiml(streamUrl: string, tenantId: string, callerPhone: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${escapeXml(streamUrl)}">` +
    `<Parameter name="tenantId" value="${escapeXml(tenantId)}"/>` +
    `<Parameter name="callerPhone" value="${escapeXml(callerPhone)}"/>` +
    `</Stream></Connect></Response>`
  );
}

function buildRejectTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

voiceRouter.post(
  "/incoming",
  express.urlencoded({ extended: false }),
  webhookRateLimiter,
  chatRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fields = extractStringFields(req.body as unknown, ["To", "From"]);
      if (!fields) {
        res.status(400).json({ error: "Twilio voice webhook payload must include To and From." });
        return;
      }

      const toNumber = stripChannelPrefix(fields["To"] ?? "");
      const fromNumber = stripChannelPrefix(fields["From"] ?? "");

      const routing = await getTenantTwilioRoutingByPhoneNumber(toNumber);
      if (!routing || !routing.isActive) {
        // Same response either way — a caller dialing a deactivated
        // tenant's number shouldn't be able to distinguish "not a real
        // number" from "real number, account currently inactive".
        res.set("Content-Type", "text/xml");
        res.status(200).send(buildRejectTwiml("Sorry, this number is not currently in service."));
        return;
      }

      const credentials = await resolveTwilioCredentials(routing.tenantId);
      if (!verifyTwilioSignature(req, credentials.authToken)) {
        res.status(403).json({ error: "Twilio signature verification failed." });
        return;
      }

      const streamUrl = buildStreamUrl(req);
      res.set("Content-Type", "text/xml");
      res.status(200).send(buildConnectStreamTwiml(streamUrl, routing.tenantId, fromNumber));
    } catch (error) {
      next(error);
    }
  },
);

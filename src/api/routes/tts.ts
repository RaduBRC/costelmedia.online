/**
 * POST /api/tts — synthesizes text to speech via ElevenLabs for the
 * dashboard's Voice Call Simulator (VoiceCallSimulator.tsx), which plays
 * the returned audio instead of the browser's own SpeechSynthesis
 * whenever this succeeds — see src/lib/api.ts's synthesizeSpeech for the
 * client side, which falls back to SpeechSynthesis on any non-2xx
 * response.
 *
 * Staff-only (requireTenantAuth): ElevenLabs bills per character, so this
 * can't be left open the way the public widget chat is — every call here
 * costs real money regardless of who's paying for whose call.
 *
 * Error responses are a stable `{ error: CODE, message }` shape so the
 * frontend can log/display exactly what happened rather than a generic
 * "something went wrong" — this endpoint has a history of failures being
 * invisible (a hung request looks identical to a slow one from the
 * client's perspective until you have a code to distinguish them):
 *   - 400 MISSING_KEYS       — ELEVENLABS_API_KEY/VOICE_ID not configured,
 *                               checked immediately, before any network call.
 *   - 400 MISSING_TEXT / TEXT_TOO_LONG — bad request body.
 *   - 504 ELEVENLABS_TIMEOUT — ElevenLabs didn't respond within the
 *                               request's 5s ceiling (see
 *                               elevenLabsTts.ts's REQUEST_TIMEOUT_MS).
 *   - 502 ELEVENLABS_FAILED  — ElevenLabs responded with a non-2xx status
 *                               (bad key, quota/plan restriction, outage).
 *   - 503 TTS_UNAVAILABLE    — anything else unexpected.
 *
 * Streams the response through rather than buffering the whole clip
 * first — same reasoning as elevenLabsTts.ts's telephony path, just
 * requesting mp3_44100_128 (browser-playable) instead of ulaw_8000
 * (Twilio-only).
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { getTenantById, insertServiceFailure, insertUsageEvent } from "../../db/supabase.js";
import {
  describeElevenLabsStatus,
  ElevenLabsRequestError,
  ElevenLabsTimeoutError,
  fetchElevenLabsSpeechStream,
  isElevenLabsConfigured,
} from "../../telephony/elevenLabsTts.js";
import { requireTenantAuth } from "../middleware/auth.js";
import { threatShieldRateLimiter } from "../middleware/security.js";

export const ttsRouter: express.Router = express.Router();

// Generous relative to MAX_CHAT_INPUT_LENGTH (500, guardrails.ts) — this
// synthesizes one agent reply at a time, not a whole exchange, but replies
// occasionally run long (e.g. listing several available slots).
const MAX_TTS_TEXT_LENGTH = 1000;

// No local express.json() here, unlike widgetChat.ts/widget.ts — this
// route is mounted (in app.ts) after the global express.json() body
// parser, which already handles it, the same way every other
// /api/tenants/... POST route in app.ts relies on that global parser
// rather than re-declaring their own.
ttsRouter.post(
  "/",
  requireTenantAuth,
  threatShieldRateLimiter,
  async (req: Request<unknown, unknown, { text?: string }>, res: Response, next: NextFunction) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string" || !text.trim()) {
        res.status(400).json({ error: "MISSING_TEXT", message: "Body must include non-empty text." });
        return;
      }
      if (text.length > MAX_TTS_TEXT_LENGTH) {
        res.status(400).json({ error: "TEXT_TOO_LONG", message: `text must be ${MAX_TTS_TEXT_LENGTH} characters or fewer.` });
        return;
      }

      // req.tenantId comes from the caller's own session (requireTenantAuth)
      // — the Voice Call Simulator only ever tests the tenant the logged-in
      // staff member belongs to, so there's no separate tenantId to accept
      // in the body. A lookup failure (deleted tenant, bad token state)
      // just falls back to the env var default voice rather than erroring
      // the whole request over a cosmetic detail.
      const tenant = req.tenantId ? await getTenantById(req.tenantId) : null;
      const voiceId = tenant?.elevenlabsVoiceId ?? null;

      // Checked immediately, before any network call — a missing/blank
      // .env value fails fast instead of only surfacing after a request
      // that was never going to succeed.
      if (!isElevenLabsConfigured(voiceId)) {
        res.status(400).json({ error: "MISSING_KEYS", message: "ElevenLabs keys are missing in .env" });
        return;
      }

      let upstream: Awaited<ReturnType<typeof fetchElevenLabsSpeechStream>>;
      try {
        upstream = await fetchElevenLabsSpeechStream(text, "mp3_44100_128", voiceId);
        if (req.tenantId) {
          void insertUsageEvent({ tenantId: req.tenantId, service: "elevenlabs_tts", quantity: text.length, unit: "characters" });
        }
      } catch (error) {
        if (error instanceof ElevenLabsTimeoutError) {
          console.error("ElevenLabs TTS request timed out:", error.message);
          void insertServiceFailure({ tenantId: req.tenantId ?? null, service: "elevenlabs", errorMessage: `Timeout: ${error.message}` });
          res.status(504).json({ error: "ELEVENLABS_TIMEOUT", message: "ElevenLabs did not respond in time." });
          return;
        }
        if (error instanceof ElevenLabsRequestError) {
          // Three separate log lines, not one concatenated string — the
          // diagnosis (401/404/429/...) is usually enough to tell a human
          // what's wrong at a glance; the raw body (which ElevenLabs' own
          // message is embedded in — "Unusual activity detected",
          // "Invalid API key", "Voice ID does not exist", a missing
          // permission scope, etc.) is the part worth grepping logs for
          // separately.
          console.error(`[ElevenLabs API] Request failed — HTTP ${error.status}: ${describeElevenLabsStatus(error.status)}`);
          console.error(`[ElevenLabs API] Response body: ${error.message}`);
          void insertServiceFailure({
            tenantId: req.tenantId ?? null,
            service: "elevenlabs",
            errorMessage: `HTTP ${error.status}: ${describeElevenLabsStatus(error.status)} — ${error.message}`,
          });
          res.status(502).json({
            error: "ELEVENLABS_FAILED",
            message: "ElevenLabs API failed",
            status: error.status,
            // Full upstream detail only outside production — this can
            // contain ElevenLabs' literal error text, which is useful for
            // debugging from the browser console but not something to
            // hand back to end users of a production deployment.
            ...(process.env["NODE_ENV"] !== "production" ? { detail: error.message } : {}),
          });
          return;
        }
        // Not configured is checked above and shouldn't reach here, but
        // this covers it (and any truly unexpected error) defensively
        // rather than letting it fall through to the generic 500 handler.
        console.error("ElevenLabs TTS request failed unexpectedly:", error instanceof Error ? error.message : error);
        res.status(503).json({ error: "TTS_UNAVAILABLE", message: "Text-to-speech is currently unavailable." });
        return;
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");

      // Node's ambient fetch types don't always propagate the Uint8Array
      // generic through ReadableStream cleanly — pin it explicitly (same
      // as elevenLabsTts.ts's own reader).
      const reader: ReadableStreamDefaultReader<Uint8Array> = upstream.body.getReader();
      // If the client cancels playback or navigates away mid-stream, stop
      // pulling (and paying ElevenLabs for) bytes nobody will hear.
      req.on("close", () => {
        reader.cancel().catch(() => {
          /* already closed/errored — nothing to do */
        });
      });

      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          if (result.value.length > 0 && !res.writableEnded) {
            res.write(Buffer.from(result.value));
          }
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
    } catch (error) {
      next(error);
    }
  },
);

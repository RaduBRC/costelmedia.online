/**
 * /admin/settings backend: business info + working hours + AI persona
 * (PATCH /api/tenants/:tenantId) and the ElevenLabs voice picker
 * (GET /api/tenants/:tenantId/voices). Mounted under
 * `/api/tenants/:tenantId` in src/server/app.ts, alongside the existing
 * GET /api/tenants/:tenantId defined directly there — distinct methods,
 * so no route conflict.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { updateTenant } from "../../db/supabase.js";
import { ElevenLabsNotConfiguredError, ElevenLabsRequestError, ElevenLabsTimeoutError, listElevenLabsVoices } from "../../telephony/elevenLabsTts.js";
import type { BusinessType, ToneOfVoice, Weekday, WorkingHours } from "../../types/index.js";
import { requireTenantAdmin, requireTenantAuth } from "../middleware/auth.js";

export const tenantSettingsRouter: express.Router = express.Router({ mergeParams: true });

// Kept in sync with the BusinessType union (src/types/index.ts) and
// BUSINESS_TYPE_RULES/BUSINESS_TYPE_LABELS (promptBuilder.ts) — all three
// need a matching entry for any given business type, or a tenant could
// set a type here that the prompt builder has no rules for.
const VALID_BUSINESS_TYPES: readonly BusinessType[] = [
  "restaurant",
  "clinic",
  "callcenter",
  "auto_shop",
  "salon",
  "legal_services",
  "general_services",
];
const VALID_TONES_OF_VOICE: readonly ToneOfVoice[] = ["formal", "friendly"];
const WEEKDAYS: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && (VALID_BUSINESS_TYPES as readonly string[]).includes(value);
}

function isToneOfVoice(value: unknown): value is ToneOfVoice {
  return typeof value === "string" && (VALID_TONES_OF_VOICE as readonly string[]).includes(value);
}

/** Validates the full WorkingHours shape — every weekday key present, each value either null (closed) or a well-formed HH:MM start/end pair with start < end. Rejects the whole update rather than silently dropping a malformed day. */
function validateWorkingHours(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return "workingHours must be an object.";
  }
  const record = value as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    const entry = record[day];
    if (entry === null) continue;
    if (typeof entry !== "object" || entry === null) {
      return `workingHours.${day} must be null (closed) or { start, end }.`;
    }
    const { start, end } = entry as { start?: unknown; end?: unknown };
    if (typeof start !== "string" || !TIME_RE.test(start) || typeof end !== "string" || !TIME_RE.test(end)) {
      return `workingHours.${day} start/end must be "HH:MM" 24-hour strings.`;
    }
    if (start >= end) {
      return `workingHours.${day}: start must be before end.`;
    }
  }
  return null;
}

interface TenantSettingsPatchBody {
  name?: string;
  businessType?: string;
  workingHours?: unknown;
  elevenlabsVoiceId?: string | null;
  systemPromptOverride?: string | null;
  greetingMessage?: string | null;
  publicPhoneNumber?: string | null;
  address?: string | null;
  toneOfVoice?: string;
}

tenantSettingsRouter.patch(
  "/",
  requireTenantAuth,
  requireTenantAdmin,
  async (req: Request<{ tenantId: string }, unknown, TenantSettingsPatchBody>, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const patch: Parameters<typeof updateTenant>[1] = {};

      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 200) {
          res.status(400).json({ error: "name must be a non-empty string of 200 characters or fewer." });
          return;
        }
        patch.name = body.name.trim();
      }

      if (body.businessType !== undefined) {
        if (!isBusinessType(body.businessType)) {
          res.status(400).json({ error: `businessType must be one of: ${VALID_BUSINESS_TYPES.join(", ")}.` });
          return;
        }
        patch.businessType = body.businessType;
      }

      if (body.workingHours !== undefined) {
        const workingHoursError = validateWorkingHours(body.workingHours);
        if (workingHoursError) {
          res.status(400).json({ error: workingHoursError });
          return;
        }
        patch.workingHours = body.workingHours as WorkingHours;
      }

      if (body.elevenlabsVoiceId !== undefined) {
        if (body.elevenlabsVoiceId !== null && typeof body.elevenlabsVoiceId !== "string") {
          res.status(400).json({ error: "elevenlabsVoiceId must be a string or null." });
          return;
        }
        patch.elevenlabsVoiceId = body.elevenlabsVoiceId;
      }

      if (body.systemPromptOverride !== undefined) {
        if (body.systemPromptOverride !== null && (typeof body.systemPromptOverride !== "string" || body.systemPromptOverride.length > 4000)) {
          res.status(400).json({ error: "systemPromptOverride must be a string of 4000 characters or fewer, or null." });
          return;
        }
        patch.systemPromptOverride = body.systemPromptOverride;
      }

      if (body.greetingMessage !== undefined) {
        if (body.greetingMessage !== null && (typeof body.greetingMessage !== "string" || body.greetingMessage.length > 1000)) {
          res.status(400).json({ error: "greetingMessage must be a string of 1000 characters or fewer, or null." });
          return;
        }
        patch.greetingMessage = body.greetingMessage;
      }

      if (body.publicPhoneNumber !== undefined) {
        if (body.publicPhoneNumber !== null && (typeof body.publicPhoneNumber !== "string" || body.publicPhoneNumber.length > 40)) {
          res.status(400).json({ error: "publicPhoneNumber must be a string of 40 characters or fewer, or null." });
          return;
        }
        patch.publicPhoneNumber = body.publicPhoneNumber;
      }

      if (body.address !== undefined) {
        if (body.address !== null && (typeof body.address !== "string" || body.address.length > 500)) {
          res.status(400).json({ error: "address must be a string of 500 characters or fewer, or null." });
          return;
        }
        patch.address = body.address;
      }

      if (body.toneOfVoice !== undefined) {
        if (!isToneOfVoice(body.toneOfVoice)) {
          res.status(400).json({ error: `toneOfVoice must be one of: ${VALID_TONES_OF_VOICE.join(", ")}.` });
          return;
        }
        patch.toneOfVoice = body.toneOfVoice;
      }

      const tenant = await updateTenant(req.params.tenantId, patch);
      res.json(tenant);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Any authenticated staff member (not admin-only — a non-admin staffer
 * previewing voices while an admin fills out the rest of Settings is
 * harmless; the write itself is still admin-gated above).
 */
tenantSettingsRouter.get("/voices", requireTenantAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const voices = await listElevenLabsVoices();
    res.json(voices);
  } catch (error) {
    if (error instanceof ElevenLabsNotConfiguredError) {
      res.status(503).json({ error: "ElevenLabs is not configured on this server." });
      return;
    }
    if (error instanceof ElevenLabsTimeoutError) {
      res.status(504).json({ error: error.message });
      return;
    }
    if (error instanceof ElevenLabsRequestError) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
  }
});

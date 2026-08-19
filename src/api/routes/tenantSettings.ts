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
import { getTenantById, getTenantTwilioRouting, insertVipLead, updateTenant } from "../../db/supabase.js";
import { DEFAULT_VOICE_ID, ElevenLabsNotConfiguredError, ElevenLabsRequestError, ElevenLabsTimeoutError, listElevenLabsVoices } from "../../telephony/elevenLabsTts.js";
import type { ElevenLabsVoice } from "../../telephony/elevenLabsTts.js";
import type { BusinessType, ToneOfVoice, Weekday, WorkingHours } from "../../types/index.js";
import { requireTenantAdmin, requireTenantAuth } from "../middleware/auth.js";
import { threatShieldRateLimiter } from "../middleware/security.js";

export const tenantSettingsRouter: express.Router = express.Router({ mergeParams: true });

/**
 * Starter/DIY plan hard limit: a curated subset of ElevenLabs' own
 * premade voices (not tenant-cloned/uploaded voices, which cost more and
 * are a VIP-only capability) — chosen for working well in Romanian via
 * eleven_multilingual_v2, plus one voice that's actually native Romanian.
 * VIP tenants can pick any voice GET /voices below returns; Starter
 * tenants are restricted to this list (or the platform default,
 * elevenlabsVoiceId === null) — enforced in the PATCH handler below, not
 * just hidden in the UI.
 *
 * IDs verified live against GET /v1/voices and a real Romanian-text
 * synthesis call on this account (the previous list here — Rachel/Domi/
 * Bella — had drifted: ElevenLabs' default premade roster changed and
 * those names/IDs no longer match what the API actually returns; George/
 * Adam/Laura/Ana Maria below are current as of this update).
 *
 * DEFAULT_VOICE_ID leads the list — it's the platform's primary default
 * (elevenLabsTts.ts), always explicitly selectable regardless of plan,
 * not just an implicit fallback for a null elevenlabsVoiceId.
 */
const STARTER_ALLOWED_VOICE_IDS: readonly string[] = [
  DEFAULT_VOICE_ID, // Voce Principală CostelMedia — platform primary default
  "JBFqnCBsd6RMkjVDRZzb", // George — warm, works well for ro-RO via multilingual_v2
  "pNInz6obpgDQGcFmaJgB", // Adam
  "FGY2WhTYpPnrIDTdsKH5", // Laura
  "urzoE6aZYmSRdFQ6215h", // Ana Maria — native Romanian voice, not multilingual-adapted
];

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

      // Needed up front (not just where it's used below) — both the
      // voice and systemPromptOverride checks below are gated on the
      // tenant's CURRENT plan, not anything in this request body (plan
      // itself is never settable through this route — see updateTenantPlan,
      // super-admin only).
      const currentTenant = await getTenantById(req.params.tenantId);
      if (!currentTenant) {
        res.status(404).json({ error: "Unknown tenant." });
        return;
      }

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
        // Starter plan: only the platform default (null) or one of the
        // curated standard voices — a real custom/cloned voice is a VIP
        // capability. VIP tenants can set any voice GET /voices returns
        // (checked, if at all, at the ElevenLabs API layer itself).
        //
        // Only blocks an actual CHANGE to a new disallowed value — not
        // resubmitting the tenant's own already-existing value unchanged.
        // Without that distinction, a tenant that already had a non-
        // standard voice set before this limit existed (or was downgraded
        // from VIP) would get 403'd on every future Settings save just
        // for the rest of the form re-submitting a field it never touched.
        const voiceIsChanging = body.elevenlabsVoiceId !== currentTenant.elevenlabsVoiceId;
        if (currentTenant.plan === "starter" && body.elevenlabsVoiceId !== null && voiceIsChanging && !STARTER_ALLOWED_VOICE_IDS.includes(body.elevenlabsVoiceId)) {
          res.status(403).json({
            error: "PLAN_LIMIT",
            message: "Custom voice selection is a VIP feature. Starter plan tenants can use the platform default or one of the standard voices.",
          });
          return;
        }
        patch.elevenlabsVoiceId = body.elevenlabsVoiceId;
      }

      if (body.systemPromptOverride !== undefined) {
        if (body.systemPromptOverride !== null && (typeof body.systemPromptOverride !== "string" || body.systemPromptOverride.length > 4000)) {
          res.status(400).json({ error: "systemPromptOverride must be a string of 4000 characters or fewer, or null." });
          return;
        }
        // Starter plan: default system prompt templates only — custom
        // instructions are a VIP feature. Clearing an existing override
        // (setting it to null) is always allowed even on Starter, e.g.
        // after a plan downgrade, so a tenant is never stuck unable to
        // remove their own text — and, same reasoning as the voice check
        // above, resubmitting an already-existing non-null override
        // UNCHANGED is also allowed, so a tenant who had one set before
        // this limit existed isn't blocked from saving anything else in
        // this form ever again. Only a genuine change to new custom text
        // is what actually requires VIP.
        const promptIsChanging = body.systemPromptOverride !== currentTenant.systemPromptOverride;
        if (currentTenant.plan === "starter" && body.systemPromptOverride !== null && promptIsChanging) {
          res.status(403).json({
            error: "PLAN_LIMIT",
            message: "Custom AI instructions are a VIP feature. Starter plan tenants use the default prompt template for their industry.",
          });
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
 * Pinned as literal Option #1 in the Settings voice picker — see
 * elevenLabsTts.ts's own comment on DEFAULT_VOICE_ID for why this can't
 * just come from listElevenLabsVoices() below: it's an ElevenLabs public-
 * library voice, not one added to this account's "My Voices", so
 * GET /v1/voices never returns it even though synthesizing with it works
 * fine. Placed first unconditionally, ahead of whatever order ElevenLabs
 * itself returns the rest in.
 */
const PRIMARY_DEFAULT_VOICE: ElevenLabsVoice = {
  voiceId: DEFAULT_VOICE_ID,
  name: "Voce Principală CostelMedia",
  previewUrl: null,
  category: "platform-default",
};

/**
 * Any authenticated staff member (not admin-only — a non-admin staffer
 * previewing voices while an admin fills out the rest of Settings is
 * harmless; the write itself is still admin-gated above).
 */
tenantSettingsRouter.get("/voices", requireTenantAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const voices = await listElevenLabsVoices();
    // De-duped in case ElevenLabs' own listing ever does start returning
    // this ID (e.g. if it gets added to "My Voices" later) — PRIMARY_DEFAULT_VOICE
    // still wins that slot with its CostelMedia label, not whatever name
    // the live API would give it.
    res.json([PRIMARY_DEFAULT_VOICE, ...voices.filter((voice) => voice.voiceId !== DEFAULT_VOICE_ID)]);
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

/**
 * GET /phone — backs the "Phone Setup" tab (SettingsPage.tsx): the
 * tenant's own assigned Twilio inbound number (the "virtual entry
 * number" calls/missed-call-forwarding get pointed at) plus whether
 * WhatsApp is enabled on it. Deliberately narrow — getTenantTwilioRouting
 * also returns accountSid/authToken, which never leave the backend; only
 * the two fields actually safe to show a tenant_admin are picked out here.
 */
tenantSettingsRouter.get("/phone", requireTenantAuth, async (req: Request<{ tenantId: string }>, res: Response, next: NextFunction) => {
  try {
    const routing = await getTenantTwilioRouting(req.params.tenantId);
    if (!routing) {
      res.status(404).json({ error: "Unknown tenant." });
      return;
    }
    res.json({ twilioPhoneNumber: routing.phoneNumber, whatsappEnabled: routing.whatsappEnabled });
  } catch (error) {
    next(error);
  }
});

interface VipLeadBody {
  requestedIntegrations?: unknown;
  message?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

const MAX_VIP_LEAD_MESSAGE_LENGTH = 2000;

/**
 * POST /vip-leads — "Request VIP Integration" (SettingsPage.tsx's
 * Integrations tab): captures a lead for manual, human-led high-ticket
 * onboarding (custom CRM/ERP/WhatsApp sync, etc.) — see the migration's
 * own comment for why this never auto-upgrades the tenant's plan. Any
 * authenticated tenant member can submit one (not admin-only — flagging
 * interest isn't a configuration change), rate-limited the same as other
 * authenticated-but-should-not-be-spammable actions.
 */
tenantSettingsRouter.post(
  "/vip-leads",
  requireTenantAuth,
  threatShieldRateLimiter,
  async (req: Request<{ tenantId: string }, unknown, VipLeadBody>, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const requestedIntegrations = Array.isArray(body.requestedIntegrations)
        ? body.requestedIntegrations.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
        : [];

      if (body.message !== undefined && body.message !== null && (typeof body.message !== "string" || body.message.length > MAX_VIP_LEAD_MESSAGE_LENGTH)) {
        res.status(400).json({ error: `message must be a string of ${MAX_VIP_LEAD_MESSAGE_LENGTH} characters or fewer, or null.` });
        return;
      }
      if (body.contactEmail !== undefined && body.contactEmail !== null && typeof body.contactEmail !== "string") {
        res.status(400).json({ error: "contactEmail must be a string or null." });
        return;
      }
      if (body.contactPhone !== undefined && body.contactPhone !== null && typeof body.contactPhone !== "string") {
        res.status(400).json({ error: "contactPhone must be a string or null." });
        return;
      }

      const lead = await insertVipLead({
        tenantId: req.params.tenantId,
        requestedIntegrations,
        message: body.message ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
      });
      res.status(201).json(lead);
    } catch (error) {
      next(error);
    }
  },
);

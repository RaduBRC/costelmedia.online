/**
 * Typed Express API exposing the backend engines (Groq agent, calendar,
 * Supabase data layer) over HTTP for the dashboard/chat frontend, plus
 * inbound channel webhooks, the voice call webhook, and a health check.
 *
 * Every tenant-data route requires a verified Supabase session
 * (requireTenantAuth) — `req.tenantId` comes from the caller's JWT, never
 * from a client-supplied URL param or body field, which is what actually
 * makes cross-tenant access impossible at this layer (RLS is the backstop
 * for direct-from-browser Supabase access; this is the backstop for this
 * API). Inbound channel webhooks authenticate differently (Twilio request
 * signatures, or requireApiKey) since there's no user session on those
 * requests — see src/api/webhooks.ts. /health is intentionally open.
 *
 * NOTE: the dashboard frontend built in an earlier pass has no login flow
 * yet — it was built before this auth layer existed, and calls these
 * routes with no Authorization header at all. Wrapping the routes in
 * requireTenantAuth (as the security-hardening pass required) means that
 * frontend will now get 401s until real Supabase Auth sign-in is wired
 * in — that's expected, not a regression to silently work around.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { computeClientRetentionRatePct, getTenantDashboardMetrics } from "../analytics/statsEngine.js";
import { bookSlot, getAvailableSlots } from "../calendar/googleCalendarEngine.js";
import {
  countAppointments,
  getClientProfileById,
  getTenantById,
  listAppointments,
  listClientProfiles,
  upsertPushSubscription,
} from "../db/supabase.js";
import type { AnalyticsTimeframe, AppointmentStatus, BookingChannel } from "../types/index.js";
import { processClientMessage } from "../agent/groqAgent.js";
import { MAX_CHAT_INPUT_LENGTH } from "../agent/guardrails.js";
import type { PushPlatform } from "../db/supabase.js";
import { healthRouter } from "../api/health.js";
import { requireTenantAuth } from "../api/middleware/auth.js";
import { chatRateLimiter, JSON_BODY_LIMIT, securityHeaders, signupRateLimiter, threatShieldRateLimiter } from "../api/middleware/security.js";
import { autoConfigureRouter } from "../api/routes/autoConfigure.js";
import { faqsRouter } from "../api/routes/faqs.js";
import { googleIntegrationTenantRouter, googleOAuthCallbackRouter } from "../api/routes/googleIntegration.js";
import { servicesRouter } from "../api/routes/services.js";
import { superAdminRouter } from "../api/routes/superAdmin.js";
import { tenantSettingsRouter } from "../api/routes/tenantSettings.js";
import { ttsRouter } from "../api/routes/tts.js";
import { widgetRouter } from "../api/routes/widget.js";
import { widgetChatRouter } from "../api/routes/widgetChat.js";
import { tenantProvisioningRouter } from "../api/tenantProvisioning.js";
import { webhooksRouter } from "../api/webhooks.js";
import { voiceRouter } from "../telephony/voiceHandler.js";
import { threatSentinel } from "../security/threatSentinelMiddleware.js";
import { GENERIC_BLOCKED_REPLY } from "../security/threatSentinel.js";

const VALID_STATUSES: readonly AppointmentStatus[] = ["confirmed", "cancelled", "rescheduled"];
const VALID_PLATFORMS: readonly PushPlatform[] = ["android", "ios", "web"];
const VALID_TIMEFRAMES: readonly AnalyticsTimeframe[] = ["7d", "30d", "all"];

function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

function isPushPlatform(value: unknown): value is PushPlatform {
  return typeof value === "string" && (VALID_PLATFORMS as readonly string[]).includes(value);
}

function isAnalyticsTimeframe(value: unknown): value is AnalyticsTimeframe {
  return typeof value === "string" && (VALID_TIMEFRAMES as readonly string[]).includes(value);
}

function todayInTimezone(timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  // en-CA formats as YYYY-MM-DD.
  return formatter.format(new Date());
}

/** Wraps an async route handler so a rejected promise reaches the error middleware instead of crashing the process. */
function asyncRoute<P, ResBody, ReqBody, ReqQuery>(
  handler: (req: Request<P, ResBody, ReqBody, ReqQuery>, res: Response) => Promise<void>,
) {
  return (req: Request<P, ResBody, ReqBody, ReqQuery>, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function createApp(): express.Express {
  const app = express();
  // Behind a proxy (Render, etc.) — needed for req.protocol/req.ip to
  // reflect X-Forwarded-* correctly (Twilio signature verification and the
  // IP-keyed rate limiter both depend on this). Trusting a specific hop
  // count, not `true` (trust every proxy in the chain) — the latter lets a
  // client trivially spoof their own X-Forwarded-For and bypass IP-based
  // rate limiting entirely. Render sits exactly one reverse proxy in front
  // of the app; adjust TRUST_PROXY_HOPS if that topology ever changes.
  app.set("trust proxy", Number(process.env["TRUST_PROXY_HOPS"] ?? 1));
  app.use(securityHeaders);

  // The embeddable widget (GET /widget.js, POST /api/v1/widget/chat) is
  // loaded by arbitrary third-party business websites — there's no origin
  // allowlist to check it against, so it sets its own unconditional CORS
  // headers and must be mounted *before* the ALLOWED_ORIGINS-scoped
  // middleware below, which would otherwise swallow its OPTIONS preflight
  // with a same-origin-only response.
  app.use(widgetRouter);
  app.use("/api/v1/widget", widgetChatRouter);

  // CORS for the Vite dev server / the split-origin production deploy
  // (Vercel frontend + Render API — see vercel.json/render.yaml). A
  // hand-rolled header beats pulling in the `cors` package for this.
  //
  // With ALLOWED_ORIGINS set (required in production — see
  // src/utils/prodChecklist.ts), only those exact origins get an
  // Access-Control-Allow-Origin echoed back; anything else is silently
  // left without the header, which browsers treat as a same-origin-only
  // response. Unset (local dev default) falls back to wildcard.
  const allowedOrigins = process.env["ALLOWED_ORIGINS"]
    ?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestOrigin = req.get("Origin");
    if (allowedOrigins && allowedOrigins.length > 0) {
      if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
        res.setHeader("Vary", "Origin");
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(healthRouter);
  // Webhooks parse their own body (form-encoded for Twilio, JSON for the
  // generic route) and authenticate via signature/API key, not a user
  // session — mounted before the global json() parser so nothing double-
  // parses the body. Same for the voice webhook (also Twilio-signed,
  // form-encoded).
  app.use("/api/v1/webhooks", webhooksRouter);
  app.use("/api/v1/voice", voiceRouter);

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Public (no requireTenantAuth — there's no session yet at sign-up time),
  // so it gets its own much stricter rate limit instead.
  app.use("/api/v1/tenants", signupRateLimiter, tenantProvisioningRouter);

  // Also unauthenticated, for the same structural reason (Google's
  // redirect back to us carries no session) — see googleIntegration.ts's
  // file header for why this can't live under /api/tenants/:tenantId/...
  // like every other route below.
  app.use("/api/integrations/google", googleOAuthCallbackRouter);

  // Staff-only TTS for the dashboard's Voice Call Simulator — not
  // tenant-scoped in the URL (no :tenantId segment), just
  // requireTenantAuth confirming the caller is *some* authenticated staff
  // member, which is all this needs.
  app.use("/api/tts", ttsRouter);
  app.use("/api/tenants/:tenantId/services", servicesRouter);
  app.use("/api/tenants/:tenantId/faqs", faqsRouter);
  app.use("/api/tenants/:tenantId/integrations/google", googleIntegrationTenantRouter);
  app.use("/api/tenants/:tenantId/auto-configure", autoConfigureRouter);
  app.use("/api/tenants/:tenantId", tenantSettingsRouter);
  app.use("/api/super-admin", superAdminRouter);

  app.get(
    "/api/tenants/:tenantId",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, unknown, unknown>(async (req, res) => {
      const tenant = await getTenantById(req.params.tenantId);
      if (!tenant) {
        res.status(404).json({ error: `Unknown tenant: ${req.params.tenantId}` });
        return;
      }
      res.json(tenant);
    }),
  );

  app.get(
    "/api/tenants/:tenantId/appointments",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, unknown, { status?: string; from?: string; to?: string }>(async (req, res) => {
      const { status, from, to } = req.query;
      if (status !== undefined && !isAppointmentStatus(status)) {
        res.status(400).json({ error: `Invalid status "${status}".` });
        return;
      }
      const appointments = await listAppointments(req.params.tenantId, {
        ...(status !== undefined ? { status } : {}),
        ...(from !== undefined ? { fromIso: from } : {}),
        ...(to !== undefined ? { toIso: to } : {}),
      });
      res.json(appointments);
    }),
  );

  app.get(
    "/api/tenants/:tenantId/clients",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, unknown, unknown>(async (req, res) => {
      const clients = await listClientProfiles(req.params.tenantId);
      res.json(clients);
    }),
  );

  app.get(
    "/api/tenants/:tenantId/slots",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, unknown, { date?: string; durationMinutes?: string }>(async (req, res) => {
      const { date, durationMinutes } = req.query;
      if (!date) {
        res.status(400).json({ error: "Query param 'date' (YYYY-MM-DD) is required." });
        return;
      }
      const duration = durationMinutes ? Number(durationMinutes) : 30;
      if (!Number.isFinite(duration) || duration <= 0) {
        res.status(400).json({ error: "Query param 'durationMinutes' must be a positive number." });
        return;
      }
      const slots = await getAvailableSlots(req.params.tenantId, date, duration);
      res.json(slots);
    }),
  );

  app.get(
    "/api/tenants/:tenantId/metrics",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, unknown, unknown>(async (req, res) => {
      const tenant = await getTenantById(req.params.tenantId);
      if (!tenant) {
        res.status(404).json({ error: `Unknown tenant: ${req.params.tenantId}` });
        return;
      }

      const [totalAppointments, appointments, clients] = await Promise.all([
        countAppointments(req.params.tenantId),
        listAppointments(req.params.tenantId, { status: "confirmed" }),
        listClientProfiles(req.params.tenantId),
      ]);

      const clientRetentionRate = computeClientRetentionRatePct(appointments);
      const availableSlotsToday = (await getAvailableSlots(req.params.tenantId, todayInTimezone(tenant.timezone), 30)).filter(
        (slot) => slot.available,
      ).length;

      res.json({ totalAppointments, availableSlotsToday, clientRetentionRate, totalClients: clients.length });
    }),
  );

  app.get(
    "/api/tenants/:tenantId/analytics",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, unknown, { timeframe?: string }>(async (req, res) => {
      const timeframe = req.query.timeframe ?? "30d";
      if (!isAnalyticsTimeframe(timeframe)) {
        res.status(400).json({ error: "Query param 'timeframe' must be '7d', '30d', or 'all'." });
        return;
      }
      const metrics = await getTenantDashboardMetrics(req.params.tenantId, timeframe);
      res.json(metrics);
    }),
  );

  app.post(
    "/api/tenants/:tenantId/chat",
    requireTenantAuth,
    chatRateLimiter,
    threatShieldRateLimiter,
    threatSentinel({
      // Defaults to "ai_chat" — every existing caller (ChatSimulator.tsx,
      // any external integration) omits `channel` and keeps working
      // exactly as before. The in-browser Voice Call Simulator
      // (VoiceCallSimulator.tsx) is the one caller that sends
      // `channel: "ai_voice"`, so its traffic is correctly attributed in
      // security_logs instead of being mislabeled as text chat.
      channel: (req) => {
        const body = req.body as { channel?: unknown } | undefined;
        return body?.channel === "ai_voice" ? "ai_voice" : "ai_chat";
      },
      onBlocked: (_req, res) => {
        res.json({
          reply: GENERIC_BLOCKED_REPLY,
          toneAssessment: { urgency: 1, formality: 3, sentiment: "neutral", toneNote: "" },
          actionsTaken: [],
        });
      },
    }),
    asyncRoute<{ tenantId: string }, unknown, { clientPhone?: string; message?: string; channel?: string }, unknown>(async (req, res) => {
      const { clientPhone, message, channel } = req.body;
      if (!clientPhone || !message) {
        res.status(400).json({ error: "Body must include clientPhone and message." });
        return;
      }
      if (message.length > MAX_CHAT_INPUT_LENGTH) {
        res.status(400).json({ error: `message must be ${MAX_CHAT_INPUT_LENGTH} characters or fewer.` });
        return;
      }
      // Only "ai_voice" is accepted as an override — anything else
      // (including garbage input) falls back to the original, always-safe
      // "ai_chat" default rather than trusting an arbitrary client-supplied
      // BookingChannel value.
      const resolvedChannel: BookingChannel = channel === "ai_voice" ? "ai_voice" : "ai_chat";
      const result = await processClientMessage(req.params.tenantId, clientPhone, message, resolvedChannel);
      res.json(result);
    }),
  );

  /**
   * Staff-created bookings — bypasses the AI agent entirely (no tone pass,
   * no Groq call). This is what src/db/offlineDb.ts's sync queue and
   * public/sw-advanced.js's background `sync` handler both POST to once
   * connectivity returns, and what a staff member using the dashboard
   * directly would call too.
   */
  app.post(
    "/api/tenants/:tenantId/appointments/manual",
    requireTenantAuth,
    threatShieldRateLimiter,
    asyncRoute<
      { tenantId: string },
      unknown,
      { phoneNumber?: string; fullName?: string; serviceType?: string; startTime?: string; durationMinutes?: number },
      unknown
    >(async (req, res) => {
      const { phoneNumber, fullName, serviceType, startTime, durationMinutes } = req.body;
      if (!phoneNumber || !fullName || !serviceType || !startTime || !durationMinutes) {
        res.status(400).json({ error: "Body must include phoneNumber, fullName, serviceType, startTime, and durationMinutes." });
        return;
      }
      const confirmation = await bookSlot(req.params.tenantId, {
        phoneNumber,
        fullName,
        serviceType,
        startTime,
        durationMinutes,
        bookingChannel: "staff_manual",
      });
      res.status(201).json(confirmation);
    }),
  );

  app.post(
    "/api/tenants/:tenantId/push-subscriptions",
    requireTenantAuth,
    asyncRoute<{ tenantId: string }, unknown, { userId?: string; platform?: string; target?: Record<string, unknown> }, unknown>(
      async (req, res) => {
        const { userId, platform, target } = req.body;
        if (!userId || !isPushPlatform(platform) || !target) {
          res.status(400).json({ error: "Body must include userId, platform ('android'|'ios'|'web'), and target." });
          return;
        }
        // userId is a client_profiles.id — confirm it actually belongs to
        // this tenant before registering a push target for it, otherwise
        // an authenticated tenant-A user could register (or overwrite) a
        // subscription for a tenant-B client whose id they guessed.
        const client = await getClientProfileById(req.params.tenantId, userId);
        if (!client) {
          res.status(404).json({ error: `No client ${userId} in this tenant.` });
          return;
        }
        await upsertPushSubscription(userId, platform, target);
        res.status(204).send();
      },
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error." });
  });

  return app;
}

/**
 * Rate limiting and security headers applied at the app level (see
 * src/server/app.ts). Both limiters are in-memory (express-rate-limit's
 * default store) — appropriate for the single-instance Node deployment
 * this project targets (see render.yaml); a multi-instance deployment
 * would need a shared store (Redis, or express-rate-limit's Supabase-backed
 * store) so limits are enforced across instances, not per-instance.
 */
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler, Request } from "express";

/** Express body-parser limit for JSON/urlencoded payloads — rejects oversized request bodies before they reach a route handler. */
export const JSON_BODY_LIMIT = "10kb";

/** Public webhooks (Twilio, generic inbound): capped per source IP. */
export const webhookRateLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." },
});

/**
 * Keys by the phone number the message is about when one is present in the
 * body (chat's `clientPhone`, Twilio's `From`) — a caller can't just rotate
 * IPs to bypass the per-conversation limit. Falls back to IP for requests
 * with no identifiable phone (defensive; shouldn't normally happen on the
 * routes this is mounted on).
 */
function chatRateLimitKey(req: Request): string {
  const body = req.body as Record<string, unknown> | undefined;
  const phone = body?.["clientPhone"] ?? body?.["From"];
  if (typeof phone === "string" && phone.length > 0) {
    return phone;
  }
  // IPv6-safe fallback: express-rate-limit's own helper normalizes an IPv6
  // address to its /64 prefix, so a client can't dodge the limit just by
  // requesting a fresh address from their /64 block.
  return ipKeyGenerator(req.ip ?? "unknown");
}

/** Chat/voice-transcript ingestion: capped per phone number/session, not just per IP. */
export const chatRateLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chatRateLimitKey,
  message: { error: "Too many messages. Please slow down." },
});

/**
 * Public embeddable widget chat (src/api/routes/widgetChat.ts): fully
 * anonymous — no session, no API key, nothing to key by except IP. At
 * least as strict as the authenticated chat limiter, since every request
 * here triggers a real Groq call at zero cost to the caller.
 */
export const widgetRateLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "Too many messages. Please try again in a moment." },
});

/**
 * AI Security & Threat Countermeasure module (src/security/): a stricter,
 * IP-keyed 10/min ceiling layered on top of the existing per-endpoint
 * limiters above (chatRateLimiter, widgetRateLimiter, webhookRateLimiter),
 * not a replacement for them — those stay exactly as they were. Applied
 * to every chat entry point and the manual-booking endpoint per the
 * "chat and booking API endpoints" security-hardening request.
 */
export const threatShieldRateLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "Too many requests from this address. Please try again in a moment." },
});

/**
 * Auto-configurator (src/api/routes/autoConfigure.ts): authenticated and
 * admin-gated already, but still worth its own limiter — one call here
 * triggers a real Groq JSON-mode completion plus several DB inserts
 * (services, FAQs), and the feature is meant to be used a handful of
 * times per tenant (initial onboarding, an occasional "regenerate"), not
 * repeatedly — a compromised session shouldn't be able to run up a real
 * Groq bill or spam a tenant's services/FAQ tables in a loop.
 */
export const autoConfigureRateLimiter: RequestHandler = rateLimit({
  windowMs: 10 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auto-configure requests. Please try again in a few minutes." },
});

/**
 * Tenant self-registration (src/api/tenantProvisioning.ts): unauthenticated
 * by nature (you're creating the account), which makes it the most
 * abuse-prone route in the app — each request creates a real Supabase Auth
 * user and a tenant. Much stricter than the general webhook limit.
 */
export const signupRateLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again later." },
});

/**
 * Helmet with a locked-down but API-appropriate CSP. This API mostly
 * returns JSON/TwiML XML rather than HTML, so CSP matters less here than
 * on the frontend — it's still set for defense in depth and because
 * `helmet()` bundles HSTS and X-Frame-Options (`frameguard`), which do
 * matter for any HTML error pages a proxy might inject.
 *
 * `crossOriginResourcePolicy: "cross-origin"` is deliberate, not an
 * oversight: the frontend and this API are different origins by design
 * (Vercel + Render — see vercel.json/render.yaml), so the stricter
 * "same-site" default would break every legitimate request.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

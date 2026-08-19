/**
 * POST /api/v1/tenants/register — lightweight tenant self-registration
 * (email/password: creates BOTH the auth user and the tenant together).
 * Public by nature (you're creating the account, so there's no session to
 * authenticate with yet), which makes it the most abuse-prone route in the
 * app — see signupRateLimiter in src/api/middleware/security.ts.
 *
 * POST /api/v1/tenants/onboard — the other half of that same job, for a
 * user who's already authenticated but owns no tenant yet: specifically,
 * someone who just completed Google sign-in (AuthContext.tsx's
 * loginWithGoogle). Supabase's OAuth flow only ever creates the auth
 * user; it has no concept of "and also create this business's tenant",
 * so that step has to happen here instead, once there's a real session to
 * attach it to.
 *
 * "Single transaction-like flow": a literal DB transaction can't span
 * either of these — creating the auth user is a GoTrue Admin API call and
 * creating the tenant is a separate PostgREST call, two different
 * Supabase subsystems the JS client has no way to wrap in one SQL
 * transaction. /register uses a compensating action instead: if the
 * tenant insert fails after the auth user was successfully created, the
 * auth user is deleted so no orphaned account is left behind with no
 * tenant to sign into. /onboard doesn't need this — the auth user already
 * exists independently of this call succeeding or not.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createAuthUser, deleteAuthUser, getAuthUserByEmail, getTenantByOwnerUserId, insertTenant } from "../db/supabase.js";
import { requireAuthenticatedUser } from "./middleware/auth.js";
import type { BusinessType } from "../types/index.js";

export const tenantProvisioningRouter: express.Router = express.Router();

// Kept in sync with the BusinessType union (src/types/index.ts) and
// BUSINESS_TYPE_RULES/BUSINESS_TYPE_LABELS (promptBuilder.ts) — this had
// drifted to only the original 3 verticals from before 013/018 added the
// other 4, silently rejecting a perfectly valid signup for e.g. a salon.
const VALID_BUSINESS_TYPES: readonly BusinessType[] = [
  "restaurant",
  "clinic",
  "callcenter",
  "auto_shop",
  "salon",
  "legal_services",
  "general_services",
];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_BUSINESS_NAME_LENGTH = 200;
// A real, valid Google Calendar API value (the calendar owner's own
// primary calendar) — used only if googleCalendarId is omitted at
// registration. This field mattered a lot more before the local-only
// booking fallback and per-tenant OAuth connect flow existed
// (googleCalendarEngine.ts, src/auth/googleOAuthTokens.ts); asking a
// brand-new business owner to already know their Google Calendar ID
// before they've even signed in is an unnecessary signup-time hurdle
// now that they can connect it for real later from Settings.
const DEFAULT_GOOGLE_CALENDAR_ID = "primary";

function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && (VALID_BUSINESS_TYPES as readonly string[]).includes(value);
}

interface RegisterBody {
  businessName?: string;
  businessType?: string;
  adminEmail?: string;
  adminPassword?: string;
  googleCalendarId?: string;
}

tenantProvisioningRouter.post(
  "/register",
  async (req: Request<unknown, unknown, RegisterBody>, res: Response, next: NextFunction) => {
    try {
      const { businessName, businessType, adminEmail, adminPassword, googleCalendarId } = req.body;

      if (!businessName || !businessName.trim()) {
        res.status(400).json({ error: "businessName is required." });
        return;
      }
      if (businessName.length > MAX_BUSINESS_NAME_LENGTH) {
        res.status(400).json({ error: `businessName must be ${MAX_BUSINESS_NAME_LENGTH} characters or fewer.` });
        return;
      }
      if (!isBusinessType(businessType)) {
        res.status(400).json({ error: `businessType must be one of: ${VALID_BUSINESS_TYPES.join(", ")}.` });
        return;
      }
      if (!adminEmail || !EMAIL_PATTERN.test(adminEmail)) {
        res.status(400).json({ error: "adminEmail must be a valid email address." });
        return;
      }
      if (!adminPassword || adminPassword.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: `adminPassword must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return;
      }
      // googleCalendarId is optional now — see DEFAULT_GOOGLE_CALENDAR_ID
      // above for why. Still rejects an explicitly-provided-but-blank
      // string rather than silently falling back, since that's more
      // likely a client bug than an intentional omission.
      if (googleCalendarId !== undefined && !googleCalendarId.trim()) {
        res.status(400).json({ error: "googleCalendarId, if provided, must not be blank." });
        return;
      }

      // Every field is validated (and, for businessType, narrowed to
      // BusinessType) above the equivalent of req.body's optional fields.

      const existing = await getAuthUserByEmail(adminEmail);
      if (existing) {
        res.status(409).json({ error: "An account with this email already exists." });
        return;
      }

      const adminUser = await createAuthUser(adminEmail, adminPassword);

      try {
        const tenant = await insertTenant({
          ownerUserId: adminUser.id,
          name: businessName.trim(),
          businessType,
          googleCalendarId: googleCalendarId?.trim() || DEFAULT_GOOGLE_CALENDAR_ID,
        });

        res.status(201).json({
          tenantId: tenant.id,
          adminUserId: adminUser.id,
          message: "Tenant registered. Sign in with the admin email and password you provided.",
        });
      } catch (tenantError) {
        await deleteAuthUser(adminUser.id).catch((cleanupError: unknown) => {
          console.error(`Failed to roll back auth user ${adminUser.id} after tenant creation failure:`, cleanupError);
        });
        throw tenantError;
      }
    } catch (error) {
      next(error);
    }
  },
);

interface OnboardBody {
  businessName?: string;
  businessType?: string;
  googleCalendarId?: string;
}

tenantProvisioningRouter.post(
  "/onboard",
  requireAuthenticatedUser,
  async (req: Request<unknown, unknown, OnboardBody>, res: Response, next: NextFunction) => {
    try {
      const { businessName, businessType, googleCalendarId } = req.body;

      // Idempotent, not an error: a returning Google-authenticated user
      // who already owns a tenant hitting this (e.g. a stale tab, a
      // double-click) just gets their existing tenant back rather than a
      // confusing failure — the frontend's own check (AuthContext's
      // tenantId claim) should normally prevent this call from happening
      // at all, but defending it here too costs nothing.
      const ownerUserId = req.userId as string;
      const existingTenant = await getTenantByOwnerUserId(ownerUserId);
      if (existingTenant) {
        res.status(200).json({ tenantId: existingTenant.id, message: "This account already has a tenant." });
        return;
      }

      if (!businessName || !businessName.trim()) {
        res.status(400).json({ error: "businessName is required." });
        return;
      }
      if (businessName.length > MAX_BUSINESS_NAME_LENGTH) {
        res.status(400).json({ error: `businessName must be ${MAX_BUSINESS_NAME_LENGTH} characters or fewer.` });
        return;
      }
      if (!isBusinessType(businessType)) {
        res.status(400).json({ error: `businessType must be one of: ${VALID_BUSINESS_TYPES.join(", ")}.` });
        return;
      }
      if (googleCalendarId !== undefined && !googleCalendarId.trim()) {
        res.status(400).json({ error: "googleCalendarId, if provided, must not be blank." });
        return;
      }

      const tenant = await insertTenant({
        ownerUserId,
        name: businessName.trim(),
        businessType,
        googleCalendarId: googleCalendarId?.trim() || DEFAULT_GOOGLE_CALENDAR_ID,
      });

      // seed_owner_as_tenant_admin (003_security_rls.sql) has already
      // created the tenant_admin membership and synced the tenant_id/
      // tenant_role claim by the time insertTenant resolves — this
      // response doesn't need to do anything else for that; the frontend
      // just needs to refresh its session to pick the new claim up (see
      // RegisterPage.tsx/OnboardingPage.tsx).
      res.status(201).json({ tenantId: tenant.id, message: "Tenant created." });
    } catch (error) {
      next(error);
    }
  },
);

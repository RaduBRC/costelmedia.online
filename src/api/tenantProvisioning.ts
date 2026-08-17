/**
 * POST /api/v1/tenants/register — lightweight tenant self-registration.
 * Public by nature (you're creating the account, so there's no session to
 * authenticate with yet), which makes it the most abuse-prone route in the
 * app — see signupRateLimiter in src/api/middleware/security.ts.
 *
 * "Single transaction-like flow": a literal DB transaction can't span
 * this — creating the auth user is a GoTrue Admin API call and creating
 * the tenant is a separate PostgREST call, two different Supabase
 * subsystems the JS client has no way to wrap in one SQL transaction.
 * Instead this uses a compensating action: if the tenant insert fails
 * after the auth user was successfully created, the auth user is deleted
 * so no orphaned account is left behind with no tenant to sign into.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createAuthUser, deleteAuthUser, getAuthUserByEmail, insertTenant } from "../db/supabase.js";
import type { BusinessType } from "../types/index.js";

export const tenantProvisioningRouter: express.Router = express.Router();

const VALID_BUSINESS_TYPES: readonly BusinessType[] = ["clinic", "restaurant", "callcenter"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_BUSINESS_NAME_LENGTH = 200;

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
        res.status(400).json({ error: "businessType must be one of 'clinic', 'restaurant', or 'callcenter'." });
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
      if (!googleCalendarId || !googleCalendarId.trim()) {
        res.status(400).json({ error: "googleCalendarId is required." });
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
          googleCalendarId: googleCalendarId.trim(),
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

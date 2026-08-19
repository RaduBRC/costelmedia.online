/**
 * POST /api/tenants/:tenantId/auto-configure — the AI Auto-Configurator
 * ("Auto-Generate Agent Configuration", OnboardingPage.tsx / SettingsPage.tsx).
 * Takes a raw text description of the business and has Groq (JSON mode)
 * generate a starting greeting, services list, FAQ set, and required-
 * booking-fields list — see src/agent/autoConfigurator.ts for the actual
 * generation + persistence logic; this route is just validation, auth,
 * and error-code mapping.
 *
 * Deliberately tenant-scoped (`/api/tenants/:tenantId/auto-configure`,
 * requireTenantAuth + requireTenantAdmin) rather than a bare
 * `/api/tenant/auto-configure` with no id/auth — every other tenant-data
 * mutation in this app works this way (tenantSettings.ts, faqs.ts,
 * services.ts), and an unauthenticated, tenant-less version of this route
 * would have no way to know which tenant's services/FAQs/greeting to
 * actually write, and no way to stop tenant A from configuring tenant B.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { AutoConfigureValidationError, autoConfigureTenant } from "../../agent/autoConfigurator.js";
import { GroqUnavailableError } from "../../agent/groqAgent.js";
import { getTenantById } from "../../db/supabase.js";
import { requireTenantAdmin, requireTenantAuth } from "../middleware/auth.js";
import { autoConfigureRateLimiter } from "../middleware/security.js";

export const autoConfigureRouter: express.Router = express.Router({ mergeParams: true });

const MAX_DESCRIPTION_LENGTH = 2000;

interface AutoConfigureBody {
  description?: string;
}

autoConfigureRouter.post(
  "/",
  requireTenantAuth,
  requireTenantAdmin,
  autoConfigureRateLimiter,
  async (req: Request<{ tenantId: string }, unknown, AutoConfigureBody>, res: Response, next: NextFunction) => {
    try {
      const { description } = req.body;
      if (!description || typeof description !== "string" || !description.trim()) {
        res.status(400).json({ error: "MISSING_DESCRIPTION", message: "Body must include a non-empty description string." });
        return;
      }
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        res.status(400).json({ error: "DESCRIPTION_TOO_LONG", message: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` });
        return;
      }

      const tenant = await getTenantById(req.params.tenantId);
      if (!tenant) {
        res.status(404).json({ error: "TENANT_NOT_FOUND", message: "Unknown tenant." });
        return;
      }

      const result = await autoConfigureTenant(tenant, description);
      res.json(result);
    } catch (error) {
      if (error instanceof AutoConfigureValidationError) {
        // Covers both a bad request (already checked above, defensively
        // re-thrown from autoConfigureTenant too) and the AI response
        // itself failing shape validation — the latter is a real,
        // user-facing "please try rephrasing your description" case, not
        // a 500.
        res.status(422).json({ error: "GENERATION_FAILED", message: error.message });
        return;
      }
      if (error instanceof GroqUnavailableError) {
        console.error(`[Auto-Configurator] Groq request failed for tenant ${req.params.tenantId}:`, error.message);
        res.status(502).json({ error: "AI_SERVICE_UNAVAILABLE", message: "The AI configuration service is temporarily unavailable. Please try again shortly." });
        return;
      }
      next(error);
    }
  },
);

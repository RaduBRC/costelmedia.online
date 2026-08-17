/**
 * Per-tenant Google Calendar OAuth connection.
 *
 * Two separate routers, mounted at two different paths in app.ts, because
 * they're authenticated completely differently:
 *
 *  - googleIntegrationTenantRouter (/api/tenants/:tenantId/integrations/google) —
 *    /status, /auth, /disconnect. Called by the authenticated dashboard via
 *    fetch (Bearer token, requireTenantAuth); tenantId comes from the URL
 *    like every other tenant-scoped route in this app.
 *  - googleOAuthCallbackRouter (/api/integrations/google) — /callback only.
 *    This one is hit by a full-page browser redirect *from Google*, which
 *    carries no Authorization header and must land on the *exact* static
 *    URL registered as this OAuth client's redirect_uri in Google Cloud
 *    Console — it cannot contain a dynamic :tenantId segment, since we
 *    register exactly one redirect_uri, not one per tenant. Tenant
 *    identity instead comes from the signed `state` parameter (see
 *    signOAuthState/verifyOAuthState in googleOAuthTokens.ts) — the only
 *    thing binding this callback back to whichever tenant started the flow.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  connectTenantGoogleAccount,
  disconnectTenantGoogleAccount,
  buildGoogleOAuthConsentUrl,
  GoogleOAuthNotConfiguredError,
  isGoogleOAuthConfigured,
  signOAuthState,
  verifyOAuthState,
} from "../../auth/googleOAuthTokens.js";
import { getGoogleCalendarConnectionStatus } from "../../db/supabase.js";
import { requireTenantAdmin, requireTenantAuth } from "../middleware/auth.js";

export const googleIntegrationTenantRouter: express.Router = express.Router({ mergeParams: true });
export const googleOAuthCallbackRouter: express.Router = express.Router();

/** Where to send the browser back to after /callback — the frontend dashboard's own origin, not this API's. Defaults to the Vite dev server for local development. */
function frontendOrigin(): string {
  return process.env["FRONTEND_ORIGIN"] || "http://localhost:5173";
}

// ---------------------------------------------------------------------------
// Tenant-scoped (authenticated)
// ---------------------------------------------------------------------------

googleIntegrationTenantRouter.get(
  "/status",
  requireTenantAuth,
  async (req: Request<{ tenantId: string }>, res: Response, next: NextFunction) => {
    try {
      const status = await getGoogleCalendarConnectionStatus(req.params.tenantId);
      if (!status) {
        res.status(404).json({ error: `Unknown tenant: ${req.params.tenantId}` });
        return;
      }
      res.json(status);
    } catch (error) {
      next(error);
    }
  },
);

googleIntegrationTenantRouter.get(
  "/auth",
  requireTenantAuth,
  requireTenantAdmin,
  (req: Request<{ tenantId: string }>, res: Response): void => {
    if (!isGoogleOAuthConfigured()) {
      // Plain { error: "<message>" } — this route is consumed through
      // apiFetch (src/lib/api.ts), which surfaces `.error` verbatim as
      // the thrown ApiError's message; unlike /api/tts (a hand-rolled
      // fetch with its own two-field { error: CODE, message } contract),
      // there's no separate reader for a `.message` field here.
      res.status(503).json({
        error: "Google OAuth is not configured on this server (GOOGLE_OAUTH_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI).",
      });
      return;
    }
    const state = signOAuthState(req.params.tenantId);
    res.json({ consentUrl: buildGoogleOAuthConsentUrl(state) });
  },
);

googleIntegrationTenantRouter.delete(
  "/disconnect",
  requireTenantAuth,
  requireTenantAdmin,
  async (req: Request<{ tenantId: string }>, res: Response, next: NextFunction) => {
    try {
      await disconnectTenantGoogleAccount(req.params.tenantId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

googleIntegrationTenantRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof GoogleOAuthNotConfiguredError) {
    res.status(503).json({ error: err.message });
    return;
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Fixed callback URL (unauthenticated — see file header)
// ---------------------------------------------------------------------------

googleOAuthCallbackRouter.get(
  "/callback",
  async (req: Request<unknown, unknown, unknown, { code?: string; state?: string; error?: string }>, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      // The user clicked "Cancel" on Google's consent screen, or Google
      // rejected the request outright — not a bug on our end.
      res.redirect(`${frontendOrigin()}/admin/settings?calendar=error&message=${encodeURIComponent(oauthError)}`);
      return;
    }
    if (!code || !state) {
      res.redirect(`${frontendOrigin()}/admin/settings?calendar=error&message=${encodeURIComponent("Missing code or state in Google's redirect.")}`);
      return;
    }

    const tenantId = verifyOAuthState(state);
    if (!tenantId) {
      res.redirect(
        `${frontendOrigin()}/admin/settings?calendar=error&message=${encodeURIComponent("This connection link expired or is invalid — please try connecting again.")}`,
      );
      return;
    }

    try {
      await connectTenantGoogleAccount(tenantId, code);
      res.redirect(`${frontendOrigin()}/admin/settings?calendar=connected`);
    } catch (error) {
      console.error(`[Google OAuth] Callback failed for tenant ${tenantId}:`, error);
      const message = error instanceof Error ? error.message : "Failed to connect Google Calendar.";
      res.redirect(`${frontendOrigin()}/admin/settings?calendar=error&message=${encodeURIComponent(message)}`);
    }
  },
);

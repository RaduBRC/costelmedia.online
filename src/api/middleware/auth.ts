/**
 * Auth paths for the API:
 *   - requireTenantAuth: browser/dashboard requests carrying a Supabase
 *     user JWT (`Authorization: Bearer <token>`), for a specific tenant.
 *   - requireSuperAdmin: same JWT carrier, but for platform-wide routes
 *     (/api/super-admin/*) — deliberately NOT built on requireTenantAuth,
 *     since a super admin (platform_admins, 003_security_rls.sql) isn't
 *     necessarily a member of any tenant at all and requireTenantAuth
 *     would 403 them for having no tenant_id.
 *   - requireApiKey: server-to-server requests carrying a tenant's API key
 *     (`X-API-Key: <key>`), hashed and compared against
 *     `tenants.api_key_hash` — the raw key is never stored, only its hash.
 *
 * requireTenantAuth attaches `req.tenantId`/`req.tenantRole`; requireSuperAdmin
 * attaches `req.isSuperAdmin`. Downstream handlers never have to trust a
 * client-supplied tenantId (or admin claim) from the URL/body again.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient } from "../../db/supabase.js";
import { getTenantByApiKeyHash } from "../../db/supabase.js";
import type { TenantRole } from "../../types/index.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own module-augmentation pattern.
  namespace Express {
    interface Request {
      tenantId?: string;
      tenantRole?: TenantRole;
      isSuperAdmin?: boolean;
      userId?: string;
    }
  }
}

function isTenantRole(value: unknown): value is TenantRole {
  return value === "tenant_admin" || value === "staff";
}

/**
 * Shared first step for both requireTenantAuth and requireSuperAdmin:
 * pull the bearer token, verify it against Supabase Auth, and return the
 * resolved user. Verification goes through `supabase.auth.getUser(token)`
 * (a call to Supabase Auth) rather than hand-verifying the JWT signature
 * locally: Supabase's signing scheme (HS256 vs rotating asymmetric keys)
 * varies by project configuration, and getting that verification subtly
 * wrong is exactly the kind of security-critical mistake worth not
 * risking — the SDK already does it correctly. Writes the 401 response
 * itself on failure so both callers get identical, correct behavior
 * without duplicating it.
 */
async function verifyBearerToken(req: Request, res: Response): Promise<User | null> {
  const authHeader = req.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;

  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <token> header." });
    return null;
  }

  const { data, error } = await getSupabaseClient().auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired session." });
    return null;
  }
  return data.user;
}

/**
 * Validates a Supabase user JWT and attaches the authenticated user's
 * tenant to the request. If the route also carries a `:tenantId` URL
 * param, that param must match the token's tenant — otherwise an
 * authenticated user from tenant A could read tenant B's data just by
 * changing the URL.
 */
export async function requireTenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await verifyBearerToken(req, res);
  if (!user) return;

  // `app_metadata` is typed `[key: string]: any` upstream — read through
  // `unknown` rather than letting that `any` propagate into this function.
  const appMetadata: unknown = user.app_metadata;
  const tenantId = (appMetadata as Record<string, unknown> | null)?.["tenant_id"];
  const tenantRole = (appMetadata as Record<string, unknown> | null)?.["tenant_role"];

  if (typeof tenantId !== "string" || !tenantId) {
    res.status(403).json({ error: "This user is not associated with a tenant." });
    return;
  }

  const routeTenantId = req.params["tenantId"];
  if (routeTenantId && routeTenantId !== tenantId) {
    res.status(403).json({ error: "You do not have access to this tenant." });
    return;
  }

  req.tenantId = tenantId;
  if (isTenantRole(tenantRole)) {
    req.tenantRole = tenantRole;
  }
  next();
}

/**
 * Validates a Supabase user JWT and attaches only `req.userId` — no
 * tenant_id required. For the one gap requireTenantAuth deliberately
 * doesn't cover: a real, already-authenticated user (e.g. just completed
 * Google sign-in) who doesn't own a tenant *yet* — see POST
 * /api/v1/tenants/onboard (src/api/tenantProvisioning.ts), which is the
 * only route that needs exactly this.
 */
export async function requireAuthenticatedUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await verifyBearerToken(req, res);
  if (!user) return;
  req.userId = user.id;
  next();
}

/** Requires `requireTenantAuth` (or requireApiKey) to have already run and attached req.tenantRole. */
export function requireTenantAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.tenantRole !== "tenant_admin") {
    res.status(403).json({ error: "This action requires the tenant_admin role." });
    return;
  }
  next();
}

/**
 * Validates a Supabase user JWT and requires the `is_super_admin` claim
 * (synced from platform_admins by 021_super_admin_claim_sync.sql) — a
 * platform-wide capability, not scoped to any tenant, so this never reads
 * or requires `:tenantId` the way requireTenantAuth does.
 */
export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await verifyBearerToken(req, res);
  if (!user) return;

  const appMetadata: unknown = user.app_metadata;
  const isSuperAdmin = (appMetadata as Record<string, unknown> | null)?.["is_super_admin"];

  if (isSuperAdmin !== true) {
    res.status(403).json({ error: "This action requires super admin access." });
    return;
  }

  req.isSuperAdmin = true;
  next();
}

/**
 * Validates a server-to-server request's `X-API-Key` header against the
 * requesting tenant's hashed key. Only the SHA-256 hash is ever compared —
 * the raw key exists only at issuance time and in the caller's hands.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.get("X-API-Key");
  if (!apiKey) {
    res.status(401).json({ error: "Missing X-API-Key header." });
    return;
  }

  const apiKeyHash = createHash("sha256").update(apiKey, "utf8").digest("hex");
  const tenant = await getTenantByApiKeyHash(apiKeyHash);
  if (!tenant) {
    res.status(401).json({ error: "Invalid API key." });
    return;
  }

  req.tenantId = tenant.id;
  next();
}

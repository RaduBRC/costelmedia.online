/**
 * Two authentication paths for the API:
 *   - requireTenantAuth: browser/dashboard requests carrying a Supabase
 *     user JWT (`Authorization: Bearer <token>`).
 *   - requireApiKey: server-to-server requests carrying a tenant's API key
 *     (`X-API-Key: <key>`), hashed and compared against
 *     `tenants.api_key_hash` — the raw key is never stored, only its hash.
 *
 * Both attach `req.tenantId` (and, for JWT auth, `req.tenantRole`) so
 * downstream handlers never have to trust a client-supplied tenantId from
 * the URL/body again.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getSupabaseClient } from "../../db/supabase.js";
import { getTenantByApiKeyHash } from "../../db/supabase.js";
import type { TenantRole } from "../../types/index.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own module-augmentation pattern.
  namespace Express {
    interface Request {
      tenantId?: string;
      tenantRole?: TenantRole;
    }
  }
}

function isTenantRole(value: unknown): value is TenantRole {
  return value === "tenant_admin" || value === "staff";
}

/**
 * Validates a Supabase user JWT and attaches the authenticated user's
 * tenant to the request. If the route also carries a `:tenantId` URL
 * param, that param must match the token's tenant — otherwise an
 * authenticated user from tenant A could read tenant B's data just by
 * changing the URL.
 *
 * Verification goes through `supabase.auth.getUser(token)` (a call to
 * Supabase Auth) rather than hand-verifying the JWT signature locally:
 * Supabase's signing scheme (HS256 vs rotating asymmetric keys) varies by
 * project configuration, and getting that verification subtly wrong is
 * exactly the kind of security-critical mistake worth not risking — the
 * SDK already does it correctly.
 */
export async function requireTenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;

  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <token> header." });
    return;
  }

  const { data, error } = await getSupabaseClient().auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired session." });
    return;
  }

  // `app_metadata` is typed `[key: string]: any` upstream — read through
  // `unknown` rather than letting that `any` propagate into this function.
  const appMetadata: unknown = data.user.app_metadata;
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

/** Requires `requireTenantAuth` (or requireApiKey) to have already run and attached req.tenantRole. */
export function requireTenantAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.tenantRole !== "tenant_admin") {
    res.status(403).json({ error: "This action requires the tenant_admin role." });
    return;
  }
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

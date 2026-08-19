/**
 * Platform-wide management routes — /api/super-admin/*. Every route here
 * is gated by requireSuperAdmin, not requireTenantAuth: a super admin
 * isn't scoped to any tenant, so there's no :tenantId to check against.
 * Deliberately minimal for now (a read-only tenant list) — see the
 * conversation this shipped in for what's intentionally out of scope
 * (deactivating/impersonating a tenant, editing platform_admins from the
 * UI, etc.) rather than silently building a much larger admin panel.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { listAllTenants } from "../../db/supabase.js";
import { requireSuperAdmin } from "../middleware/auth.js";

export const superAdminRouter: express.Router = express.Router();

superAdminRouter.get("/tenants", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tenants = await listAllTenants();
    res.json(tenants);
  } catch (error) {
    next(error);
  }
});

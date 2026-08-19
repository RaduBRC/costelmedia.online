/**
 * Platform-wide management routes — /api/super-admin/*. Every route here
 * is gated by requireSuperAdmin, not requireTenantAuth: a super admin
 * isn't scoped to any tenant, so there's no :tenantId to check against.
 * Deliberately minimal for now (a read-only tenant list, VIP lead list,
 * and plan changes) — see the conversation this shipped in for what's
 * intentionally out of scope (deactivating/impersonating a tenant,
 * editing platform_admins from the UI, etc.) rather than silently
 * building a much larger admin panel.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { listAllTenants, listAllVipLeads, updateTenantPlan } from "../../db/supabase.js";
import type { TenantPlan } from "../../types/index.js";
import { requireSuperAdmin } from "../middleware/auth.js";

export const superAdminRouter: express.Router = express.Router();

const VALID_PLANS: readonly TenantPlan[] = ["starter", "vip"];

function isTenantPlan(value: unknown): value is TenantPlan {
  return typeof value === "string" && (VALID_PLANS as readonly string[]).includes(value);
}

superAdminRouter.get("/tenants", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tenants = await listAllTenants();
    res.json(tenants);
  } catch (error) {
    next(error);
  }
});

/**
 * Every "Request VIP Integration" lead across every tenant — how a super
 * admin actually discovers there's a lead to work, since there's no
 * automated notification (email/Slack/CRM webhook) wired up for this yet.
 */
superAdminRouter.get("/vip-leads", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const leads = await listAllVipLeads();
    res.json(leads);
  } catch (error) {
    next(error);
  }
});

interface UpdatePlanBody {
  plan?: string;
}

/**
 * The one and only way a tenant moves to VIP — no self-serve upgrade
 * button anywhere in the tenant-facing app. A super admin calls this
 * manually after working a vip_leads entry (or any other manual sales
 * conversation) to completion. See 022_onboarding_plans_and_leads.sql.
 */
superAdminRouter.patch(
  "/tenants/:tenantId/plan",
  requireSuperAdmin,
  async (req: Request<{ tenantId: string }, unknown, UpdatePlanBody>, res: Response, next: NextFunction) => {
    try {
      if (!isTenantPlan(req.body.plan)) {
        res.status(400).json({ error: `plan must be one of: ${VALID_PLANS.join(", ")}.` });
        return;
      }
      const tenant = await updateTenantPlan(req.params.tenantId, req.body.plan);
      res.json(tenant);
    } catch (error) {
      next(error);
    }
  },
);
